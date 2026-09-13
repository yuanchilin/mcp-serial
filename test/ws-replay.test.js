// ============================================================================
//  WebSocket 连接时回放缓冲 —— 回归测试
//  背景：新打开的页面若只收到"连接之后"的数据，缓冲里明明有历史数据却显示空终端。
//  覆盖：空缓冲不补发 / 有数据按 UTF-8 字节补发 / 只发给新连接不广播 / 清空后不补发
// ============================================================================
import test from "node:test";
import assert from "node:assert/strict";
import { SerialMonitor } from "../build/serial-monitor.js";

/** 最小 WebSocket 桩：记录 send() 收到的内容 */
function fakeWs() {
  const sent = [];
  return {
    sent,
    send: (d) => { sent.push(Buffer.from(d)); },
    on: () => { /* 事件回调不参与本测试 */ },
  };
}

test("WS 回放：新连接补发缓冲历史，空缓冲/已清空则不补发", () => {
  const monitor = new SerialMonitor(1024);

  // ① 空缓冲：不应发送任何东西
  const empty = fakeWs();
  monitor.addWSClient(empty, "ws-empty");
  assert.equal(empty.sent.length, 0, "空缓冲不应补发");

  // ② 缓冲有数据（含多字节 UTF-8）：按原字节补发
  const text = "boot ok\r\nsysinfo: 温度 25.5C\r\n";
  monitor.buffer.append(text);
  const first = fakeWs();
  monitor.addWSClient(first, "ws-first");
  assert.equal(first.sent.length, 1, "应恰好补发一次");
  assert.equal(first.sent[0].toString("utf-8"), text, "补发内容应与缓冲一致");
  assert.equal(first.sent[0].length, Buffer.byteLength(text), "应按 UTF-8 字节数发送（多字节不截断）");

  // ③ 回放只给新连接：先连的那个不应被再次写入
  const second = fakeWs();
  monitor.addWSClient(second, "ws-second");
  assert.equal(second.sent.length, 1, "第二个新连接也应收到一次回放");
  assert.equal(first.sent.length, 1, "已连接的客户端不应被重复推送（回放不是广播）");

  // ④ 清空缓冲后，新连接不再补发
  monitor.buffer.clear();
  const after = fakeWs();
  monitor.addWSClient(after, "ws-after");
  assert.equal(after.sent.length, 0, "缓冲清空后不应补发");
});

test("WS 回放：缓冲超上限时只回放仍保留的部分", () => {
  // 注意：RingBuffer 按【整块】裁剪，不切分块内数据。
  // 单块 10 字符、上限 64 → 各次 append 后逐步丢掉最老的整块，最终保留 6 块 = 60 字符。
  const monitor = new SerialMonitor(64);
  for (let i = 0; i < 10; i++) monitor.buffer.append("0123456789");
  const expect = "0123456789".repeat(6);
  assert.equal(monitor.buffer.getAll(), expect, "缓冲应按整块裁剪到上限内");

  const ws = fakeWs();
  monitor.addWSClient(ws, "ws-trim");
  assert.equal(ws.sent.length, 1, "应补发一次");
  assert.equal(ws.sent[0].toString("utf-8"), expect, "只回放仍保留的部分");
  assert.equal(ws.sent[0].length, 60, "回放长度应等于缓冲实际保留量，而非原写入量");
});
