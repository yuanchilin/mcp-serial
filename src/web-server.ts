import * as http from "http";
import { SerialMonitor } from "./serial-monitor.js";
import { getViewerHTML } from "./viewer-html.js";
import type { SendRequestBody } from "./types.js";

// ============================================================================
// Web 监视器服务器
// ============================================================================

export function startWebServer(port: number, monitor: SerialMonitor): http.Server {
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

    // POST /send
    if (req.method === "POST" && url.pathname === "/send") {
      handleSend(req, res, monitor);
      return;
    }

    // GET /events (SSE)
    if (url.pathname === "/events") {
      handleSSE(req, res, monitor);
      return;
    }

    // GET /status
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

  server.listen(port, () => {
    console.error(`[WebServer] 串口实时终端: http://localhost:${port}`);
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

// ---- HTTP 处理函数 ----

function handleSend(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  monitor: SerialMonitor
): void {
  let body = "";

  req.on("data", (chunk: Buffer) => {
    body += chunk.toString();
  });

  req.on("end", async () => {
    try {
      const { command, lineEnding } = JSON.parse(body) as SendRequestBody;

      if (!command || typeof command !== "string") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "缺少 command 参数" }));
        return;
      }

      const le = typeof lineEnding === "string" ? lineEnding : "\n";
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

function handleSSE(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  monitor: SerialMonitor
): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });

  res.write(": connected\n\n");
  monitor.addSSEClient(res);

  // 发送当前状态
  const status = monitor.getStatus();
  res.write(
    `data: ${JSON.stringify({
      timestamp: Date.now(),
      text: `[系统] 串口状态: ${
        status.connected
          ? `已连接 ${status.port} @ ${status.baudRate}`
          : "未连接"
      }\n`,
    })}\n\n`
  );

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
    monitor.removeSSEClient(res);
  });
}
