// ============================================================================
//  远程访问密码认证测试
//  单用例顺序执行（node:test 顶层测试并行会竞争模块级密码状态）
//  覆盖：本机免密 / 远程 401 / 密码登录(对/错) / 会话访问 / 伪造会话 / 免密模式
//  "远程"模拟：非回环 IP 访问（remoteAddress 非回环 → isLocal=false）
// ============================================================================
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { SerialMonitor } from "../build/serial-monitor.js";
import { startWebServer } from "../build/web-server.js";

function lanIP() {
  for (const ifaces of Object.values(os.networkInterfaces() || {})) {
    for (const i of ifaces || []) {
      if (i.family === "IPv4" && !i.internal) return i.address;
    }
  }
  return "127.0.0.1";
}

function startAuthServer(password) {
  const monitor = new SerialMonitor(1024);
  let actualPort = null;
  const server = startWebServer(0, monitor, false, undefined, undefined, (p) => { actualPort = p; }, password);
  return new Promise((resolve) => {
    server.once("listening", () => {
      resolve({ server, base: `http://127.0.0.1:${actualPort}`, remote: `http://${lanIP()}:${actualPort}` });
    });
  });
}

const close = (s) => new Promise((r) => { s.closeAllConnections?.(); s.close(r); });

test("认证：密码模式(本机免密/远程登录/会话/伪造拒) + 免密模式(开放)", async () => {
  // ── 密码模式 ──
  const s1 = await startAuthServer("s3cret");
  try {
    const local = await fetch(`${s1.base}/`);
    assert.equal(local.status, 200, "本机应免密直达");

    const far = await fetch(`${s1.remote}/`);
    assert.equal(far.status, 401, "远程无会话应 401");
    assert.match(await far.text(), /授权访问/, "应返回登录页");

    const bad = await fetch(`${s1.remote}/api/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pwd: "wrong" }),
    });
    assert.equal(bad.status, 401, "错误密码应 401");

    const ok = await fetch(`${s1.remote}/api/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pwd: "s3cret" }),
    });
    assert.equal(ok.status, 200, "正确密码应 200");
    const { session } = await ok.json();
    assert.ok(session && session.length > 8, "应返回会话令牌");

    const authed = await fetch(`${s1.remote}/?session=${encodeURIComponent(session)}`);
    assert.equal(authed.status, 200, "带有效会话应放行");

    const fake = await fetch(`${s1.remote}/?session=not-a-real-session`);
    assert.equal(fake.status, 401, "伪造会话应 401");
  } finally {
    await close(s1.server);
  }

  // ── 免密模式（显式空密码覆盖模块级状态）──
  const s2 = await startAuthServer("");
  try {
    const res = await fetch(`${s2.remote}/`);
    assert.equal(res.status, 200, "无密码时远程应直接放行（现状兼容）");
  } finally {
    await close(s2.server);
  }
});