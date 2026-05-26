import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// ============================================================================
// 从 viewer.html 文件加载 HTML 模板
// ============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let _cachedHTML: string | null = null;

export function getViewerHTML(): string {
  if (_cachedHTML) return _cachedHTML;

  try {
    _cachedHTML = readFileSync(join(__dirname, "viewer.html"), "utf-8");
  } catch {
    // Fallback: 可能在 src 目录下运行（未编译）, 尝试从相对路径读取
    try {
      _cachedHTML = readFileSync(
        join(__dirname, "..", "src", "viewer.html"),
        "utf-8"
      );
    } catch {
      _cachedHTML = "<html><body><h1>串口实时终端</h1><p>HTML 模板加载失败</p></body></html>";
    }
  }

  return _cachedHTML;
}
