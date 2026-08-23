import test from "node:test";
import assert from "node:assert/strict";
import { SerialMonitor } from "../build/serial-monitor.js";

test("serial_send：并发命令按顺序隔离响应", async () => {
  const monitor = new SerialMonitor(1024);
  monitor.serialPort = {
    isOpen: true,
    write(payload, callback) {
      callback();
      const response = payload.startsWith("first") ? "first:OK" : "second:OK";
      setTimeout(() => monitor.buffer.append(response), 20);
    },
  };

  const first = monitor.send("first", "", 1000, {
    responseMode: "marker",
    endMarker: "OK",
  });
  const second = monitor.send("second", "", 1000, {
    responseMode: "marker",
    endMarker: "OK",
  });

  assert.equal(await first, "first:OK");
  assert.equal(await second, "second:OK");
});

test("serial_send：length 模式按 UTF-8 字节数结束", async () => {
  const monitor = new SerialMonitor(1024);
  monitor.serialPort = {
    isOpen: true,
    write(payload, callback) {
      callback();
      setTimeout(() => monitor.buffer.append("😀"), 20);
    },
  };

  const response = await monitor.send("emoji", "", 500, {
    responseMode: "length",
    expectedLength: 4,
  });

  assert.equal(response, "😀");
});