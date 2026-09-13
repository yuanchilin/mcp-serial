# mcp-serial

MCP 串口终端服务器 — 持久化串口通信 + Web 实时监视器。

## 功能特性

- **持久化串口** — 一次打开，持续缓冲，`serial_read` 增量读取
- **Web 实时终端** — 浏览器串口终端 `http://localhost:9721`：左侧设置栏（端口 / 波特率 / 控制权 / 实时统计）+ 顶栏状态徽标，控制权分级（🎮 控制端 / 👁 监视端，可申请 / 强制接管）
- **界面自适应** — 宽屏侧栏可一键收起（状态本地记忆），窄屏（≤980px）自动收成抽屉；点击区 ≥28px，文字对比度 ≥4.5:1（WCAG AA）
- **终端外观** — 深色 / 亮色 / 护眼 / 高对比四套配色（界面与终端一起换）+ 字号增减（也支持 Ctrl+滚轮），选择记在浏览器本地
- **浏览器发文件** — 侧栏「发送文件」把**浏览器所在机器**上的文件按块（默认 16KB，可调块间延时）原始字节直写串口，用于灌固件 / HEX / SREC，带进度与取消
- **打开即见历史** — 新建 WebSocket 连接时服务端补发环形缓冲区里已有的数据，新打开 / 刷新的页面不会只看到空白终端
- **离线可用** — xterm 资源由服务端 `/vendor/xterm.js|css` 本地提供（仅在缺失时回退 CDN），纯局域网 / 断网环境同样可用
- **SSE / WebSocket 双通道** — 浏览器事件流 + xterm.js 真终端
- **MCP over Streamable HTTP 远程传输** — `http://<host>:9721/mcp`（POST/GET/DELETE 同一端点，有状态会话），局域网远程接入同一套工具
  > ⚠️ 旧版 `http://<host>:9721/mcp/sse` + `/mcp/message`（legacy HTTP+SSE）随 SDK v2 移除，请求该路径会收到 **410** 与迁移提示
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

## Web 界面

| 区域 | 内容 |
|---|---|
| 顶栏 | ☰ 收起/展开设置栏（宽屏收起整栏、窄屏开合抽屉）、连接状态徽标（端口 · 波特率 · 控制端/监视端）、事件/终端两条通道指示灯、配色（深色/亮色/护眼/高对比）、字号 A−/A+ |
| 侧栏 | 端口 + 刷新、波特率（含「自定义…」）、连接/断开、控制权（当前控制端 + 申请 / 强制接管）、清屏 / 复制 / 保存日志、**发送文件**（分块 + 块间延时 + 进度 + 取消）、实时统计（已接收 / 缓冲占用 / 数据块 / 运行时长 / 在线客户端） |
| 终端 | xterm.js 真终端，点击后直接键盘输入；仅控制端可发送数据（键盘输入与文件传输同一规则） |

- 「清屏」只清浏览器显示与本地缓存，**不影响服务端环形缓冲区**（服务端用 MCP 工具 `serial_clear_buffer`）
- 快捷操作：`Ctrl + 滚轮` 缩放字号
- 指示灯的语义：绿=已连接、黄=连接中/监视端、红=断开（鼠标悬停有说明）
- 发送文件的 HTTP 接口：`POST /send-file?clientId=<控制端 id>`，请求体即原始字节，单块上限 1MB（前端默认 16KB/块）；非控制端返回 403，串口未打开返回 500
- 终端历史：页面建立 WebSocket 时服务端会补发当前环形缓冲区内容（回放只发给该连接，不是广播），因此刷新 / 新开页面能立刻看到此前收到的数据；「清屏」只清本地显示，不影响下一次回放

## MCP 工具

| 工具 | 功能 |
|---|---|
| list_ports | 列出所有可用串口 |
| serial_start / serial_stop | 打开 / 关闭串口 |
| serial_read | 增量读取缓冲区新数据 |
| serial_send | 发送命令并等待响应，支持 timeout / line / marker / regex / length 五种结束策略 |
| serial_write | 发送原始数据（不追加行尾、不等响应），用于逐字符交互输入 |
| serial_send_file | 把一个**文件**按原始字节推给串口（不追加行尾、不等响应；二进制安全）。用于把固件/HEX/SREC 等整份镜像灌给板子（如 UART 加载器）。可选 `chunkSize` / `chunkDelayMs` / `progressEvery`，返回字节数、耗时与吞吐 |
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
├── index.ts          # MCP 服务器（SDK v2：McpServer + registerTool + zod v4）+ stdio 传输 + 主入口
├── web-server.ts     # HTTP 服务器 + REST API + /mcp（Streamable HTTP）
├── serial-monitor.ts # 串口 + SSE 客户端 + 控制权管理
├── viewer.html       # Web 终端 HTML（自包含单页）
├── viewer-html.ts    # HTML 加载器
├── ring-buffer.ts    # 环形缓冲区
└── types.ts          # 共享类型
```

> 运行环境：**Node.js ≥ 20**（`@modelcontextprotocol/server` v2 的要求）。

## 脚本命令

| 命令 | 说明 |
|---|---|
| `npm run build` | 编译 TypeScript |
| `npm start` | 启动编译后的服务器 |
| `npm run watch` | 监听模式自动重编译 |
| `npm run inspector` | 使用 MCP Inspector 调试 |

## 许可证

MIT