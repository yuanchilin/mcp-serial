#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { SerialPort } from "serialport";
import * as http from "http";
import * as fs from "fs";
import * as path from "path";

// ============================================================================
// 配置常量
// ============================================================================

const SERIAL_PORT_ENV = process.env.SERIAL_PORT || "COM3";
const SERIAL_BAUDRATE_ENV = parseInt(process.env.SERIAL_BAUDRATE || "115200", 10);
const BUFFER_MAX_SIZE = parseInt(process.env.SERIAL_BUFFER_SIZE || "1048576", 10); // 默认 1MB
const WEB_PORT = parseInt(process.env.SERIAL_WEB_PORT || "9721", 10);
const AUTO_CONNECT = process.env.SERIAL_AUTO_CONNECT === "true"; // 新增：开机自连

// ============================================================================
// 环形缓冲区 - 存储所有串口接收数据，永不丢失 (buffer 范围内)
// ============================================================================

interface SerialChunk {
  timestamp: number;   // ms since epoch
  data: string;        // 原始文本
}

class RingBuffer {
  private chunks: SerialChunk[] = [];
  private totalBytes = 0;

  /** Agent 读取游标 - agent 每次 serial_read 后更新此值 */
  public agentReadOffset = 0;

  append(text: string): void {
    if (!text) return;

    const chunk: SerialChunk = {
      timestamp: Date.now(),
      data: text,
    };
    this.chunks.push(chunk);
    this.totalBytes += text.length;

    // 超过最大容量时从头裁剪
    while (this.totalBytes > BUFFER_MAX_SIZE) {
      const removed = this.chunks.shift();
      if (removed) {
        this.totalBytes -= removed.data.length;
        // 同步调整 agent 读偏移
        if (this.agentReadOffset > 0) {
          this.agentReadOffset = Math.max(0, this.agentReadOffset - removed.data.length);
        }
      }
    }
  }

  /** 获取从指定偏移量开始的所有数据 */
  getSince(offset: number): { text: string; newOffset: number } {
    let text = "";
    let currentOffset = 0;

    for (const chunk of this.chunks) {
      const chunkEnd = currentOffset + chunk.data.length;
      if (chunkEnd > offset) {
        // 这个 chunk 有部分或全部数据在 offset 之后
        const startInChunk = Math.max(0, offset - currentOffset);
        text += chunk.data.slice(startInChunk);
      }
      currentOffset = chunkEnd;
    }

    return {
      text,
      newOffset: this.totalBytes,
    };
  }

  /** 获取全部数据 (不更新偏移) */
  getAll(): string {
    return this.chunks.map(c => c.data).join("");
  }

  getStats(): { totalBytes: number; chunkCount: number; bufferMaxSize: number } {
    return {
      totalBytes: this.totalBytes,
      chunkCount: this.chunks.length,
      bufferMaxSize: BUFFER_MAX_SIZE,
    };
  }

  clear(): void {
    this.chunks = [];
    this.totalBytes = 0;
    this.agentReadOffset = 0;
  }
}

// ============================================================================
// 持久化串口监视器 - 保持串口打开，持续接收数据
// ============================================================================

class SerialMonitor {
  private serialPort: SerialPort | null = null;
  private port = "";
  private baudRate = 0;
  private startedAt: Date | null = null;
  public buffer = new RingBuffer();
  private sseClients: Set<http.ServerResponse> = new Set();

  isActive(): boolean {
    return this.serialPort !== null && this.serialPort.isOpen;
  }

  getStatus(): {
    connected: boolean;
    port: string;
    baudRate: number;
    startedAt: string | null;
    uptimeMs: number;
    stats: ReturnType<RingBuffer["getStats"]>;
  } {
    return {
      connected: this.isActive(),
      port: this.port,
      baudRate: this.baudRate,
      startedAt: this.startedAt?.toISOString() ?? null,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt.getTime() : 0,
      stats: this.buffer.getStats(),
    };
  }

  async start(port: string, baudRate: number): Promise<void> {
    // 如果已经连接，先断开
    if (this.isActive()) {
      await this.stop();
    }

    return new Promise((resolve, reject) => {
      const sp = new SerialPort({
        path: port,
        baudRate: baudRate,
        autoOpen: false,
      });

      sp.on("data", (data: Buffer) => {
        const text = data.toString("utf-8");
        this.buffer.append(text);
        this.broadcastSSE(text);
      });

      sp.on("error", (err: Error) => {
        console.error(`[SerialMonitor] 串口错误: ${err.message}`);
        // 广播错误到 SSE 客户端
        this.broadcastSSE(`\n[错误] ${err.message}\n`);
      });

      sp.on("close", () => {
        console.error("[SerialMonitor] 串口已关闭");
        this.broadcastSSE("\n[串口已关闭]\n");
        this.serialPort = null;
      });

      sp.open((err) => {
        if (err) {
          reject(new Error(`无法打开串口 ${port}: ${err.message}`));
          return;
        }

        this.serialPort = sp;
        this.port = port;
        this.baudRate = baudRate;
        this.startedAt = new Date();

        console.error(`[SerialMonitor] 串口已打开: ${port} @ ${baudRate} baud`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.serialPort) return;

    return new Promise((resolve) => {
      const sp = this.serialPort!;
      sp.close(() => {
        this.serialPort = null;
        this.startedAt = null;
        console.error("[SerialMonitor] 串口已停止");
        resolve();
      });
    });
  }

  async send(command: string, lineEnding: string, timeout: number): Promise<string> {
    if (!this.serialPort || !this.serialPort.isOpen) {
      throw new Error("串口未打开，请先调用 serial_start");
    }

    return new Promise((resolve, reject) => {
      // 记录发送前的缓冲区偏移，用于捕获响应
      const preSendOffset = this.buffer.getStats().totalBytes;

      const sp = this.serialPort!;

      const timeoutId = setTimeout(() => {
        // 超时：返回从发送后到现在的所有数据
        const { text } = this.buffer.getSince(preSendOffset);
        resolve(text || "(超时 - 无响应)");
      }, timeout);

      sp.write(command + lineEnding, (err) => {
        if (err) {
          clearTimeout(timeoutId);
          reject(err);
          return;
        }

        // 等待一小段时间收集响应
        const waitTime = Math.min(timeout, 2000);
        setTimeout(() => {
          clearTimeout(timeoutId);
          const { text } = this.buffer.getSince(preSendOffset);
          resolve(text || "(无响应)");
        }, waitTime);
      });
    });
  }

  /** 同步发送 (无等待响应)，用于 Web 终端快速发送 */
  async sendRaw(command: string, lineEnding: string): Promise<void> {
    if (!this.serialPort || !this.serialPort.isOpen) {
      throw new Error("串口未打开");
    }
    return new Promise((resolve, reject) => {
      this.serialPort!.write(command + lineEnding, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  // SSE 客户端管理
  addSSEClient(res: http.ServerResponse): void {
    this.sseClients.add(res);
    console.error(`[SSE] 客户端已连接，当前 ${this.sseClients.size} 个客户端`);
  }

  removeSSEClient(res: http.ServerResponse): void {
    this.sseClients.delete(res);
    console.error(`[SSE] 客户端已断开，当前 ${this.sseClients.size} 个客户端`);
  }

  private broadcastSSE(data: string): void {
    if (this.sseClients.size === 0) return;

    const eventData = `data: ${JSON.stringify({
      timestamp: Date.now(),
      text: data,
    })}\n\n`;

    for (const client of this.sseClients) {
      try {
        client.write(eventData);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }
}

// ============================================================================
// 全局单例
// ============================================================================

const monitor = new SerialMonitor();

// ============================================================================
// Web 监视器 HTML 页面 - 双向串口终端
// ============================================================================

function getViewerHTML(webPort: number): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>串口实时终端</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  background: #1a1a2e;
  color: #e0e0e0;
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
  height: 100vh;
  display: flex;
  flex-direction: column;
}
.header {
  background: #16213e;
  padding: 10px 16px;
  display: flex;
  align-items: center;
  gap: 12px;
  border-bottom: 1px solid #0f3460;
  flex-shrink: 0;
}
.header .title {
  font-size: 15px;
  font-weight: bold;
  color: #e94560;
}
.header .status {
  font-size: 12px;
  padding: 3px 10px;
  border-radius: 12px;
  background: #333;
}
.header .status.connected { background: #1b5e20; color: #81c784; }
.header .status.disconnected { background: #4a1414; color: #ef9a9a; }
.header .info { font-size: 11px; color: #888; margin-left: auto; }
.controls {
  background: #16213e;
  padding: 6px 12px;
  display: flex;
  gap: 6px;
  flex-shrink: 0;
  border-bottom: 1px solid #0f3460;
  flex-wrap: wrap;
  align-items: center;
}
.controls button {
  background: #0f3460;
  color: #e0e0e0;
  border: 1px solid #1a508b;
  padding: 4px 12px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 11px;
  font-family: inherit;
}
.controls button:hover { background: #1a508b; }
.controls button.danger { border-color: #e94560; color: #e94560; }
.controls button.danger:hover { background: #e94560; color: #fff; }
.controls .byte-count { font-size: 11px; color: #888; margin-left: auto; }
.output {
  flex: 1;
  overflow-y: auto;
  padding: 10px 14px;
  background: #0a0a1a;
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
}
.output .line { }
.output .timestamp { color: #555; font-size: 10px; margin-right: 8px; }
.output .error { color: #e94560; }
.output .info-msg { color: #f0a500; }
.output .sent-cmd { color: #4fc3f7; }
.output::-webkit-scrollbar { width: 8px; }
.output::-webkit-scrollbar-track { background: #0a0a1a; }
.output::-webkit-scrollbar-thumb { background: #0f3460; border-radius: 4px; }
.output::-webkit-scrollbar-thumb:hover { background: #1a508b; }
.empty-state {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: #555;
  font-size: 14px;
  flex-direction: column;
  gap: 8px;
}
/* 输入区域 */
.input-bar {
  background: #16213e;
  padding: 8px 12px;
  display: flex;
  gap: 8px;
  border-top: 1px solid #0f3460;
  flex-shrink: 0;
  align-items: center;
}
.input-bar input[type="text"] {
  flex: 1;
  background: #0a0a1a;
  color: #e0e0e0;
  border: 1px solid #0f3460;
  padding: 6px 10px;
  border-radius: 4px;
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
  font-size: 13px;
  outline: none;
}
.input-bar input[type="text"]:focus {
  border-color: #e94560;
}
.input-bar select {
  background: #0f3460;
  color: #e0e0e0;
  border: 1px solid #1a508b;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-family: inherit;
  cursor: pointer;
}
.input-bar button.send-btn {
  background: #e94560;
  color: #fff;
  border: none;
  padding: 6px 16px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  font-family: inherit;
  font-weight: bold;
}
.input-bar button.send-btn:hover { background: #ff6b81; }
.input-bar button.send-btn:disabled { background: #555; cursor: not-allowed; }
</style>
</head>
<body>
<div class="header">
  <span class="title">🔌 串口实时终端</span>
  <span id="status" class="status disconnected">未连接</span>
  <span class="info" id="portInfo"></span>
</div>
<div class="controls">
  <button onclick="clearOutput()">清屏</button>
  <button onclick="toggleScroll()" id="scrollBtn">🔽 自动滚动</button>
  <button class="danger" onclick="disconnectSSE()">断开 SSE</button>
  <span class="byte-count" id="byteCount">0 bytes</span>
</div>
<div class="output" id="output">
  <div class="empty-state">
    <span>等待串口数据...</span>
    <small>请确保 MCP 已打开串口 (serial_start 或 AUTO_CONNECT)</small>
  </div>
</div>
<!-- 输入区域 -->
<div class="input-bar">
  <input type="text" id="cmdInput" placeholder="输入要发送的命令..."
         onkeydown="if(event.key==='Enter')sendCommand()" />
  <select id="lineEnding">
    <option value="\n">\\n (LF)</option>
    <option value="\r\n">\\r\\n (CRLF)</option>
    <option value="\r">\\r (CR)</option>
    <option value="">无</option>
  </select>
  <button class="send-btn" id="sendBtn" onclick="sendCommand()">发送</button>
</div>

<script>
const WEB_PORT = ${webPort};
let eventSource = null;
let autoScroll = true;
let totalBytes = 0;
let firstData = true;

function init() { connectSSE(); }

function connectSSE() {
  if (eventSource) eventSource.close();

  eventSource = new EventSource('http://localhost:' + WEB_PORT + '/events');

  eventSource.onopen = () => {
    document.getElementById('status').textContent = '监听中';
    document.getElementById('status').className = 'status connected';
    appendLine('--- SSE 已连接，等待串口数据 ---', 'info-msg');
  };

  eventSource.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (firstData) {
        clearOutput();
        firstData = false;
      }
      appendText(msg.text);
      totalBytes += msg.text.length;
      updateByteCount();
    } catch(e) {
      appendLine('解析错误: ' + e.message, 'error');
    }
  };

  eventSource.onerror = () => {
    document.getElementById('status').textContent = '连接断开';
    document.getElementById('status').className = 'status disconnected';
    appendLine('--- SSE 连接断开，3秒后重连 ---', 'error');
    eventSource.close();
    setTimeout(connectSSE, 3000);
  };
}

function disconnectSSE() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  document.getElementById('status').textContent = '已手动断开';
  document.getElementById('status').className = 'status disconnected';
  appendLine('--- SSE 已手动断开 ---', 'info-msg');
}

// ---- 发送命令到串口 ----
async function sendCommand() {
  const input = document.getElementById('cmdInput');
  const cmd = input.value.trim();
  if (!cmd) return;

  const lineEnding = document.getElementById('lineEnding').value;

  // 在输出中显示发送的命令
  appendLine('> ' + cmd + (lineEnding === '\\n' ? '' : ' [' + lineEnding.replace(/\\\\/g,'\\\\') + ']'), 'sent-cmd');

  // 禁用按钮，防止重复点击
  const btn = document.getElementById('sendBtn');
  btn.disabled = true;
  input.disabled = true;

  try {
    const resp = await fetch('http://localhost:' + WEB_PORT + '/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: cmd, lineEnding: lineEnding }),
    });
    if (!resp.ok) {
      const err = await resp.json();
      appendLine('发送失败: ' + (err.error || '未知错误'), 'error');
    }
  } catch(e) {
    appendLine('发送失败: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    input.disabled = false;
    input.value = '';
    input.focus();
  }
}

function appendText(text) {
  const output = document.getElementById('output');
  if (output.querySelector('.empty-state')) {
    output.innerHTML = '';
  }
  const now = new Date();
  const ts = now.toTimeString().slice(0,8) + '.' + String(now.getMilliseconds()).padStart(3,'0');
  const span = document.createElement('span');
  span.className = 'line';
  span.innerHTML = '<span class="timestamp">[' + ts + ']</span>' + escapeHtml(text);
  output.appendChild(span);

  if (autoScroll) {
    output.scrollTop = output.scrollHeight;
  }
}

function appendLine(text, cls) {
  const output = document.getElementById('output');
  if (output.querySelector('.empty-state')) {
    output.innerHTML = '';
  }
  const div = document.createElement('div');
  div.className = 'line ' + (cls || '');
  div.textContent = text;
  output.appendChild(div);
  if (autoScroll) output.scrollTop = output.scrollHeight;
}

function clearOutput() {
  document.getElementById('output').innerHTML = '';
  totalBytes = 0;
  updateByteCount();
}

function toggleScroll() {
  autoScroll = !autoScroll;
  document.getElementById('scrollBtn').textContent = autoScroll ? '🔄 自动滚动' : '📌 暂停滚动';
}

function updateByteCount() {
  document.getElementById('byteCount').textContent =
    totalBytes >= 1048576 ? (totalBytes/1048576).toFixed(1)+' MB' :
    totalBytes >= 1024 ? (totalBytes/1024).toFixed(1)+' KB' :
    totalBytes + ' bytes';
}

function escapeHtml(text) {
  return text.replace(/&/g,'&').replace(/</g,'<').replace(/>/g,'>');
}

// 定期获取串口状态
setInterval(async () => {
  try {
    const resp = await fetch('http://localhost:' + WEB_PORT + '/status');
    const status = await resp.json();
    document.getElementById('portInfo').textContent =
      status.connected
        ? status.port + ' @ ' + status.baudRate + ' | 运行: ' + formatUptime(status.uptimeMs)
        : '';
  } catch(e) {}
}, 3000);

function formatUptime(ms) {
  const s = Math.floor(ms/1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s/60);
  if (m < 60) return m + 'm' + (s%60) + 's';
  const h = Math.floor(m/60);
  return h + 'h' + (m%60) + 'm';
}

init();
</script>
</body>
</html>`;
}

// ============================================================================
// HTTP/SSE 服务器 - 提供实时数据流、状态查询和双向通信
// ============================================================================

function startWebServer(port: number): http.Server {
  const server = http.createServer(async (req, res) => {
    // CORS 头
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    const url = new URL(req.url || "/", `http://localhost:${port}`);

    // POST /send - 从 Web 终端发送命令到串口 (双向通信核心)
    if (req.method === "POST" && url.pathname === "/send") {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", async () => {
        try {
          const { command, lineEnding } = JSON.parse(body);
          if (!command || typeof command !== "string") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "缺少 command 参数" }));
            return;
          }
          const le = typeof lineEnding === "string" ? lineEnding : "\n";
          await monitor.sendRaw(command, le);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message || "发送失败" }));
        }
      });
      return;
    }

    // SSE 端点 - 实时串口数据流
    if (url.pathname === "/events") {
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
      res.write(`data: ${JSON.stringify({
        timestamp: Date.now(),
        text: `[系统] 串口状态: ${status.connected ? `已连接 ${status.port} @ ${status.baudRate}` : "未连接"}\n`,
      })}\n\n`);

      // 发送已有缓冲区数据
      const existingData = monitor.buffer.getAll();
      if (existingData) {
        res.write(`data: ${JSON.stringify({
          timestamp: Date.now(),
          text: existingData,
        })}\n\n`);
      }

      req.on("close", () => {
        monitor.removeSSEClient(res);
      });
      return;
    }

    // 状态 API
    if (url.pathname === "/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(monitor.getStatus()));
      return;
    }

    // 主页面
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(getViewerHTML(port));
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
      console.error(`[WebServer] 请设置环境变量 SERIAL_WEB_PORT 更换端口`);
    } else {
      console.error(`[WebServer] 启动失败: ${err.message}`);
    }
  });

  return server;
}

// ============================================================================
// MCP 服务器
// ============================================================================

const server = new Server(
  {
    name: "serial-terminal",
    version: "2.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// ============================================================================
// 工具列表
// ============================================================================

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "list_ports",
        description: "列出系统中所有可用的串口",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "serial_start",
        description:
          "启动持久化串口监听。打开串口并持续接收数据到环形缓冲区。" +
          "所有接收到的数据都会被缓存，不会丢失。同时启动 Web 实时监视器。" +
          "必须先调用此工具，才能使用 serial_send 和 serial_read。" +
          "Web 监视器地址: http://localhost:PORT (默认 9721)。" +
          "如果设置了 SERIAL_AUTO_CONNECT=true，服务器启动时已自动连接，无需手动调用。",
        inputSchema: {
          type: "object",
          properties: {
            port: {
              type: "string",
              description: "串口名称，如 COM3",
            },
            baudRate: {
              type: "number",
              description: "波特率，如 9600, 115200，默认 115200",
            },
          },
          required: ["port"],
        },
      },
      {
        name: "serial_stop",
        description: "停止持久化串口监听，关闭串口连接",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "serial_status",
        description: "获取当前串口连接状态和统计数据",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "serial_read",
        description:
          "读取串口缓冲区中尚未被 Agent 读取的新数据。" +
          "使用增量读取：每次调用只返回上次读取后新到达的数据。" +
          "返回空字符串表示没有新数据。" +
          "如果希望读取所有历史数据，设置 reset=true。",
        inputSchema: {
          type: "object",
          properties: {
            reset: {
              type: "boolean",
              description: "是否重置读取偏移，读取全部缓冲区数据，默认 false",
            },
          },
        },
      },
      {
        name: "serial_send",
        description:
          "通过已打开的持久化串口发送命令并等待响应。" +
          "必须先调用 serial_start 打开串口（或已通过 AUTO_CONNECT 自动打开）。" +
          "响应数据来自串口在发送后收到的数据。",
        inputSchema: {
          type: "object",
          properties: {
            command: {
              type: "string",
              description: "要发送的命令文本",
            },
            timeout: {
              type: "number",
              description: "等待响应的超时时间（毫秒），默认 2000",
            },
            lineEnding: {
              type: "string",
              description: "行结束符，如 \\n, \\r\\n，默认 \\n",
            },
          },
          required: ["command"],
        },
      },
      {
        name: "serial_clear_buffer",
        description: "清空串口数据缓冲区",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
    ],
  };
});

// ============================================================================
// 工具调用处理器
// ============================================================================

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name;
  const args = request.params.arguments || {};

  switch (toolName) {
    // ------------------------------------------------------------------------
    // list_ports
    // ------------------------------------------------------------------------
    case "list_ports": {
      try {
        const ports = await SerialPort.list();
        const portList = ports.map((p) => ({
          path: p.path,
          manufacturer: p.manufacturer,
          serialNumber: p.serialNumber,
          pnpId: p.pnpId,
        }));

        return {
          content: [
            {
              type: "text",
              text: `可用串口列表:\n${JSON.stringify(portList, null, 2)}`,
            },
          ],
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: `获取串口列表失败: ${errorMessage}`,
            },
          ],
          isError: true,
        };
      }
    }

    // ------------------------------------------------------------------------
    // serial_start - 启动持久化监听
    // ------------------------------------------------------------------------
    case "serial_start": {
      const port = String(args.port || SERIAL_PORT_ENV);
      const baudRate = Number(args.baudRate || SERIAL_BAUDRATE_ENV);

      // 如果已经连接，先返回当前状态
      if (monitor.isActive()) {
        const status = monitor.getStatus();
        return {
          content: [
            {
              type: "text",
              text:
                `串口已在运行中:\n` +
                `  端口: ${status.port}\n` +
                `  波特率: ${status.baudRate}\n` +
                `  已运行: ${formatDuration(status.uptimeMs)}\n` +
                `  已接收: ${formatBytes(status.stats.totalBytes)}\n` +
                `\n如需重新连接，请先调用 serial_stop` +
                `\n\nWeb 实时终端: http://localhost:${WEB_PORT}`,
            },
          ],
        };
      }

      try {
        await monitor.start(port, baudRate);
        const status = monitor.getStatus();

        return {
          content: [
            {
              type: "text",
              text:
                `✅ 串口持久化监听已启动:\n` +
                `  端口: ${port}\n` +
                `  波特率: ${baudRate}\n` +
                `  缓冲区大小: ${formatBytes(BUFFER_MAX_SIZE)}\n` +
                `\n📊 Web 实时终端: http://localhost:${WEB_PORT}\n` +
                `   在浏览器中打开此地址可实时查看 + 发送串口数据\n` +
                `\n💡 后续使用:\n` +
                `   - serial_send: 发送命令到串口\n` +
                `   - serial_read: 读取新到达的数据\n` +
                `   - serial_status: 查看连接状态`,
            },
          ],
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: `❌ 启动串口监听失败: ${errorMessage}\n\n可能原因:\n  1. 串口被其他程序占用 (如 VSCode 串口插件)\n  2. 串口号错误\n  3. 权限不足`,
            },
          ],
          isError: true,
        };
      }
    }

    // ------------------------------------------------------------------------
    // serial_stop - 停止持久化监听
    // ------------------------------------------------------------------------
    case "serial_stop": {
      if (!monitor.isActive()) {
        return {
          content: [
            {
              type: "text",
              text: "串口未在运行中，无需停止",
            },
          ],
        };
      }

      try {
        const status = monitor.getStatus();
        const totalReceived = status.stats.totalBytes;
        await monitor.stop();

        return {
          content: [
            {
              type: "text",
              text:
                `✅ 串口监听已停止\n` +
                `  端口: ${status.port}\n` +
                `  会话共接收: ${formatBytes(totalReceived)}\n` +
                `  运行时长: ${formatDuration(status.uptimeMs)}`,
            },
          ],
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: `停止串口失败: ${errorMessage}`,
            },
          ],
          isError: true,
        };
      }
    }

    // ------------------------------------------------------------------------
    // serial_status - 状态查询
    // ------------------------------------------------------------------------
    case "serial_status": {
      const status = monitor.getStatus();

      return {
        content: [
          {
            type: "text",
            text:
              `串口状态:\n` +
              `  连接状态: ${status.connected ? "✅ 已连接" : "❌ 未连接"}\n` +
              `  端口: ${status.port || "N/A"}\n` +
              `  波特率: ${status.baudRate || "N/A"}\n` +
              `  运行时长: ${formatDuration(status.uptimeMs)}\n` +
              `  已接收数据: ${formatBytes(status.stats.totalBytes)}\n` +
              `  数据块数: ${status.stats.chunkCount}\n` +
              `  缓冲区上限: ${formatBytes(status.stats.bufferMaxSize)}\n` +
              `  Agent 未读数: ${formatBytes(status.stats.totalBytes - monitor.buffer.agentReadOffset)}\n` +
              `\n📊 Web 实时终端: http://localhost:${WEB_PORT}`,
          },
        ],
      };
    }

    // ------------------------------------------------------------------------
    // serial_read - 增量读取缓冲区
    // ------------------------------------------------------------------------
    case "serial_read": {
      if (!monitor.isActive()) {
        return {
          content: [
            {
              type: "text",
              text:
                "❌ 串口未打开。请先调用 serial_start 启动监听。\n" +
                "如果设备已上电运行，启动后可使用 serial_read 获取缓冲区中已有的数据。",
            },
          ],
          isError: true,
        };
      }

      const reset = Boolean(args.reset);
      if (reset) {
        monitor.buffer.agentReadOffset = 0;
      }

      const { text, newOffset } = monitor.buffer.getSince(
        monitor.buffer.agentReadOffset
      );
      monitor.buffer.agentReadOffset = newOffset;

      if (!text) {
        return {
          content: [
            {
              type: "text",
              text: "(无新数据)\n\n提示: 如果设备已运行但无数据，可能原因:\n  1. 设备尚未输出任何内容\n  2. 波特率不匹配\n  3. 串口接线问题",
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `串口数据 (${text.length} 字符):\n${text}`,
          },
        ],
      };
    }

    // ------------------------------------------------------------------------
    // serial_send - 通过持久连接发送命令
    // ------------------------------------------------------------------------
    case "serial_send": {
      if (!monitor.isActive()) {
        return {
          content: [
            {
              type: "text",
              text: "❌ 串口未打开。请先调用 serial_start 启动监听，然后再发送命令。",
            },
          ],
          isError: true,
        };
      }

      const command = String(args.command);
      const timeout = Number(args.timeout || 2000);
      const lineEnding = String(args.lineEnding || "\n");

      if (!command) {
        return {
          content: [
            {
              type: "text",
              text: "错误: 命令不能为空",
            },
          ],
          isError: true,
        };
      }

      try {
        const response = await monitor.send(command, lineEnding, timeout);
        return {
          content: [
            {
              type: "text",
              text: `串口响应 (${response.length} 字符):\n${response}`,
            },
          ],
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: `串口通信错误: ${errorMessage}`,
            },
          ],
          isError: true,
        };
      }
    }

    // ------------------------------------------------------------------------
    // serial_clear_buffer - 清空缓冲区
    // ------------------------------------------------------------------------
    case "serial_clear_buffer": {
      const stats = monitor.buffer.getStats();
      monitor.buffer.clear();

      return {
        content: [
          {
            type: "text",
            text: `✅ 缓冲区已清空，之前有 ${formatBytes(stats.totalBytes)} 数据`,
          },
        ],
      };
    }

    // ------------------------------------------------------------------------
    // 未知工具
    // ------------------------------------------------------------------------
    default:
      return {
        content: [
          {
            type: "text",
            text: `未知工具: ${toolName}`,
          },
        ],
        isError: true,
      };
  }
});

// ============================================================================
// 辅助函数
// ============================================================================

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ${s % 60}s`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(2)} MB`;
}

// ============================================================================
// 主函数
// ============================================================================

async function main() {
  // 启动 Web 监视器
  const webServer = startWebServer(WEB_PORT);

  // =========================================================================
  // 新增：AUTO_CONNECT - 服务器启动时自动打开串口
  // =========================================================================
  if (AUTO_CONNECT) {
    console.error(
      `[AutoConnect] 已启用自动连接 → ${SERIAL_PORT_ENV} @ ${SERIAL_BAUDRATE_ENV} baud`
    );
    try {
      await monitor.start(SERIAL_PORT_ENV, SERIAL_BAUDRATE_ENV);
      console.error("[AutoConnect] ✅ 串口已自动打开，开始缓冲数据");
    } catch (err: any) {
      console.error(`[AutoConnect] ⚠️ 自动连接失败: ${err.message}`);
      console.error("[AutoConnect] 可稍后通过 serial_start 手动连接");
    }
  }

  // 启动 MCP 服务器 (stdio)
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    "[MCP] Serial Terminal v2.1.0 - 持久化串口监听 + Web 双向终端"
  );
  console.error(`[MCP] Web 终端: http://localhost:${WEB_PORT}`);
  console.error(`[MCP] 自动连接: ${AUTO_CONNECT ? "启用" : "禁用"} (SERIAL_AUTO_CONNECT)`);

  // 优雅退出
  const shutdown = async () => {
    console.error("[MCP] 正在关闭...");
    if (monitor.isActive()) {
      await monitor.stop();
    }
    webServer.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});