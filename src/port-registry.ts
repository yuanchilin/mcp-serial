import { SerialMonitor } from "./serial-monitor.js";
import type { SerialStatus } from "./types.js";
import { loadPrivatePorts, savePrivatePorts, privacyFilePath } from "./port-privacy.js";

// ============================================================================
// 多串口注册表 —— 唯一的端口状态源
//
// 设计要点（与另一分支的 SerialManager 的关键区别）：
// 1. **没有 getOrCreate**：只由显式的 open() 创建会话，不会因 /events、/status 之类的
//    只读访问凭空造出"幽灵串口"。
// 2. **寻址绝不静默回退**：resolve(port) 在 port 省略时必须"恰好一路已打开"才放行，
//    0 路或 ≥2 路一律返回可读错误 —— 这是"多串口互不干扰"的核心保证。
// 3. 关闭即从注册表移除，不做"留着但未打开"的残留条目。
// 4. **按受众过滤**：标记为"仅本机可见"的端口对 remote 受众完全不存在 ——
//    连错误文案里的候选列表都不会出现它的名字（避免泄露存在性）。
// ============================================================================

/** 受众：本机（回环来源 / stdio）或远程 */
export type Audience = "local" | "remote";

export type ResolveResult =
  | { ok: true; session: SerialMonitor }
  | { ok: false; error: string };

export class PortRegistry {
  /** 端口键（去空格的设备路径）→ 该端口的独占会话 */
  private sessions = new Map<string, SerialMonitor>();
  /** "仅本机可见"的端口集合 */
  private privatePorts: Set<string>;
  /** 私有状态文件路径（可注入，便于测试） */
  private privacyFile: string;

  /**
   * @param bufferMaxSize 每个端口各自的环形缓冲区上限
   * @param sessionFactory 会话工厂（默认创建真实 SerialMonitor；测试可注入假会话，无需真实硬件）
   * @param options.privacyFile 私有端口状态文件（默认走 OS 应用数据目录，可用 SERIAL_PRIVATE_FILE 覆盖）
   * @param options.privatePorts 直接指定初始私有端口（测试用；否则从文件/环境变量加载）
   */
  constructor(
    private bufferMaxSize: number,
    private sessionFactory: (bufferMaxSize: number) => SerialMonitor = (max) => new SerialMonitor(max),
    options: { privacyFile?: string; privatePorts?: Iterable<string> } = {}
  ) {
    this.privacyFile = options.privacyFile ?? privacyFilePath();
    this.privatePorts = options.privatePorts
      ? new Set([...options.privatePorts].map((p) => p.trim()).filter(Boolean))
      : loadPrivatePorts(this.privacyFile);
  }

  // ---- 可见性（仅本机可见） ----

  /** 该端口是否"仅本机可见" */
  isPrivate(port: string): boolean {
    return this.privatePorts.has(PortRegistry.key(port));
  }

  /** 当前所有"仅本机可见"的端口（排序；仅本机消费方可用，远程不应调用） */
  listPrivate(): string[] {
    return [...this.privatePorts].sort();
  }

  /** 设置/取消"仅本机可见"，并落盘 */
  setPrivate(port: string, isPrivate: boolean): void {
    const key = PortRegistry.key(port);
    if (!key) return;
    if (isPrivate) this.privatePorts.add(key);
    else this.privatePorts.delete(key);
    savePrivatePorts(this.privatePorts, this.privacyFile);
  }

  /** 某受众是否可见该端口 */
  visible(port: string, audience: Audience): boolean {
    return audience === "local" || !this.isPrivate(port);
  }

  private static key(port: string): string {
    return port.trim();
  }

  /** 已打开的端口名（按受众过滤；排序，供错误文案与提示使用） */
  openPortNames(audience: Audience = "local"): string[] {
    return this.openSessions(audience)
      .map((s) => s.port || "")
      .filter(Boolean)
      .sort();
  }

  /** 候选提示文案：任何寻址失败都要告诉调用方"现在到底有哪些口"（且不泄露私有端口） */
  private candidates(audience: Audience): string {
    const names = this.openPortNames(audience);
    return names.length > 0 ? `当前已打开：${names.join(", ")}` : "当前没有已打开的串口";
  }

  /** 按端口取会话（不创建；remote 受众对私有端口一律"不存在"） */
  get(port: string, audience: Audience = "local"): SerialMonitor | undefined {
    const key = PortRegistry.key(port);
    if (!this.visible(key, audience)) return undefined;
    return this.sessions.get(key);
  }

  /** 所有已打开端口的会话（按受众过滤） */
  openSessions(audience: Audience = "local"): SerialMonitor[] {
    return [...this.sessions.values()]
      .filter((s) => s.isActive() && this.visible(s.port || "", audience));
  }

  /** 所有端口的摘要状态（只含仍打开的；关闭即移除，故与 openSessions 一致） */
  /** 所有端口的摘要状态（按受众过滤） */
  list(audience: Audience = "local"): SerialStatus[] {
    return this.openSessions(audience).map((s) => s.getStatus());
  }

  activeCount(audience: Audience = "local"): number {
    return this.openSessions(audience).length;
  }

  /**
   * 显式打开一个端口。已打开则复用（不重复 start）；只有这里能创建会话。
   * 端口被别的进程占用等错误由 SerialMonitor.start 抛出，原样上抛。
   */
  async open(port: string, baudRate: number): Promise<SerialMonitor> {
    const key = PortRegistry.key(port);
    let session = this.sessions.get(key);
    if (!session) {
      session = this.sessionFactory(this.bufferMaxSize);
      this.sessions.set(key, session);
    }
    if (!session.isActive()) {
      try {
        await session.start(port, baudRate);
      } catch (err) {
        // 打开失败：不要把半成品会话留在注册表里（避免幽灵条目）
        if (!session.isActive()) this.sessions.delete(key);
        throw err;
      }
    }
    return session;
  }

  /** 关闭指定端口。返回是否确有该端口（不负责"全关"，全关走 closeAll）。 */
  async close(port: string): Promise<boolean> {
    const key = PortRegistry.key(port);
    const session = this.sessions.get(key);
    if (!session) return false;
    if (session.isActive()) await session.stop();
    this.sessions.delete(key);
    return true;
  }

  /** 关闭全部端口，返回被关闭的端口名（排序） */
  async closeAll(): Promise<string[]> {
    const closed: string[] = [];
    for (const [key, session] of [...this.sessions.entries()]) {
      closed.push(session.port || key);
      try {
        if (session.isActive()) await session.stop();
      } catch {
        /* 单个端口关闭失败不应阻塞其他端口 */
      }
      this.sessions.delete(key);
    }
    return closed.sort();
  }

  /**
   * 寻址规则（本设计的核心，用于消除跨端口串扰）：
   * - 给了 port：必须存在且正在运行，否则返回带候选列表的错误；
   * - 省略 port：仅当"恰好一路已打开"时放行；0 路或 ≥2 路都返回可读错误；
   * - audience=remote 时，私有端口一律按"未打开"处理（连候选列表都不出现）。
   */
  resolve(port?: unknown, audience: Audience = "local"): ResolveResult {
    const wanted = typeof port === "string" ? port.trim() : "";
    if (wanted) {
      const session = this.sessions.get(wanted);
      if (!session || !this.visible(wanted, audience)) {
        return { ok: false, error: `串口 ${wanted} 未打开（${this.candidates(audience)}）` };
      }
      if (!session.isActive()) return { ok: false, error: `串口 ${wanted} 未在运行中（${this.candidates(audience)}）` };
      return { ok: true, session };
    }

    const open = this.openSessions(audience);
    if (open.length === 0) {
      return { ok: false, error: "没有已打开的串口，请先 serial_start（同时开多路时需指定 port）" };
    }
    if (open.length > 1) {
      return {
        ok: false,
        error: `有 ${open.length} 个串口已打开（${open.map((s) => s.port).join(", ")}），为避免发错口请显式指定 port`,
      };
    }
    return { ok: true, session: open[0] };
  }

  /** 进程退出时清掉所有端口的客户端连接 */
  disposeAll(): void {
    for (const session of this.sessions.values()) session.dispose();
  }

  /**
   * 关闭策略（防误伤）：必须显式给 port；要一次关掉全部必须显式 all:true。
   * 返回 { ports } 表示允许关闭这些端口，否则给出可读错误。
   * audience=remote 时，私有端口对其不可见也不可关（all=true 也只关它看得见的那些）。
   */
  planStop(port?: unknown, all?: unknown, audience: Audience = "local"): { ok: true; ports: string[] } | { ok: false; error: string } {
    if (all === true) {
      const names = this.openPortNames(audience);
      if (names.length === 0) return { ok: false, error: "当前没有已打开的串口" };
      return { ok: true, ports: names };
    }

    const wanted = typeof port === "string" ? port.trim() : "";
    if (!wanted) {
      const names = this.openPortNames(audience);
      const list = names.length > 0 ? names.join(", ") : "无";
      return {
        ok: false,
        error: `请指定要关闭的 port（当前已打开：${list}）；若要关闭全部 ${names.length} 路，请显式传 all:true`,
      };
    }

    const session = this.sessions.get(wanted);
    if (!session || !session.isActive() || !this.visible(wanted, audience)) {
      return { ok: false, error: `串口 ${wanted} 未在运行中（${this.candidates(audience)}）` };
    }
    return { ok: true, ports: [wanted] };
  }
}
