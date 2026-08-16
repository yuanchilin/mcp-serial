import test from "node:test";
import assert from "node:assert/strict";
import { SerialManager } from "../build/serial-manager.js";
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

function jsonHeaders() {
  return { "Content-Type": "application/json", Connection: "close" };
}

async function api(base, path, options = {}) {
  return fetch(base + path, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Connection: "close",
    },
  });
}

function addSSEClient(manager, port, clientId) {
  const monitor = manager.getOrCreate(port);
  monitor.sseClients.set(clientId, {
    res: { write() {} },
    connectedAt: Date.now(),
    name: "test",
    ip: "127.0.0.1",
    lastSeen: Date.now(),
  });
}

test("GET /status 返回所有串口状态数组", async () => {
  const manager = new SerialManager(1024);
  const { server, base } = await startTestServer(manager);
  try {
    const res = await api(base, '/status');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body));
  } finally {
    await closeServer(server);
  }
});

test("GET /events 缺少 clientId 返回 400", async () => {
  const manager = new SerialManager(1024);
  const { server, base } = await startTestServer(manager);
  try {
    const res = await api(base, '/events');
    assert.equal(res.status, 400);
    assert.match(await res.text(), /缺少 clientId/);
  } finally {
    await closeServer(server);
  }
});

test("POST /send 缺少 port 返回 404", async () => {
  const manager = new SerialManager(1024);
  const { server, base } = await startTestServer(manager);
  try {
    const res = await fetch(`${base}/send`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ command: "AT" }),
    });
    assert.equal(res.status, 404);
  } finally {
    await closeServer(server);
  }
});

test("POST /send 已注册监视端不能发送 (403)", async () => {
  const manager = new SerialManager(1024);
  const monitor = manager.getOrCreate("COM3");
  monitor.controllerClientId = "ctrl-1";
  // monitor-1 已通过 SSE 注册为监视端（非控制端）
  monitor.sseClients.set("monitor-1", {
    res: { write() {} },
    connectedAt: Date.now(),
    name: "test",
    ip: "127.0.0.1",
    lastSeen: Date.now(),
  });
  monitor.serialPort = {
    isOpen: true,
    write(data, cb) { cb(); },
  };
  const { server, base } = await startTestServer(manager);
  try {
    const res = await fetch(`${base}/send`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ port: "COM3", command: "AT", clientId: "monitor-1" }),
    });
    assert.equal(res.status, 403);
  } finally {
    await closeServer(server);
  }
});

test("POST /send 全新 clientId 自动注册并接管后可以发送", async () => {
  const manager = new SerialManager(1024);
  const monitor = manager.getOrCreate("COM3");
  monitor.controllerClientId = "old-ctrl";
  monitor.serialPort = {
    isOpen: true,
    write(data, cb) {
      monitor.__written = (monitor.__written || "") + data.toString();
      cb();
    },
  };
  const { server, base } = await startTestServer(manager);
  try {
    const res = await fetch(`${base}/send`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ port: "COM3", command: "HI", clientId: "fresh-agent" }),
    });
    assert.equal(res.status, 200);
    assert.equal(monitor.controllerClientId, "fresh-agent");
    assert.equal(monitor.__written, "HI\n");
  } finally {
    await closeServer(server);
  }
});

test("POST /send 控制端可以发送", async () => {
  const manager = new SerialManager(1024);
  const monitor = manager.getOrCreate("COM3");
  monitor.controllerClientId = "ctrl-1";
  monitor.serialPort = {
    isOpen: true,
    write(data, cb) {
      monitor.__written = (monitor.__written || "") + data.toString();
      cb();
    },
  };
  const { server, base } = await startTestServer(manager);
  try {
    const res = await fetch(`${base}/send`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ port: "COM3", command: "AT", lineEnding: "\r\n", clientId: "ctrl-1" }),
    });
    assert.equal(res.status, 200);
    assert.equal(monitor.__written, "AT\r\n");
  } finally {
    await closeServer(server);
  }
});

test("POST /force-control 未建立 SSE 连接时返回 409", async () => {
  const manager = new SerialManager(1024);
  manager.getOrCreate("COM3").controllerClientId = "old-ctrl";
  const { server, base } = await startTestServer(manager);
  try {
    const res = await fetch(`${base}/force-control`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ port: "COM3", clientId: "no-sse" }),
    });
    assert.equal(res.status, 409);
    assert.match(await res.text(), /未注册/);
  } finally {
    await closeServer(server);
  }
});


test("POST /force-control 可以强制接管控制权", async () => {
  const manager = new SerialManager(1024);
  const monitor = manager.getOrCreate("COM3");
  monitor.controllerClientId = "old-ctrl";
  addSSEClient(manager, "COM3", "new-ctrl");
  const { server, base } = await startTestServer(manager);
  try {
    const res = await fetch(`${base}/force-control`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ port: "COM3", clientId: "new-ctrl" }),
    });
    assert.equal(res.status, 200);
    assert.equal(monitor.controllerClientId, "new-ctrl");
  } finally {
    await closeServer(server);
  }
});

test("POST /request-control 无控制端时自动成为控制端", async () => {
  const manager = new SerialManager(1024);
  const monitor = manager.getOrCreate("COM3");
  monitor.controllerClientId = null;
  addSSEClient(manager, "COM3", "req-1");
  const { server, base } = await startTestServer(manager);
  try {
    const res = await fetch(`${base}/request-control`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ port: "COM3", clientId: "req-1" }),
    });
    assert.equal(res.status, 200);
    assert.equal(monitor.controllerClientId, "req-1");
  } finally {
    await closeServer(server);
  }
});

test("POST /send 已注册 http-agent 刷新活跃时间（防 TTL 误清）", async () => {
  const manager = new SerialManager(1024);
  const monitor = manager.getOrCreate("COM3");
  monitor.registerClient("agent-1"); // 无连接注册, 自动成为控制端
  monitor.sseClients.get("agent-1").lastSeen = 0; // 拨回过去
  monitor.serialPort = { isOpen: true, write(_d, cb) { cb(); } };
  const { server, base } = await startTestServer(manager);
  try {
    const res = await fetch(`${base}/send`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ port: "COM3", command: "AT", clientId: "agent-1" }),
    });
    assert.equal(res.status, 200);
    assert.ok(monitor.sseClients.get("agent-1").lastSeen > 0, "/send 应刷新活跃时间");
  } finally {
    await closeServer(server);
  }
});

test("POST /request-control 向控制端发送 control-request SSE 事件", async () => {
  const manager = new SerialManager(1024);
  const monitor = manager.getOrCreate("COM3");

  // 模拟控制端 "ctrl-1"（浏览器 SSE 连接），捕获 write 调用以验证事件发送
  let sseWritten = null;
  const ctrlRes = {
    write(data) {
      sseWritten = data;
    },
  };
  monitor.sseClients.set("ctrl-1", {
    res: ctrlRes,
    connectedAt: Date.now(),
    name: "Browser",
    ip: "127.0.0.1",
    lastSeen: Date.now(),
  });
  monitor.controllerClientId = "ctrl-1";

  // 注册申请者 "req-1"（模拟另一个浏览器/agent 的 SSE 连接）
  addSSEClient(manager, "COM3", "req-1");

  const { server, base } = await startTestServer(manager);
  try {
    const res = await fetch(`${base}/request-control`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ port: "COM3", clientId: "req-1" }),
    });
    assert.equal(res.status, 200, "申请应返回 200");

    // 验证 control-request SSE 事件已发送到控制端
    assert.ok(sseWritten, "应发送 SSE 事件到控制端");
    assert.ok(
      sseWritten.includes("event: control-request"),
      `SSE 事件应包含 event: control-request，实际: ${sseWritten}`
    );
    assert.ok(
      sseWritten.includes("requesterId"),
      `应包含 requesterId，实际: ${sseWritten}`
    );
    assert.ok(
      sseWritten.includes("req-1"),
      `应包含申请者 req-1，实际: ${sseWritten}`
    );
  } finally {
    await closeServer(server);
  }
});
