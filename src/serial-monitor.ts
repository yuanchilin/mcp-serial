import type { SerialStatus, SerialSendOptions, ResponseMode } from "./types.js";
import { RingBuffer } from "./ring-buffer.js";
import { SerialPort } from "serialport";
import type { ServerResponse } from "http";
import type { WebSocket } from "ws";
import { XmodemSender, type XmodemIO, type XmodemOptions, type XmodemResult } from "./xmodem.js";

// ============================================================================
// SSE 客户端信息
// ============================================================================

interface ClientInfo {
  /** SSE 响应对象；无连接注册（如 /send 自动接管）时为 null */
  res: ServerResponse | null;
  connectedAt: number;
  /** 最后活跃时间（用于非连接客户端的 TTL 清理） */
  lastSeen: number;
  name: string;
  ip: string;
}

// ============================================================================
// WebSocket 终端客户端
// ============================================================================

interface WSClient {
  ws: WebSocket;
  name: string;
  clientId?: string;
  /** 来源地址（用于"仅本机可见"切换时踢掉远程连接） */
  ip?: string;
}

// ============================================================================
// 持久化串口监视器 - 保持串口打开，持续接收数据
// ============================================================================

/**
 * 控制端断开后的「控制权宽限期」（毫秒）。
 * 用途：浏览器刷新会断开再重连 SSE，若一断开立刻把控制权提升给别人，
 * 同 clientId 回来的页面就再也拿不回来了（多连接时尤其明显）。
 * 0 = 立即提升（旧行为）；可用 SERIAL_CONTROL_GRACE_MS 覆盖。
 */
function controlGraceMs(): number {
  const raw = Number(process.env.SERIAL_CONTROL_GRACE_MS);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return 10000;
}

export class SerialMonitor {
  serialPort: SerialPort | null = null;
  port = "";
  baudRate = 0;
  startedAt: Date | null = null;
  buffer: RingBuffer;
  sseClients = new Map<string, ClientInfo>();
  wsClients = new Set<WSClient>();
  controllerClientId: string | null = null;
  /** 已断开但仍在宽限期内的控制端（等它回连复权） */
  private pendingReleaseController: string | null = null;
  /** 宽限期定时器 */
  private controlReleaseTimer: ReturnType<typeof setTimeout> | null = null;
  private sendQueue: Promise<void> = Promise.resolve();
  /** 跨 chunk 边界暂存的未完成 UTF-8 字节，拼接到下个 chunk */
  private pendingBytes: Buffer = Buffer.alloc(0);
  /** XMODEM 传输期间的"原始字节接收口"：进来的字节会同时喂给它（不影响缓冲区/终端显示） */
  private xferSink: ((b: Buffer) => void) | null = null;
  /** 正在进行的 XMODEM 传输（用于并发保护与取消） */
  private xferAbort: AbortController | null = null;

  constructor(bufferMaxSize: number) {
    this.buffer = new RingBuffer(bufferMaxSize);
  }

  /** 检查串口是否活跃 */
  isActive(): boolean {
    return this.serialPort !== null && this.serialPort.isOpen;
  }

  /** 获取串口状态 */
  getStatus(): SerialStatus {
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

  /**
   * 串口收到数据的**唯一入口**（真实串口与测试夹具共用同一条路径）：
   *   ① 先喂 XMODEM 协议引擎（用未经 UTF-8 拼接的原始字节，控制字节不能被丢/延迟）
   *   ② 再做 UTF-8 拼接 → 写环形缓冲区 → 广播 SSE / WS
   */
  ingest(data: Buffer): void {
    if (this.xferSink) {
      try {
        this.xferSink(data);
      } catch {
        /* 协议侧的问题不能影响正常收数据 */
      }
    }
    const merged = this.pendingBytes.length > 0 ? Buffer.concat([this.pendingBytes, data]) : data;
    const { complete, incomplete } = splitCompleteUTF8(merged);
    this.pendingBytes = incomplete;
    if (complete.length > 0) {
      const text = complete.toString("utf-8");
      this.buffer.append(text);
      this.broadcastSSE(text);
      this.broadcastWS(complete); /* 包含跨 chunk 拼接后的完整 UTF-8 字节 */
    }
  }

  /** 打开串口并开始监听 */
  async start(port: string, baudRate: number): Promise<void> {    if (this.isActive()) {
      await this.stop();
    }

    return new Promise((resolve, reject) => {
      const sp = new SerialPort({
        path: port,
        baudRate: baudRate,
        autoOpen: false,
      });

      sp.on("data", (data: Buffer) => this.ingest(data));

      sp.on("error", (err: Error) => {
        console.error(`[SerialMonitor] 串口错误: ${err.message}`);
        this.broadcastSSE(`\n[错误] ${err.message}\n`);
      });

      sp.on("close", () => {
        console.error("[SerialMonitor] 串口已关闭");
        this.broadcastSSE("\n[串口已关闭]\n");
        this.serialPort = null;
        this.startedAt = null;
        this.broadcastStatus();
      });

      sp.open((err) => {
        if (err) {
          reject(new Error(`无法打开串口 ${port}: ${err.message}`));
          return;
        }
        this.serialPort = sp;
        this.port = port;
        this.baudRate = baudRate;
        this.startedAt = new Date();
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

    return new Promise((resolve) => {
      if (!sp.isOpen) {
        this.broadcastStatus();
        resolve();
        return;
      }
      sp.close((err) => {
        if (err) console.error(`[SerialMonitor] 关闭错误: ${err.message}`);
        else console.error("[SerialMonitor] 串口已停止");
        this.broadcastStatus();
        resolve();
      });
    });
  }

  /**
   * 发送命令并等待响应。
   * responseMode:
   * - timeout: 继续等待到超时，默认兼容历史行为
   * - line: 读取到 CR/LF 结束符后立即返回
   * - marker: 读取到 endMarker 指定字符串后立即返回
   * - regex: 读取到 endMarker 正则表达式匹配后立即返回
   * - length: 读取到 expectedLength 字节数后立即返回
   */
  async send(command: string, lineEnding: string, timeout: number, options: SerialSendOptions = {}): Promise<string> {
    const run = this.sendQueue.then(() => this.sendNow(command, lineEnding, timeout, options));
    this.sendQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async sendNow(command: string, lineEnding: string, timeout: number, options: SerialSendOptions = {}): Promise<string> {
    if (!this.serialPort || !this.serialPort.isOpen) {
      throw new Error("串口未打开，请先调用 serial_start");
    }

    const mode: ResponseMode = options.responseMode || "timeout";
    const stableThreshold = Math.max(
      100,
      Number.parseInt(process.env.SERIAL_RESPONSE_STABLE_MS || "2000", 10)
    );

    return new Promise((resolve, reject) => {
      const preSendOffset = this.buffer.totalBytes;
      const sp = this.serialPort!;
      let polling = true;
      let settled = false;
      let timeoutId: NodeJS.Timeout | null = null;
      let pollTimer: NodeJS.Timeout | null = null;

      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        if (pollTimer) clearTimeout(pollTimer);
      };

      const buildResponse = (text: string): string => {
        if (mode === "line") {
          const idx = text.search(/\r\n|\n|\r/);
          if (idx >= 0) return text.slice(0, idx + (text[idx] === "\r" && text[idx + 1] === "\n" ? 2 : 1));
          return text;
        }
        if (mode === "marker") {
          const marker = options.endMarker || "";
          if (!marker) return text;
          const idx = text.indexOf(marker);
          if (idx >= 0) return text.slice(0, idx + marker.length);
          return text;
        }
        if (mode === "regex") {
          const pattern = options.endMarker || "";
          if (!pattern) return text;
          try {
            const regex = new RegExp(pattern);
            const match = regex.exec(text);
            if (match && match.index >= 0) {
              return text.slice(0, match.index + match[0].length);
            }
          } catch {
            // 兜底：正则匹配失败时回退到超时等待模式
          }
          return text;
        }
        if (mode === "length") {
          const expected = Number(options.expectedLength || 0);
          if (!expected || expected <= 0) return text;
          return Buffer.from(text, "utf-8").subarray(0, expected).toString("utf-8");
        }
        return text;
      };

      const shouldComplete = (text: string): boolean => {
        if (text.length === 0) return false;
        if (mode === "line") return /\r\n|\n|\r/.test(text);
        if (mode === "marker") {
          const marker = options.endMarker || "";
          return !!marker && text.includes(marker);
        }
        if (mode === "regex") {
          const pattern = options.endMarker || "";
          if (!pattern) return false;
          try { return new RegExp(pattern).test(text); } catch { return false; }
        }
        if (mode === "length") {
          const expected = Number(options.expectedLength || 0);
          return expected > 0 && Buffer.byteLength(text, "utf-8") >= expected;
        }
        return false;
      };

      const finish = (callback: () => string | PromiseLike<string>, shouldReject = false) => {
        if (settled) return;
        settled = true;
        polling = false;
        cleanup();
        if (shouldReject) {
          reject(callback() as never);
          return;
        }
        resolve(callback());
      };

      timeoutId = setTimeout(() => {
        if (settled) return;
        const { text } = this.buffer.getSince(preSendOffset);
        finish(() => buildResponse(text) || "(超时 - 无响应)");
      }, timeout);

      sp.write(command + lineEnding, (err) => {
        if (err) {
          finish(() => {
            throw err;
          }, true);
          return;
        }

        let elapsed = 0;
        const pollInterval = 50;
        let lastTotalBytes = preSendOffset;

        const poll = () => {
          if (!polling || settled) return;

          const { text } = this.buffer.getSince(preSendOffset);
          const currentTotal = this.buffer.totalBytes;
          elapsed += pollInterval;

          if (currentTotal > lastTotalBytes) {
            lastTotalBytes = currentTotal;
            elapsed = 0;
          }

          if (mode !== "timeout" && shouldComplete(text)) {
            finish(() => buildResponse(text) || "(无响应)");
            return;
          }

          if (mode === "timeout" && elapsed >= stableThreshold) {
            finish(() => text || "(无响应)");
            return;
          }

          pollTimer = setTimeout(poll, pollInterval);
        };

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

  /**
   * 流式写入**原始字节**（不追加行尾、不等待响应）。
   * 与 write(string) 的区别：string 会按 UTF-8 编码，二进制镜像（字节 >0x7F）会被改写；
   * 这个重载直接吃 Buffer，用于把固件/HEX/SREC 等整份文件推给板子。
   */
  async writeBuffer(data: Buffer): Promise<void> {
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

  addWSClient(ws: WebSocket, name: string, clientId?: string, ip?: string, opts: { replay?: boolean } = {}): void {
    this.wsClients.add({ ws, name, clientId, ip });
    // 回放是【按需】的，默认不补发历史：
    // 新开的窗口 / 刷新后的页面一律从空开始（「清屏」也就成了"只是这个窗口的事"，
    // 刷新不会把清掉的历史又倒回来）。要看服务端缓冲里的历史，得显式请求
    // （页面上的「载入历史缓冲」按钮 → WS 带 ?replay=1）。
    if (opts.replay) this.replayBufferTo(ws);
    ws.on("message", (data: Buffer) => {
      if (this.serialPort && this.serialPort.isOpen) {
        // 有 clientId 的 WS 连接需要校验控制权，非控制端忽略
        if (clientId && this.controllerClientId && clientId !== this.controllerClientId) {
          return;
        }
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

  /** 把当前环形缓冲内容补发给单个 WS 客户端（按 UTF-8 还原为原始字节，不广播给其他人） */
  replayBufferTo(ws: WebSocket): void {
    const history = this.buffer.getAll();
    if (!history) return;
    try {
      ws.send(Buffer.from(history, "utf-8"));
    } catch { /* 连接已失效，忽略 */ }
  }

  /**
   * 断开所有【非回环】来源的连接（SSE + WS）。
   * 用于把某端口切换成"仅本机可见"时立即踢掉远程客户端 —— 不能切了还让它们继续收数据。
   * 返回被踢掉的连接数。
   */
  disconnectRemoteClients(): number {
    const isLoopback = (ip?: string): boolean => {
      const a = (ip || "").replace(/^::ffff:/, "");
      return a === "127.0.0.1" || a === "::1" || a === "localhost" || a.startsWith("127.");
    };
    let kicked = 0;
    for (const [id, client] of [...this.sseClients.entries()]) {
      if (isLoopback(client.ip)) continue;
      this.sseClients.delete(id);
      try { client.res?.end(); } catch { /* 连接已失效 */ }
      kicked++;
    }
    for (const c of [...this.wsClients]) {
      if (isLoopback(c.ip)) continue;
      this.wsClients.delete(c);
      try { c.ws.close(1008, "port is local-only now"); } catch { /* 忽略 */ }
      kicked++;
    }
    if (kicked > 0) {
      console.error(`[Privacy] ${this.port || "端口"} 已设为仅本机可见，断开 ${kicked} 个远程连接`);
      this.broadcastStatus();
    }
    return kicked;
  }

  broadcastWS(data: Buffer): void {
    for (const c of this.wsClients) {
      try { c.ws.send(data); } catch { this.wsClients.delete(c); }
    }
  }

  // ---- SSE 客户端管理 ----

  /**
   * 注册一个 SSE 客户端。同 clientId 重连时顶掉旧连接（end 旧 res），
   * 避免旧 res 泄漏与竞态误删新连接。
   */
  addClient(clientId: string, res: ServerResponse, name: string, ip: string): void {
    const existing = this.sseClients.get(clientId);
    if (existing && existing.res && existing.res !== res) {
      try { existing.res.end(); } catch { /* 旧连接已失效 */ }
    }
    this.sseClients.set(clientId, { res, connectedAt: Date.now(), lastSeen: Date.now(), name, ip });
    // 同 clientId 在宽限期内回连（典型：浏览器刷新）→ 控制权原样保留，不交给别人
    if (this.pendingReleaseController === clientId) {
      this.pendingReleaseController = null;
      if (this.controlReleaseTimer) { clearTimeout(this.controlReleaseTimer); this.controlReleaseTimer = null; }
      console.error(`[SSE] 控制端 ${clientId.slice(0, 8)} 已回连，保留控制权`);
    }
    // 首个客户端自动成为控制端
    if (!this.controllerClientId) {
      this.controllerClientId = clientId;
    }
    // 仅新客户端（非同 clientId 重连）打印，避免浏览器刷新刷屏
    if (!existing) {
      console.error(`[SSE] 客户端 ${name}(${ip}) 已连接，当前 ${this.sseClients.size} 个客户端`);
    }
  }

  /**
   * 无连接注册（如 HTTP /send 自动接管控制端）。res 为 null，不推送数据。
   * 已存在则仅刷新 lastSeen。
   */
  registerClient(clientId: string, name = "http-agent", ip = "127.0.0.1"): void {
    const existing = this.sseClients.get(clientId);
    if (existing) {
      existing.lastSeen = Date.now();
      return;
    }
    this.sseClients.set(clientId, { res: null, connectedAt: Date.now(), lastSeen: Date.now(), name, ip });
  }

  /** 是否已注册（含无连接注册） */
  isRegistered(clientId: string): boolean {
    return this.sseClients.has(clientId);
  }

  /** 刷新客户端活跃时间（用于 TTL 清理） */
  touchClient(clientId: string): void {
    const c = this.sseClients.get(clientId);
    if (c) c.lastSeen = Date.now();
  }

  /**
   * 清理过期的无连接（null res）客户端，避免 /send 幽灵控制端无限堆积。
   * 默认 30 分钟，可用 SERIAL_AGENT_TTL_MS 覆盖。
   */
  pruneStaleClients(ttlMs: number = 30 * 60 * 1000): void {
    const now = Date.now();
    let controllerRemoved = false;
    for (const [id, c] of this.sseClients) {
      if (c.res === null && now - c.lastSeen > ttlMs) {
        this.sseClients.delete(id);
        if (this.controllerClientId === id) controllerRemoved = true;
      }
    }
    if (controllerRemoved) {
      this.controllerClientId = this.getOldestClient();
      this.broadcastStatus();
    }
  }

  /**
   * 移除客户端。res 参数用于身份校验：当存在同 clientId 的更新连接时，
   * 旧连接断开不应误删新连接。
   *
   * 控制权处理（刷新不丢权）：
   * 控制端断开时**不立刻**把控制权提升给别人，而是给一个宽限期（默认 10s）。
   * 同一个 clientId 在宽限期内回来（典型场景：浏览器刷新）→ 控制权原样保留；
   * 宽限期到了还没回来 → 才按老规矩提升给最老的剩余客户端。
   */
  removeClient(clientId: string, res?: ServerResponse): void {
    const existing = this.sseClients.get(clientId);
    if (existing && res && existing.res !== res) {
      // 这是旧连接的断开事件，新连接已接管该 clientId，不删除
      return;
    }
    this.sseClients.delete(clientId);
    console.error(`[SSE] 客户端 ${clientId.slice(0, 8)} 已断开，当前 ${this.sseClients.size} 个客户端`);

    if (this.controllerClientId === clientId) {
      const graceMs = controlGraceMs();
      if (graceMs > 0) {
        // 宽限期内保留控制权，等同 clientId 重连后自动复权
        if (this.controlReleaseTimer) clearTimeout(this.controlReleaseTimer);
        this.pendingReleaseController = clientId;
        this.controlReleaseTimer = setTimeout(() => {
          this.controlReleaseTimer = null;
          this.pendingReleaseController = null;
          // 期间没人接管、且原控制端没回来 → 才提升
          if (this.controllerClientId === clientId) this.promoteControllerAfterControllerLeft();
        }, graceMs);
        if (typeof this.controlReleaseTimer.unref === "function") this.controlReleaseTimer.unref();
        console.error(`[SSE] 控制端 ${clientId.slice(0, 8)} 断开，保留控制权 ${graceMs}ms（刷新可自动复权）`);
      } else {
        this.promoteControllerAfterControllerLeft();
      }
    }
  }

  /** 控制端离开后：提升最老的剩余客户端；没有别人则置空（内部使用） */
  private promoteControllerAfterControllerLeft(): void {
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

  /** 设置控制端（返回 false 表示 clientId 未注册，不设置） */
  setController(clientId: string): boolean {
    if (!this.sseClients.has(clientId)) return false;
    const oldController = this.controllerClientId;
    this.controllerClientId = clientId;
    const c = this.sseClients.get(clientId);
    if (c) c.lastSeen = Date.now();
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

  /** 广播一条自定义 SSE 事件（例如 XMODEM 的 xfer 进度） */
  broadcastEvent(event: string, payload: unknown): void {
    if (this.sseClients.size === 0) return;
    const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const [, client] of this.sseClients) {
      if (!client.res) continue;
      try {
        client.res.write(frame);
      } catch {
        // dead client
      }
    }
  }

  // ---- XMODEM 传输（发送方向） ----

  isXferActive(): boolean {
    return this.xferAbort !== null;
  }

  /** 取消正在进行的 XMODEM 传输；返回是否真的有传输被取消 */
  cancelXfer(): boolean {
    if (!this.xferAbort) return false;
    this.xferAbort.abort();
    return true;
  }

  /** 造一个 XmodemIO：写走真实串口，读走"进来什么给什么"的口子；取消时立刻打断等待 */
  private makeXmodemIO(ac: AbortController): { io: XmodemIO; dispose: () => void } {
    const queue: Buffer[] = [];
    let waiter: ((b: Buffer) => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const wake = (b: Buffer): void => {
      if (!waiter) return;
      const w = waiter;
      waiter = null;
      if (timer) { clearTimeout(timer); timer = null; }
      w(b);
    };
    const sink = (b: Buffer): void => {
      if (waiter) wake(b);
      else queue.push(b);
    };
    // 取消时不能让协议引擎枯等到本块的超时（默认 3s）——否则"点取消"要等好几秒才有反应
    const onAbort = (): void => wake(Buffer.alloc(0));
    ac.signal.addEventListener("abort", onAbort);
    this.xferSink = sink;
    return {
      io: {
        write: (buf: Buffer) => this.writeBuffer(buf),
        read: (timeoutMs: number) =>
          new Promise<Buffer>((resolve) => {
            const q = queue.shift();
            if (q) return resolve(q);
            waiter = resolve;
            timer = setTimeout(() => {
              waiter = null;
              timer = null;
              resolve(Buffer.alloc(0));
            }, timeoutMs);
          }),
      },
      dispose: () => {
        ac.signal.removeEventListener("abort", onAbort);
        this.xferSink = null;
        if (timer) { clearTimeout(timer); timer = null; }
        waiter = null;
        queue.length = 0;
      },
    };
  }

  /**
   * 用 XMODEM 把 data 发给设备（发送方向）。
   * 并发保护：同一端口同一时刻只允许一个传输 —— 两个传输同时读写同一串口会互相污染。
   */
  async xmodemSend(
    data: Buffer,
    opts: XmodemOptions & { label?: string } = {}
  ): Promise<XmodemResult> {
    if (!this.isActive()) throw new Error("串口未打开");
    if (this.xferAbort) throw new Error(`串口 ${this.port} 正在 XMODEM 传输中（同一端口不支持并发传输）`);
    const ac = new AbortController();
    this.xferAbort = ac;
    const { io, dispose } = this.makeXmodemIO(ac);
    this.broadcastEvent("xfer", {
      state: "start",
      port: this.port,
      label: opts.label || "",
      totalBytes: data.length,
      mode: opts.mode || "auto",
      timestamp: Date.now(),
    });
    try {
      const sender = new XmodemSender(io, {
        ...opts,
        signal: ac.signal,
        onProgress: (p) => {
          this.broadcastEvent("xfer", { state: "progress", port: this.port, timestamp: Date.now(), ...p });
          opts.onProgress?.(p);
        },
      });
      const res = await sender.send(data);
      this.broadcastEvent("xfer", { state: res.ok ? "done" : "error", port: this.port, timestamp: Date.now(), ...res });
      return res;
    } finally {
      dispose();
      this.xferAbort = null;
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

  /** 释放资源：关闭所有 SSE/WS 长连接并断开串口（进程退出时调用） */
  dispose(): void {
    if (this.controlReleaseTimer) { clearTimeout(this.controlReleaseTimer); this.controlReleaseTimer = null; }
    this.pendingReleaseController = null;
    for (const [, client] of this.sseClients) {
      try { client.res?.end(); } catch { /* ignore */ }
    }
    this.sseClients.clear();
    for (const c of this.wsClients) {
      try { c.ws.close(); } catch { /* ignore */ }
    }
    this.wsClients.clear();
    this.controllerClientId = null;
    if (this.isActive()) {
      try {
        this.serialPort?.close();
      } catch { /* ignore */ }
      this.serialPort = null;
      this.startedAt = null;
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
function splitCompleteUTF8(buffer: Buffer): { complete: Buffer; incomplete: Buffer } {
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

  // 没找到起始字节（全部是后续字节）→ 全部暂存
  return { complete: Buffer.alloc(0), incomplete: buffer };
}
