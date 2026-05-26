import type { SerialStatus } from "./types.js";
import { RingBuffer } from "./ring-buffer.js";
import { SerialPort } from "serialport";
import type { ServerResponse } from "http";

// ============================================================================
// 持久化串口监视器 - 保持串口打开，持续接收数据
// ============================================================================

export class SerialMonitor {
  serialPort: SerialPort | null = null;
  port = "";
  baudRate = 0;
  startedAt: Date | null = null;
  buffer: RingBuffer;
  sseClients = new Set<ServerResponse>();

  constructor(bufferMaxSize: number) {
    this.buffer = new RingBuffer(bufferMaxSize);
  }

  /** 检查串口是否活跃 */
  isActive(): boolean {
    return this.serialPort !== null && this.serialPort.isOpen;
  }

  /** 获取串口状态 */
  getStatus(): SerialStatus {
    return {
      connected: this.isActive(),
      port: this.port,
      baudRate: this.baudRate,
      startedAt: this.startedAt?.toISOString() ?? null,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt.getTime() : 0,
      stats: this.buffer.getStats(),
    };
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

  addSSEClient(res: ServerResponse): void {
    this.sseClients.add(res);
    console.error(`[SSE] 客户端已连接，当前 ${this.sseClients.size} 个客户端`);
  }

  removeSSEClient(res: ServerResponse): void {
    this.sseClients.delete(res);
    console.error(`[SSE] 客户端已断开，当前 ${this.sseClients.size} 个客户端`);
  }

  broadcastSSE(data: string): void {
    if (this.sseClients.size === 0) return;

    const eventData = `data: ${JSON.stringify({
      timestamp: Date.now(),
      text: data,
    })}\n\n`;

    for (const client of this.sseClients) {
      try {
        client.write(eventData);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }
}
