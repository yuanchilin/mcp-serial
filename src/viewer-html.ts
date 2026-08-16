import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// ============================================================================
// HTML 模板加载器
// ============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function readHtml(fileName: string): string {
  try {
    return readFileSync(join(__dirname, fileName), "utf-8");
  } catch {
    try {
      return readFileSync(join(__dirname, "..", "src", fileName), "utf-8");
    } catch {
      return "<html><body><h1>串口实时终端</h1><p>HTML 模板加载失败</p></body></html>";
    }
  }
}

/** 多串口分屏外壳（根路径 /） */
export function getViewerHTML(): string {
  return readHtml("multi.html");
}

/** 单个串口终端页（/viewer.html，用于 iframe 分屏） */
export function getTerminalHTML(): string {
  return readHtml("viewer.html");
}
