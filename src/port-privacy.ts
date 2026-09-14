import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// ============================================================================
// 私有端口（"仅本机可见"）的持久化
//
// 语义：被标记为私有的端口，对【非回环来源】的客户端完全不可见 ——
//       列表里不出现、状态里没有、订阅与操作一律 404（用 404 而非 403，避免泄露存在性）。
//
// 存储：
//   - 默认写到操作系统的应用数据目录（Windows %APPDATA%\mcp-serial\、类 Unix ~/.config/mcp-serial/），
//     不污染仓库工作区；
//   - 可用 SERIAL_PRIVATE_FILE 指定任意路径（测试与特殊部署用）；
//   - 首次启动若文件不存在，用环境变量 SERIAL_PRIVATE_PORTS 作为初始值，之后以文件为准。
// ============================================================================

/** 隐私状态文件名 */
const FILE_NAME = "private-ports.json";

/** 解析私有端口状态文件路径 */
export function privacyFilePath(): string {
  const explicit = process.env.SERIAL_PRIVATE_FILE;
  if (explicit && explicit.trim()) return explicit.trim();
  const home = homedir();
  const dir = process.platform === "win32"
    ? join(process.env.APPDATA || join(home, "AppData", "Roaming"), "mcp-serial")
    : join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "mcp-serial");
  return join(dir, FILE_NAME);
}

/** 从 SERIAL_PRIVATE_PORTS="COM14,COM5" 解析初始私有端口 */
export function privateFromEnv(): string[] {
  return (process.env.SERIAL_PRIVATE_PORTS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 读取私有端口集合。
 * 文件存在 → 以文件为准；不存在 → 用 SERIAL_PRIVATE_PORTS；读取失败 → 退回环境变量并告警（不崩溃）。
 */
export function loadPrivatePorts(file: string = privacyFilePath()): Set<string> {
  try {
    if (existsSync(file)) {
      const raw = readFileSync(file, "utf-8");
      const parsed = JSON.parse(raw) as { private?: unknown };
      const list = Array.isArray(parsed.private) ? parsed.private : [];
      return new Set(list.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim()));
    }
  } catch (err) {
    console.error(`[Privacy] 读取 ${file} 失败，改用 SERIAL_PRIVATE_PORTS: ${err instanceof Error ? err.message : String(err)}`);
  }
  return new Set(privateFromEnv());
}

/** 保存私有端口集合（自动建目录；文件很小，直接覆盖写） */
export function savePrivatePorts(ports: Set<string>, file: string = privacyFilePath()): void {
  const payload = JSON.stringify({ private: [...ports].sort(), updatedAt: new Date().toISOString() }, null, 2) + "\n";
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, payload, "utf-8");
  } catch (err) {
    console.error(`[Privacy] 写入 ${file} 失败（本次运行内仍生效）: ${err instanceof Error ? err.message : String(err)}`);
  }
}
