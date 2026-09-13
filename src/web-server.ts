import * as http from "http";
import * as os from "os";
import { exec } from "child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { WebSocketServer } from "ws";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import type { McpServer } from "@modelcontextprotocol/server";
import { SerialMonitor } from "./serial-monitor.js";
import { getViewerHTML } from "./viewer-html.js";
import { SerialPort } from "serialport";
import type { SendRequestBody, ConnectRequestBody } from "./types.js";

// ============================================================================
// MCP Server 工厂类型
// ============================================================================
type MCPServerFactory = (monitor: SerialMonitor, version: string) => McpServer;

// ============================================================================
// 安全 / 健壮性 公共工具
// ============================================================================

/** 请求体上限：64KB，超限返回 413，防止内存耗尽 DoS */
const MAX_BODY_BYTES = 64 * 1024;

/** 文件分块上限：1MB（前端默认 16KB/块，这里仅作防御） */
const MAX_FILE_CHUNK_BYTES = 1024 * 1024;

/** 带 HTTP 状态码的错误，便于统一错误处理 */
class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

/** 读取已配置的可选访问令牌（默认空 = 关闭鉴权，向后兼容） */
function getConfiguredToken(): string {
  return process.env.SERIAL_WEB_TOKEN || "";
}

/**
 * 校验请求是否通过令牌鉴权。
 * - 未配置 SERIAL_WEB_TOKEN：始终放行（向后兼容）。
 * - 已配置：需携带 `Authorization: Bearer <token>` 或 `?token=<token>`。
 */
function tokenValid(req: http.IncomingMessage, url: URL): boolean {
  const t = getConfiguredToken();
  if (!t) return true;
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    if (auth.slice(7) === t) return true;
  }
  const q = url.searchParams.get("token");
  if (q && q === t) return true;
  return false;
}

// ============================================================================
// 远程访问密码认证（SERIAL_WEB_PASSWORD）
//  - 本机(回环)访问免密；远程访问需密码（登录后发会话令牌，sessionStorage 关标签失效）
//  - 未设密码（env 空且未手动输入）→ 免密模式，一切开放（现状行为）
// ============================================================================

/** 本次运行的访问密码（env 或启动时手动输入，index.ts 传入）；空 = 免密模式 */
let WEB_PASSWORD = process.env.SERIAL_WEB_PASSWORD || "";

/** 登录会话: token -> 过期时间戳 */
const sessions = new Map<string, number>();
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 小时上限（sessionStorage 关标签即失效为主）

/** 设置访问密码（启动时手动输入后调用） */
export function setWebPassword(p: string): void {
  WEB_PASSWORD = p || "";
}

/** 是否为本机（回环）来源 */
function isLocal(req: http.IncomingMessage): boolean {
  const addr = (req.socket.remoteAddress || "").replace(/^::ffff:/, "");
  return addr === "127.0.0.1" || addr === "::1" || addr === "localhost";
}

/** 校验登录会话令牌是否有效 */
function sessionValid(token: string | null): boolean {
  if (!token) return false;
  const exp = sessions.get(token);
  if (!exp) return false;
  if (Date.now() > exp) { sessions.delete(token); return false; }
  return true;
}

/** 认证总入口：本机免密 / token 放行 / 密码模式远程需会话 */
function authPass(req: http.IncomingMessage, url: URL): boolean {
  if (isLocal(req)) return true; // 本机免密
  // 配置了 SERIAL_WEB_TOKEN 才校验（未配置不拦截）
  const t = getConfiguredToken();
  if (t) {
    const auth = req.headers["authorization"];
    if (typeof auth === "string" && auth.startsWith("Bearer ") && auth.slice(7) === t) return true;
    if (url.searchParams.get("token") === t) return true;
  }
  if (!WEB_PASSWORD) return true; // 免密模式（无密码开放）
  return sessionValid(url.searchParams.get("session")); // 密码模式远程需会话
}

/** 生成一次性登录会话令牌 */
function createSession(): string {
  const t = randomUUID();
  sessions.set(t, Date.now() + SESSION_TTL_MS);
  return t;
}

/** 远程无会话时的登录页（深色极简，与终端风格一致） */
function loginPageHtml(): string {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<title>串口终端 · 授权访问</title>
<style>
body{background:#000;color:#ccc;font:14px Consolas,monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{background:#161616;border:1px solid #333;padding:36px 44px;border-radius:8px;width:320px}
h1{font-size:15px;color:#4caf50;margin:0 0 20px}
label{display:block;color:#888;font-size:12px;margin-bottom:6px}
input{width:100%;box-sizing:border-box;background:#000;color:#ccc;border:1px solid #444;padding:8px 10px;font:inherit;margin-bottom:16px;border-radius:4px}
button{width:100%;background:#2d5a2d;color:#fff;border:none;padding:9px;font:inherit;border-radius:4px;cursor:pointer}
button:hover{background:#3a7a3a}
.err{color:#f66;font-size:12px;margin-top:10px;display:none}
</style></head>
<body><div class="card">
<h1>🔒 串口终端 · 授权访问</h1>
<label>访问密码</label>
<input type="password" id="pwd" placeholder="请输入密码" autofocus>
<button id="btn">登录</button>
<div class="err" id="err">密码错误，请重试</div>
</div>
<script>
const pwd=document.getElementById('pwd'),btn=document.getElementById('btn'),err=document.getElementById('err');
async function login(){
  if(!pwd.value)return;
  const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({pwd:pwd.value})});
  if(r.ok){const d=await r.json();sessionStorage.setItem('mcpSerialSession',d.session);
    location.href='/?session='+encodeURIComponent(d.session);}
  else{err.style.display='block';pwd.value='';pwd.focus();}
}
btn.onclick=login;pwd.addEventListener('keydown',e=>{if(e.key==='Enter')login();});
</script></body></html>`;
}

/** POST /api/login — 比对密码，成功发会话令牌 */
function handleLogin(req: http.IncomingMessage, res: http.ServerResponse): void {
  parseBody<{ pwd?: string }>(req)
    .then(({ pwd }) => {
      if (pwd && pwd === WEB_PASSWORD) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, session: createSession() }));
      } else {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "密码错误" }));
      }
    })
    .catch((e) => sendError(res, e));
}

/** 读取请求体原始文本，超过 MAX_BODY_BYTES 抛 HttpError(413) */
function readBodyRaw(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let body = "";
    let aborted = false;
    req.on("data", (chunk: Buffer) => {
      if (aborted) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        reject(new HttpError(413, "请求体过大（上限 64KB）"));
        // 注意：不要在发送 413 前 destroy 套接字，否则响应无法送达
        return;
      }
      body += chunk.toString();
    });
    req.on("end", () => { if (!aborted) resolve(body); });
    req.on("error", (e) => { if (!aborted) reject(e); });
  });
}

/** 解析 JSON 请求体（复用读取上限）；解析失败抛 HttpError(400) */
async function parseBody<T>(req: http.IncomingMessage): Promise<T> {
  const raw = await readBodyRaw(req);
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new HttpError(400, "无效的 JSON");
  }
}

/** 读取原始字节请求体（用于文件传输，二进制安全），超过 limit 抛 HttpError(413) */
function readRawBytes(req: http.IncomingMessage, limit = MAX_FILE_CHUNK_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on("data", (chunk: Buffer) => {
      if (aborted) return;
      size += chunk.length;
      if (size > limit) {
        aborted = true;
        reject(new HttpError(413, `请求体过大（上限 ${Math.round(limit / 1024)}KB）`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => { if (!aborted) resolve(Buffer.concat(chunks)); });
    req.on("error", (e) => { if (!aborted) reject(e); });
  });
}

/** 统一错误响应：HttpError 用其状态码，其余按 500 */
function sendError(res: http.ServerResponse, err: unknown): void {
  const status = err instanceof HttpError ? err.status : 500;
  const message = err instanceof Error ? err.message : "失败";
  if (!res.headersSent) {
    res.writeHead(status, { "Content-Type": "application/json" });
  }
  res.end(JSON.stringify({ error: message }));
}

// ============================================================================
// SSE MCP 传输会话管理
// ============================================================================
/** MCP Streamable HTTP 会话表：sessionId → transport（v2 已无 legacy SSE 传输） */
const httpTransports = new Map<string, NodeStreamableHTTPServerTransport>();

// ============================================================================
// 浏览器打开工具
// ============================================================================

let browserOpened = false;

/** 打开 URL：使用系统默认浏览器。仅当显式设置 WEB_AUTO_OPEN=true 或调用 open_web_monitor 工具时触发；启动时默认不打开。 */
export function openBrowser(url: string): boolean {
  if (browserOpened) {
    console.error(`[WebServer] 浏览器已打开，跳过: ${url}`);
    return false;
  }
  browserOpened = true;

  // 不再使用 `code --open-url`（新版 VS Code 中该参数是布尔开关、不接受 URL，
  // 只会弹出空窗口且退出码为 0，导致默认浏览器兜底永远不执行）。
  // 直接用系统默认浏览器。
  const platform = process.platform;
  let command: string;
  if (platform === "win32") {
    command = `start "" "${url}"`;
  } else if (platform === "darwin") {
    command = `open "${url}"`;
  } else {
    command = `xdg-open "${url}"`;
  }
  exec(command, (err) => {
    if (err) {
      console.error(`[WebServer] 无法自动打开浏览器: ${err.message}`);
    }
  });
  return true;
}

// ============================================================================
// 局域网 IP 检测
// ============================================================================

/** 获取本机局域网 IPv4 地址列表 */
export function getLanIPs(): string[] {
  const Result: string[] = [];
  const Interfaces = os.networkInterfaces();
  for (const Name of Object.keys(Interfaces)) {
    const Ifaces = Interfaces[Name];
    if (!Ifaces) continue;
    for (const Iface of Ifaces) {
      if (Iface.family === "IPv4" && !Iface.internal) {
        Result.push(Iface.address);
      }
    }
  }
  return Result;
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
  autoOpenBrowser: boolean = false,
  mcpServerFactory?: MCPServerFactory,
  appVersion?: string,
  onStarted?: (actualPort: number) => void,
  password?: string
): http.Server {
  if (password !== undefined) WEB_PASSWORD = password; // 启动时手动输入可覆盖
  const server = http.createServer((req, res) => {
    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    const host = req.headers.host || `localhost:${port}`;
    const url = new URL(req.url || "/", `http://${host}`);

    // POST /api/login — 远程登录（密码比对，成功发会话令牌）[免认证]
    if (req.method === "POST" && url.pathname === "/api/login") {
      handleLogin(req, res);
      return;
    }

    // 认证：本机免密 / token 放行 / 密码模式远程需会话
    if (!authPass(req, url)) {
      const wantsPage = req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html");
      if (wantsPage && WEB_PASSWORD) {
        res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
        res.end(loginPageHtml());
      } else {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "未授权：远程访问需要密码登录" }));
      }
      return;
    }

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

    // POST /send-file — 浏览器上传文件原始字节（二进制安全）
    if (req.method === "POST" && url.pathname === "/send-file") {
      handleSendFile(req, res, monitor, url);
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

    // ====================================================================
    // MCP over Streamable HTTP — 远程 MCP 客户端连接（SDK v2；POST/GET/DELETE 同一端点）
    // ====================================================================

    // /mcp — Streamable HTTP：POST 发消息、GET 收流、DELETE 结束会话
    if (url.pathname === "/mcp" || url.pathname === "/mcp/") {
      handleMCPHttp(req, res, monitor, mcpServerFactory, appVersion).catch((err: Error) => {
        console.error("[MCP-HTTP] error:", err);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // 旧 legacy SSE 端点：已随 SDK v2 移除，给出明确迁移提示（而不是静默 404）
    if (url.pathname === "/mcp/sse" || url.pathname === "/mcp/message") {
      res.writeHead(410, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        error: "legacy HTTP+SSE 传输已移除（SDK v2 起改由 Streamable HTTP 提供）",
        use: `http://${host}/mcp`,
      }));
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

    // GET /vendor/xterm.js|css — 本地前端资源（离线可用）
    if (url.pathname.startsWith("/vendor/")) {
      handleVendorAsset(res, url.pathname.slice("/vendor/".length));
      return;
    }

    // GET /
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache, no-store, must-revalidate" });
      res.end(getViewerHTML());
      return;
    }

    // 404
    res.writeHead(404);
    res.end("Not Found");
  });

  // WebSocket — Xterm.js 真终端
  const wss = new WebSocketServer({ server });
  // http server 的 EADDRINUSE 由下方 error 处理担当（端口回退）；
  // wss attach 同一 server，listen 失败时 ws 库也会向 wss emit error，这里吞掉避免未捕获崩溃
  wss.on("error", (err: Error) => {
    if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") {
      console.error(`[WebServer] WebSocket 错误: ${err.message}`);
    }
  });
  wss.on("connection", (ws, req) => {
    // WebSocket 升级不走上面的 HTTP 回调，需在此单独走认证（本机免密 / token / 远程会话）
    const wsUrl = new URL(req.url || "/", "http://localhost");
    if (!authPass(req, wsUrl)) {
      try { ws.close(); } catch { /* ignore */ }
      return;
    }
    const name = (req.headers["user-agent"] || "ws").slice(0, 20);
    const clientId = wsUrl.searchParams.get("clientId") || undefined;
    monitor.addWSClient(ws, name, clientId);
  });

  // 端口自动回退：配置端口被占用时递增尝试（最多额外 10 个），实际端口由 listening 回调获取
  let currentPort = port;
  const tryListen = () => {
    server.listen(currentPort, "0.0.0.0");
  };
  server.once("listening", () => {
    const addr = server.address();
    const actualPort = typeof addr === "object" && addr ? addr.port : currentPort;
    const LanIPs = getLanIPs();
    console.error(`[WebServer] 串口实时终端: http://localhost:${actualPort}`);
    // 局域网 IP 合并为一行，避免多 IP 逐行刷屏
    if (LanIPs.length > 0) {
      console.error(`[WebServer] 局域网访问: ${LanIPs.map((ip) => `http://${ip}:${actualPort}`).join(", ")}`);
      console.error(`[WebServer] 提示: 如果局域网其他电脑无法访问，请检查 Windows 防火墙是否放行端口 ${actualPort}`);
    }
    if (mcpServerFactory) {
      console.error(`[WebServer] MCP over Streamable HTTP: http://localhost:${actualPort}/mcp`);
    }
    onStarted?.(actualPort);
    if (autoOpenBrowser) {
      openBrowser(`http://localhost:${actualPort}`);
    }
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      if (currentPort - port < 10) {
        console.error(`[WebServer] 端口 ${currentPort} 被占用，尝试 ${currentPort + 1}`);
        currentPort += 1;
        tryListen();
      } else {
        console.error(`[WebServer] 端口 ${port}~${currentPort} 均被占用，Web 监视器未启动`);
        console.error(`[WebServer] 请释放端口或设置环境变量 WEB_PORT 指定其他端口`);
      }
    } else {
      console.error(`[WebServer] 启动失败: ${err.message}`);
    }
  });

  tryListen();

  return server;
}

// ---- 工具函数 ----

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
    sendError(res, err);
  }
}

/** GET /vendor/* — 本地 xterm 资源（离线可用；缺失时前端自动回退 CDN） */
function handleVendorAsset(res: http.ServerResponse, name: string): void {
  // 白名单：只允许这两个文件，避免变成任意文件读取
  const Targets: Record<string, { mime: string; paths: string[] }> = {
    "xterm.js": { mime: "application/javascript; charset=utf-8", paths: ["lib/xterm.js"] },
    "xterm.css": { mime: "text/css; charset=utf-8", paths: ["css/xterm.css"] },
  };
  const target = Targets[name];
  if (!target) {
    res.writeHead(404);
    res.end("Not Found");
    return;
  }
  const Here = dirname(fileURLToPath(import.meta.url));
  // 优先取构建产物 build/vendor/，其次取 node_modules 里的 @xterm/xterm（开发态）
  const Candidates = [
    join(Here, "vendor", name),
    ...target.paths.map((p) => join(Here, "..", "node_modules", "@xterm", "xterm", p)),
  ];
  for (const File of Candidates) {
    if (!existsSync(File)) continue;
    try {
      const Data = readFileSync(File);
      res.writeHead(200, {
        "Content-Type": target.mime,
        "Content-Length": Data.length,
        "Cache-Control": "public, max-age=86400",
      });
      res.end(Data);
      return;
    } catch {
      /* 继续尝试下一个候选路径 */
    }
  }
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("xterm asset not found");
}

/** POST /send-file?clientId=xxx — 把请求体原始字节写入串口（二进制安全，不追加行尾、不等响应）
 *  前端按块上传（默认 16KB/块），避免超大请求体；仅控制端可用。 */
async function handleSendFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  monitor: SerialMonitor,
  url: URL
): Promise<void> {
  try {
    const clientId = url.searchParams.get("clientId") || "";
    // 权限前置：非控制端直接拒绝（不注册幽灵客户端，也不产生副作用）
    const permErr = checkController(monitor, clientId);
    if (permErr) throw new HttpError(403, permErr);
    // 体量上限要在串口状态之前判定，否则超大块永远拿不到 413
    const Data = await readRawBytes(req);
    if (Data.length === 0) throw new HttpError(400, "空请求体");
    if (!monitor.isActive()) throw new HttpError(500, "串口未打开");
    monitor.touchClient(clientId);
    await monitor.writeBuffer(Data);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, sent: Data.length }));
  } catch (err) {
    sendError(res, err);
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
    sendError(res, err);
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
    sendError(res, err);
  }
}

/** POST /send */
function handleSend(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  monitor: SerialMonitor
): void {
  readBodyRaw(req).then(async (body) => {
    try {
      const raw = JSON.parse(body) as SendRequestBody & { clientId?: string };
      const { command, lineEnding, clientId } = raw;
      if (!command || typeof command !== "string") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "缺少 command 参数" }));
        return;
      }
      const le = typeof lineEnding === "string" ? lineEnding : "\n";
      // 流式写入 (空行尾) 不需要控制权；完整命令需要控制端权限
      if (le !== "") {
        monitor.pruneStaleClients();
        // 全新 clientId 直接 /send：注册并立即接管控制（免先连 SSE 长连接）
        if (clientId && typeof clientId === "string" && !monitor.isRegistered(clientId)) {
          monitor.registerClient(clientId);
          monitor.setController(clientId);
        }
        if (clientId && typeof clientId === "string") monitor.touchClient(clientId);
        const permErr = checkController(monitor, clientId);
        if (permErr) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: permErr }));
          return;
        }
      }
      // /send 仅负责原始写入，不等待响应；响应等待使用 MCP serial_send
      await monitor.sendRaw(command, le);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      sendError(res, err);
    }
  }).catch((err) => {
    sendError(res, err);
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
    sendError(res, err);
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
    sendError(res, err);
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

    // 未注册 clientId 不构成接管（修复假成功 200）
    if (!monitor.isRegistered(clientId)) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "clientId 未注册（需先连 /events 或 /send 自动注册）" }));
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
    sendError(res, err);
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

  // 20s 心跳：代理/客户端空闲断开后服务端残连接不回收；ping 保持长连接
  const heartbeat = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      clearInterval(heartbeat);
    }
  }, 20000);

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
    clearInterval(heartbeat);
    // 传入 res 进行身份校验，避免旧连接断开误删新连接
    monitor.removeClient(clientId, res);
  });
}

// ============================================================================
// MCP over Streamable HTTP — 处理函数（SDK v2）
// ============================================================================

/**
 * /mcp — MCP Streamable HTTP 端点。
 * 有状态模式：首个请求（POST initialize）新建 transport + server 实例，
 * 服务端在响应头回 `mcp-session-id`，后续 GET（收流）/ POST（发消息）/ DELETE（结束）凭该 id 复用。
 */
async function handleMCPHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  monitor: SerialMonitor,
  factory?: MCPServerFactory,
  version?: string
): Promise<void> {
  if (!factory) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("MCP over HTTP not available");
    return;
  }

  const rawHeader = req.headers["mcp-session-id"];
  const sessionId = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;

  // ① 已有会话：复用同一个 transport（GET 收流 / POST 发消息 / DELETE 结束）
  if (sessionId) {
    const existing = httpTransports.get(sessionId);
    if (!existing) {
      res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "未知会话：mcp-session-id 无效或已过期，请重新 initialize" }));
      return;
    }
    await existing.handleRequest(req, res);
    return;
  }

  // ② 无会话：只有 POST（首次 initialize）可以开新会话
  if (req.method !== "POST") {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "缺少 mcp-session-id：新会话请用 POST 发送 initialize" }));
    return;
  }

  const transport = new NodeStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  const server = factory(monitor, version || "0.0.0");

  transport.onclose = () => {
    const sid = transport.sessionId;
    if (sid) httpTransports.delete(sid);
    server.close().catch(() => {});
  };

  await server.connect(transport);
  await transport.handleRequest(req, res);

  // sessionId 在 initialize 处理过程中生成，响应发出后即可登记
  const sid = transport.sessionId;
  if (sid) httpTransports.set(sid, transport);
}
