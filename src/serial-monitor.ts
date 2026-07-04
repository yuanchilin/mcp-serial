import type { SerialStatus } from "./types.js";
import { RingBuffer } from "./ring-buffer.js";
import { SerialPort } from "serialport";
import type { ServerResponse } from "http";

// ============================================================================
// SSE 客户端信息
// ============================================================================

interface ClientInfo {
  res: ServerResponse;
  connectedAt: number;
  name: string;
  ip: string;
}

// ============================================================================
// 持久化串口监视器 - 保持串口打开，持续接收数据
// ============================================================================

export class SerialMonitor {
  serialPort: SerialPort | null = null;
  port = "";
  baudRate = 0;
  startedAt: Date | null = null;
  buffer: RingBuffer;
  sseClients = new Map<string, ClientInfo>();
  controllerClientId: string | null = null;

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

  /** 打开串口并开始监听 */
  async start(port: string, baudRate: number): Promise<void> {
    if (this.isActive()) {
      await this.stop();
    }

    return new Promise((resolve, reject) => {
      const sp = new SerialPort({
        path: port,
        baudRate: baudRate,
        autoOpen: false,
      });

      sp.on("data", (data: Buffer) => {
        const text = data.toString("utf-8");
        this.buffer.append(text);
        this.broadcastSSE(text);
      });

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
    if (!this.serialPort) return;

    return new Promise((resolve) => {
      const sp = this.serialPort!;
      sp.close(() => {
        this.serialPort = null;
        this.startedAt = null;
        this.broadcastStatus();
        console.error("[SerialMonitor] 串口已停止");
        resolve();
      });
    });
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

      // 主超时定时器
      const timeoutId = setTimeout(() => {
        polling = false;
        const { text } = this.buffer.getSince(preSendOffset);
        resolve(text || "(超时 - 无响应)");
      }, timeout);

      // 写入命令
      sp.write(command + lineEnding, (err) => {
        if (err) {
          clearTimeout(timeoutId);
          polling = false;
          reject(err);
          return;
        }

        // 短间隔轮询：每 50ms 检查是否有新数据，最多等 2s 后认为响应完成
        let elapsed = 0;
        const pollInterval = 50;
        const stableThreshold = 2000; // 连续无新数据则视为响应完成
        let lastTotalBytes = preSendOffset;

        const poll = () => {
          if (!polling) return; // 超时已触发

          elapsed += pollInterval;
          const currentTotal = this.buffer.totalBytes;

          if (currentTotal > lastTotalBytes) {
            // 有新数据到达，重置稳定计时
            lastTotalBytes = currentTotal;
          }

          if (elapsed >= stableThreshold) {
            // 已等待足够长时间，认为响应完成
            clearTimeout(timeoutId);
            polling = false;
            const { text } = this.buffer.getSince(preSendOffset);
            resolve(text || "(无响应)");
            return;
          }

          setTimeout(poll, pollInterval);
        };

        // 从下一个事件循环开始轮询
        setTimeout(poll, pollInterval);
      });
    });
  }

  /** 同步发送（无等待响应），用于 Web 终端快速发送 */
  async sendRaw(command: string, lineEnding: string): Promise<void> {
    if (!this.serialPort || !this.serialPort.isOpen) {
      throw new Error("串口未打开");
    }

    return new Promise((resolve, reject) => {
      this.serialPort!.write(command + lineEnding, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  // ---- SSE 客户端管理 ----

  addClient(clientId: string, res: ServerResponse, name: string, ip: string): void {
    this.sseClients.set(clientId, { res, connectedAt: Date.now(), name, ip });
    // 首个客户端自动成为控制端
    if (!this.controllerClientId) {
      this.controllerClientId = clientId;
    }
    console.error(`[SSE] 客户端 ${name}(${ip}) 已连接，当前 ${this.sseClients.size} 个客户端`);
  }

  removeClient(clientId: string): void {
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
    if (!client) return;
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
      try {
        client.res.write(eventData);
      } catch {
        // dead client
      }
    }
  }
}
