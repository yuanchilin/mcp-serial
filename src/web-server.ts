import * as http from "http";
import { exec } from "child_process";
import { readFileSync } from "fs";
import { extname, join, dirname, normalize, sep } from "path";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";
import { SerialManager } from "./serial-manager.js";
import type { SerialMonitor } from "./serial-monitor.js";
import { getViewerHTML, getTerminalHTML } from "./viewer-html.js";
import { SerialPort } from "serialport";
import type { SendRequestBody, ConnectRequestBody } from "./types.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import type { Server as MCPServer } from "@modelcontextprotocol/sdk/server/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const VENDOR_DIR = join(__dirname, "vendor");

/** POST 请求体大小上限 (64KB)，防止内存 DoS */
const MAX_BODY_SIZE = 64 * 1024;

/** MCP Server 工厂：由 index.ts 提供，SSE 端点用它创建 Server 实例 */
export type MCPServerFactory = (manager: SerialManager, version: string) => MCPServer;

/** MCP over SSE 会话表 (sessionId -> transport) */
const sseTransports = new Map<string, SSEServerTransport>();

// ============================================================================
// 可选鉴权 (SERIAL_WEB_TOKEN)
// ============================================================================

/**
 * 校验请求是否携带访问令牌。未设置 SERIAL_WEB_TOKEN 时放行所有请求（默认行为）。
 * 令牌可通过 `Authorization: Bearer <token>` 头或 `?token=<token>` 查询参数传递。
 */
function authOK(req: http.IncomingMessage): boolean {
  const token = process.env.SERIAL_WEB_TOKEN || "";
  if (!token) return true;
  if (req.headers.authorization === `Bearer ${token}`) return true;
  try {
    const u = new URL(req.url || "/", "http://localhost");
    return u.searchParams.get("token") === token;
  } catch {
    return false;
  }
}

/** 统一错误响应：支持带 statusCode 的异常（如请求体过大 413） */
function sendError(res: http.ServerResponse, err: unknown, overrideCode?: number): void {
  const code =
    overrideCode ??
    (err && typeof err === "object" && "statusCode" in err && typeof (err as { statusCode?: unknown }).statusCode === "number"
      ? ((err as { statusCode: number }).statusCode)
      : 500);
  const message = err instanceof Error ? err.message : "服务器错误";
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: message }));
}

// ============================================================================
// 浏览器打开工具
// ============================================================================

/** 已打开浏览器的 URL 集合（按 URL 去重，避免多实例共享标志导致误跳过） */
const openedUrls = new Set<string>();

/** 打开 URL：优先 VS Code Simple Browser，备用系统浏览器。同一 URL 仅打开一次。 */
export function openBrowser(url: string): boolean {
  if (openedUrls.has(url)) {
    console.error(`[WebServer] 浏览器已打开，跳过: ${url}`);
    return false;
  }
  openedUrls.add(url);

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

/** 待处理的控制权申请: Map<"port:clientId", timeoutId> (按端口隔离) */
const pendingRequests = new Map<string, ReturnType<typeof setTimeout>>();

// ============================================================================
// Web 监视器服务器
// ============================================================================

export function startWebServer(
  port: number,
  manager: SerialManager,
  autoOpenBrowser: boolean = false,
  host: string = "0.0.0.0",
  mcpFactory?: MCPServerFactory,
  mcpVersion?: string
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

    // MCP over SSE 传输端点（独立于 Web 鉴权；由 MCP 客户端经传输层连接）
    const rawPath = (req.url || "/").split("?")[0];
    if (rawPath === "/mcp/sse") {
      handleMCPSse(req, res, manager, mcpFactory, mcpVersion);
      return;
    }
    if (req.method === "POST" && rawPath === "/mcp/message") {
      handleMCPMessage(req, res);
      return;
    }

    // 可选令牌校验：所有写操作 (POST) 均要求授权
    if (req.method === "POST" && !authOK(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "未授权: 缺少或错误的 SERIAL_WEB_TOKEN" }));
      return;
    }

    const host = req.headers.host || `localhost:${port}`;
    const url = new URL(req.url || "/", `http://${host}`);

    // POST /send — Web 终端发送命令
    if (req.method === "POST" && url.pathname === "/send") {
      handleSend(req, res, manager);
      return;
    }

    // POST /connect — Web 终端连接串口
    if (req.method === "POST" && url.pathname === "/connect") {
      handleConnect(req, res, manager);
      return;
    }

    // POST /disconnect — Web 终端断开串口
    if (req.method === "POST" && url.pathname === "/disconnect") {
      handleDisconnect(req, res, manager);
      return;
    }

    // POST /request-control — 申请控制权
    if (req.method === "POST" && url.pathname === "/request-control") {
      handleRequestControl(req, res, manager);
      return;
    }

    // POST /respond-control — 响应控制权申请
    if (req.method === "POST" && url.pathname === "/respond-control") {
      handleRespondControl(req, res, manager);
      return;
    }

    // POST /force-control — 强制接管控制权
    if (req.method === "POST" && url.pathname === "/force-control") {
      handleForceControl(req, res, manager);
      return;
    }

    // GET /events — SSE 实时数据流
    if (url.pathname === "/events") {
      handleSSE(req, res, manager, url);
      return;
    }

    // GET /ports — 列出可用串口
    if (url.pathname === "/ports") {
      handleGetPorts(req, res);
      return;
    }

    // GET /status — 获取串口状态
    if (url.pathname === "/status") {
      const portParam = url.searchParams.get("port");
      if (portParam) {
        const m = manager.get(portParam);
        if (!m) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `串口 ${portParam} 不存在` }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(m.getStatus()));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(manager.getStatus()));
      return;
    }

    // GET /
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(getViewerHTML());
      return;
    }

    // GET /viewer.html — 单串口终端页（多串口分屏 iframe 使用）
    if (url.pathname === "/viewer.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(getTerminalHTML());
      return;
    }


    // GET /vendor/* — 本地静态资源（xterm 等）
    if (url.pathname.startsWith("/vendor/")) {
      const relative = url.pathname.slice("/vendor/".length);
      const filePath = normalize(join(VENDOR_DIR, relative));
      if (!filePath.startsWith(VENDOR_DIR + sep) && filePath !== VENDOR_DIR) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }
      try {
        const content = readFileSync(filePath);
        const ext = extname(filePath).toLowerCase();
        const mime = ext === ".css" ? "text/css" : ext === ".js" || ext === ".mjs" ? "application/javascript" : "application/octet-stream";
        res.writeHead(200, { "Content-Type": mime });
        res.end(content);
      } catch {
        res.writeHead(404);
        res.end("Not Found");
      }
      return;
    }

    // 404
    res.writeHead(404);
    res.end("Not Found");
  });

  // WebSocket — Xterm.js 真终端
  const wss = new WebSocketServer({ server });
  // 端口被占用等错误不应导致进程崩溃（MCP stdio 通道必须保持可用）
  wss.on("error", (err: NodeJS.ErrnoException) => {
    console.error(`[WebServer] WebSocket 服务不可用（${err.message}），仅 MCP stdio 模式运行`);
  });
  wss.on("connection", (ws, req) => {
    if (!authOK(req)) {
      ws.close(4001, "unauthorized");
      return;
    }
    const name = (req.headers["user-agent"] || "ws").slice(0, 20);
    const url = new URL(req.url || "/", "http://localhost");
    const clientId = url.searchParams.get("clientId") || undefined;
    const port = url.searchParams.get("port");
    if (!port) {
      ws.close();
      return;
    }
    const monitor = manager.getOrCreate(port);
    monitor.addWSClient(ws, name, clientId);
  });

  server.listen(port, host, () => {
    const addr = server.address();
    const actualPort = typeof addr === "object" && addr ? addr.port : port;
    console.error(`[WebServer] 串口实时终端: http://localhost:${actualPort}`);
    if (autoOpenBrowser) {
      openBrowser(`http://localhost:${actualPort}`);
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

/** 从请求体中解析 JSON（带大小上限，超限返回 413） */
function parseBody<T>(req: http.IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let body = "";
    let tooBig = false;
    req.on("data", (chunk: Buffer) => {
      if (tooBig) return; // 超限后丢弃后续数据，等待 end 返回 413
      body += chunk.toString();
      if (body.length > MAX_BODY_SIZE) {
        tooBig = true;
        body = "";
      }
    });
    req.on("error", () => {
      reject(
        tooBig
          ? Object.assign(new Error("请求体过大"), { statusCode: 413 })
          : new Error("请求中断")
      );
    });
    req.on("end", () => {
      if (tooBig) {
        reject(Object.assign(new Error("请求体过大"), { statusCode: 413 }));
        return;
      }
      try {
        resolve(JSON.parse(body) as T);
      } catch (e) {
        reject(new Error("无效的 JSON"));
      }
    });
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

/** 从请求体中读取 port 并获取对应监视器 */
function getMonitor(manager: SerialManager, port: unknown): SerialMonitor | undefined {
  if (!port || typeof port !== "string") return undefined;
  return manager.get(port);
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
  manager: SerialManager
): Promise<void> {
  try {
    const body = await parseBody<ConnectRequestBody & { clientId?: string }>(req);
    if (!body.port || typeof body.port !== "string") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "缺少 port 参数" }));
      return;
    }
    const monitor = manager.getOrCreate(body.port);
    // 串口未连接时任何人都可以连接；已连接时仅控制端可断开重连。
    // 无控制端（如 SERIAL_AUTO_CONNECT 自动打开）时放行，与 /disconnect 逻辑一致。
    if (monitor.isActive() && monitor.controllerClientId) {
      const permErr = checkController(monitor, body.clientId);
      if (permErr) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: permErr }));
        return;
      }
    }
    const br = typeof body.baudRate === "number" && body.baudRate > 0 ? body.baudRate : 115200;
    await monitor.start(body.port, br);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, ...monitor.getStatus() }));
  } catch (err) {
    sendError(res, err);
  }
}

/** POST /disconnect */
async function handleDisconnect(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  manager: SerialManager
): Promise<void> {
  try {
    const body = await parseBody<{ port?: string; clientId?: string }>(req);
    const monitor = getMonitor(manager, body.port);
    if (!monitor) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "串口不存在" }));
      return;
    }
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
    sendError(res, err);
  }
}

/** POST /send */
async function handleSend(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  manager: SerialManager
): Promise<void> {
  try {
    const parsed = await parseBody<SendRequestBody & { clientId?: string; port?: string }>(req);
    const monitor = getMonitor(manager, parsed.port);
    if (!monitor) {
      sendError(res, new Error("串口不存在，请先连接"), 404);
      return;
    }
    const { command, lineEnding, clientId } = parsed;
    // 先做参数校验，再产生注册/接管副作用
    if (!command || typeof command !== "string") {
      sendError(res, new Error("缺少 command 参数"), 400);
      return;
    }
    if (!monitor.isActive()) {
      // 串口未打开：直接 500，不注册任何客户端（避免失败请求留下幽灵控制端）
      sendError(res, new Error("串口未打开，请先连接"), 500);
      return;
    }
    const reqIp = (req.socket.remoteAddress || "127.0.0.1").replace(/^::ffff:/, "");
    // 自动注册 + 接管: 脚本/agent 无需预开 SSE 长连接即可发送
    if (clientId && typeof clientId === "string") {
      if (!monitor.isController(clientId) && !monitor.isRegistered(clientId)) {
        monitor.registerClient(clientId, "http-agent", reqIp);
        monitor.setController(clientId); // 立即接管, 否则 checkController 仍 403
      } else if (monitor.isRegistered(clientId)) {
        monitor.touchClient(clientId); // 刷新活跃时间, 防止被 TTL 误清
      }
    }
    // 所有写入都要求控制端权限，防止监视端向串口发送数据
    const permErr = checkController(monitor, clientId);
    if (permErr) {
      sendError(res, new Error(permErr), 403);
      return;
    }
    const le = typeof lineEnding === "string" ? lineEnding : "\n";
    await monitor.sendRaw(command, le);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  } catch (err) {
    sendError(res, err);
  }
}

/** POST /request-control — 申请控制权 */
async function handleRequestControl(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  manager: SerialManager
): Promise<void> {
  try {
    const body = await parseBody<{ port?: string; clientId?: string }>(req);
    if (!body.port || typeof body.port !== "string") {
      sendError(res, new Error("缺少 port 参数"), 400);
      return;
    }
    const monitor = getMonitor(manager, body.port);
    if (!monitor) {
      sendError(res, new Error(`串口 ${body.port} 不存在`), 404);
      return;
    }
    const clientId = body.clientId;
    if (!clientId || typeof clientId !== "string") {
      sendError(res, new Error("缺少 clientId"), 400);
      return;
    }
    // 前置校验：未注册的 clientId 直接 409，避免 10 秒后向已结束的响应写数据导致进程崩溃
    if (!monitor.isRegistered(clientId)) {
      sendError(res, new Error("客户端未建立 SSE 连接，无法成为控制端"), 409);
      return;
    }
    if (monitor.isController(clientId)) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, message: "已经是控制端" }));
      return;
    }
    const controller = monitor.controllerClientId;
    if (!controller) {
      // 没有控制端，直接提升（已通过上面的注册校验）
      const ok = monitor.setController(clientId);
      if (!ok) {
        sendError(res, new Error("客户端未建立 SSE 连接，无法成为控制端"), 409);
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, message: "已自动成为控制端" }));
      return;
    }

    // 待处理请求按 port+clientId 隔离（不同串口互不干扰）
    const reqKey = `${body.port}:${clientId}`;
    // 清除之前的待处理请求
    const prevTimeout = pendingRequests.get(reqKey);
    if (prevTimeout) clearTimeout(prevTimeout);

    // 向当前控制端发送申请
    console.error(`[handleRequestControl] port=${body.port} requester=${clientId.slice(0,8)} controller=${controller.slice(0,8)} sseClients=${monitor.sseClients.size}`);
    monitor.sendToClient(controller, "control-request", {
      requesterId: clientId,
      timestamp: Date.now(),
    });

    // 10 秒超时自动同意（回调只改状态 + SSE 通知，绝不写已结束的 HTTP 响应）
    const timeoutId = setTimeout(() => {
      pendingRequests.delete(reqKey);
      if (monitor.controllerClientId === controller) {
        const ok = monitor.setController(clientId);
        if (ok) {
          monitor.sendToClient(clientId, "control-response", {
            approved: true,
            autoApproved: true,
          });
        }
      }
    }, 10000);
    pendingRequests.set(reqKey, timeoutId);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, message: "已发送申请，等待控制端响应（10 秒超时自动同意）" }));
  } catch (err) {
    sendError(res, err);
  }
}

/** POST /respond-control — 控制端响应申请 */
async function handleRespondControl(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  manager: SerialManager
): Promise<void> {
  try {
    const body = await parseBody<{ port?: string; clientId?: string; requesterId?: string; approve?: boolean }>(req);
    const monitor = getMonitor(manager, body.port);
    if (!monitor) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "串口不存在" }));
      return;
    }
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

    // 清除超时（按 port+requesterId 隔离）
    const reqKey = `${body.port}:${requesterId}`;
    const timeoutId = pendingRequests.get(reqKey);
    if (timeoutId) {
      clearTimeout(timeoutId);
      pendingRequests.delete(reqKey);
    }

    if (approve) {
      const ok = monitor.setController(requesterId);
        if (!ok) {
          sendError(res, new Error("申请人未建立 SSE 连接，无法授予控制权"), 409);
          return;
        }
    }

    // 通知申请人
    monitor.sendToClient(requesterId, "control-response", {
      approved: approve,
      autoApproved: false,
    });

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, approved: approve }));
  } catch (err) {
    sendError(res, err);
  }
}

/** POST /force-control — 强制接管控制权 */
async function handleForceControl(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  manager: SerialManager
): Promise<void> {
  try {
    const body = await parseBody<{ port?: string; clientId?: string }>(req);
    if (!body.port || typeof body.port !== "string") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "缺少 port 参数" }));
      return;
    }
    const monitor = getMonitor(manager, body.port);
    if (!monitor) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `串口 ${body.port} 不存在` }));
      return;
    }
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

    // 清除该申请人之前待处理的请求（按 port+clientId 隔离）
    const reqKey = `${body.port}:${clientId}`;
    const timeoutId = pendingRequests.get(reqKey);
    if (timeoutId) {
      clearTimeout(timeoutId);
      pendingRequests.delete(reqKey);
    }

    const ok = monitor.setController(clientId);
      if (!ok) {
        sendError(res, new Error("clientId 未注册 (需先连 /events 或 /send 自动注册)"), 409);
        return;
      }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, message: "已强制接管控制权" }));
  } catch (err) {
    sendError(res, err);
  }
}

/** GET /events — SSE 实时数据流 */
function handleSSE(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  manager: SerialManager,
  url: URL
): void {
  if (!authOK(req)) {
    res.writeHead(401, { "Content-Type": "text/plain" });
    res.end("Unauthorized");
    return;
  }
  const clientId = url.searchParams.get("clientId");
  const port = url.searchParams.get("port");
  if (!clientId) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("缺少 clientId 参数");
    return;
  }
  if (!port) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("缺少 port 参数");
    return;
  }
  const name = url.searchParams.get("name") || "Anonymous";
  const ip = (req.socket.remoteAddress || "127.0.0.1").replace(/^::ffff:/, "");
  const monitor = manager.getOrCreate(port);

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });

  res.write(": connected\n\n");
  const info = monitor.addClient(clientId, res, name, ip);

  // 心跳：定期发送注释行，防止代理/NAT 静默断开空闲 SSE 连接
  const hb = setInterval(() => {
    try { res.write(": ping\n\n"); } catch { /* 连接已断开 */ }
  }, 20000);
  info.hb = hb;

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
    const cur = monitor.sseClients.get(clientId);
    // 只有当前条目仍属于本连接时才清理：同 clientId 重连后，旧连接的 close 不得误清新连接的心跳/条目
    if (cur && cur.res === res) {
      if (cur.hb) clearInterval(cur.hb);
      monitor.removeClient(clientId, res);
    }
  });
}

// ============================================================================
// MCP over SSE — 远程传输端点 (从 feat/sse-remote-access 移植, 适配多串口)
// ============================================================================

/** GET /mcp/sse — 建立 SSE 连接，创建 MCP Server 实例 */
function handleMCPSse(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  manager: SerialManager,
  factory?: MCPServerFactory,
  version?: string
): void {
  if (!factory) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("MCP over SSE not available");
    return;
  }

  const transport = new SSEServerTransport("/mcp/message", res);
  const server = factory(manager, version || "2.5.0");

  transport.onclose = () => {
    sseTransports.delete(transport.sessionId);
    server.close().catch(() => {});
  };

  sseTransports.set(transport.sessionId, transport);
  server.connect(transport).catch((err: Error) => {
    console.error("[MCP-SSE] connect error:", err);
  });
}

/** POST /mcp/message — 接收 MCP 客户端消息并路由到对应会话 */
function handleMCPMessage(req: http.IncomingMessage, res: http.ServerResponse): void {
  let sessionId: string | null = null;
  try {
    sessionId = new URL(req.url || "/", "http://localhost").searchParams.get("sessionId");
  } catch {
    sessionId = null;
  }
  if (!sessionId || !sseTransports.has(sessionId)) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Session not found");
    return;
  }

  const transport = sseTransports.get(sessionId)!;
  transport.handlePostMessage(req, res).catch((err: Error) => {
    console.error("[MCP-SSE] handlePostMessage error:", err);
  });
}
