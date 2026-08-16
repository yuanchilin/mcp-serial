import test from "node:test";
import assert from "node:assert/strict";
import { RingBuffer } from "../build/ring-buffer.js";

test("RingBuffer 增量读取只返回新数据", () => {
  const rb = new RingBuffer(1024);

  rb.append("hello ");
  const first = rb.getSince(0);
  assert.equal(first.text, "hello ");
  assert.equal(first.newOffset, 6);

  rb.append("world");
  const second = rb.getSince(first.newOffset);
  assert.equal(second.text, "world");
  assert.equal(second.newOffset, 11);
});

test("RingBuffer 超过容量时丢弃旧数据并调整 Agent 游标", () => {
  const rb = new RingBuffer(10);

  rb.append("abcdefghij"); // 10 bytes
  const r1 = rb.getSince(0);
  assert.equal(r1.text, "abcdefghij");

  // 继续写入，超过 10 字节，旧数据应被裁剪
  rb.append("KLMN");
  const stats = rb.getStats();
  assert.ok(stats.totalBytes <= 10);
  assert.ok(stats.chunkCount >= 1);
  assert.ok(stats.chunkCount <= 2);

  // 旧游标会被裁剪逻辑调整到安全位置，getSince 不应抛错
  const r2 = rb.getSince(rb.agentReadOffset);
  assert.equal(typeof r2.text, "string");
});

test("RingBuffer clear 清空所有数据", () => {
  const rb = new RingBuffer(1024);
  rb.append("data");
  rb.getSince(0);
  rb.clear();

  assert.equal(rb.getStats().totalBytes, 0);
  assert.equal(rb.getStats().chunkCount, 0);
  assert.equal(rb.agentReadOffset, 0);
  assert.equal(rb.getAll(), "");
});
