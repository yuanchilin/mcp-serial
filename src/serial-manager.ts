import type { SerialStatus } from "./types.js";
import { SerialMonitor } from "./serial-monitor.js";

// ============================================================================
// 多串口管理器 - 一个进程同时管理多个 SerialMonitor
// ============================================================================

export class SerialManager {
  private monitors = new Map<string, SerialMonitor>();
  private bufferMaxSize: number;

  constructor(bufferMaxSize: number) {
    this.bufferMaxSize = bufferMaxSize;
  }

  /** 获取指定串口的监视器（不存在时返回 undefined） */
  get(port: string): SerialMonitor | undefined {
    return this.monitors.get(port.trim());
  }

  /** 获取指定串口的监视器，不存在时自动创建 */
  getOrCreate(port: string): SerialMonitor {
    const key = port.trim();
    let monitor = this.monitors.get(key);
    if (!monitor) {
      monitor = new SerialMonitor(this.bufferMaxSize);
      this.monitors.set(key, monitor);
    }
    return monitor;
  }

  /** 打开串口；如果已打开则直接返回现有监视器 */
  async start(port: string, baudRate: number): Promise<SerialMonitor> {
    const monitor = this.getOrCreate(port);
    if (!monitor.isActive()) {
      await monitor.start(port, baudRate);
    }
    return monitor;
  }

  /** 关闭指定串口 */
  async stop(port: string): Promise<boolean> {
    const monitor = this.get(port);
    if (!monitor) return false;
    await monitor.stop();
    return true;
  }

  /** 关闭所有已打开串口 */
  async stopAll(): Promise<void> {
    const active = this.getActiveMonitors();
    await Promise.all(active.map((m) => m.stop()));
  }

  /** 获取所有监视器状态（仅包含至少打开过一次的串口，过滤 /events 等创建的幽灵监视器） */
  getStatus(): SerialStatus[] {
    return Array.from(this.monitors.values())
      .filter((m) => m.port !== "" || m.isActive())
      .map((m) => m.getStatus());
  }

  /** 获取所有已打开串口状态 */
  getActiveStatus(): SerialStatus[] {
    return this.getActiveMonitors().map((m) => m.getStatus());
  }

  /** 获取所有已打开串口的监视器 */
  getActiveMonitors(): SerialMonitor[] {
    return Array.from(this.monitors.values()).filter((m) => m.isActive());
  }

  /** 当前已打开串口数量 */
  activeCount(): number {
    return this.getActiveMonitors().length;
  }

  /** 获取默认操作目标：指定端口 > 唯一活动端口 > 环境默认端口对应监视器 */
  resolve(port?: string, defaultPort?: string): SerialMonitor | undefined {
    if (port) return this.get(port);

    const active = this.getActiveMonitors();
    if (active.length === 1) return active[0];

    if (defaultPort) return this.get(defaultPort);

    return undefined;
  }

  /** 获取所有已创建的监视器（含未打开过的） */
  getAllMonitors(): SerialMonitor[] {
    return Array.from(this.monitors.values());
  }

  /** 关闭所有监视器的客户端连接（进程退出时调用） */
  disposeAll(): void {
    for (const m of this.monitors.values()) m.dispose();
  }
}
