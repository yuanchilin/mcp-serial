#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { SerialPort } from "serialport";
import { SerialMonitor } from "./serial-monitor.js";
import { startWebServer, openBrowser } from "./web-server.js";

const SERIAL_PORT_ENV = process.env.SERIAL_PORT || "COM3";
const SERIAL_BAUDRATE_ENV = parseInt(process.env.SERIAL_BAUDRATE || "115200", 10);
const BUFFER_MAX_SIZE = parseInt(process.env.SERIAL_BUFFER_SIZE || "1048576", 10);
const WEB_PORT = parseInt(process.env.WEB_PORT || "9721", 10);
const AUTO_CONNECT = process.env.SERIAL_AUTO_CONNECT === "true";
const WEB_AUTO_OPEN = process.env.WEB_AUTO_OPEN !== "false"; // 默认 true

const monitor = new SerialMonitor(BUFFER_MAX_SIZE);
const APP_VERSION = "2.2.0";

const server = new Server({ name: "serial-terminal", version: APP_VERSION }, { capabilities: { tools: {} } });

// 工具列表
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "list_ports",
        description: "列出系统中所有可用的串口",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "serial_start",
        description: "启动持久化串口监听。打开串口并持续接收数据到环形缓冲区。所有接收到的数据都会被缓存，不会丢失。同时启动 Web 实时监视器。必须先调用此工具，才能使用 serial_send 和 serial_read。Web 监视器地址: http://localhost:PORT (默认 9721)。如果设置了 SERIAL_AUTO_CONNECT=true，服务器启动时已自动连接，无需手动调用。",
        inputSchema: {
          type: "object",
          properties: {
            port: { type: "string", description: "串口名称，如 COM3" },
            baudRate: { type: "number", description: "波特率，如 9600, 115200，默认 115200" },
          },
          required: ["port"],
        },
      },
      {
        name: "serial_stop",
        description: "停止持久化串口监听，关闭串口连接",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "serial_status",
        description: "获取当前串口连接状态和统计数据",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "serial_read",
        description: "读取串口缓冲区中尚未被 Agent 读取的新数据。使用增量读取：每次调用只返回上次读取后新到达的数据。返回空字符串表示没有新数据。如果希望读取所有历史数据，设置 reset=true。",
        inputSchema: {
          type: "object",
          properties: {
            reset: { type: "boolean", description: "是否重置读取偏移，读取全部缓冲区数据，默认 false" },
          },
        },
      },
      {
        name: "serial_send",
        description: "通过已打开的持久化串口发送命令并等待响应。必须先调用 serial_start 打开串口（或已通过 AUTO_CONNECT 自动打开）。响应数据来自串口在发送后收到的数据。",
        inputSchema: {
          type: "object",
          properties: {
            command: { type: "string", description: "要发送的命令文本" },
            timeout: { type: "number", description: "等待响应的超时时间（毫秒），默认 2000" },
            lineEnding: { type: "string", description: "行结束符，如 \\n, \\r\\n，默认 \\n" },
          },
          required: ["command"],
        },
      },
      {
        name: "serial_clear_buffer",
        description: "清空串口数据缓冲区",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "open_web_monitor",
        description: "在 VS Code 内置浏览器（Simple Browser）中打开串口 Web 实时监视器。监视器地址: http://localhost:PORT",
        inputSchema: { type: "object", properties: {} },
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
    case "list_ports":
      try {
        const ports = await SerialPort.list();
        return { content: [{ type: "text", text: `可用串口列表:\n${JSON.stringify(ports, null, 2)}` }] };
      } catch (error) {
        return { content: [{ type: "text", text: `获取串口列表失败: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }

    case "serial_start": {
      const port = String(args.port || SERIAL_PORT_ENV);
      const baudRate = Number(args.baudRate || SERIAL_BAUDRATE_ENV);
      if (monitor.isActive()) {
        const s = monitor.getStatus();
        return { content: [{ type: "text", text: `串口已在运行中:\n  端口: ${s.port}\n  波特率: ${s.baudRate}\n  已运行: ${formatDuration(s.uptimeMs)}\n  已接收: ${formatBytes(s.stats.totalBytes)}\n\n如需重新连接，请先 serial_stop\n\nWeb: http://localhost:${WEB_PORT}` }] };
      }
      try {
        await monitor.start(port, baudRate);
        return { content: [{ type: "text", text: `✅ 串口已启动:\n  端口: ${port}\n  波特率: ${baudRate}\n  缓冲: ${formatBytes(BUFFER_MAX_SIZE)}\n\n📊 http://localhost:${WEB_PORT}\n\n💡 serial_send / serial_read / serial_status` }] };
      } catch (error) {
        return { content: [{ type: "text", text: `❌ 启动失败: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    }

    case "serial_stop":
      if (!monitor.isActive()) return { content: [{ type: "text", text: "串口未在运行中" }] };
      try {
        const s = monitor.getStatus();
        const total = s.stats.totalBytes;
        await monitor.stop();
        return { content: [{ type: "text", text: `✅ 串口已停止\n  端口: ${s.port}\n  共接收: ${formatBytes(total)}\n  运行: ${formatDuration(s.uptimeMs)}` }] };
      } catch (error) {
        return { content: [{ type: "text", text: `停止失败: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }

    case "serial_status": {
      const s = monitor.getStatus();
      return { content: [{ type: "text", text: `串口状态:\n  连接: ${s.connected ? "✅" : "❌"}\n  端口: ${s.port || "N/A"}\n  波特率: ${s.baudRate || "N/A"}\n  运行: ${formatDuration(s.uptimeMs)}\n  已接收: ${formatBytes(s.stats.totalBytes)}\n  块数: ${s.stats.chunkCount}\n  缓冲上限: ${formatBytes(s.stats.bufferMaxSize)}\n  Agent未读: ${formatBytes(s.stats.totalBytes - monitor.buffer.agentReadOffset)}\n\nWeb: http://localhost:${WEB_PORT}` }] };
    }

    case "serial_read":
      if (!monitor.isActive()) return { content: [{ type: "text", text: "❌ 串口未打开，请先 serial_start" }], isError: true };
      if (args.reset) monitor.buffer.agentReadOffset = 0;
      const readResult = monitor.buffer.getSince(monitor.buffer.agentReadOffset);
      monitor.buffer.agentReadOffset = readResult.newOffset;
      return { content: [{ type: "text", text: readResult.text || "(无新数据)" }] };

    case "serial_send": {
      if (!monitor.isActive()) return { content: [{ type: "text", text: "❌ 串口未打开" }], isError: true };
      const cmd = String(args.command || "");
      if (!cmd) return { content: [{ type: "text", text: "命令不能为空" }], isError: true };
      const timeout = Number(args.timeout || 2000);
      const le = String(args.lineEnding || "\n");
      try {
        const resp = await monitor.send(cmd, le, timeout);
        return { content: [{ type: "text", text: resp }] };
      } catch (error) {
        return { content: [{ type: "text", text: `错误: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    }

    case "serial_clear_buffer": {
      const stats = monitor.buffer.getStats();
      monitor.buffer.clear();
      return { content: [{ type: "text", text: `✅ 已清空 (之前 ${formatBytes(stats.totalBytes)})` }] };
    }

    case "open_web_monitor": {
      const url = `http://localhost:${WEB_PORT}`;
      const opened = openBrowser(url);
      if (opened) {
        return { content: [{ type: "text", text: `✅ 已在 VS Code 内置浏览器中打开: ${url}` }] };
      }
      return { content: [{ type: "text", text: `🔗 Web 监视器已在运行: ${url}（浏览器已打开，请直接使用）` }] };
    }

    default:
      return { content: [{ type: "text", text: `未知工具: ${toolName}` }], isError: true };
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
async function main(): Promise<void> {
  const webServer = startWebServer(WEB_PORT, monitor, WEB_AUTO_OPEN);

  if (AUTO_CONNECT) {
    console.error(`[AutoConnect] → ${SERIAL_PORT_ENV} @ ${SERIAL_BAUDRATE_ENV} baud`);
    try {
      await monitor.start(SERIAL_PORT_ENV, SERIAL_BAUDRATE_ENV);
      console.error("[AutoConnect] ✅ 串口已自动打开");
    } catch (err) {
      console.error(`[AutoConnect] ⚠️ 自动连接失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[MCP] Serial Terminal v${APP_VERSION}`);
  console.error(`[MCP] Web 终端: http://localhost:${WEB_PORT}`);
  console.error(`[MCP] 自动连接: ${AUTO_CONNECT ? "启用" : "禁用"}`);
  console.error(`[MCP] Web 自动打开: ${WEB_AUTO_OPEN ? "启用" : "禁用"}`);

  const shutdown = async () => {
    console.error("[MCP] 正在关闭...");
    if (monitor.isActive()) await monitor.stop();
    webServer.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  console.error("Server error:", error);
  process.exit(1);
});
