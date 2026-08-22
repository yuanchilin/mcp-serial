// ============================================================================
//  端口占用自动回退 + 实际端口透传测试
//  约定：只使用 9721~9730 段内端口；占用者保持监听（避免探测-使用竞态）
//  每个场景用后立即关闭释放端口，finally 兜底清理
// ============================================================================
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { SerialMonitor } from "../build/serial-monitor.js";
import { startWebServer } from "../build/web-server.js";

const PORT_MIN = 9722;
const PORT_MAX = 9730;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 在 [from, to] 段内尝试监听，成功返回占用中的 server */
function occupyFreePort(from, to) {
  return new Promise((resolve, reject) => {
    const tryNext = (p) => {
      if (p > to) return reject(new Error(`{${PORT_MIN}~${PORT_MAX}} 段内无空闲端口`));
      const s = http.createServer(() => {});
      s.once("error", (e) => {
        if (e.code === "EADDRINUSE") tryNext(p + 1);
        else { s.close(); reject(e); }
      });
      s.listen(p, "0.0.0.0", () => { s._usedPort = p; resolve(s); });
    };
    tryNext(from);
  });
}

function startServer(port) {
  const monitor = new SerialMonitor(1024);
  let actualPort = null;
  const server = startWebServer(port, monitor, false, undefined, undefined, (p) => { actualPort = p; });
  return { server, getActual: () => actualPort };
}

async function waitActual(s) {
  const deadline = Date.now() + 3000;
  while (s.getActual() === null && Date.now() < deadline) await wait(50);
  return s.getActual();
}

async function closeOne(s) {
  try {
    s.closeAllConnections?.();
    await new Promise((r) => s.close(r));
  } catch { /* 已关闭 */ }
}

test("端口回退：占用则递增回退到可用端口、实际端口透传（9721~9730 段）", async () => {
  // 场景 1：配置端口空闲 → 直接用配置端口，且实际端口在段内可访问
  const t1 = startServer(PORT_MIN + 3); // 9725
  const a1 = await waitActual(t1);
  assert.equal(a1, PORT_MIN + 3, "空闲端口应直接用配置端口");
  await closeOne(t1.server); // 立即释放

  // 场景 2：占用一个基准端口 → 自动回退到基准之后的空闲端口
  const b1 = await occupyFreePort(PORT_MIN, PORT_MAX - 1);
  const base2 = b1._usedPort;
  const t2 = startServer(base2);
  const a2 = await waitActual(t2);
  assert.ok(a2 !== null && a2 > base2 && a2 <= PORT_MAX, `应回退到 ${base2} 之后，实际 ${a2}`);
  await closeOne(b1);
  await closeOne(t2.server); // 立即释放

  // 场景 3：连续占用 3 个端口 → 回退到基准+2 之后
  const b3a = await occupyFreePort(PORT_MIN, PORT_MAX - 3);
  const base3 = b3a._usedPort;
  const b3b = await occupyFreePort(base3 + 1, base3 + 1);
  const b3c = await occupyFreePort(base3 + 2, base3 + 2);
  const t3 = startServer(base3);
  const a3 = await waitActual(t3);
  assert.ok(a3 !== null && a3 > base3 + 2 && a3 <= PORT_MAX, `应回退到 ${base3 + 2} 之后，实际 ${a3}`);
  await closeOne(b3a);
  await closeOne(b3b);
  await closeOne(b3c);
  await closeOne(t3.server); // 立即释放
});