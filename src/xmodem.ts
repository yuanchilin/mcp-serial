// ============================================================================
//  XMODEM 发送端引擎（发送方向：PC → 设备）
//  · 变体：XMODEM（128B + 8 位校验和）/ XMODEM-CRC（128B + CRC16）/ XMODEM-1K（1024B + CRC16）
//  · 握手由**接收端**发起：先等 'C'（CRC 模式）；收到 NAK 则退回校验和模式
//  · 重传：每块最多 maxRetries 次（超时与 NAK 都算）；1K 连续 3 次被 NAK 自动退回 128B
//    （退回时块号不变、只把该块的 128 字节先发出去，这正是 128B-only 接收端期望的行为）
//  · 取消：AbortSignal，随时可中断，返回 ok:false / error:'已取消'
//  只依赖 XmodemIO（写字节 + 按超时读字节），所以单元测试可以直接喂脚本化 IO。
//  协议参考：XMODEM 规范（SOH/STX、块号与反码、CRC-16/XMODEM、EOT/ACK）
// ============================================================================

export const X = {
  SOH: 0x01,
  STX: 0x02,
  EOT: 0x04,
  ACK: 0x06,
  NAK: 0x15,
  CAN: 0x18,
  CRC_CHAR: 0x43, // 'C'
} as const;

export type XmodemMode = "auto" | "crc" | "checksum" | "1k";

export interface XmodemIO {
  write(buf: Buffer): Promise<void>;
  /** 等到至少一个字节到达；超时返回空 Buffer */
  read(timeoutMs: number): Promise<Buffer>;
}

export interface XmodemProgress {
  phase: "handshake" | "sending" | "finishing" | "done" | "error";
  sentBytes: number;
  totalBytes: number;
  block: number;
  totalBlocks: number;
  retries: number;
  blockSize: number;
  crc: boolean;
  elapsedMs: number;
  rateBps: number;
  message?: string;
}

export interface XmodemResult {
  ok: boolean;
  sentBytes: number;
  retries: number;
  blockSize: number;
  crc: boolean;
  elapsedMs: number;
  error?: string;
}

export interface XmodemOptions {
  mode?: XmodemMode;
  /** 每块等应答的超时（默认 3000 ms） */
  timeoutMs?: number;
  /** 等接收端握手字符的超时（默认 10000 ms）；**<= 0 表示一直等**（直到对端回应或取消） */
  handshakeTimeoutMs?: number;
  /** 每块重试上限（默认 10，即最多尝试 11 次）；**<= 0 表示不限次数**，一直等到回应或取消 */
  maxRetries?: number;
  /** 末块补位字节（默认 0x1A） */
  padByte?: number;
  onProgress?: (p: XmodemProgress) => void;
  signal?: AbortSignal;
}

/** 内部：取消 / 对端 CAN */
class XmodemCancelled extends Error {}
class XmodemPeerAbort extends Error {}

const CRC_TABLE = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 8;
    for (let j = 0; j < 8; j++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
    t[i] = c;
  }
  return t;
})();

/** CRC-16/XMODEM（poly 0x1021、初值 0、不反射）。标准校验向量："123456789" → 0x31C3 */
export function crc16(buf: Buffer): number {
  let crc = 0;
  for (const b of buf) crc = (((crc << 8) & 0xffff) ^ CRC_TABLE[((crc >> 8) ^ b) & 0xff]) & 0xffff;
  return crc & 0xffff;
}

/** 8 位累加校验和（XMODEM 原始模式） */
export function checksum8(buf: Buffer): number {
  let s = 0;
  for (const b of buf) s = (s + b) & 0xff;
  return s;
}

/** 打一个数据块：[SOH|STX][块号][255-块号][数据 128|1024][CRC16 高位,低位 | 8 位校验和] */
export function buildBlock(blockNo: number, payload: Buffer, useCrc: boolean): Buffer {
  const seq = blockNo & 0xff;
  const head = Buffer.from([payload.length === 1024 ? X.STX : X.SOH, seq, (0xff - seq) & 0xff]);
  const tail = useCrc
    ? (() => {
        const c = crc16(payload);
        return Buffer.from([(c >> 8) & 0xff, c & 0xff]);
      })()
    : Buffer.from([checksum8(payload)]);
  return Buffer.concat([head, payload, tail]);
}

export class XmodemSender {
  private pending = Buffer.alloc(0);
  private opt: Required<Pick<XmodemOptions, "timeoutMs" | "handshakeTimeoutMs" | "maxRetries" | "padByte">> & XmodemOptions;

  constructor(private io: XmodemIO, opts: XmodemOptions = {}) {
    this.opt = { timeoutMs: 3000, handshakeTimeoutMs: 10000, maxRetries: 10, padByte: 0x1a, ...opts };
  }

  private checkAbort(): void {
    if (this.opt.signal?.aborted) throw new XmodemCancelled("已取消");
  }

  /** 读一个字节（先吃内部缓冲），超时返回 null */
  private async readByte(timeoutMs: number): Promise<number | null> {
    if (this.pending.length > 0) {
      const b = this.pending[0];
      this.pending = this.pending.subarray(1);
      return b;
    }
    this.checkAbort();
    const got = await this.io.read(timeoutMs);
    if (!got || got.length === 0) return null;
    this.pending = Buffer.from(got);
    const b = this.pending[0];
    this.pending = this.pending.subarray(1);
    return b;
  }

  /** 等一个"我们关心的"控制字节；timeoutMs <= 0 表示**一直等**（直到有回应或取消） */
  private async waitControl(timeoutMs: number): Promise<number | null> {
    const forever = !(timeoutMs > 0);
    const deadline = forever ? Infinity : Date.now() + timeoutMs;
    for (;;) {
      this.checkAbort();
      const left = forever ? 500 : deadline - Date.now();
      if (!forever && left <= 0) return null;
      const b = await this.readByte(left);
      if (b === null) {
        if (!forever) return null;
        // 一直等：让出一次 macrotask 再继续等。
        // 若读取端"立刻返回空"，不加这一步会变成微任务紧循环、把定时器（含取消信号）饿死。
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }
      if (b === X.SOH || b === X.STX) continue; // 对端自己的数据，忽略
      if (b === X.ACK || b === X.NAK || b === X.CAN || b === X.CRC_CHAR) return b;
      // 其它字节（日志/回显）忽略
    }
  }

  /** 等接收端发起握手：'C' = CRC，NAK = 校验和 */
  private async handshake(): Promise<{ crc: boolean; blockSize: number } | null> {
    const mode = this.opt.mode || "auto";
    const b = await this.waitControl(this.opt.handshakeTimeoutMs);
    if (b === null) return null;
    if (b === X.CAN) throw new XmodemPeerAbort();
    // 由对端的握手字符决定校验方式（显式指定只影响块长与首选）
    const crc = b === X.CRC_CHAR ? true : b === X.NAK ? false : mode !== "checksum";
    return { crc, blockSize: mode === "1k" ? 1024 : 128 };
  }

  async send(data: Buffer): Promise<XmodemResult> {
    const t0 = Date.now();
    let sentBytes = 0;
    let retries = 0;
    let block = 0;
    let blockSize = 128;
    let crc = true;
    let totalBlocks = 0;

    const emit = (phase: XmodemProgress["phase"], message?: string): void => {
      const elapsedMs = Date.now() - t0;
      this.opt.onProgress?.({
        phase,
        sentBytes,
        totalBytes: data.length,
        block,
        totalBlocks,
        retries,
        blockSize,
        crc,
        elapsedMs,
        rateBps: Math.round(sentBytes / Math.max(elapsedMs / 1000, 1e-3)),
        message,
      });
    };
    const done = (ok: boolean, error?: string): XmodemResult => {
      emit(ok ? "done" : "error", error);
      return { ok, sentBytes, retries, blockSize, crc, elapsedMs: Date.now() - t0, error };
    };

    try {
      const hs = await this.handshake();
      if (!hs) {
        return done(false, "对端没有发起握手（没收到 'C' 或 NAK）—— 确认设备已进入 XMODEM 接收模式");
      }
      crc = hs.crc;
      blockSize = hs.blockSize;
      totalBlocks = Math.max(1, Math.ceil(data.length / blockSize));
      emit("handshake");

      let offset = 0;
      let nakStreak = 0;
      let guard = 0;
      const unlimited = !(this.opt.maxRetries > 0);      // maxRetries<=0 → 一直重试（直到回应或取消）
      const maxBlocks = Math.ceil(data.length / 128) + 1024; // 防呆：绝不无限循环
      while ((offset < data.length || block === 0) && guard++ < maxBlocks) {
        block++;
        let acked = false;
        for (let attempt = 0; unlimited || attempt <= this.opt.maxRetries; attempt++) {
          this.checkAbort();
          const payload = Buffer.alloc(blockSize, this.opt.padByte);
          data.copy(payload, 0, offset, Math.min(offset + blockSize, data.length));
          await this.io.write(buildBlock(block, payload, crc));
          if (attempt > 0) retries++;
          const r = await this.waitControl(this.opt.timeoutMs);
          if (r === X.ACK) {
            acked = true;
            break;
          }
          if (r === X.CAN) throw new XmodemPeerAbort();
          if (r === X.NAK) nakStreak++;
          else nakStreak = 0; // 超时不清零：连续无应答同样说明该换小包
          if (blockSize === 1024 && nakStreak >= 3) {
            // 对端不吃 1K：退回 128B 重发这一块（块号不变）
            blockSize = 128;
            nakStreak = 0;
            totalBlocks = block - 1 + Math.max(1, Math.ceil((data.length - offset) / blockSize));
            emit("sending", "对端不接受 1K，已退回 128 字节块");
          } else if (unlimited && attempt > 0) {
            // 一直等模式：让界面看得出"还活着、在等对端"，而不是像卡死
            emit("sending", `等待对端应答（第 ${block} 块已重试 ${attempt} 次）`);
          }
        }
        if (!acked) {
          return done(false, `第 ${block} 块连续 ${this.opt.maxRetries + 1} 次没有 ACK（超时或被 NAK）`);
        }
        offset += blockSize;
        sentBytes = Math.min(offset, data.length);
        emit("sending");
      }

      emit("finishing");
      for (let attempt = 0; unlimited || attempt <= this.opt.maxRetries; attempt++) {
        this.checkAbort();
        await this.io.write(Buffer.from([X.EOT]));
        if (attempt > 0) retries++;
        const r = await this.waitControl(this.opt.timeoutMs);
        if (r === X.ACK) return done(true);
        if (r === X.CAN) throw new XmodemPeerAbort();
      }
      return done(false, "EOT 之后没有收到 ACK（对端可能没收到完整数据）");
    } catch (e) {
      if (e instanceof XmodemCancelled) return done(false, "已取消");
      if (e instanceof XmodemPeerAbort) return done(false, "对端发出 CAN，传输被中止");
      return done(false, e instanceof Error ? e.message : String(e));
    }
  }
}
