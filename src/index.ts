#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { SerialPort } from "serialport";
import { SerialManager } from "./serial-manager.js";
import type { SerialStatus } from "./types.js";
import { startWebServer, openBrowser } from "./web-server.js";

const SERIAL_PORT_ENV = process.env.SERIAL_PORT || "COM3";
const SERIAL_BAUDRATE_ENV = parseInt(process.env.SERIAL_BAUDRATE || "115200", 10);
const BUFFER_MAX_SIZE = parseInt(process.env.SERIAL_BUFFER_SIZE || "1048576", 10);
const WEB_PORT = parseInt(process.env.WEB_PORT || "9721", 10);
const HOST = process.env.HOST || "0.0.0.0";
const AUTO_CONNECT = process.env.SERIAL_AUTO_CONNECT === "true";
const WEB_AUTO_OPEN = process.env.WEB_AUTO_OPEN === "true"; // 默认 false（无 GUI 环境避免 spawn 浏览器失败）

const manager = new SerialManager(BUFFER_MAX_SIZE);
const APP_VERSION = "2.5.0";

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
        description: "启动持久化串口监听。支持同时打开多个串口，每次调用通过 port 指定目标串口；不传 port 时使用环境变量 SERIAL_PORT。",
        inputSchema: {
          type: "object",
          properties: {
            port: { type: "string", description: "串口名称，如 COM3、/dev/ttyUSB0" },
            baudRate: { type: "number", description: "波特率，如 9600, 115200，默认 115200" },
          },
        },
      },
      {
        name: "serial_stop",
        description: "关闭串口。传 port 关闭指定串口；不传 port 时关闭所有已打开串口。",
        inputSchema: {
          type: "object",
          properties: {
            port: { type: "string", description: "要关闭的串口名称" },
          },
        },
      },
      {
        name: "serial_status",
        description: "获取串口状态。传 port 查看指定串口；不传 port 返回所有已打开串口的摘要。",
        inputSchema: {
          type: "object",
          properties: {
            port: { type: "string", description: "串口名称" },
          },
        },
      },
      {
        name: "serial_read",
        description: "读取指定串口缓冲区中尚未被 Agent 读取的新数据。使用增量读取：每次调用只返回上次读取后新到达的数据。返回空字符串表示没有新数据。如果希望读取所有历史数据，设置 reset=true。",
        inputSchema: {
          type: "object",
          properties: {
            port: { type: "string", description: "串口名称；不传时自动选择唯一活动串口或默认串口" },
            reset: { type: "boolean", description: "是否重置读取偏移，读取全部缓冲区数据，默认 false" },
          },
        },
      },
      {
        name: "serial_send",
        description: "通过已打开的串口发送命令并等待响应。支持多串口，通过 port 指定目标串口。",
        inputSchema: {
          type: "object",
          properties: {
            port: { type: "string", description: "串口名称；不传时自动选择唯一活动串口或默认串口" },
            command: { type: "string", description: "要发送的命令文本" },
            timeout: { type: "number", description: "等待响应的超时时间（毫秒），默认 2000" },
            lineEnding: { type: "string", description: "行结束符，如 \\n, \\r\\n，默认 \\n" },
          },
          required: ["command"],
        },
      },
      {
        name: "serial_write",
        description: "流式写入：向指定串口发送原始数据，不追加行尾，不等待响应。用于逐字符发送（如终端交互式输入）。",
        inputSchema: {
          type: "object",
          properties: {
            port: { type: "string", description: "串口名称；不传时自动选择唯一活动串口或默认串口" },
            data: { type: "string", description: "要发送的原始数据（不加行尾）" },
          },
          required: ["data"],
        },
      },
      {
        name: "serial_clear_buffer",
        description: "清空指定串口的数据缓冲区。",
        inputSchema: {
          type: "object",
          properties: {
            port: { type: "string", description: "串口名称；不传时自动选择唯一活动串口或默认串口" },
          },
        },
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
      const existing = manager.get(port);
      if (existing?.isActive()) {
        const s = existing.getStatus();
        return { content: [{ type: "text", text: `串口已在运行中:\n  端口: ${s.port}\n  波特率: ${s.baudRate}\n  已运行: ${formatDuration(s.uptimeMs)}\n  已接收: ${formatBytes(s.stats.totalBytes)}\n\n如需重新连接，请先 serial_stop\n\nWeb: http://localhost:${WEB_PORT}` }] };
      }
      try {
        await manager.start(port, baudRate);
        return { content: [{ type: "text", text: `✅ 串口已启动:\n  端口: ${port}\n  波特率: ${baudRate}\n  缓冲: ${formatBytes(BUFFER_MAX_SIZE)}\n\n📊 http://localhost:${WEB_PORT}\n\n💡 serial_send / serial_read / serial_status` }] };
      } catch (error) {
        return { content: [{ type: "text", text: `❌ 启动失败: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    }

    case "serial_stop": {
      if (manager.activeCount() === 0) return { content: [{ type: "text", text: "没有已打开的串口" }] };
      try {
        if (args.port) {
          const port = String(args.port);
          const m = manager.get(port);
          if (!m?.isActive()) return { content: [{ type: "text", text: `串口 ${port} 未在运行中` }] };
          const s = m.getStatus();
          await manager.stop(port);
          return { content: [{ type: "text", text: `✅ 串口已停止\n  端口: ${s.port}\n  共接收: ${formatBytes(s.stats.totalBytes)}\n  运行: ${formatDuration(s.uptimeMs)}` }] };
        }

        const active = manager.getActiveStatus();
        const ports = active.map((s) => s.port).join(", ");
        await manager.stopAll();
        return { content: [{ type: "text", text: `✅ 已停止全部串口: ${ports}` }] };
      } catch (error) {
        return { content: [{ type: "text", text: `停止失败: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    }

    case "serial_status": {
      const port = args.port ? String(args.port) : undefined;
      if (port) {
        const m = manager.get(port);
        if (!m) return { content: [{ type: "text", text: `串口 ${port} 不存在，请先 serial_start` }], isError: true };
        return { content: [{ type: "text", text: formatStatus(m.getStatus(), m.buffer.agentReadOffset, WEB_PORT) }] };
      }

      const active = manager.getActiveStatus();
      if (active.length === 0) return { content: [{ type: "text", text: "当前没有已打开的串口" }] };
      const text = active.map((s) => {
        const m = manager.get(s.port);
        return formatStatus(s, m?.buffer.agentReadOffset ?? 0, WEB_PORT);
      }).join("\n\n");
      return { content: [{ type: "text", text: text }] };
    }

    case "serial_read": {
      const target = manager.resolve(args.port ? String(args.port) : undefined, SERIAL_PORT_ENV);
      if (!target?.isActive()) return { content: [{ type: "text", text: "❌ 串口未打开，请先 serial_start 并指定 port" }], isError: true };
      if (args.reset) target.buffer.agentReadOffset = 0;
      const readResult = target.buffer.getSince(target.buffer.agentReadOffset);
      target.buffer.agentReadOffset = readResult.newOffset;
      return { content: [{ type: "text", text: readResult.text || "(无新数据)" }] };
    }

    case "serial_send": {
      const target = manager.resolve(args.port ? String(args.port) : undefined, SERIAL_PORT_ENV);
      if (!target?.isActive()) return { content: [{ type: "text", text: "❌ 串口未打开" }], isError: true };
      const cmd = String(args.command || "");
      if (!cmd) return { content: [{ type: "text", text: "命令不能为空" }], isError: true };
      const timeoutRaw = Number(args.timeout);
      const timeout = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : 2000;
      const le = String(args.lineEnding || "\n");
      try {
        const resp = await target.send(cmd, le, timeout);
        return { content: [{ type: "text", text: resp }] };
      } catch (error) {
        return { content: [{ type: "text", text: `错误: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    }

    case "serial_write": {
      const target = manager.resolve(args.port ? String(args.port) : undefined, SERIAL_PORT_ENV);
      if (!target?.isActive()) return { content: [{ type: "text", text: "❌ 串口未打开" }], isError: true };
      const data = String(args.data || "");
      if (!data) return { content: [{ type: "text", text: "数据不能为空" }], isError: true };
      try {
        await target.write(data);
        return { content: [{ type: "text", text: "✅" }] };
      } catch (error) {
        return { content: [{ type: "text", text: `错误: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    }

    case "serial_clear_buffer": {
      const target = manager.resolve(args.port ? String(args.port) : undefined, SERIAL_PORT_ENV);
      if (!target) return { content: [{ type: "text", text: "❌ 串口不存在" }], isError: true };
      const stats = target.buffer.getStats();
      target.buffer.clear();
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
function formatStatus(s: SerialStatus, agentReadOffset: number, webPort: number): string {
  return `串口状态 [${s.port || "N/A"}]:
  连接: ${s.connected ? "✅" : "❌"}
  波特率: ${s.baudRate || "N/A"}
  运行: ${formatDuration(s.uptimeMs)}
  已接收: ${formatBytes(s.stats.totalBytes)}
  块数: ${s.stats.chunkCount}
  缓冲上限: ${formatBytes(s.stats.bufferMaxSize)}
  Agent未读: ${formatBytes(s.stats.totalBytes - agentReadOffset)}
  Web: http://localhost:${webPort}`;
}

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
  const webServer = startWebServer(WEB_PORT, manager, WEB_AUTO_OPEN, HOST);

  if (AUTO_CONNECT) {
    console.error(`[AutoConnect] → ${SERIAL_PORT_ENV} @ ${SERIAL_BAUDRATE_ENV} baud`);
    try {
      await manager.start(SERIAL_PORT_ENV, SERIAL_BAUDRATE_ENV);
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
    await manager.stopAll();
    manager.disposeAll(); // 关闭所有 SSE/WS 长连接，让 Web 端立即感知
    webServer.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // 兜底：MCP stdio 通道不能被未捕获异常带崩（串口工具应尽量保持运行）
  process.on("uncaughtException", (err) => {
    console.error("[MCP] 未捕获异常 (进程保持运行):", err);
  });
}

main().catch((error: unknown) => {
  console.error("Server error:", error);
  process.exit(1);
});
