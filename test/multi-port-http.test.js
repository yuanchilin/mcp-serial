// ============================================================================
//  多串口 HTTP 集成测试（P1 验收核心）
//  做法：用真实 SerialMonitor，但把 start/stop 换成"注入假写口"——不接触任何硬件，
//        却能走完整的寻址 / 控制权 / 缓冲 / 分发逻辑。
//  覆盖：0 路与多路的寻址拒绝、/status 形状、串扰负向测试、每端口控制权独立、
//        /disconnect 必须指定 port、0 路时 SSE/WS 不挂载。
// ============================================================================
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { SerialMonitor } from "../build/serial-monitor.js";
import { PortRegistry } from "../build/port-registry.js";
import { startWebServer } from "../build/web-server.js";

/** 假串口写口：只记录写入了什么，用于断言"数据到底进了哪一路" */
function fakePort(owner) {
  return {
    isOpen: true,
    written: [],
    write(data, cb) {
      owner.written.push(typeof data === "string" ? data : data.toString("utf8"));
      if (typeof cb === "function") cb(null);
      return true;
    },
    close(cb) { if (typeof cb === "function") cb(null); },
    removeAllListeners() { /* noop */ },
  };
}

/** 免硬件工厂：真实 SerialMonitor，但 start/stop 不发真实串口操作 */
function hardwareFreeFactory(bufferMaxSize) {
  const m = new SerialMonitor(bufferMaxSize);
  m.written = [];
  m.start = async (port, baudRate) => {
    m.port = port;
    m.baudRate = baudRate;
    m.startedAt = new Date();
    m.serialPort = fakePort(m);
  };
  m.stop = async () => {
    m.serialPort = null;
    m.startedAt = null;
  };
  return m;
}

async function startTestServer() {
  // 隔离：临时隐私文件，绝不读写用户真实的 private-ports.json
  const registry = new PortRegistry(1024, hardwareFreeFactory, {
    privacyFile: join(mkdtempSync(join(tmpdir(), "mcp-priv-")), "private-ports.json"),
    privatePorts: [],
  });
  let actualPort = null;
  const server = startWebServer(0, registry, false, undefined, undefined, (p) => { actualPort = p; });
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${actualPort}`;
  const close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
  return { registry, base, port: actualPort, close };
}

/** 本机局域网 IP：用它访问即被判定为"远程"（remoteAddress 非回环） */
function lanIP() {
  for (const ifaces of Object.values(networkInterfaces() || {})) {
    for (const i of ifaces || []) {
      if (i.family === "IPv4" && !i.internal) return i.address;
    }
  }
  return "127.0.0.1";
}

const postJson = (base, path, body) =>
  fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("多串口 HTTP：0 路时所有需要端口的接口都拒绝并说明原因（不猜、不挂载）", async () => {
  const { base, close } = await startTestServer();
  try {
    const status = await (await fetch(`${base}/status`)).json();
    assert.equal(status.connected, false);
    assert.deepEqual(status.openPorts, []);
    assert.deepEqual(status.ports, []);

    // SSE 不挂载
    const sse = await fetch(`${base}/events?clientId=c1`);
    assert.equal(sse.status, 400, "0 路时 /events 应 400");
    assert.match(await sse.text(), /没有已打开的串口/);

    // /send、/send-file、控制权操作都必须先有端口
    const send = await postJson(base, "/send", { command: "AT", clientId: "c1" });
    assert.equal(send.status, 400);
    assert.match((await send.json()).error, /没有已打开的串口/);

    const sendFile = await fetch(`${base}/send-file?clientId=c1`, {
      method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: Buffer.from([1, 2, 3]),
    });
    assert.equal(sendFile.status, 400, "0 路时 /send-file 应先因寻址失败而 400");

    const force = await postJson(base, "/force-control", { clientId: "c1" });
    assert.equal(force.status, 400, "控制权操作也要先有端口");
  } finally {
    await close();
  }
});

test("多串口 HTTP：单路时保持旧形状（向后兼容），并支持按端口寻址", async () => {
  const { registry, base, close } = await startTestServer();
  try {
    await registry.open("COM3", 115200);

    const status = await (await fetch(`${base}/status`)).json();
    assert.equal(status.connected, true, "单路时仍返回扁平结构（旧 UI 依赖）");
    assert.equal(status.port, "COM3");
    assert.equal(status.baudRate, 115200);
    assert.deepEqual(status.openPorts, ["COM3"]);

    const byPort = await (await fetch(`${base}/status?port=COM3`)).json();
    assert.equal(byPort.port, "COM3");
    assert.equal(byPort.connected, true);

    const missing = await fetch(`${base}/status?port=COM9`);
    assert.equal(missing.status, 404);

    // /ports 保持裸数组（旧 UI 直接 forEach），并附带 open 标记
    const ports = await (await fetch(`${base}/ports`)).json();
    assert.ok(Array.isArray(ports), "/ports 必须仍是数组");
    const com3 = ports.find((p) => p.path === "COM3");
    if (com3) assert.equal(com3.open, true, "已打开的端口应标记 open");
  } finally {
    await close();
  }
});

test("多串口 HTTP：两路同时收数据互不串（串扰负向测试）", async () => {
  const { registry, base, close } = await startTestServer();
  try {
    const a = await registry.open("COM3", 115200);
    const b = await registry.open("COM5", 9600);

    // 用同一个 clientId 在两路上各发一条带标识的命令（/send 会自动接管该路控制权）
    const sendA = await postJson(base, "/send", { port: "COM3", command: "CMD-A", clientId: "c-shared" });
    assert.equal(sendA.status, 200);
    const sendB = await postJson(base, "/send", { port: "COM5", command: "CMD-B", clientId: "c-shared" });
    assert.equal(sendB.status, 200);

    assert.deepEqual(a.written, ["CMD-A\n"], "COM3 只应收到自己的命令");
    assert.deepEqual(b.written, ["CMD-B\n"], "COM5 只应收到自己的命令");
    assert.ok(!a.written.join("").includes("CMD-B"), "COM3 绝不能收到 COM5 的命令");
    assert.ok(!b.written.join("").includes("CMD-A"), "COM5 绝不能收到 COM3 的命令");

    // 缓冲同样互不干扰：手动往两路写数据后分别读
    a.buffer.append("only-A");
    b.buffer.append("only-B");
    assert.equal(a.buffer.getAll(), "only-A");
    assert.equal(b.buffer.getAll(), "only-B");

    // 多路时省略 port：一律 400 并列出候选
    const ambiguous = await postJson(base, "/send", { command: "AT", clientId: "c-shared" });
    assert.equal(ambiguous.status, 400, "多路时省略 port 必须拒绝");
    const body = await ambiguous.json();
    assert.match(body.error, /COM3/);
    assert.match(body.error, /COM5/);
    assert.deepEqual(body.openPorts, ["COM3", "COM5"]);

    // /status 多路摘要
    const status = await (await fetch(`${base}/status`)).json();
    assert.equal(status.multi, true);
    assert.equal(status.ports.length, 2);
    assert.deepEqual(status.openPorts, ["COM3", "COM5"]);
  } finally {
    await close();
  }
});

test("多串口 HTTP：控制权按端口独立，关一路不影响另一路", async () => {
  const { registry, base, close } = await startTestServer();
  try {
    const a = await registry.open("COM3", 115200);
    const b = await registry.open("COM5", 9600);

    // c1 在 COM3 上取得控制权（/send 自动接管——此时 COM3 还没有控制端）
    await postJson(base, "/send", { port: "COM3", command: "x", clientId: "c1" });
    assert.equal(a.controllerClientId, "c1");

    // c1 在 COM5 上首次发送：COM5 还没有控制端 → 允许，并成为 COM5 的控制端
    const firstOnB = await postJson(base, "/send", { port: "COM5", command: "y", clientId: "c1" });
    assert.equal(firstOnB.status, 200, "该路无控制端时应允许并自动接管");
    assert.equal(b.controllerClientId, "c1");

    // 关键隔离断言：c2 是 COM5 的新客户端，未获授权 → 403，且绝不能顶掉 c1
    const steal = await postJson(base, "/send", { port: "COM5", command: "steal", clientId: "c2" });
    assert.equal(steal.status, 403, "已有控制端时，新 clientId 不得静默夺权");
    assert.equal(b.controllerClientId, "c1", "控制端不应被抢走");
    assert.deepEqual(b.written, ["y\n"], "被拒绝的写入不应落到串口");

    // 而被夺权的一方在自己的端口上依然正常
    const stillMine = await postJson(base, "/send", { port: "COM3", command: "z", clientId: "c1" });
    assert.equal(stillMine.status, 200);
    assert.deepEqual(a.written, ["x\n", "z\n"]);

    // /disconnect 不传 port → 拒绝（必须显式，防误伤）
    const noPort = await postJson(base, "/disconnect", { clientId: "c1" });
    assert.equal(noPort.status, 400);
    assert.match((await noPort.json()).error, /all:true/);

    // 关 COM3：只有它被关，COM5 不受影响
    const closeA = await postJson(base, "/disconnect", { port: "COM3", clientId: "c1" });
    assert.equal(closeA.status, 200);
    assert.equal(registry.get("COM3"), undefined, "COM3 应已从注册表移除");
    assert.equal(b.isActive(), true, "COM5 必须仍在运行");
    assert.deepEqual(registry.openPortNames(), ["COM5"]);

    // 仍能继续在 COM5 上工作（用它自己的控制端身份 c1）
    const okOnB = await postJson(base, "/send", { port: "COM5", command: "z2", clientId: "c1" });
    assert.equal(okOnB.status, 200, "本路控制端应能继续操作");
    assert.deepEqual(b.written, ["y\n", "z2\n"]);

    // 而陌生 clientId 依然被拒（不能因为"这路还有控制端"就被顶掉）
    const stranger = await postJson(base, "/send", { port: "COM5", command: "z3", clientId: "c-shared-b" });
    assert.equal(stranger.status, 403, "陌生 clientId 不得操作已有控制端的端口");
    assert.deepEqual(b.written, ["y\n", "z2\n"], "被拒绝的写入不应落到串口");
    assert.equal(b.controllerClientId, "c1", "控制端不应被顶替");
  } finally {
    await close();
  }
});

test("多串口 HTTP：SSE 按端口订阅，只收到本端口的事件", async () => {
  const { registry, base, close } = await startTestServer();
  try {
    const a = await registry.open("COM3", 115200);
    await registry.open("COM5", 9600);

    const ac = new AbortController();
    const res = await fetch(`${base}/events?clientId=sse-c&port=COM3`, { signal: ac.signal });
    assert.equal(res.status, 200, "指定 port 时应建立 SSE");
    const reader = res.body.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assert.match(first, /event: status/, "首个事件应是状态");
    assert.match(first, /COM3/, "状态里应带本端口名");
    ac.abort();

    // 该 clientId 只在 COM3 上注册，不应出现在 COM5
    assert.ok(a.isRegistered("sse-c"), "应在 COM3 上注册");
    const bSession = registry.get("COM5");
    assert.ok(bSession && !bSession.isRegistered("sse-c"), "不应在 COM5 上注册");
  } finally {
    await close();
  }
});

test("可见性 HTTP：私有端口对远程完全不可见（404），本机可管理，切换后远程被断开", async () => {
  const { registry, base, port, close } = await startTestServer();
  try {
    await registry.open("COM3", 115200);
    await registry.open("COM5", 9600);
    registry.setPrivate("COM5", true); // COM5 = 仅本机可见（夹具直接设置）

    // 本机"管理员"先取得 COM3 的控制权（无控制端时 /send 会自动接管）
    await postJson(base, "/send", { port: "COM3", command: "init", clientId: "admin" });
    assert.equal(registry.get("COM3").controllerClientId, "admin", "管理员应已接管 COM3");

    const remoteBase = `http://${lanIP()}:${port}`;

    // ── 本机：两路都看得到，且能读隐私设置 ──
    const localStatus = await (await fetch(`${base}/status`)).json();
    assert.deepEqual(localStatus.openPorts, ["COM3", "COM5"]);
    assert.equal(localStatus.audience, "local");
    const privacy = await (await fetch(`${base}/privacy`)).json();
    assert.deepEqual(privacy.private, ["COM5"], "本机应能读到私有端口列表");

    // ── 远程：状态/列表里没有 COM5 ──
    const remoteStatus = await (await fetch(`${remoteBase}/status`)).json();
    assert.equal(remoteStatus.audience, "remote");
    assert.deepEqual(remoteStatus.openPorts, ["COM3"], "远程状态不应含私有端口");
    assert.equal(remoteStatus.port, "COM3", "远程只可见一路时应返回该路详情");
    assert.ok(!JSON.stringify(remoteStatus).includes("COM5"), "远程响应里不应出现私有端口名");

    // ── 远程访问私有端口的四类入口：一律 404（而不是 400/403）──
    const ev = await fetch(`${remoteBase}/events?clientId=r1&port=COM5`);
    assert.equal(ev.status, 404, "远程订阅私有端口应 404");
    const send = await postJson(remoteBase, "/send", { port: "COM5", command: "x", clientId: "r1" });
    assert.equal(send.status, 404, "远程向私有端口发命令应 404");
    const conn = await postJson(remoteBase, "/connect", { port: "COM5", baudRate: 115200, clientId: "r1" });
    assert.equal(conn.status, 404, "远程不得打开私有端口");
    const disc = await postJson(remoteBase, "/disconnect", { port: "COM5", clientId: "r1" });
    assert.notEqual(disc.status, 200, "远程不得关闭私有端口");
    const sf = await fetch(`${remoteBase}/send-file?clientId=r1&port=COM5`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: Buffer.from([1]) });
    assert.equal(sf.status, 404, "远程不得向私有端口推文件");

    // ── 远程也不能管理隐私设置 ──
    assert.equal((await fetch(`${remoteBase}/privacy`)).status, 404);
    assert.equal((await postJson(remoteBase, "/privacy", { port: "COM3", private: true, clientId: "admin" })).status, 404);

    // ── 权限回归：本机【监视端】也不得修改可见性（原 bug：本机任意客户端都能锁）──
    const denyMonitor = await postJson(base, "/privacy", { port: "COM3", private: true, clientId: "someone-else" });
    assert.equal(denyMonitor.status, 403, "本机监视端不得修改可见性");
    assert.ok(!registry.isPrivate("COM3"), "被拒绝的请求不得改动状态");
    assert.equal((await postJson(base, "/privacy", { port: "COM3", private: true })).status, 403, "未带 clientId 时也不得修改");

    // ── 远程已连着公开端口，被本机切成私有后应立即断开 ──
    const ac = new AbortController();
    const sse = await fetch(`${remoteBase}/events?clientId=r-keep&port=COM3`, { signal: ac.signal });
    assert.equal(sse.status, 200, "远程可订阅公开端口");
    const reader = sse.body.getReader();
    await reader.read(); // 建立后先读一次

    const setPriv = await postJson(base, "/privacy", { port: "COM3", private: true, clientId: "admin" });
    assert.equal(setPriv.status, 200);
    const setBody = await setPriv.json();
    assert.ok(setBody.kicked >= 1, `切成私有应断开该端口的远程连接（kicked=${setBody.kicked}）`);

    const finished = await reader.read();
    assert.equal(finished.done, true, "远程 SSE 流应被服务端结束");
    ac.abort();

    // 本机自己的连接不受影响
    const localSse = await fetch(`${base}/events?clientId=local-keep&port=COM3`);
    assert.equal(localSse.status, 200, "本机仍可订阅（现在是私有端口）");
    localSse.body.cancel();
  } finally {
    await close();
  }
});
