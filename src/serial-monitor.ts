import type { SerialStatus } from "./types.js";
import { RingBuffer } from "./ring-buffer.js";
import { SerialPort } from "serialport";
import type { ServerResponse } from "http";
import type { WebSocket } from "ws";

// ============================================================================
// SSE 客户端信息
// ============================================================================

interface ClientInfo {
  res: ServerResponse | null; // null = 无连接注册 (HTTP 脚本/agent, 不推送)
  connectedAt: number;
  name: string;
  ip: string;
  /** SSE 心跳定时器 (无心跳时代理/NAT 会静默断开长连接) */
  hb?: ReturnType<typeof setInterval>;
  /** 最近活跃时间戳 (无连接注册的 http-agent 用 TTL 过期清理) */
  lastSeen: number;
}

// ============================================================================
// WebSocket 终端客户端
// ============================================================================

interface WSClient {
  ws: WebSocket;
  name: string;
  clientId?: string;
}

// ============================================================================
// 持久化串口监视器 - 保持串口打开，持续接收数据
// ============================================================================

/** 无连接注册 (res:null 的 http-agent) 的 TTL，超过则自动清理（毫秒，默认 30 分钟） */
const AGENT_TTL_MS = parseInt(process.env.SERIAL_AGENT_TTL_MS || "1800000", 10);

export class SerialMonitor {
  serialPort: SerialPort | null = null;
  port = "";
  baudRate = 0;
  startedAt: Date | null = null;
  buffer: RingBuffer;
  sseClients = new Map<string, ClientInfo>();
  wsClients = new Set<WSClient>();
  controllerClientId: string | null = null;
  /** 跨 chunk 边界暂存的未完成 UTF-8 字节，拼接到下个 chunk */
  private pendingBytes: Buffer = Buffer.alloc(0);
  /** 用户主动 stop 时置位，抑制 close 事件的「串口已关闭」噪音 */
  private stoppedByUser = false;
  /** 进行中的打开操作 (防止并发 /connect 双重打开串口) */
  private opening: Promise<void> | null = null;

  constructor(bufferMaxSize: number) {
    this.buffer = new RingBuffer(bufferMaxSize);
  }

  /** 检查串口是否活跃 */
  isActive(): boolean {
    return this.serialPort !== null && this.serialPort.isOpen;
  }

  /** 获取串口状态 */
  getStatus(): SerialStatus {
    this.pruneStaleClients(AGENT_TTL_MS); // 惰性清理过期 http-agent
    const clients = Array.from(this.sseClients.entries()).map(([id, info]) => ({
      clientId: id,
      name: info.name,
      ip: info.ip,
      isController: id === this.controllerClientId,
    }));
    return {
      connected: this.isActive(),
      port: this.port,
      baudRate: this.baudRate,
      startedAt: this.startedAt?.toISOString() ?? null,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt.getTime() : 0,
      stats: this.buffer.getStats(),
      clientCount: this.sseClients.size,
      controllerClientId: this.controllerClientId,
      clients,
    };
  }

  /** 判断是否为控制端 */
  isController(clientId: string): boolean {
    return this.controllerClientId === clientId;
  }

  /** 打开串口并开始监听 */
  async start(port: string, baudRate: number): Promise<void> {
    if (this.isActive()) {
      await this.stop();
    }
    // 并发打开保护：多个调用共享同一次打开操作
    if (this.opening) return this.opening;
    this.opening = this.doStart(port, baudRate).finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  private doStart(port: string, baudRate: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const sp = new SerialPort({
        path: port,
        baudRate: baudRate,
        autoOpen: false,
      });

      sp.on("data", (data: Buffer) => {
        // 拼接上次未完成的 UTF-8 字节
        const merged = this.pendingBytes.length > 0
          ? Buffer.concat([this.pendingBytes, data])
          : data;

        // 分离完整序列和末尾不完整字节
        const { complete, incomplete } = splitCompleteUTF8(merged);
        this.pendingBytes = incomplete;

        if (complete.length > 0) {
          const text = complete.toString("utf-8");
          this.buffer.append(text);
          this.broadcastSSE(text);
          this.broadcastWS(complete);  /* 拼接后的完整序列, 避免 WS 端跨 chunk 乱码 */
        }
      });

      sp.on("error", (err: Error) => {
        console.error(`[SerialMonitor] 串口错误: ${err.message}`);
        this.broadcastSSE(`\n[错误] ${err.message}\n`);
      });

      sp.on("close", () => {
        if (!this.stoppedByUser) {
          console.error("[SerialMonitor] 串口已关闭");
          this.broadcastSSE("\n[串口已关闭]\n");
        }
        this.serialPort = null;
        this.startedAt = null;
        this.broadcastStatus();
      });

      sp.open((err) => {
        if (err) {
          reject(new Error(`无法打开串口 ${port}: ${err.message}`));
          return;
        }
        // 关闭 DTR/RTS: 防止拉高 DTR 触发 ESP32 复位进入下载模式
        // (serialport 默认 dtr:true)
        sp.set({ dtr: false, rts: false } as any);
        this.serialPort = sp;
        this.port = port;
        this.baudRate = baudRate;
        this.startedAt = new Date();
        this.stoppedByUser = false;
        console.error(`[SerialMonitor] 串口已打开: ${port} @ ${baudRate} baud`);
        this.broadcastStatus();
        resolve();
      });
    });
  }

  /** 关闭串口 */
  async stop(): Promise<void> {
    const sp = this.serialPort;
    if (!sp) return;
    this.serialPort = null;           /* 先清引用, 防竞态 */
    this.startedAt = null;
    this.stoppedByUser = true;        /* 抑制 close 事件噪音 */

    await new Promise<void>((resolve) => {
      if (!sp.isOpen) { resolve(); return; }
      sp.close((err) => {
        if (err) console.error(`[SerialMonitor] 关闭错误: ${err.message}`);
        else console.error("[SerialMonitor] 串口已停止");
        resolve();
      });
    });
    this.broadcastStatus();
  }

  /** 关闭所有客户端连接（进程退出时调用，让 Web 端立即感知） */
  dispose(): void {
    for (const [, c] of this.sseClients) {
      if (c.hb) clearInterval(c.hb);
      try { c.res?.end(); } catch { /* 已断开 */ }
    }
    this.sseClients.clear();
    for (const c of this.wsClients) {
      try { c.ws.close(); } catch { /* 已断开 */ }
    }
    this.wsClients.clear();
  }

  /**
   * 发送命令并等待响应（修复：使用单一超时 + 短间隔轮询）
   * 在超时时间内持续收集数据，超时后返回所有收集到的响应
   */
  async send(command: string, lineEnding: string, timeout: number): Promise<string> {
    if (!this.serialPort || !this.serialPort.isOpen) {
      throw new Error("串口未打开，请先调用 serial_start");
    }

    return new Promise((resolve, reject) => {
      const preSendOffset = this.buffer.totalBytes;
      const sp = this.serialPort!;
      let polling = true;
      let pollTimer: ReturnType<typeof setTimeout> | null = null;

      // 主超时定时器
      const timeoutId = setTimeout(() => {
        polling = false;
        if (pollTimer) clearTimeout(pollTimer);
        const { text } = this.buffer.getSince(preSendOffset);
        resolve(text || "(超时 - 无响应)");
      }, timeout);

      // 写入命令
      sp.write(command + lineEnding, (err) => {
        if (err) {
          clearTimeout(timeoutId);
          if (pollTimer) clearTimeout(pollTimer);
          polling = false;
          reject(err);
          return;
        }

        // 短间隔轮询：每 50ms 检查是否有新数据，空闲超过阈值后认为响应完成
        let idleMs = 0;
        const pollInterval = 50;
        const stableThreshold = 2000; // 连续无新数据则视为响应完成
        let lastTotalBytes = preSendOffset;

        const poll = () => {
          if (!polling) return; // 超时已触发

          idleMs += pollInterval;
          const currentTotal = this.buffer.totalBytes;

          if (currentTotal > lastTotalBytes) {
            // 有新数据到达，重置空闲计时
            lastTotalBytes = currentTotal;
              idleMs = 0;
          }

          if (idleMs >= stableThreshold) {
            // 已等待足够长时间，认为响应完成
            clearTimeout(timeoutId);
            polling = false;
            if (pollTimer) clearTimeout(pollTimer);
            const { text } = this.buffer.getSince(preSendOffset);
            resolve(text || "(无响应)");
            return;
          }

          pollTimer = setTimeout(poll, pollInterval);
        };

        // 从下一个事件循环开始轮询
        pollTimer = setTimeout(poll, pollInterval);
      });
    });
  }

  /** 同步发送（无等待响应），用于 Web 终端快速发送 */
  async sendRaw(command: string, lineEnding: string): Promise<void> {
    if (!this.serialPort || !this.serialPort.isOpen) {
      throw new Error("串口未打开");
    }

    return new Promise((resolve, reject) => {
      const payload = lineEnding !== "" ? command + lineEnding : command;
      this.serialPort!.write(payload, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /** 流式写入：仅发送原始字节，不追加行尾，不等待响应 */
  async write(data: string): Promise<void> {
    if (!this.serialPort || !this.serialPort.isOpen) {
      throw new Error("串口未打开");
    }

    return new Promise((resolve, reject) => {
      this.serialPort!.write(data, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  // ---- WebSocket 客户端管理 ----

  addWSClient(ws: WebSocket, name: string, clientId?: string): void {
    this.wsClients.add({ ws, name, clientId });
    ws.on("message", (data: Buffer) => {
      if (this.serialPort && this.serialPort.isOpen && this.canWSWrite(clientId)) {
        this.serialPort.write(data);
      }
    });
    ws.on("close", () => {
      for (const c of this.wsClients) { if (c.ws === ws) { this.wsClients.delete(c); break; } }
    });
    ws.on("error", () => {
      for (const c of this.wsClients) { if (c.ws === ws) { this.wsClients.delete(c); break; } }
    });
  }

  /** 检查 WebSocket 客户端是否有串口写入权限（必须是对应 SSE 控制端） */
  canWSWrite(clientId?: string): boolean {
    if (!clientId) return false;
    return this.isController(clientId);
  }


  broadcastWS(data: Buffer): void {
    for (const c of this.wsClients) {
      try { c.ws.send(data); } catch { this.wsClients.delete(c); }
    }
  }

  // ---- SSE 客户端管理 ----

  // ---- 无连接注册 (供 HTTP 脚本/agent 直接调用, 无需 SSE 长连接) ----
  registerClient(clientId: string, name = "http-agent", ip = "127.0.0.1"): boolean {
    if (this.sseClients.has(clientId)) return this.sseClients.get(clientId)!.res !== null;
    this.sseClients.set(clientId, {
      res: null, // 无真实连接, 不推送
      connectedAt: Date.now(),
      name,
      ip,
      lastSeen: Date.now(),
    });
    this.pruneStaleClients(AGENT_TTL_MS);
    if (!this.controllerClientId) {
      this.controllerClientId = clientId;
    }
    console.error(`[SSE] 无连接注册: ${clientId.slice(0, 8)} (${name})`);
    this.broadcastStatus();
    return true;
  }

  /** 更新客户端最近活跃时间（http-agent 每次 /send 调用时刷新） */
  touchClient(clientId: string): void {
    const c = this.sseClients.get(clientId);
    if (c) c.lastSeen = Date.now();
  }

  /** 清理过期的无连接注册（res:null 的 http-agent），返回清理数 */
  pruneStaleClients(ttlMs: number): number {
    const cutoff = Date.now() - ttlMs;
    let removed = 0;
    let controllerRemoved = false;
    for (const [id, c] of this.sseClients) {
      if (c.res === null && c.lastSeen < cutoff) {
        this.sseClients.delete(id);
        removed++;
        if (this.controllerClientId === id) {
          this.controllerClientId = null;
          controllerRemoved = true;
        }
      }
    }
    if (controllerRemoved) {
      this.controllerClientId = this.getOldestClient(); // 提升最老活跃客户端或置空
    }
    if (removed > 0) this.broadcastStatus();
    return removed;
  }

  isRegistered(clientId: string): boolean {
    return this.sseClients.has(clientId);
  }

  addClient(clientId: string, res: ServerResponse, name: string, ip: string): ClientInfo {
    // 同 clientId 重连 (EventSource 自动重连): 顶掉旧连接, 防止旧 close 事件误删新条目
    const existing = this.sseClients.get(clientId);
    if (existing) {
      if (existing.hb) clearInterval(existing.hb);
      if (existing.res && existing.res !== res) {
        try { existing.res.end(); } catch { /* 已断开 */ }
      }
    }
    const info: ClientInfo = { res, connectedAt: Date.now(), name, ip, lastSeen: Date.now() };
    this.sseClients.set(clientId, info);
    // 首个客户端自动成为控制端
    if (!this.controllerClientId) {
      this.controllerClientId = clientId;
    }
    console.error(`[SSE] 客户端 ${name}(${ip}) 已连接，当前 ${this.sseClients.size} 个客户端`);
    return info;
  }

  removeClient(clientId: string, res?: ServerResponse | null): void {
    const cur = this.sseClients.get(clientId);
    if (!cur) return;
    // 条目已被新连接替换: 旧连接的 close 不删除新条目 (SSE 重连防顶掉)
    if (res && cur.res !== res) return;
    if (cur.hb) clearInterval(cur.hb);
    this.sseClients.delete(clientId);
    console.error(`[SSE] 客户端 ${clientId.slice(0, 8)} 已断开，当前 ${this.sseClients.size} 个客户端`);

    // 如果移除的是当前控制端，自动提升最老客户端
    if (this.controllerClientId === clientId) {
      const oldest = this.getOldestClient();
      if (oldest) {
        this.controllerClientId = oldest;
        this.broadcastControlEvent("control-taken", {
          newController: oldest,
          reason: "控制端已断开，自动提升",
        });
        console.error(`[SSE] 控制端已自动提升为 ${oldest.slice(0, 8)}`);
      } else {
        this.controllerClientId = null;
      }
      this.broadcastStatus();
    }
  }

  /** 设置控制端 */
  setController(clientId: string): boolean {
    if (!this.sseClients.has(clientId)) return false;
    const oldController = this.controllerClientId;
    this.controllerClientId = clientId;
    this.broadcastControlEvent("control-taken", {
      newController: clientId,
      oldController: oldController,
    });
    this.broadcastStatus();
    return true;
  }

  /** 获取最老的客户端 ID */
  getOldestClient(): string | null {
    let oldest = null;
    let oldestTime = Infinity;
    for (const [id, info] of this.sseClients) {
      if (info.connectedAt < oldestTime) {
        oldestTime = info.connectedAt;
        oldest = id;
      }
    }
    return oldest;
  }

  /** 向指定客户端发送事件 */
  sendToClient(clientId: string, eventName: string, data: unknown): void {
    const client = this.sseClients.get(clientId);
    if (!client || !client.res) return;
    try {
      const payload = JSON.stringify(data);
      client.res.write(`event: ${eventName}\ndata: ${payload}\n\n`);
    } catch {
      this.sseClients.delete(clientId);
    }
  }

  /** 广播控制事件给所有客户端 */
  broadcastControlEvent(eventName: string, data: unknown): void {
    if (this.sseClients.size === 0) return;
    const payload = JSON.stringify(data);
    const eventData = `event: ${eventName}\ndata: ${payload}\n\n`;
    for (const [, client] of this.sseClients) {
      if (!client.res) continue;
      try {
        client.res.write(eventData);
      } catch {
        // dead client, will be cleaned up on close
      }
    }
  }

  /** 广播结构化状态变更事件给所有 SSE 客户端 */
  broadcastStatus(): void {
    if (this.sseClients.size === 0) return;
    const payload = JSON.stringify(this.getStatus());
    const eventData = `event: status\ndata: ${payload}\n\n`;
    for (const [, client] of this.sseClients) {
      if (!client.res) continue;
      try {
        client.res.write(eventData);
      } catch {
        // dead client
      }
    }
  }

  /** 广播文本数据给所有 SSE 客户端 */
  broadcastSSE(data: string): void {
    if (this.sseClients.size === 0) return;

    const eventData = `data: ${JSON.stringify({
      timestamp: Date.now(),
      text: data,
    })}\n\n`;

    for (const [, client] of this.sseClients) {
      if (!client.res) continue;
      try {
        client.res.write(eventData);
      } catch {
        // dead client
      }
    }
  }
}

// ============================================================================
// UTF-8 边界处理 — 防止跨 chunk 截断多字节字符
// ============================================================================

/**
 * 将 Buffer 分离为「完整 UTF-8 序列」和「末尾不完整字节」两部分。
 * 不完整字节应暂存并拼接到下一 chunk 的开头。
 */
export function splitCompleteUTF8(buffer: Buffer): { complete: Buffer; incomplete: Buffer } {
  const len = buffer.length;

  // 从末尾向前扫描最多 4 个字节（UTF-8 最长序列）
  for (let i = len - 1; i >= 0 && i >= len - 4; i--) {
    const byte = buffer[i];

    if ((byte & 0x80) === 0x00) {
      // ASCII (0xxxxxxx) — 干净边界，后面没有多字节序列
      return { complete: buffer, incomplete: Buffer.alloc(0) };
    }

    if ((byte & 0xC0) === 0xC0) {
      // 多字节序列起始字节 (11xxxxxx)
      const seqLen =
        (byte & 0xE0) === 0xC0 ? 2 :   // 110xxxxx → 2 字节
        (byte & 0xF0) === 0xE0 ? 3 :   // 1110xxxx → 3 字节
        (byte & 0xF8) === 0xF0 ? 4 :   // 11110xxx → 4 字节
        1;                               // 不可能到这里

      const available = len - i;
      if (available < seqLen) {
        // 不完整：起始字节后缺少后续字节
        return {
          complete: buffer.subarray(0, i),
          incomplete: buffer.subarray(i),
        };
      }
      // 序列完整
      return { complete: buffer, incomplete: Buffer.alloc(0) };
    }
    // (byte & 0xC0) === 0x80: 后续字节 (10xxxxxx)，继续向前
  }

  // 没找到起始字节（全部是后续字节，非法 UTF-8 / 二进制数据）。
  // 长度 ≤ 4 暂存拼接（可能只是截断的起始字节）；更长的垃圾数据直接放行，防止无限挂起。
  if (buffer.length > 4) {
    return { complete: buffer, incomplete: Buffer.alloc(0) };
  }
  return { complete: Buffer.alloc(0), incomplete: buffer };
}
