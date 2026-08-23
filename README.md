# mcp-serial

MCP 串口终端服务器 — 持久化串口通信 + Web 实时监视器。

## 功能特性

- **持久化串口** — 一次打开，持续缓冲，`serial_read` 增量读取
- **Web 实时终端** — 浏览器串口终端 `http://localhost:9721`，控制权分级（🎮 控制端 / 👁 监视端，可申请 / 强制接管）
- **SSE / WebSocket 双通道** — 浏览器事件流 + xterm.js 真终端
- **MCP over SSE 远程传输** — `http://<host>:9721/mcp/sse`，局域网远程接入同一套工具
- **终端交互** — 光标键盘输入、Ctrl+A~Z 控制字符、ESC 释放输入、时间戳/回显开关、复制/保存
- **自动连接** — `SERIAL_AUTO_CONNECT=true` 启动即自动打开串口
- **跨平台** — Windows 11 / WSL 2 / Ubuntu（原生 Node.js，WSL 无需端口转发）

## 安装

```bash
# 全局安装（推荐）
npm install -g @yuanchilin/mcp-serial

# 免安装直跑
npx @yuanchilin/mcp-serial
```

本地开发：`git clone` → `npm install` → `npm run build` → `npm start`（无串口也可启动）。

## 快速验证

```bash
mcp-serial          # 或 npx @yuanchilin/mcp-serial
```

启动后：MCP 工具经 stdio 通道可用；浏览器访问 http://localhost:9721 查看实时终端。启动日志会打印 Web 地址与局域网访问地址。

> ⚠️ 端口被占用时更换端口：`WEB_PORT=9722 mcp-serial`
> WSL/Ubuntu 用户：串口路径用 `/dev/ttyUSB0`、`/dev/ttyS0` 等。

## MCP 工具

| 工具 | 功能 |
|---|---|
| list_ports | 列出所有可用串口 |
| serial_start / serial_stop | 打开 / 关闭串口 |
| serial_read | 增量读取缓冲区新数据 |
| serial_send | 发送命令并等待响应，支持 timeout / line / marker / regex / length 五种结束策略 |
| serial_status | 查询连接状态和统计 |
| serial_clear_buffer | 清空环形缓冲区 |
| open_web_monitor | 在系统默认浏览器打开 Web 监视器 |

`serial_send` 示例：

```json
{ "command": "AT\r\n", "timeout": 3000, "responseMode": "line" }
{ "command": "AT\r\n", "timeout": 3000, "responseMode": "marker", "endMarker": "OK" }
{ "command": "AT\r\n", "timeout": 3000, "responseMode": "regex", "endMarker": "OK|ERROR" }
{ "command": "AT\r\n", "timeout": 3000, "responseMode": "length", "expectedLength": 8 }
```

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| SERIAL_PORT | COM3 | 串口名称 |
| SERIAL_BAUDRATE | 115200 | 波特率 |
| SERIAL_AUTO_CONNECT | false | 启动时自动连接串口 |
| WEB_PORT | 9721 | Web 监视器端口 |
| WEB_AUTO_OPEN | false | 启动时自动打开系统默认浏览器（显式设为 true 才开启；默认不打开任何窗口） |
| SERIAL_BUFFER_SIZE | 1048576 | 环形缓冲区最大容量（字节） |
| SERIAL_RESPONSE_STABLE_MS | 2000 | `serial_send` 在 `timeout` 模式下判定响应稳定结束的静默窗口（毫秒）；调大可适配慢速设备 |
| SERIAL_WEB_PASSWORD | (空) | Web 远程访问密码：本机访问免密；远程访问需密码登录（未设置时启动可手动输入一次；留空=免密模式，远程可直接访问） |

## 常见问题

- **端口被占用**：`WEB_PORT=9722 mcp-serial` 更换端口
- **WSL 看不到串口**：`ls -la /dev/ttyS* /dev/ttyUSB*`；USB 适配器（CH340/CP2102 等）需经 [usbipd-win](https://github.com/dorssel/usbipd-win) 挂载为 `/dev/ttyUSB0`
- **串口权限**（WSL/Ubuntu）：`sudo usermod -a -G dialout $USER`（重新登录生效）

## 项目结构

```
src/
├── index.ts          # MCP 服务器 + SSE/stdio 传输 + 主入口
├── web-server.ts     # HTTP/SSE 服务器 + REST API + /mcp/sse
├── serial-monitor.ts # 串口 + SSE 客户端 + 控制权管理
├── viewer.html       # Web 终端 HTML（自包含单页）
├── viewer-html.ts    # HTML 加载器
├── ring-buffer.ts    # 环形缓冲区
└── types.ts          # 共享类型
```

## 脚本命令

| 命令 | 说明 |
|---|---|
| `npm run build` | 编译 TypeScript |
| `npm start` | 启动编译后的服务器 |
| `npm run watch` | 监听模式自动重编译 |
| `npm run inspector` | 使用 MCP Inspector 调试 |

## 许可证

MIT