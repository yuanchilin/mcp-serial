#!/usr/bin/env node
import { createRequire } from "module";
import * as readline from "node:readline";
import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { SerialPort } from "serialport";
import { SerialMonitor } from "./serial-monitor.js";
import { startWebServer, openBrowser } from "./web-server.js";

const SERIAL_PORT_ENV = process.env.SERIAL_PORT || "COM3";
const SERIAL_BAUDRATE_ENV = parseInt(process.env.SERIAL_BAUDRATE || "115200", 10);
const BUFFER_MAX_SIZE = parseInt(process.env.SERIAL_BUFFER_SIZE || "1048576", 10);
const WEB_PORT = parseInt(process.env.WEB_PORT || "9721", 10);
/** 实际生效的 Web 端口（端口被占用自动回退后更新；open_web_monitor 用实际端口） */
let ACTUAL_WEB_PORT = WEB_PORT;
const AUTO_CONNECT = process.env.SERIAL_AUTO_CONNECT === "true";
// 默认 false：启动时不自动打开任何浏览器/窗口（需要时手动打开，或显式设 WEB_AUTO_OPEN=true）
const WEB_AUTO_OPEN = process.env.WEB_AUTO_OPEN === "true";

const monitor = new SerialMonitor(BUFFER_MAX_SIZE);
// 版本号单一起源：读取 package.json，避免硬编码与发布版本不一致（如 v2.4.2 打印 2.3.0）
const require = createRequire(import.meta.url);
const APP_VERSION: string = require("../package.json").version;

/** 统一的错误文本提取（保持 v1 时期的文案格式不变） */
function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 创建 MCP 服务器（SDK v2 / @modelcontextprotocol/server）。
 *
 * 迁移说明（0.6.0 → 2.0.0）：
 * - `new Server(...)` + `setRequestHandler(CallToolRequestSchema, ...)` → `new McpServer(...)` + `registerTool(...)`
 * - 工具入参 schema 从手写 JSON Schema 改为 zod v4；v2 会自动转成 JSON Schema（draft 2020-12）上线，
 *   因此对客户端呈现的工具外形不变（golden 比对见 test/tools-golden.test.js）
 */
export function createMCPServer(monitor: SerialMonitor, version: string): McpServer {
  const server = new McpServer({ name: "serial-terminal", version });

  server.registerTool(
    "list_ports",
    { description: "列出系统中所有可用的串口", inputSchema: z.object({}) },
    async () => {
      try {
        const ports = await SerialPort.list();
        return { content: [{ type: "text", text: `可用串口列表:\n${JSON.stringify(ports, null, 2)}` }] };
      } catch (error) {
        return { content: [{ type: "text", text: `获取串口列表失败: ${errText(error)}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "serial_start",
    {
      description: "启动持久化串口监听。打开串口并持续接收数据到环形缓冲区。所有接收到的数据都会被缓存，不会丢失。同时启动 Web 实时监视器。必须先调用此工具，才能使用 serial_send 和 serial_read。Web 监视器地址: http://localhost:PORT (默认 9721)。如果设置了 SERIAL_AUTO_CONNECT=true，服务器启动时已自动连接，无需手动调用。",
      inputSchema: z.object({
        port: z.string().describe("串口名称，如 COM3"),
        baudRate: z.number().optional().describe("波特率，如 9600, 115200，默认 115200"),
      }),
    },
    async ({ port, baudRate }) => {
      const usePort = String(port || SERIAL_PORT_ENV);
      const useBaud = Number(baudRate || SERIAL_BAUDRATE_ENV);
      if (monitor.isActive()) {
        const s = monitor.getStatus();
        return { content: [{ type: "text", text: `串口已在运行中:\n  端口: ${s.port}\n  波特率: ${s.baudRate}\n  已运行: ${formatDuration(s.uptimeMs)}\n  已接收: ${formatBytes(s.stats.totalBytes)}\n\n如需重新连接，请先 serial_stop\n\nWeb: http://localhost:${ACTUAL_WEB_PORT}` }] };
      }
      try {
        await monitor.start(usePort, useBaud);
        return { content: [{ type: "text", text: `✅ 串口已启动:\n  端口: ${usePort}\n  波特率: ${useBaud}\n  缓冲: ${formatBytes(BUFFER_MAX_SIZE)}\n\n📊 http://localhost:${ACTUAL_WEB_PORT}\n\n💡 serial_send / serial_read / serial_status` }] };
      } catch (error) {
        return { content: [{ type: "text", text: `❌ 启动失败: ${errText(error)}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "serial_stop",
    { description: "停止持久化串口监听，关闭串口连接", inputSchema: z.object({}) },
    async () => {
      if (!monitor.isActive()) return { content: [{ type: "text", text: "串口未在运行中" }] };
      try {
        const s = monitor.getStatus();
        const total = s.stats.totalBytes;
        await monitor.stop();
        return { content: [{ type: "text", text: `✅ 串口已停止\n  端口: ${s.port}\n  共接收: ${formatBytes(total)}\n  运行: ${formatDuration(s.uptimeMs)}` }] };
      } catch (error) {
        return { content: [{ type: "text", text: `停止失败: ${errText(error)}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "serial_status",
    { description: "获取当前串口连接状态和统计数据", inputSchema: z.object({}) },
    async () => {
      const s = monitor.getStatus();
      return { content: [{ type: "text", text: `串口状态:\n  连接: ${s.connected ? "✅" : "❌"}\n  端口: ${s.port || "N/A"}\n  波特率: ${s.baudRate || "N/A"}\n  运行: ${formatDuration(s.uptimeMs)}\n  已接收: ${formatBytes(s.stats.totalBytes)}\n  块数: ${s.stats.chunkCount}\n  缓冲上限: ${formatBytes(s.stats.bufferMaxSize)}\n  Agent未读: ${formatBytes(s.stats.totalBytes - monitor.buffer.agentReadOffset)}\n\nWeb: http://localhost:${ACTUAL_WEB_PORT}` }] };
    }
  );

  server.registerTool(
    "serial_read",
    {
      description: "读取串口缓冲区中尚未被 Agent 读取的新数据。使用增量读取：每次调用只返回上次读取后新到达的数据。返回空字符串表示没有新数据。如果希望读取所有历史数据，设置 reset=true。",
      inputSchema: z.object({
        reset: z.boolean().optional().describe("是否重置读取偏移，读取全部缓冲区数据，默认 false"),
      }),
    },
    async ({ reset }) => {
      if (!monitor.isActive()) return { content: [{ type: "text", text: "❌ 串口未打开，请先 serial_start" }], isError: true };
      if (reset) monitor.buffer.agentReadOffset = 0;
      const readResult = monitor.buffer.getSince(monitor.buffer.agentReadOffset);
      monitor.buffer.agentReadOffset = readResult.newOffset;
      return { content: [{ type: "text", text: readResult.text || "(无新数据)" }] };
    }
  );

  server.registerTool(
    "serial_send",
    {
      description: "通过已打开的持久化串口发送命令并等待响应。支持 timeout / line / marker / regex / length 五种结束策略，可精确控制串口响应判断。也支持通过 options 对象传入同一组参数以保持更规范的 API。",
      inputSchema: z.object({
        command: z.string().describe("要发送的命令文本"),
        timeout: z.number().optional().describe("等待响应的总超时时间（毫秒），默认 2000"),
        lineEnding: z.string().optional().describe("行结束符，如 \\n, \\r\\n，默认 \\n"),
        responseMode: z.enum(["timeout", "line", "marker", "regex", "length"]).optional()
          .describe("响应结束策略：timeout / line / marker / regex / length"),
        endMarker: z.string().optional().describe("marker / regex 模式使用的结束标记；regex 模式传正则字符串"),
        expectedLength: z.number().optional().describe("length 模式下期望读取的字节数"),
        options: z.object({
          timeout: z.number().optional().describe("等待响应的总超时时间（毫秒）"),
          lineEnding: z.string().optional().describe("行结束符"),
          responseMode: z.enum(["timeout", "line", "marker", "regex", "length"]).optional(),
          endMarker: z.string().optional(),
          expectedLength: z.number().optional(),
        }).optional().describe("统一的发送选项对象，支持 responseMode / endMarker / expectedLength。此对象和顶层字段可混用，顶层字段优先。"),
      }),
    },
    async ({ command, timeout, lineEnding, responseMode, endMarker, expectedLength, options }) => {
      if (!monitor.isActive()) return { content: [{ type: "text", text: "❌ 串口未打开" }], isError: true };
      const cmd = String(command || "");
      if (!cmd) return { content: [{ type: "text", text: "命令不能为空" }], isError: true };

      const optionSource = (options && typeof options === "object") ? options : {};
      const useTimeout = Number(timeout ?? optionSource.timeout ?? 2000);
      const le = String(lineEnding ?? optionSource.lineEnding ?? "\n");
      const mode = String(responseMode ?? optionSource.responseMode ?? "timeout");
      const marker = typeof endMarker === "string" ? endMarker
        : typeof optionSource.endMarker === "string" ? optionSource.endMarker : "";
      const expLen = Number(expectedLength ?? optionSource.expectedLength ?? 0);

      try {
        const resp = await monitor.send(cmd, le, useTimeout, {
          responseMode: ["timeout", "line", "marker", "regex", "length"].includes(mode)
            ? mode as "timeout" | "line" | "marker" | "regex" | "length"
            : "timeout",
          endMarker: marker,
          expectedLength: Number.isFinite(expLen) && expLen > 0 ? expLen : undefined,
        });
        return { content: [{ type: "text", text: resp }] };
      } catch (error) {
        return { content: [{ type: "text", text: `错误: ${errText(error)}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "serial_write",
    {
      description: "流式写入：向串口发送原始数据，不追加行尾，不等待响应。用于逐字符发送（如终端交互式输入）。与 serial_send 的区别：serial_write 发送后立即返回，不读取响应；serial_send 发送完整命令行并等待响应。",
      inputSchema: z.object({
        data: z.string().describe("要发送的原始数据（不加行尾）"),
      }),
    },
    async ({ data }) => {
      if (!monitor.isActive()) return { content: [{ type: "text", text: "❌ 串口未打开" }], isError: true };
      const payload = String(data || "");
      if (!payload) return { content: [{ type: "text", text: "数据不能为空" }], isError: true };
      try {
        await monitor.write(payload);
        return { content: [{ type: "text", text: "✅" }] };
      } catch (error) {
        return { content: [{ type: "text", text: `错误: ${errText(error)}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "serial_send_file",
    {
      description: "把一个**文件**按原始字节写入串口（不追加行尾、不等待响应）。用于把固件/HEX/SREC 等整份镜像推给板子（例如 UART 加载器灌固件）。与 serial_write 的区别：数据来自磁盘文件，不受 MCP 参数字符串长度限制，且按原始字节发送（二进制安全）。可选分块大小与块间延时；返回发送字节数、耗时与吞吐。",
      inputSchema: z.object({
        path: z.string().describe("要发送的文件路径（绝对路径，或相对服务器进程当前目录）"),
        chunkSize: z.number().optional().describe("分块大小（字节），默认 1024"),
        chunkDelayMs: z.number().optional().describe("每块之间的延时（毫秒），默认 0（不延时）"),
        progressEvery: z.number().optional().describe("每发送多少字节记一次进度，默认 8192；0 = 不记"),
      }),
    },
    async ({ path: filePath, chunkSize, chunkDelayMs, progressEvery }) => {
      if (!monitor.isActive()) return { content: [{ type: "text", text: "❌ 串口未打开" }], isError: true };
      const file = String(filePath || "");
      if (!file) return { content: [{ type: "text", text: "path 不能为空" }], isError: true };
      try {
        const buf = await readFile(file);
        const useChunk = Math.max(1, Number(chunkSize) || 1024);
        const useDelay = Math.max(0, Number(chunkDelayMs) || 0);
        const useProgress = progressEvery === undefined ? 8192 : Number(progressEvery);
        const t0 = Date.now();
        let sent = 0;
        const marks: number[] = [];
        for (let off = 0; off < buf.length; off += useChunk) {
          const chunk = buf.subarray(off, Math.min(off + useChunk, buf.length));
          await monitor.writeBuffer(chunk);
          sent += chunk.length;
          if (useProgress > 0 && (sent % useProgress === 0 || sent === buf.length)) marks.push(sent);
          if (useDelay > 0 && off + useChunk < buf.length) {
            await new Promise((r) => setTimeout(r, useDelay));
          }
        }
        const dt = (Date.now() - t0) / 1000;
        const rate = sent / Math.max(dt, 1e-9);
        return {
          content: [{
            type: "text",
            text: `✅ 已发送 ${sent} 字节 (${file})\n用时 ${dt.toFixed(2)} s (${Math.round(rate)} B/s)`
              + (marks.length ? `\n进度: ${marks.join(" → ")}` : ""),
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: `错误: ${errText(error)}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "serial_clear_buffer",
    { description: "清空串口数据缓冲区", inputSchema: z.object({}) },
    async () => {
      const stats = monitor.buffer.getStats();
      monitor.buffer.clear();
      return { content: [{ type: "text", text: `✅ 已清空 (之前 ${formatBytes(stats.totalBytes)})` }] };
    }
  );

  server.registerTool(
    "open_web_monitor",
    { description: "在 VS Code 内置浏览器（Simple Browser）中打开串口 Web 实时监视器。监视器地址: http://localhost:PORT", inputSchema: z.object({}) },
    async () => {
      const url = `http://localhost:${ACTUAL_WEB_PORT}`;
      const opened = openBrowser(url);
      if (opened) {
        return { content: [{ type: "text", text: `✅ 已在 VS Code 内置浏览器中打开: ${url}` }] };
      }
      return { content: [{ type: "text", text: `🔗 Web 监视器已在运行: ${url}（浏览器已打开，请直接使用）` }] };
    }
  );

  return server;
}

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
  // 启动时密码引导：env 缺失 → 终端给一次手动输入机会（必须在 MCP stdio connect 前，stdin 空闲）
  const pwdFromEnv = process.env.SERIAL_WEB_PASSWORD || "";
  let password = pwdFromEnv;
  if (!pwdFromEnv && process.stdin.isTTY) {
    password = await new Promise<string>((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
      rl.question("⚠️ 未设置 SERIAL_WEB_PASSWORD\n请输入访问密码（留空=免密模式，远程可直接访问）: ", (ans) => {
        rl.close();
        resolve(ans.trim());
      });
    });
    if (password) console.error("[MCP] ✅ 已通过手动输入设置访问密码（本次运行有效）");
    else console.error("[MCP] 未设置访问密码，启用免密模式（远程可直接访问 Web）");
  }

  // 兜底：未捕获异常 / 未处理的 Promise 拒绝不应直接崩溃进程
  process.on("uncaughtException", (err: Error) => {
    console.error(`[MCP] 未捕获异常（已兜底，服务继续运行）: ${err.message}`);
  });
  process.on("unhandledRejection", (reason: unknown) => {
    console.error(`[MCP] 未处理的 Promise 拒绝（已兜底）: ${reason instanceof Error ? reason.message : String(reason)}`);
  });

  const webServer = startWebServer(WEB_PORT, monitor, WEB_AUTO_OPEN, createMCPServer, APP_VERSION, (p) => {
    ACTUAL_WEB_PORT = p; // 记录实际端口（可能因占用自动回退）
  }, password);

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
  const server = createMCPServer(monitor, APP_VERSION);
  await server.connect(transport);
  console.error(`[MCP] Serial Terminal v${APP_VERSION} (stdio)`);
  console.error(`[MCP] 自动连接: ${AUTO_CONNECT ? "启用" : "禁用"}`);
  console.error(`[MCP] Web 自动打开: ${WEB_AUTO_OPEN ? "启用" : "禁用"}`);
  // 访问地址 / 局域网 / 防火墙提示由 WebServer 统一打印一次，此处不重复

  const shutdown = async () => {
    console.error("[MCP] 正在关闭...");
    monitor.dispose();
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
