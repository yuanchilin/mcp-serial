import test from "node:test";
import assert from "node:assert/strict";
import { SerialMonitor } from "../build/serial-monitor.js";

test("serial_send 在持续收到数据时等待数据静默 2 秒后才返回", async () => {
  const monitor = new SerialMonitor(1024);
  monitor.serialPort = {
    isOpen: true,
    write(_data, cb) {
      cb();
      let count = 0;
      const timer = setInterval(() => {
        count += 1;
        monitor.buffer.append(`chunk-${count}\n`);
        if (count >= 15) {
          clearInterval(timer);
        }
      }, 100);
    },
  };

  const start = Date.now();
  const result = await monitor.send("CMD", "\n", 8000);
  const elapsed = Date.now() - start;

  assert.match(result, /chunk-15/);
  // 最后一片数据约在 1500ms 到达，之后应再等约 2000ms 静默
  assert.ok(elapsed >= 3000, `应在最后数据后等待约 2s，实际 ${elapsed}ms`);
  assert.ok(elapsed < 8000, `不应超过主超时，实际 ${elapsed}ms`);
});
