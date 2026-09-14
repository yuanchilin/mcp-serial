// ============================================================================
//  "仅本机可见"端口：可见性矩阵 / 不泄露存在性 / 落盘持久化 / 远程连接被踢
// ============================================================================
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PortRegistry } from "../build/port-registry.js";
import { SerialMonitor } from "../build/serial-monitor.js";
import { RingBuffer } from "../build/ring-buffer.js";

/** 每次用独立临时文件，绝不触碰用户真实的 private-ports.json */
function tmpPrivacyFile() {
  return join(mkdtempSync(join(tmpdir(), "mcp-priv-")), "private-ports.json");
}

function fakeSession(bufferMaxSize) {
  const buffer = new RingBuffer(bufferMaxSize);
  const s = {
    port: "", baudRate: 0, buffer, _active: false,
    isActive() { return s._active; },
    async start(port, baudRate) { s.port = port; s.baudRate = baudRate; s._active = true; },
    async stop() { s._active = false; },
    getStatus() {
      return { connected: s._active, port: s.port, baudRate: s.baudRate, startedAt: null, uptimeMs: 0,
        stats: buffer.getStats(), clientCount: 0, controllerClientId: null, clients: [] };
    },
    dispose() {},
  };
  return s;
}

const makeRegistry = (file = tmpPrivacyFile()) => new PortRegistry(1024, fakeSession, { privacyFile: file, privatePorts: [] });

test("可见性：私有端口对 remote 受众完全不存在（含候选列表不泄露）", async () => {
  const registry = makeRegistry();
  await registry.open("COM3", 115200);
  await registry.open("COM5", 9600);
  registry.setPrivate("COM5", true);

  // 本机：两个都在
  assert.deepEqual(registry.openPortNames("local"), ["COM3", "COM5"]);
  assert.equal(registry.get("COM5", "local")?.port, "COM5");
  assert.equal(registry.resolve("COM5", "local").ok, true);
  assert.equal(registry.list("local").length, 2);

  // 远程：COM5 完全不存在
  assert.deepEqual(registry.openPortNames("remote"), ["COM3"], "远程列表不应含私有端口");
  assert.equal(registry.get("COM5", "remote"), undefined, "远程取不到私有端口会话");
  assert.equal(registry.list("remote").length, 1);
  const r = registry.resolve("COM5", "remote");
  assert.equal(r.ok, false);
  assert.ok(!r.error.includes("COM5") || r.error.startsWith("串口 COM5 未打开"), "错误文案不应把私有端口列为候选");
  assert.ok(!/当前已打开：.*COM5/.test(r.error), "候选列表里绝不能出现私有端口名");

  // 省略 port 的歧义判定同样基于可见集合：远程只看到 1 路 → 可直接用
  const auto = registry.resolve(undefined, "remote");
  assert.equal(auto.ok, true, "远程只可见一路时应能省略 port");
  assert.equal(auto.session.port, "COM3");
});

test("可见性：全部端口都私有时，远程应得到\"没有已打开的串口\"而不是数量提示", async () => {
  const registry = makeRegistry();
  await registry.open("COM3", 115200);
  await registry.open("COM5", 9600);
  registry.setPrivate("COM3", true);
  registry.setPrivate("COM5", true);

  const r = registry.resolve(undefined, "remote");
  assert.equal(r.ok, false);
  assert.match(r.error, /没有已打开的串口/, "不应暴露「其实有 2 路」");
  assert.deepEqual(registry.openPortNames("remote"), []);
  assert.deepEqual(registry.planStop(undefined, true, "remote"), { ok: false, error: "当前没有已打开的串口" });
});

test("可见性：remote 不能关闭（也看不到）私有端口；all=true 只关它看得见的", async () => {
  const registry = makeRegistry();
  await registry.open("COM3", 115200);
  await registry.open("COM5", 9600);
  registry.setPrivate("COM5", true);

  const one = registry.planStop("COM5", undefined, "remote");
  assert.equal(one.ok, false, "远程不得关闭私有端口");
  assert.ok(!/当前已打开：.*COM5/.test(one.error));

  const all = registry.planStop(undefined, true, "remote");
  assert.equal(all.ok, true);
  assert.deepEqual(all.ports, ["COM3"], "全关也只关它看得见的那一路");

  const allLocal = registry.planStop(undefined, true, "local");
  assert.deepEqual(allLocal.ports, ["COM3", "COM5"]);
});

test("持久化：私有标记写入文件，并且能被新实例读回", async () => {
  const file = tmpPrivacyFile();
  const first = makeRegistry(file);
  first.setPrivate("COM14", true);
  first.setPrivate("COM5", true);
  first.setPrivate("COM5", false); // 取消一个

  assert.ok(existsSync(file), "应生成状态文件");
  const saved = JSON.parse(readFileSync(file, "utf-8"));
  assert.deepEqual(saved.private, ["COM14"], "文件内容应为去重后的集合");

  // 新实例（模拟重启）应读回同样的标记
  const second = new PortRegistry(1024, fakeSession, { privacyFile: file });
  assert.equal(second.isPrivate("COM14"), true);
  assert.equal(second.isPrivate("COM5"), false);
  assert.deepEqual(second.listPrivate(), ["COM14"]);
});

test("持久化：端口名两侧空格应被容忍", () => {
  const registry = makeRegistry();
  registry.setPrivate(" COM14 ", true);
  assert.equal(registry.isPrivate("COM14"), true);
  assert.equal(registry.isPrivate("  COM14  "), true);
  assert.deepEqual(registry.listPrivate(), ["COM14"]);
});

test("切为私有时：断开该端口上的远程连接，保留本机连接", () => {
  const m = new SerialMonitor(1024);
  m.port = "COM14";
  const local = { end() { local.ended = true; }, write() { return true; }, ended: false };
  const remote = { end() { remote.ended = true; }, write() { return true; }, ended: false };
  m.addClient("local-page", local, "local", "127.0.0.1");
  m.addClient("remote-page", remote, "remote", "192.168.1.50");

  const kicked = m.disconnectRemoteClients();
  assert.equal(kicked, 1, "只应踢掉远程那一个");
  assert.equal(remote.ended, true, "远程连接应被断开");
  assert.equal(local.ended, false, "本机连接不应受影响");
  assert.equal(m.isRegistered("local-page"), true);
  assert.equal(m.isRegistered("remote-page"), false);
});
