import * as http from "http";
import { exec } from "child_process";
import { WebSocketServer } from "ws";
import { SerialMonitor } from "./serial-monitor.js";
import { getViewerHTML } from "./viewer-html.js";
import { SerialPort } from "serialport";
import type { SendRequestBody, ConnectRequestBody } from "./types.js";

// ============================================================================
// 浏览器打开工具
// ============================================================================

let browserOpened = false;

/** 打开 URL：优先 VS Code Simple Browser，备用系统浏览器。仅打开一次。 */
export function openBrowser(url: string): boolean {
  if (browserOpened) {
    console.error(`[WebServer] 浏览器已打开，跳过: ${url}`);
    return false;
  }
  browserOpened = true;

  exec(`code --open-url "${url}"`, (err) => {
    if (!err) return; // VS Code 打开成功

    // 备用：系统默认浏览器
    const platform = process.platform;
    let command: string;
    if (platform === "win32") {
      command = `start "" "${url}"`;
    } else if (platform === "darwin") {
      command = `open "${url}"`;
    } else {
      command = `xdg-open "${url}"`;
    }
    exec(command, (err2) => {
      if (err2) {
        console.error(`[WebServer] 无法自动打开浏览器: ${err2.message}`);
      }
    });
  });
  return true;
}

// ============================================================================
// 控制权申请管理
// ============================================================================

/** 待处理的控制权申请: Map<requesterClientId, timeoutId> */
const pendingRequests = new Map<string, ReturnType<typeof setTimeout>>();

// ============================================================================
// Web 监视器服务器
// ============================================================================

export function startWebServer(
  port: number,
  monitor: SerialMonitor,
  autoOpenBrowser: boolean = false
): http.Server {
  const server = http.createServer((req, res) => {
    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    const host = req.headers.host || `localhost:${port}`;
    const url = new URL(req.url || "/", `http://${host}`);

    // POST /send — Web 终端发送命令
    if (req.method === "POST" && url.pathname === "/send") {
      handleSend(req, res, monitor);
      return;
    }

    // POST /connect — Web 终端连接串口
    if (req.method === "POST" && url.pathname === "/connect") {
      handleConnect(req, res, monitor);
      return;
    }

    // POST /disconnect — Web 终端断开串口
    if (req.method === "POST" && url.pathname === "/disconnect") {
      handleDisconnect(req, res, monitor);
      return;
    }

    // POST /request-control — 申请控制权
    if (req.method === "POST" && url.pathname === "/request-control") {
      handleRequestControl(req, res, monitor);
      return;
    }

    // POST /respond-control — 响应控制权申请
    if (req.method === "POST" && url.pathname === "/respond-control") {
      handleRespondControl(req, res, monitor);
      return;
    }

    // POST /force-control — 强制接管控制权
    if (req.method === "POST" && url.pathname === "/force-control") {
      handleForceControl(req, res, monitor);
      return;
    }

    // GET /events — SSE 实时数据流
    if (url.pathname === "/events") {
      handleSSE(req, res, monitor, url);
      return;
    }

    // GET /ports — 列出可用串口
    if (url.pathname === "/ports") {
      handleGetPorts(req, res);
      return;
    }

    // GET /status — 获取串口状态
    if (url.pathname === "/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(monitor.getStatus()));
      return;
    }

    // GET /
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(getViewerHTML());
      return;
    }

    // 404
    res.writeHead(404);
    res.end("Not Found");
  });

  // WebSocket — Xterm.js 真终端
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws, req) => {
    const name = (req.headers["user-agent"] || "ws").slice(0, 20);
    monitor.addWSClient(ws, name);
  });

  server.listen(port, () => {
    console.error(`[WebServer] 串口实时终端: http://localhost:${port}`);
    if (autoOpenBrowser) {
      openBrowser(`http://localhost:${port}`);
    }
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`[WebServer] 端口 ${port} 已被占用，Web 监视器未启动`);
      console.error(`[WebServer] 请设置环境变量 WEB_PORT 更换端口`);
    } else {
      console.error(`[WebServer] 启动失败: ${err.message}`);
    }
  });

  return server;
}

// ---- 工具函数 ----

/** 从请求体中解析 JSON */
function parseBody<T>(req: http.IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body) as T);
      } catch (e) {
        reject(new Error("无效的 JSON"));
      }
    });
    req.on("error", reject);
  });
}

/** 校验是否为控制端 */
function checkController(monitor: SerialMonitor, clientId: unknown): string | null {
  if (!clientId || typeof clientId !== "string") {
    return "缺少 clientId";
  }
  if (!monitor.isController(clientId)) {
    return "没有控制权限，当前为监视端";
  }
  return null; // OK
}

// ---- HTTP 处理函数 ----

/** GET /ports */
async function handleGetPorts(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  try {
    const ports = await SerialPort.list();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(ports));
  } catch (err) {
    const message = err instanceof Error ? err.message : "获取端口列表失败";
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: message }));
  }
}

/** POST /connect */
async function handleConnect(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  monitor: SerialMonitor
): Promise<void> {
  try {
    const body = await parseBody<ConnectRequestBody & { clientId?: string }>(req);
    // 串口未连接时，任何人都可以连接；已连接时只有控制端可以断开并重连
    if (monitor.isActive()) {
      const permErr = checkController(monitor, body.clientId);
      if (permErr) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: permErr }));
        return;
      }
    }
    if (!body.port || typeof body.port !== "string") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "缺少 port 参数" }));
      return;
    }
    const br = typeof body.baudRate === "number" && body.baudRate > 0 ? body.baudRate : 115200;
    await monitor.start(body.port, br);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, ...monitor.getStatus() }));
  } catch (err) {
    const message = err instanceof Error ? err.message : "连接失败";
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: message }));
  }
}

/** POST /disconnect */
async function handleDisconnect(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  monitor: SerialMonitor
): Promise<void> {
  try {
    const body = await parseBody<{ clientId?: string }>(req);
    // 无控制端(自动连接)或本人是控制端 → 允许断开
    if (monitor.controllerClientId && monitor.controllerClientId !== body.clientId) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "无权限: 需要控制端权限" }));
      return;
    }
    if (!monitor.isActive()) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, message: "串口未在运行中" }));
      return;
    }
    await monitor.stop();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  } catch (err) {
    const message = err instanceof Error ? err.message : "断开失败";
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: message }));
  }
}

/** POST /send */
function handleSend(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  monitor: SerialMonitor
): void {
  let body = "";
  req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
  req.on("end", async () => {
    try {
      const { command, lineEnding, clientId } = JSON.parse(body) as SendRequestBody & { clientId?: string };
      if (!command || typeof command !== "string") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "缺少 command 参数" }));
        return;
      }
      const le = typeof lineEnding === "string" ? lineEnding : "\n";
      // 流式写入 (空行尾) 不需要控制权；完整命令需要
      if (le !== "") {
        const permErr = checkController(monitor, clientId);
        if (permErr) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: permErr }));
          return;
        }
      }
      await monitor.sendRaw(command, le);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      const message = err instanceof Error ? err.message : "发送失败";
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: message }));
    }
  });
}

/** POST /request-control — 申请控制权 */
async function handleRequestControl(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  monitor: SerialMonitor
): Promise<void> {
  try {
    const body = await parseBody<{ clientId?: string }>(req);
    const clientId = body.clientId;
    if (!clientId || typeof clientId !== "string") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "缺少 clientId" }));
      return;
    }
    if (monitor.isController(clientId)) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, message: "已经是控制端" }));
      return;
    }
    const controller = monitor.controllerClientId;
    if (!controller) {
      // 没有控制端，直接提升
      monitor.setController(clientId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, message: "已自动成为控制端" }));
      return;
    }

    // 清除之前的待处理请求
    const prevTimeout = pendingRequests.get(clientId);
    if (prevTimeout) clearTimeout(prevTimeout);

    // 向当前控制端发送申请
    monitor.sendToClient(controller, "control-request", {
      requesterId: clientId,
      timestamp: Date.now(),
    });

    // 10 秒超时自动同意
    const timeoutId = setTimeout(() => {
      pendingRequests.delete(clientId);
      if (monitor.controllerClientId === controller) {
        monitor.setController(clientId);
        monitor.sendToClient(clientId, "control-response", {
          approved: true,
          autoApproved: true,
        });
      }
    }, 10000);
    pendingRequests.set(clientId, timeoutId);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, message: "已发送申请，等待控制端响应（10 秒超时自动同意）" }));
  } catch (err) {
    const message = err instanceof Error ? err.message : "申请失败";
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: message }));
  }
}

/** POST /respond-control — 控制端响应申请 */
async function handleRespondControl(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  monitor: SerialMonitor
): Promise<void> {
  try {
    const body = await parseBody<{ clientId?: string; requesterId?: string; approve?: boolean }>(req);
    const clientId = body.clientId;
    const requesterId = body.requesterId;
    const approve = body.approve === true;

    if (!clientId || !requesterId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "缺少参数" }));
      return;
    }
    if (!monitor.isController(clientId)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "只有控制端可以响应申请" }));
      return;
    }

    // 清除超时
    const timeoutId = pendingRequests.get(requesterId);
    if (timeoutId) {
      clearTimeout(timeoutId);
      pendingRequests.delete(requesterId);
    }

    if (approve) {
      monitor.setController(requesterId);
    }

    // 通知申请人
    monitor.sendToClient(requesterId, "control-response", {
      approved: approve,
      autoApproved: false,
    });

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, approved: approve }));
  } catch (err) {
    const message = err instanceof Error ? err.message : "响应失败";
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: message }));
  }
}

/** POST /force-control — 强制接管控制权 */
async function handleForceControl(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  monitor: SerialMonitor
): Promise<void> {
  try {
    const body = await parseBody<{ clientId?: string }>(req);
    const clientId = body.clientId;
    if (!clientId || typeof clientId !== "string") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "缺少 clientId" }));
      return;
    }
    if (monitor.isController(clientId)) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, message: "已经是控制端" }));
      return;
    }

    // 清除该申请人之前待处理的请求
    const timeoutId = pendingRequests.get(clientId);
    if (timeoutId) {
      clearTimeout(timeoutId);
      pendingRequests.delete(clientId);
    }

    monitor.setController(clientId);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, message: "已强制接管控制权" }));
  } catch (err) {
    const message = err instanceof Error ? err.message : "强制接管失败";
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: message }));
  }
}

/** GET /events — SSE 实时数据流 */
function handleSSE(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  monitor: SerialMonitor,
  url: URL
): void {
  const clientId = url.searchParams.get("clientId");
  if (!clientId) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("缺少 clientId 参数");
    return;
  }
  const name = url.searchParams.get("name") || "Anonymous";
  const ip = (req.socket.remoteAddress || "127.0.0.1").replace(/^::ffff:/, "");

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });

  res.write(": connected\n\n");
  monitor.addClient(clientId, res, name, ip);

  // 发送结构化状态事件
  const statusPayload = JSON.stringify(monitor.getStatus());
  res.write(`event: status\ndata: ${statusPayload}\n\n`);

  // 发送已有缓冲区数据
  const existingData = monitor.buffer.getAll();
  if (existingData) {
    res.write(
      `data: ${JSON.stringify({
        timestamp: Date.now(),
        text: existingData,
      })}\n\n`
    );
  }

  req.on("close", () => {
    monitor.removeClient(clientId);
  });
}
