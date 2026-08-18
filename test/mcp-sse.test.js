// ============================================================================
//  MCP over SSE 端点测试（多串口线移植自 feat/sse-remote-access）
//  覆盖：SSE 握手 / 会话注册 / 消息路由 404 —— 防端点回归
// ============================================================================
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { SerialManager } from "../build/serial-manager.js";
import { startWebServer } from "../build/web-server.js";
import { createMCPServer } from "../build/index.js"; // isMain 守卫下 import 无副作用

async function startSSEServer() {
  const manager = new SerialManager(1024);
  const server = startWebServer(0, manager, false, "127.0.0.1", createMCPServer, "2.5.0");
  await new Promise((r) => server.once("listening", r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function closeServer(server) {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
}

/** 读取 SSE 响应的第一条数据（endpoint 握手消息） */
function readFirstChunk(res) {
  return new Promise((resolve) => {
    res.on("data", (c) => resolve(c.toString()));
  });
}

test("GET /mcp/sse 返回 SSE 握手 (event: endpoint + sessionId)", async () => {
  const { server, base } = await startSSEServer();
  try {
    const res = await new Promise((resolve, reject) => {
      const req = http.get(`${base}/mcp/sse`, (r) => resolve(r));
      req.on("error", reject);
    });
    assert.equal(res.statusCode, 200, "应返回 200");
    assert.match(res.headers["content-type"] || "", /text\/event-stream/, "应返回 SSE 内容类型");

    const chunk = await readFirstChunk(res);
    assert.match(chunk, /event: endpoint/, "应发送 endpoint 事件");
    assert.match(chunk, /sessionId=/, "应携带 sessionId");
    assert.match(chunk, /\/mcp\/message/, "endpoint 应指向 message 端点");

    res.destroy();
  } finally {
    await closeServer(server);
  }
});

test("POST /mcp/message 无 sessionId 返回 404", async () => {
  const { server, base } = await startSSEServer();
  try {
    const res = await fetch(`${base}/mcp/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Connection: "close" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    });
    assert.equal(res.status, 404, "无有效 sessionId 应 404");
  } finally {
    await closeServer(server);
  }
});

test("POST /mcp/message 伪造 sessionId 返回 404", async () => {
  const { server, base } = await startSSEServer();
  try {
    const res = await fetch(`${base}/mcp/message?sessionId=fake-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Connection: "close" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    assert.equal(res.status, 404, "伪造 sessionId 应 404");
  } finally {
    await closeServer(server);
  }
});
