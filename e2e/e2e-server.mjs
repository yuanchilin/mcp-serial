// E2E 测试专用服务器：只起 HTTP Web 服务（不起 MCP stdio，避免 stdin EOF 退出）
import { SerialManager } from "../build/serial-manager.js";
import { startWebServer } from "../build/web-server.js";

const manager = new SerialManager(1024 * 1024);
startWebServer(9721, manager, false); // 第三个参数 false = 不自动开浏览器
console.error("[e2e-server] Web 服务已启动: http://127.0.0.1:9721");
