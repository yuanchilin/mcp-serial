// ============================================================================
//  控制权宽限期：多连接下"刷新页面不丢控制权"
//  背景：浏览器刷新会断开再重连 SSE。旧逻辑一断开就把控制权提升给最老的其他客户端，
//        同 clientId 回来的页面再也拿不回来（只有单连接时才会"碰巧"拿回）。
// ============================================================================
import test from "node:test";
import assert from "node:assert/strict";
import { SerialMonitor } from "../build/serial-monitor.js";

/** 最小 SSE 响应桩：只需 end/write */
function fakeRes() {
  return { end() {}, write() { return true; }, on() {} };
}

/** 造一个带两个客户端的监视器：A 是控制端、B 是监视端 */
function twoClients() {
  const m = new SerialMonitor(1024);
  m.port = "COM-TEST";
  m.baudRate = 115200;
  m.addClient("A", fakeRes(), "page-A", "127.0.0.1");
  m.addClient("B", fakeRes(), "page-B", "127.0.0.1");
  assert.equal(m.controllerClientId, "A", "先到的 A 应为控制端");
  return m;
}

const setGrace = (ms) => { process.env.SERIAL_CONTROL_GRACE_MS = String(ms); };
const resetGrace = () => { delete process.env.SERIAL_CONTROL_GRACE_MS; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("控制权宽限期：刷新（同 clientId 回连）不丢控制权", async () => {
  setGrace(500);
  try {
    const m = twoClients();

    // 模拟浏览器刷新：先断开 SSE
    m.removeClient("A");
    assert.equal(m.controllerClientId, "A", "断开瞬间不应把控制权交给别人");
    assert.ok(!m.isRegistered("A"), "A 的客户端条目应已移除");

    // 同 clientId 回连（刷新后页面用 sessionStorage 里的同一个 CID）
    m.addClient("A", fakeRes(), "page-A", "127.0.0.1");
    assert.equal(m.controllerClientId, "A", "回连后应原样保留控制权");
    assert.equal(m.isController("A"), true);
    assert.equal(m.isController("B"), false, "B 不应被提升");

    // 宽限期过后也不应被改（A 已经回来了）
    await wait(650);
    assert.equal(m.controllerClientId, "A", "回连后过了宽限期仍是 A");
  } finally { resetGrace(); }
});

test("控制权宽限期：真的不回来，宽限期到点才提升给别人", async () => {
  setGrace(120);
  try {
    const m = twoClients();
    m.removeClient("A");
    assert.equal(m.controllerClientId, "A", "宽限期内仍归 A");
    await wait(250);
    assert.equal(m.controllerClientId, "B", "宽限期结束后应提升给最老的剩余客户端 B");
  } finally { resetGrace(); }
});

test("控制权宽限期：设为 0 时保持旧的「立即提升」行为", () => {
  setGrace(0);
  try {
    const m = twoClients();
    m.removeClient("A");
    assert.equal(m.controllerClientId, "B", "grace=0 应立刻提升（向后兼容）");
  } finally { resetGrace(); }
});

test("控制权宽限期：期间被别人强制接管后，回连不得抢回", async () => {
  setGrace(500);
  try {
    const m = twoClients();
    m.removeClient("A");
    // 宽限期内 B 强制接管
    assert.equal(m.setController("B"), true);
    assert.equal(m.controllerClientId, "B");

    // A 回来了：不得把控制权从 B 手里抢走
    m.addClient("A", fakeRes(), "page-A", "127.0.0.1");
    assert.equal(m.controllerClientId, "B", "已被接管的情况下，回连不应抢回控制权");

    await wait(650);
    assert.equal(m.controllerClientId, "B", "宽限期到点也不应改变既有控制端");
  } finally { resetGrace(); }
});

test("控制权宽限期：控制端是唯一客户端时，宽限期后置空（不产生幽灵控制端）", async () => {
  setGrace(100);
  try {
    const m = new SerialMonitor(1024);
    m.port = "COM-SOLO";
    m.addClient("only", fakeRes(), "solo", "127.0.0.1");
    assert.equal(m.controllerClientId, "only");
    m.removeClient("only");
    await wait(220);
    assert.equal(m.controllerClientId, null, "没人剩下时应置空");
    assert.equal(m.isController("only"), false);
  } finally { resetGrace(); }
});
