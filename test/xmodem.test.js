// ============================================================================
//  XMODEM 发送端引擎 —— 单元测试
//  验证方式：用一个**按规范独立实现**的接收端（本文件内）接发送端的字节流，
//  再把收到的数据与源文件逐字节比对；CRC 另用公开校验向量校准（"123456789" → 0x31C3）。
//  覆盖：128B(CRC) / 128B(校验和) / 1K / 丢块重传 / NAK 重传 / 1K 退回 128B /
//        超过重试上限 / 握手超时 / 对端 CAN / AbortSignal 取消 / EOT 重发 /
//        块号 255 回绕 / 末块补位
// ============================================================================
import test from "node:test";
import assert from "node:assert/strict";
import { XmodemSender, crc16, checksum8, buildBlock, X } from "../build/xmodem.js";

/** 独立接收端：按 XMODEM 规范解析字节流并回 ACK/NAK；可注入丢包/NAK/首次 EOT 被拒 */
function makeReceiver(opts = {}) {
  const useCrc = opts.crc !== false;
  const out = [];            // 待回给对端的字节
  const chunks = [];         // 已成功接收的数据块
  const state = { blocks: 0, naks: 0, drops: 0, crcErrors: 0 };
  const maxBlock = opts.maxBlock || 1024;
  let frame = null;
  let expectSeq = 0;
  let sawEot = 0;
  let done = false;

  const send = (b) => out.push(b);
  send(useCrc ? X.CRC_CHAR : X.NAK);   // 握手由接收端发起

  function feed(byte) {
    if (done) return;
    // 只有在**块边界**上 0x04 才是 EOT；数据区里的 0x04 是普通字节
    if (!frame && byte === X.EOT) {
      sawEot++;
      if (opts.nakFirstEot && sawEot === 1) return send(X.NAK);
      done = true;
      return send(X.ACK);
    }
    if (!frame) {
      if (byte === X.SOH || byte === X.STX) frame = { stx: byte === X.STX, bytes: [byte] };
      return;
    }
    frame.bytes.push(byte);
    const size = frame.stx ? 1024 : 128;
    const frameLen = 3 + size + (useCrc ? 2 : 1);
    if (frame.bytes.length < frameLen) return;
    const b = Buffer.from(frame.bytes);
    frame = null;
    if (size > maxBlock) {                       // 接收端不支持这个块长：整块丢掉并 NAK
      state.naks++;
      return send(X.NAK);
    }
    const seq = b[1];
    const invOk = (seq + b[2]) % 256 === 255;
    const payload = b.subarray(3, 3 + size);
    const sumOk = useCrc
      ? crc16(payload) === ((b[3 + size] << 8) | b[3 + size + 1])
      : checksum8(payload) === b[3 + size];
    const nth = expectSeq + 1;
    const seqOk = seq === nth % 256;
    if (!invOk || !sumOk || !seqOk || (opts.drop && opts.drop(nth)) || (opts.nak && opts.nak(nth))) {
      if (!sumOk) state.crcErrors++;
      if (opts.drop && opts.drop(nth)) state.drops++;
      state.naks++;
      return send(X.NAK);
    }
    state.blocks++;
    expectSeq = nth;
    chunks.push(payload);
    send(X.ACK);
  }

  return { feed, out, stats: state, bytes: () => Buffer.concat(chunks) };
}

/** 把发送端与接收端接成一条"链路"：写出去喂接收端，接收端的回应喂 read；无回应即超时 */
function makeLink(recvOpts = {}) {
  const recv = makeReceiver(recvOpts);
  const replies = [];
  const io = {
    write: async (buf) => {
      for (const b of buf) recv.feed(b);
      while (recv.out.length) replies.push(recv.out.shift());
    },
    // 读取时也要先把接收端产生的字节收进来（握手字节是在任何 write 之前就发出的）
    read: async () => {
      while (recv.out.length) replies.push(recv.out.shift());
      return replies.length ? Buffer.from([replies.shift()]) : Buffer.alloc(0);
    },
  };
  return { io, recv };
}

const bytesOf = (n, f) => Buffer.from(Array.from({ length: n }, (_, i) => f(i) & 0xff));

test("CRC-16/XMODEM：标准校验向量 + 块结构", () => {
  assert.equal(crc16(Buffer.from("123456789")), 0x31c3, "CRC-16/XMODEM 校验向量应为 0x31C3");
  assert.equal(checksum8(Buffer.from([0xff, 0x02])), 0x01, "8 位校验和");

  const payload = Buffer.alloc(128, 0x5a);
  const blk = buildBlock(7, payload, true);
  assert.equal(blk.length, 3 + 128 + 2, "128B + CRC 的块长应为 133");
  assert.equal(blk[0], X.SOH);
  assert.equal(blk[1], 7);
  assert.equal(blk[2], 0xf8, "块号反码 = 255-块号");
  assert.equal((blk[131] << 8) | blk[132], crc16(payload), "块尾应是 CRC16 大端");
  assert.equal(buildBlock(1, Buffer.alloc(1024), false)[0], X.STX, "1024B 用 STX 帧头");
});

test("XMODEM-CRC：128B 全量传输，接收端重组后与源文件逐字节一致", async () => {
  const src = bytesOf(1000, (i) => i * 7 + 3);
  const { io, recv } = makeLink({ crc: true });
  const res = await new XmodemSender(io, { mode: "auto", timeoutMs: 50 }).send(src);
  assert.equal(res.ok, true, "应成功：" + (res.error || ""));
  assert.equal(res.crc, true, "对端发 'C' → 走 CRC16");
  assert.equal(res.blockSize, 128);
  assert.equal(Buffer.compare(recv.bytes().subarray(0, src.length), src), 0, "重组数据应与源文件一致");
  assert.equal(recv.bytes().length % 128, 0, "最后一块按 128 字节对齐");
  assert.ok(recv.bytes().subarray(src.length).every((b) => b === 0x1a), "末块补位应为 0x1A");
});

test("XMODEM（校验和）：对端以 NAK 握手时自动退回 8 位校验和", async () => {
  const src = Buffer.from("hello-xmodem".repeat(20));
  const { io, recv } = makeLink({ crc: false });
  const res = await new XmodemSender(io, { mode: "auto", timeoutMs: 50 }).send(src);
  assert.equal(res.ok, true, "应成功：" + (res.error || ""));
  assert.equal(res.crc, false, "对端发 NAK → 走 8 位校验和");
  assert.equal(Buffer.compare(recv.bytes().subarray(0, src.length), src), 0);
});

test("XMODEM-1K：1024B 块 + 丢块重传后仍与源文件一致", async () => {
  const src = bytesOf(5000, (i) => i * 31);
  let dropped = false;
  const { io, recv } = makeLink({ crc: true, drop: (n) => (n === 3 && !dropped ? (dropped = true) : false) });
  const seen = [];
  const res = await new XmodemSender(io, { mode: "1k", timeoutMs: 50, onProgress: (p) => seen.push(p) }).send(src);
  assert.equal(res.ok, true, "应成功：" + (res.error || ""));
  assert.equal(res.blockSize, 1024, "1K 模式应用 1024 字节块");
  assert.ok(res.retries >= 1, "第 3 块被丢应触发重传，实际重传 " + res.retries);
  assert.equal(Buffer.compare(recv.bytes().subarray(0, src.length), src), 0, "重传后数据仍完整");
  assert.ok(seen.some((p) => p.phase === "sending" && p.totalBlocks > 1), "应上报分块进度");
});

test("1K 对端不接受时自动退回 128B（块号不变，数据不重不漏）", async () => {
  const src = bytesOf(3000, (i) => i * 13 + 5);
  const { io, recv } = makeLink({ crc: true, maxBlock: 128 });   // 只吃 128B 的接收端
  const res = await new XmodemSender(io, { mode: "1k", timeoutMs: 50 }).send(src);
  assert.equal(res.ok, true, "退回 128B 后应传完：" + (res.error || ""));
  assert.equal(res.blockSize, 128, "最终块长应退回 128");
  assert.equal(Buffer.compare(recv.bytes().subarray(0, src.length), src), 0, "退回过程不能重不能漏");
});

test("重试上限：对端始终 NAK 第 2 块 → 失败并指明是哪一块", async () => {
  const src = bytesOf(400, (i) => i);
  const { io } = makeLink({ crc: true, nak: (n) => n === 2 });
  const res = await new XmodemSender(io, { mode: "crc", timeoutMs: 50, maxRetries: 3 }).send(src);
  assert.equal(res.ok, false);
  assert.match(res.error || "", /第 2 块/, "错误里要指明块号，实际：" + res.error);
  assert.equal(res.retries, 3, "重传次数应等于上限");
});

test("握手超时：对端不发言 → 明确报错而不是死等", async () => {
  const io = { write: async () => {}, read: async () => Buffer.alloc(0) };
  const res = await new XmodemSender(io, { mode: "auto", handshakeTimeoutMs: 30, timeoutMs: 20 }).send(Buffer.from("x"));
  assert.equal(res.ok, false);
  assert.match(res.error || "", /没有发起握手/);
});

test("对端 CAN / AbortSignal 取消：都要能干净退出", async () => {
  const ioCan = { write: async () => {}, read: async () => Buffer.from([X.CAN]) };
  const r1 = await new XmodemSender(ioCan, { mode: "auto", handshakeTimeoutMs: 50 }).send(Buffer.from("x"));
  assert.equal(r1.ok, false);
  assert.match(r1.error || "", /CAN/);

  const src = bytesOf(2000, (i) => i);
  const { io } = makeLink({ crc: true });
  const ac = new AbortController();
  const res = await new XmodemSender(io, {
    mode: "auto", timeoutMs: 50, signal: ac.signal,
    onProgress: (p) => { if (p.block >= 2) ac.abort(); },
  }).send(src);
  assert.equal(res.ok, false);
  assert.match(res.error || "", /取消/);
});

test("EOT 被拒一次要重发；块号超过 255 要回绕且数据完整", async () => {
  const src = bytesOf(300 * 128, (i) => i * 3);
  const { io, recv } = makeLink({ crc: true, nakFirstEot: true });
  const res = await new XmodemSender(io, { mode: "crc", timeoutMs: 50 }).send(src);
  assert.equal(res.ok, true, "EOT 重发后应成功：" + (res.error || ""));
  assert.equal(recv.stats.blocks, 300, "300 块都要被接收（块号在 255 处回绕）");
  assert.equal(Buffer.compare(recv.bytes().subarray(0, src.length), src), 0, "回绕后数据仍完整");
  assert.ok(res.retries >= 1, "首次 EOT 被 NAK 应计一次重传");
});

test("一直等（maxRetries=0）：对端连拒 25 次也继续重试，最终仍传完", async () => {
  const src = bytesOf(300, (i) => i + 1);
  let naks = 0;
  const { io, recv } = makeLink({
    crc: true,
    nak: (n) => n === 1 && ++naks <= 25,        // 第 1 块先拒 25 次
  });
  const res = await new XmodemSender(io, { mode: "crc", timeoutMs: 20, maxRetries: 0 }).send(src);
  assert.equal(res.ok, true, "不限次数重试应最终成功：" + (res.error || ""));
  assert.ok(res.retries >= 25, "应记录到 25 次以上重传，实际 " + res.retries);
  assert.equal(Buffer.compare(recv.bytes().subarray(0, src.length), src), 0, "数据仍完整");
});

test("一直等（handshakeMs=0）：对端迟迟不发握手字符也要等到", async () => {
  let reads = 0;
  const io = {
    write: async () => {},
    read: async () => {
      reads++;
      if (reads < 40) return Buffer.alloc(0);          // 前 39 次什么都没有
      if (reads === 40) return Buffer.from([0x43]);    // 'C' → CRC 握手
      return Buffer.from([0x06]);                      // 之后一律 ACK
    },
  };
  const res = await new XmodemSender(io, { mode: "auto", handshakeTimeoutMs: 0, timeoutMs: 20 }).send(Buffer.from("hello"));
  assert.equal(res.ok, true, "一直等握手应成功：" + (res.error || ""));
  assert.equal(res.crc, true);
  assert.ok(reads >= 40, "应确实等待了多次空读，实际 " + reads);
});

test("一直等模式下取消要立刻生效（不能卡在无限等待里）", async () => {
  const io = { write: async () => {}, read: async () => Buffer.alloc(0) };   // 永远没回应
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 300);
  const t0 = Date.now();
  const res = await new XmodemSender(io, { mode: "auto", handshakeTimeoutMs: 0, signal: ac.signal }).send(Buffer.from("x"));
  const dt = Date.now() - t0;
  assert.equal(res.ok, false);
  assert.match(res.error || "", /取消/);
  assert.ok(dt < 2000, `取消应立刻生效，实际 ${dt} ms`);
});
