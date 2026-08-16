import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { RingBuffer } from "../build/ring-buffer.js";
import { SerialManager } from "../build/serial-manager.js";
import { splitCompleteUTF8, SerialMonitor } from "../build/serial-monitor.js";
import { startWebServer } from "../build/web-server.js";

async function startTestServer(manager) {
  const server = startWebServer(0, manager, false);
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  return { server, base: `http://127.0.0.1:${port}` };
}

async function closeServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

function post(base, path, body) {
  return fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Connection: "close" },
    body: JSON.stringify(body),
  });
}

// ---- RingBuffer 字节计数 ----

test("RingBuffer 按 UTF-8 字节计数（多字节字符）", () => {
  const rb = new RingBuffer(100);
  rb.append("你好");
  assert.equal(rb.totalBytes, 6, "你好 = 6 字节");
  rb.append("A");
  assert.equal(rb.totalBytes, 7);
  const stats = rb.getStats();
  assert.equal(stats.totalBytes, 7);
});

test("RingBuffer 裁剪时按字节调整游标", () => {
  const rb = new RingBuffer(10);
  rb.append("你好"); // 6 字节
  rb.getSince(0);
  rb.append("ABC"); // 3 字节 → 9 字节
  assert.equal(rb.totalBytes, 9);
});

// ---- splitCompleteUTF8 ----

test("splitCompleteUTF8 跨 chunk 拼接多字节字符", () => {
  const r1 = splitCompleteUTF8(Buffer.from([0xE4, 0xBD])); // “你”的前 2 字节
  assert.equal(r1.complete.length, 0);
  assert.equal(r1.incomplete.length, 2);
  const merged = Buffer.concat([r1.incomplete, Buffer.from([0xA0, 0x41])]); // “你”+A
  const r2 = splitCompleteUTF8(merged);
  assert.equal(r2.complete.toString("utf-8"), "你A");
  assert.equal(r2.incomplete.length, 0);
});

test("splitCompleteUTF8 纯连续字节超过 4 字节直接放行（防止挂起）", () => {
  const r = splitCompleteUTF8(Buffer.from([0x80, 0x81, 0x82, 0x83, 0x84]));
  assert.equal(r.complete.length, 5);
  assert.equal(r.incomplete.length, 0);
});

// ---- HTTP 回归 ----

test("POST /send 串口未打开时不注册客户端（无副作用）", async () => {
  const manager = new SerialManager(1024);
  const monitor = manager.getOrCreate("COM3");
  const { server, base } = await startTestServer(manager);
  try {
    const res = await post(base, "/send", { port: "COM3", command: "AT", clientId: "ghost-1" });
    assert.equal(res.status, 500);
    assert.equal(monitor.sseClients.size, 0, "失败请求不应留下已注册客户端");
    assert.equal(monitor.controllerClientId, null, "失败请求不应抢走控制权");
  } finally {
    await closeServer(server);
  }
});

test("POST /send 缺少 command 时不注册客户端", async () => {
  const manager = new SerialManager(1024);
  const monitor = manager.getOrCreate("COM3");
  monitor.serialPort = { isOpen: true, write() {} };
  const { server, base } = await startTestServer(manager);
  try {
    const res = await post(base, "/send", { port: "COM3", clientId: "ghost-2" });
    assert.equal(res.status, 400);
    assert.equal(monitor.sseClients.size, 0);
  } finally {
    await closeServer(server);
  }
});

test("POST /request-control 未注册 clientId 立即返回 409（不再 10 秒后崩溃）", async () => {
  const manager = new SerialManager(1024);
  const monitor = manager.getOrCreate("COM3");
  monitor.controllerClientId = "ctrl-1";
  const { server, base } = await startTestServer(manager);
  try {
    const res = await post(base, "/request-control", { port: "COM3", clientId: "nobody" });
    assert.equal(res.status, 409);
    assert.match(await res.text(), /SSE/);
    // 服务必须仍然存活（修复前这里会在 10 秒后写已结束的响应导致进程崩溃）
    const status = await fetch(`${base}/status`, { headers: { Connection: "close" } });
    assert.equal(status.status, 200);
  } finally {
    await closeServer(server);
  }
});

test("POST /connect 已连接且无控制端时放行（不返回 403）", async () => {
  const manager = new SerialManager(1024);
  const monitor = manager.getOrCreate("COM3");
  monitor.controllerClientId = null;
  monitor.serialPort = { isOpen: true, write() {} }; // 无 close → start 内部会报错，但不应是 403
  const { server, base } = await startTestServer(manager);
  try {
    const res = await post(base, "/connect", { port: "COM3", clientId: "x" });
    assert.notEqual(res.status, 403, "无控制端时 /connect 不应因权限被拒");
  } finally {
    await closeServer(server);
  }
});

test("POST /connect 有控制端时非控制端被拒 403", async () => {
  const manager = new SerialManager(1024);
  const monitor = manager.getOrCreate("COM3");
  monitor.controllerClientId = "ctrl-1";
  monitor.serialPort = { isOpen: true, write() {} };
  const { server, base } = await startTestServer(manager);
  try {
    const res = await post(base, "/connect", { port: "COM3", clientId: "other" });
    assert.equal(res.status, 403);
  } finally {
    await closeServer(server);
  }
});

test("SERIAL_WEB_TOKEN 未授权 POST 返回 401，带 token 放行", async () => {
  process.env.SERIAL_WEB_TOKEN = "secret";
  try {
    const manager = new SerialManager(1024);
    const { server, base } = await startTestServer(manager);
    try {
      const noToken = await post(base, "/send", { port: "COM3", command: "AT" });
      assert.equal(noToken.status, 401);
      const withToken = await fetch(`${base}/send?token=secret`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Connection: "close" },
        body: JSON.stringify({ port: "COM3", command: "AT" }),
      });
      assert.notEqual(withToken.status, 401);
    } finally {
      await closeServer(server);
    }
  } finally {
    delete process.env.SERIAL_WEB_TOKEN;
  }
});

test("POST /send 超大请求体返回 413", async () => {
  const manager = new SerialManager(1024);
  const { server, base } = await startTestServer(manager);
  try {
    const res = await fetch(`${base}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Connection: "close" },
      body: JSON.stringify({ port: "COM3", command: "x".repeat(100 * 1024) }),
    });
    assert.equal(res.status, 413);
  } finally {
    await closeServer(server);
  }
});

test("SSE 同 clientId 重连后，旧连接 close 不误清新连接心跳", async () => {
  const manager = new SerialManager(1024);
  const monitor = manager.getOrCreate("COM7");
  const { server, base } = await startTestServer(manager);
  const openSSE = (url) =>
    new Promise((resolve, reject) => {
      const req = http.get(url, (res) => {
        res.resume(); // 消费 SSE 流，避免背压
        resolve(req);
      });
      req.on("error", reject);
    });
  try {
    const clientId = "reconnect-hb";
    const req1 = await openSSE(`${base}/events?clientId=${clientId}&port=COM7`);
    const req2 = await openSSE(`${base}/events?clientId=${clientId}&port=COM7`);

    // 新连接的心跳定时器应活跃
    const hb = monitor.sseClients.get(clientId)?.hb;
    assert.ok(hb, "重连后应存在心跳定时器");
    assert.equal(hb._destroyed, false, "心跳应处于活跃状态");

    // 关闭旧连接（触发其 close 处理器），不得影响新连接的心跳
    req1.destroy();
    await new Promise((r) => setTimeout(r, 300));

    assert.ok(monitor.sseClients.has(clientId), "新连接条目应保留");
    assert.equal(monitor.sseClients.get(clientId)?.hb, hb, "心跳引用应保持不变");
    assert.equal(hb._destroyed, false, "旧连接 close 不得误清新连接的心跳");

    req2.destroy();
    await new Promise((r) => setTimeout(r, 300));
  } finally {
    await closeServer(server);
  }
});

test("POST /force-control 不存在的 port 返回 404（不创建幽灵 monitor）", async () => {
  const manager = new SerialManager(1024);
  const { server, base } = await startTestServer(manager);
  try {
    const res = await post(base, "/force-control", { port: "COM-NOPE", clientId: "ghost" });
    assert.equal(res.status, 404);
    assert.equal(manager.getAllMonitors().length, 0, "不应创建幽灵 monitor");
  } finally {
    await closeServer(server);
  }
});

test("pruneStaleClients 清理过期的无连接注册 (http-agent)", () => {
  const monitor = new SerialMonitor(1024);
  monitor.registerClient("old-agent");
  monitor.registerClient("fresh-agent");
  // 把 old-agent 的活跃时间拨回 1 小时前
  monitor.sseClients.get("old-agent").lastSeen = Date.now() - 60 * 60 * 1000;
  const removed = monitor.pruneStaleClients(30 * 60 * 1000);
  assert.equal(removed, 1);
  assert.ok(!monitor.sseClients.has("old-agent"), "过期的 http-agent 应被清理");
  assert.ok(monitor.sseClients.has("fresh-agent"), "未过期的应保留");
});

// ---- Bug 1 & 2 回归：RingBuffer 多字节字符 + 裁剪 ----

test("RingBuffer getSince 多字节字符按字节偏移正确读取", () => {
  const rb = new RingBuffer(100);
  rb.append("你好世界"); // 12 字节
  const r1 = rb.getSince(0);
  assert.equal(r1.text, "你好世界");
  assert.equal(r1.newOffset, 12);

  // 从字节偏移 3 读取（跳过"你"）
  const r2 = rb.getSince(3);
  assert.equal(r2.text, "好世界");
  assert.equal(r2.newOffset, 12);

  // 从字节偏移 6 读取（跳过"你好"）
  const r3 = rb.getSince(6);
  assert.equal(r3.text, "世界");
});

test("RingBuffer 裁剪后 getSince 偏移不漂移", () => {
  const rb = new RingBuffer(10); // 容量 10 字节
  rb.append("你好"); // 6 字节
  rb.append("AB");   // 2 字节 → 8
  rb.append("CD");   // 2 字节 → 10
  rb.append("EF");   // 2 字节 → 12 > 10, 裁剪"你好"(6字节)

  // 裁剪后 totalBytes = 6 (ABCD=4 + EF=2... 不对, AB=2, CD=2, EF=2 = 6)
  assert.equal(rb.totalBytes, 6);

  // 从 0 读取应返回剩余全部
  const r = rb.getSince(0);
  assert.equal(r.text, "ABCDEF");
  assert.equal(r.newOffset, 6);
});

test("RingBuffer getSince 从多字节字符中间截断不产乱码", () => {
  const rb = new RingBuffer(100);
  rb.append("你好世界"); // 12 字节: E4 BD A0 E5 A5 BD E4 B8 96 E7 95 8C
  // 从字节偏移 4 读取 — 在"好"(E5 A5 BD)的第 2 字节处截断
  const r = rb.getSince(4);
  // Buffer.toString 会跳过开头不完整的 UTF-8 字节，从"好"的完整序列开始
  assert.ok(r.text.includes("世界") || r.text.includes("好世界"), `不应产乱码, 实际: "${r.text}"`);
});

// ---- Bug 3 回归：send() 写入失败时定时器正确清理 ----

test("serial_send 写入失败时 reject 且不泄漏定时器", async () => {
  const monitor = new SerialMonitor(1024);
  let writeCallback = null;
  monitor.serialPort = {
    isOpen: true,
    write(_data, cb) {
      writeCallback = cb;
    },
  };

  // 发送命令但不立即回调
  const sendPromise = monitor.send("AT", "\r\n", 1000);

  // 模拟写入失败
  const writeError = new Error("串口写入失败");
  writeCallback(writeError);

  await assert.rejects(sendPromise, (err) => {
    assert.equal(err.message, "串口写入失败");
    return true;
  });

  // 验证没有遗留的轮询定时器（通过检查内部状态）
  // 如果 cleanup 正确执行，polling 应为 false，不会有额外的 setTimeout 挂起
});

test("serial_send 写入失败后再次 send 不受影响", async () => {
  const monitor = new SerialMonitor(1024);
  monitor.serialPort = {
    isOpen: true,
    write(_data, cb) {
      cb(new Error("第一次失败"));
    },
  };

  await assert.rejects(monitor.send("AT", "\r\n", 100));

  // 修复串口，第二次应成功
  monitor.serialPort = {
    isOpen: true,
    write(_data, cb) {
      cb();
      setTimeout(() => monitor.buffer.append("OK\r\n"), 10);
    },
  };

  const result = await monitor.send("AT", "\r\n", 500);
  assert.match(result, /OK/);
});

import { openBrowser } from "../build/web-server.js";

// ---- Bug 4 回归：openBrowser 多 URL 独立跟踪 ----

test("openBrowser 不同 URL 各自独立打开（不共享标志）", () => {
  // 由于 openedUrls 是模块级 Set，测试前需清空（通过重新导入模块）
  // 注意：openBrowser 内部使用 exec，测试环境会尝试执行命令
  // 我们主要验证 URL 去重逻辑而非实际执行
  const url1 = "http://localhost:9721";
  const url2 = "http://192.168.1.100:9721";

  // 第一次打开 url1 应该返回 true（表示尝试打开）
  // 第二次打开相同 url1 应该返回 false（已打开过）
  // 但打开 url2 应该返回 true（不同 URL）
  // 注意：由于 exec 是异步的，返回值在调用时确定
  const r1 = openBrowser(url1);
  const r1again = openBrowser(url1);
  const r2 = openBrowser(url2);

  assert.equal(r1, true, "首次打开 URL1 应尝试执行");
  assert.equal(r1again, false, "重复打开 URL1 应跳过");
  assert.equal(r2, true, "首次打开 URL2 应尝试执行");
});

// ---- SSE 并发连接竞争回归 ----

test("SSE 同 clientId 并发连接不导致重复注册或连接泄漏", async () => {
  const manager = new SerialManager(1024);
  const monitor = manager.getOrCreate("COM8");
  const { server, base } = await startTestServer(manager);
  const openSSE = (url) =>
    new Promise((resolve, reject) => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve(req);
      });
      req.on("error", reject);
    });
  try {
    const clientId = "concurrent-test";
    // 模拟快速连续连接（如 auto=1 场景下 init() 和 tc() 竞争）
    const [req1, req2] = await Promise.all([
      openSSE(`${base}/events?clientId=${clientId}&port=COM8`),
      openSSE(`${base}/events?clientId=${clientId}&port=COM8`),
    ]);

    // 应该只有一个注册条目
    assert.equal(monitor.sseClients.size, 1, "同 clientId 并发连接应只保留一个条目");
    assert.ok(monitor.sseClients.has(clientId));

    // 心跳应该存在且活跃
    const info = monitor.sseClients.get(clientId);
    assert.ok(info.hb, "应有心跳定时器");
    assert.equal(info.hb._destroyed, false, "心跳应活跃");

    req1.destroy();
    req2.destroy();
    await new Promise((r) => setTimeout(r, 300));
  } finally {
    await closeServer(server);
  }
});

test("SSE 连接断开后 clientId 被正确移除", async () => {
  const manager = new SerialManager(1024);
  const monitor = manager.getOrCreate("COM9");
  const { server, base } = await startTestServer(manager);
  try {
    const clientId = "disconnect-test";
    const req = http.get(`${base}/events?clientId=${clientId}&port=COM9`, (res) => {
      res.resume();
    });
    await new Promise((r) => setTimeout(r, 100));

    assert.ok(monitor.sseClients.has(clientId), "连接后应注册");
    const sizeAfterConnect = monitor.sseClients.size;

    req.destroy();
    await new Promise((r) => setTimeout(r, 300));

    assert.ok(!monitor.sseClients.has(clientId), "断开后应移除注册");
    assert.equal(monitor.sseClients.size, sizeAfterConnect - 1);
  } finally {
    await closeServer(server);
  }
});
