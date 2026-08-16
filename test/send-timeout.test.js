import test from "node:test";
import assert from "node:assert/strict";
import { SerialMonitor } from "../build/serial-monitor.js";

test("serial_send 无响应时按主超时返回", async () => {
  const monitor = new SerialMonitor(1024);
  monitor.serialPort = {
    isOpen: true,
    write(_data, cb) {
      cb();
    },
  };

  const start = Date.now();
  const result = await monitor.send("AT", "\r\n", 50);
  const elapsed = Date.now() - start;

  assert.match(result, /超时 - 无响应/);
  assert.ok(elapsed < 1000, `超时返回不应拖太久，实际 ${elapsed}ms`);
});

test("serial_send 在超时前收到数据则返回已收集的响应", async () => {
  const monitor = new SerialMonitor(1024);
  monitor.serialPort = {
    isOpen: true,
    write(_data, cb) {
      cb();
      setTimeout(() => {
        monitor.buffer.append("OK\r\n");
      }, 20);
    },
  };

  const result = await monitor.send("AT", "\r\n", 500);
  assert.match(result, /OK/);
});
