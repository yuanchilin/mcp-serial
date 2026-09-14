#!/usr/bin/env node
import { createRequire } from "module";
import * as readline from "node:readline";
import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { SerialPort } from "serialport";
import { PortRegistry, type Audience } from "./port-registry.js";
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
/**
 * 启动时自动打开的多路串口：`SERIAL_PORTS="COM3@115200,COM5@9600"`（波特率可省略，默认 SERIAL_BAUDRATE）。
 * 与 SERIAL_PORT/SERIAL_AUTO_CONNECT 的关系：设了 SERIAL_PORTS 就以它为准（多路），否则沿用单路旧行为。
 */
const SERIAL_PORTS_ENV = process.env.SERIAL_PORTS || "";

/** 多串口注册表：进程内唯一的端口状态源 */
const registry = new PortRegistry(BUFFER_MAX_SIZE);
// 版本号单一起源：读取 package.json，避免硬编码与发布版本不一致（如 v2.4.2 打印 2.3.0）
const require = createRequire(import.meta.url);
const APP_VERSION: string = require("../package.json").version;

/** 统一的错误文本提取（保持既有文案格式不变） */
function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 数据类工具共用的 port 参数说明（寻址规则必须对使用者一目了然） */
const PORT_HINT = "目标串口，如 COM3、/dev/ttyUSB0。同时打开多个串口时必须显式指定；只开了一路时可省略。";

/**
 * 创建 MCP 服务器（SDK v2 / @modelcontextprotocol/server；多串口 + 显式寻址）。
 *
 * 寻址规则（消除跨端口串扰的关键）：
 * - 给了 port → 必须已打开，否则报错并列出当前已打开的端口；
 * - 省略 port → 仅在"恰好一路已打开"时放行；0 路或 ≥2 路一律报错。
 * - serial_stop 必须给 port；要全关必须显式 all=true。
 */
export function createMCPServer(reg: PortRegistry, version: string, opts: { audience?: Audience } = {}): McpServer {
  // 受众：stdio（DSH 里的 agent）默认本机；远程 MCP over HTTP 传 remote
  const audience: Audience = opts.audience ?? "local";
  /** 受众感知访问：remote 受众对"仅本机可见"的端口一律按不存在处理 */
  const getPort = (p: string) => reg.get(p, audience);
  const openNames = () => reg.openPortNames(audience);
  const openSessionsFor = () => reg.openSessions(audience);
  const resolveTarget = (p?: unknown) => reg.resolve(p, audience);
  const planStopFor = (p?: unknown, all?: unknown) => reg.planStop(p, all, audience);
  const visiblePort = (p: string) => reg.visible(p, audience);

  const server = new McpServer({ name: "serial-terminal", version });

  server.registerTool(
    "list_ports",
    { description: "列出系统中所有可用的串口，并标注哪些已被本服务打开。", inputSchema: z.object({}) },
    async () => {
      try {
        const ports = await SerialPort.list();
        const annotated = ports
          .filter((p) => visiblePort(p.path)) // 远程看不到"仅本机可见"的端口（连设备存在性都不暴露）
          .map((p) => {
            const session = getPort(p.path);
            const active = !!session && session.isActive();
            return { ...p, open: active, baudRate: active ? session!.getStatus().baudRate : undefined };
          });
        const names = openNames();
        const summary = names.length > 0 ? `\n已打开：${names.join(", ")}` : "\n已打开：无";
        return { content: [{ type: "text", text: `可用串口列表:${summary}\n${JSON.stringify(annotated, null, 2)}` }] };
      } catch (error) {
        return { content: [{ type: "text", text: `获取串口列表失败: ${errText(error)}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "serial_start",
    {
      description: "打开一个串口并持续接收数据到该串口自己的环形缓冲区。可同时打开多个串口，各自独立、互不干扰。Web 监视器: http://localhost:PORT（默认 9721）。若设置了 SERIAL_AUTO_CONNECT=true，启动时已自动打开 SERIAL_PORT 指定的那一路。",
      inputSchema: z.object({
        port: z.string().optional().describe("要打开的串口，如 COM3；省略时使用环境变量 SERIAL_PORT"),
        baudRate: z.number().optional().describe("波特率，如 9600, 115200，默认 115200"),
      }),
    },
    async ({ port, baudRate }) => {
      const usePort = String(port || SERIAL_PORT_ENV);
      const useBaud = Number(baudRate || SERIAL_BAUDRATE_ENV);
      // 远程受众不得打开（也不得知道）"仅本机可见"的端口
      if (!visiblePort(usePort)) {
        return { content: [{ type: "text", text: `❌ 串口 ${usePort} 不存在` }], isError: true };
      }
      const existing = getPort(usePort);
      if (existing && existing.isActive()) {
        const s = existing.getStatus();
        return { content: [{ type: "text", text: `串口 ${usePort} 已在运行中:\n  波特率: ${s.baudRate}\n  已运行: ${formatDuration(s.uptimeMs)}\n  已接收: ${formatBytes(s.stats.totalBytes)}\n\n如需重连请先 serial_stop（port=${usePort}）\n已打开端口: ${openNames().join(", ") || "无"}\n\nWeb: http://localhost:${ACTUAL_WEB_PORT}` }] };
      }
      try {
        await reg.open(usePort, useBaud);
        return { content: [{ type: "text", text: `✅ 串口已启动:\n  端口: ${usePort}\n  波特率: ${useBaud}\n  缓冲: ${formatBytes(BUFFER_MAX_SIZE)}（每路独立）\n  当前已打开: ${openNames().join(", ")}\n\n📊 http://localhost:${ACTUAL_WEB_PORT}\n\n💡 serial_send / serial_read / serial_status（多路时请带 port）` }] };
      } catch (error) {
        return { content: [{ type: "text", text: `❌ 打开 ${usePort} 失败: ${errText(error)}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "serial_stop",
    {
      description: "关闭串口。必须指定 port（只关这一路）；要一次关闭全部已打开串口，显式传 all=true。",
      inputSchema: z.object({
        port: z.string().optional().describe("要关闭的串口，如 COM3"),
        all: z.boolean().optional().describe("是否关闭全部已打开串口，默认 false"),
      }),
    },
    async ({ port, all }) => {
      const plan = planStopFor(port, all);
      if (!plan.ok) return { content: [{ type: "text", text: `❌ ${plan.error}` }], isError: true };

      const lines: string[] = [];
      for (const name of plan.ports) {
        const before = getPort(name)?.getStatus();
        try {
          await reg.close(name);
          lines.push(`✅ ${name} 已关闭（共接收 ${formatBytes(before?.stats.totalBytes || 0)}，运行 ${formatDuration(before?.uptimeMs || 0)}）`);
        } catch (error) {
          lines.push(`❌ ${name} 关闭失败: ${errText(error)}`);
        }
      }
      const remain = openNames();
      return {
        content: [{ type: "text", text: `${lines.join("\n")}\n\n仍打开: ${remain.join(", ") || "无"}` }],
        isError: lines.some((l) => l.startsWith("❌")),
      };
    }
  );

  server.registerTool(
    "serial_status",
    {
      description: "获取串口状态与统计。指定 port 返回该端口详情；省略则返回所有已打开串口的摘要（只读操作，不受多端口寻址限制）。",
      inputSchema: z.object({
        port: z.string().optional().describe("要查看的串口；省略则返回全部已打开串口的摘要"),
      }),
    },
    async ({ port }) => {
      const wanted = typeof port === "string" ? port.trim() : "";
      if (wanted) {
        const session = getPort(wanted);
        if (!session || !session.isActive()) {
          return { content: [{ type: "text", text: `❌ 串口 ${wanted} 未在运行中（当前已打开：${openNames().join(", ") || "无"}）` }], isError: true };
        }
        return { content: [{ type: "text", text: formatStatus(session) }] };
      }

      const sessions = openSessionsFor();
      if (sessions.length === 0) {
        return { content: [{ type: "text", text: `串口状态: 当前没有已打开的串口\n\nWeb: http://localhost:${ACTUAL_WEB_PORT}` }] };
      }
      const blocks = sessions
        .slice()
        .sort((a, b) => (a.port || "").localeCompare(b.port || ""))
        .map((s) => formatStatus(s));
      const head = sessions.length > 1 ? `共 ${sessions.length} 个串口已打开（操作数据请显式带 port）\n\n` : "";
      return { content: [{ type: "text", text: head + blocks.join("\n\n") }] };
    }
  );

  server.registerTool(
    "serial_read",
    {
      description: "读取指定串口缓冲区中尚未被 Agent 读取的新数据（增量读取：只返回上次读取后新到达的数据；空字符串表示没有新数据；reset=true 读取全部历史）。",
      inputSchema: z.object({
        port: z.string().optional().describe(PORT_HINT),
        reset: z.boolean().optional().describe("是否重置读取偏移，读取全部缓冲区数据，默认 false"),
      }),
    },
    async ({ port, reset }) => {
      const target = resolveTarget(port);
      if (!target.ok) return { content: [{ type: "text", text: `❌ ${target.error}` }], isError: true };
      const session = target.session;
      if (reset) session.buffer.agentReadOffset = 0;
      const readResult = session.buffer.getSince(session.buffer.agentReadOffset);
      session.buffer.agentReadOffset = readResult.newOffset;
      return { content: [{ type: "text", text: readResult.text || `(${session.port} 无新数据)` }] };
    }
  );

  server.registerTool(
    "serial_send",
    {
      description: "向指定串口发送命令并等待响应。支持 timeout / line / marker / regex / length 五种结束策略；也支持通过 options 对象传入同一组参数。同时打开多个串口时必须显式指定 port，避免发错目标。",
      inputSchema: z.object({
        port: z.string().optional().describe(PORT_HINT),
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
    async ({ port, command, timeout, lineEnding, responseMode, endMarker, expectedLength, options }) => {
      const target = resolveTarget(port);
      if (!target.ok) return { content: [{ type: "text", text: `❌ ${target.error}` }], isError: true };
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
        const resp = await target.session.send(cmd, le, useTimeout, {
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
      description: "向指定串口流式写入原始数据（不追加行尾、不等待响应），用于逐字符发送等终端式交互。多路时必须显式指定 port。",
      inputSchema: z.object({
        port: z.string().optional().describe(PORT_HINT),
        data: z.string().describe("要发送的原始数据（不加行尾）"),
      }),
    },
    async ({ port, data }) => {
      const target = resolveTarget(port);
      if (!target.ok) return { content: [{ type: "text", text: `❌ ${target.error}` }], isError: true };
      const payload = String(data || "");
      if (!payload) return { content: [{ type: "text", text: "数据不能为空" }], isError: true };
      try {
        await target.session.write(payload);
        return { content: [{ type: "text", text: `✅ 已写入 ${target.session.port}` }] };
      } catch (error) {
        return { content: [{ type: "text", text: `错误: ${errText(error)}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "serial_send_file",
    {
      description: "把一个**文件**按原始字节写入指定串口（不追加行尾、不等待响应），用于把固件/HEX/SREC 整份镜像推给板子（二进制安全）。可选分块大小与块间延时；返回发送字节数、耗时与吞吐。多路时必须显式指定 port。",
      inputSchema: z.object({
        port: z.string().optional().describe(PORT_HINT),
        path: z.string().describe("要发送的文件路径（绝对路径，或相对服务器进程当前目录）"),
        chunkSize: z.number().optional().describe("分块大小（字节），默认 1024"),
        chunkDelayMs: z.number().optional().describe("每块之间的延时（毫秒），默认 0（不延时）"),
        progressEvery: z.number().optional().describe("每发送多少字节记一次进度，默认 8192；0 = 不记"),
      }),
    },
    async ({ port, path: filePath, chunkSize, chunkDelayMs, progressEvery }) => {
      const target = resolveTarget(port);
      if (!target.ok) return { content: [{ type: "text", text: `❌ ${target.error}` }], isError: true };
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
          await target.session.writeBuffer(chunk);
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
            text: `✅ 已发送 ${sent} 字节到 ${target.session.port} (${file})\n用时 ${dt.toFixed(2)} s (${Math.round(rate)} B/s)`
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
    {
      description: "清空指定串口的接收缓冲区（多路时必须显式指定 port）。",
      inputSchema: z.object({
        port: z.string().optional().describe(PORT_HINT),
      }),
    },
    async ({ port }) => {
      const target = resolveTarget(port);
      if (!target.ok) return { content: [{ type: "text", text: `❌ ${target.error}` }], isError: true };
      const stats = target.session.buffer.getStats();
      target.session.buffer.clear();
      return { content: [{ type: "text", text: `✅ ${target.session.port} 已清空 (之前 ${formatBytes(stats.totalBytes)})` }] };
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
/** 单端口状态文案（serial_status 指定 port 与摘要共用） */
function formatStatus(session: SerialMonitor): string {
  const s = session.getStatus();
  return `串口状态 [${s.port || "N/A"}]:
  连接: ${s.connected ? "✅" : "❌"}
  波特率: ${s.baudRate || "N/A"}
  运行: ${formatDuration(s.uptimeMs)}
  已接收: ${formatBytes(s.stats.totalBytes)}
  块数: ${s.stats.chunkCount}
  缓冲上限: ${formatBytes(s.stats.bufferMaxSize)}
  Agent未读: ${formatBytes(s.stats.totalBytes - session.buffer.agentReadOffset)}

Web: http://localhost:${ACTUAL_WEB_PORT}`;
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

/** 解析 SERIAL_PORTS="COM3@115200,COM5@9600" */
function parseSerialPortsEnv(raw: string): Array<{ port: string; baudRate: number }> {
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [port, baud] = item.split("@").map((x) => x.trim());
      const parsed = Number(baud);
      return { port, baudRate: Number.isFinite(parsed) && parsed > 0 ? parsed : SERIAL_BAUDRATE_ENV };
    })
    .filter((x) => !!x.port);
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

  const webServer = startWebServer(WEB_PORT, registry, WEB_AUTO_OPEN, createMCPServer, APP_VERSION, (p) => {
    ACTUAL_WEB_PORT = p; // 记录实际端口（可能因占用自动回退）
  }, password);

  // 自动打开：SERIAL_PORTS 优先（多路）；否则沿用 SERIAL_PORT + SERIAL_AUTO_CONNECT（单路，向后兼容）
  const multi = parseSerialPortsEnv(SERIAL_PORTS_ENV);
  if (multi.length > 0) {
    for (const item of multi) {
      try {
        await registry.open(item.port, item.baudRate);
        console.error(`[AutoConnect] ✅ ${item.port} @ ${item.baudRate}`);
      } catch (err) {
        console.error(`[AutoConnect] ⚠️ ${item.port} 打开失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } else if (AUTO_CONNECT) {
    console.error(`[AutoConnect] → ${SERIAL_PORT_ENV} @ ${SERIAL_BAUDRATE_ENV} baud`);
    try {
      await registry.open(SERIAL_PORT_ENV, SERIAL_BAUDRATE_ENV);
      console.error("[AutoConnect] ✅ 串口已自动打开");
    } catch (err) {
      console.error(`[AutoConnect] ⚠️ 自动连接失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const transport = new StdioServerTransport();
  const server = createMCPServer(registry, APP_VERSION);
  await server.connect(transport);
  console.error(`[MCP] Serial Terminal v${APP_VERSION} (stdio)`);
  console.error(`[MCP] 已打开端口: ${registry.openPortNames().join(", ") || "无"}`);
  console.error(`[MCP] Web 自动打开: ${WEB_AUTO_OPEN ? "启用" : "禁用"}`);
  // 访问地址 / 局域网 / 防火墙提示由 WebServer 统一打印一次，此处不重复

  const shutdown = async () => {
    console.error("[MCP] 正在关闭...");
    registry.disposeAll();
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
