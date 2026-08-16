import test from "node:test";
import assert from "node:assert/strict";
import { SerialMonitor } from "../build/serial-monitor.js";

function makeFakeWs() {
  const cbs = {};
  return {
    sent: [],
    on(event, cb) {
      cbs[event] = cb;
    },
    emit(event, data) {
      if (cbs[event]) cbs[event](data);
    },
  };
}

test("WebSocket 控制端可以写串口", () => {
  const monitor = new SerialMonitor(1024);
  monitor.controllerClientId = "ctrl-1";
  monitor.serialPort = {
    isOpen: true,
    write(data) {
      monitor.__written = (monitor.__written || "") + data.toString();
    },
  };

  const ws = makeFakeWs();
  monitor.addWSClient(ws, "controller", "ctrl-1");

  ws.emit("message", Buffer.from("AT\r\n"));
  assert.equal(monitor.__written, "AT\r\n");
});

test("WebSocket 监视端不能写串口", () => {
  const monitor = new SerialMonitor(1024);
  monitor.controllerClientId = "ctrl-1";
  monitor.serialPort = {
    isOpen: true,
    write(data) {
      monitor.__written = (monitor.__written || "") + data.toString();
    },
  };

  const ws = makeFakeWs();
  monitor.addWSClient(ws, "monitor", "monitor-1");

  ws.emit("message", Buffer.from("should-not-send"));
  assert.equal(monitor.__written, undefined);
});

test("WebSocket 缺少 clientId 时不能写串口", () => {
  const monitor = new SerialMonitor(1024);
  monitor.controllerClientId = "ctrl-1";
  monitor.serialPort = {
    isOpen: true,
    write(data) {
      monitor.__written = (monitor.__written || "") + data.toString();
    },
  };

  const ws = makeFakeWs();
  monitor.addWSClient(ws, "anonymous");

  ws.emit("message", Buffer.from("x"));
  assert.equal(monitor.__written, undefined);
});

test("canWSWrite 只允许当前控制端", () => {
  const monitor = new SerialMonitor(1024);
  monitor.controllerClientId = "ctrl-1";

  assert.equal(monitor.canWSWrite("ctrl-1"), true);
  assert.equal(monitor.canWSWrite("monitor-1"), false);
  assert.equal(monitor.canWSWrite(undefined), false);
});
