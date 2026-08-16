# mcp-serial

MCP 串口终端服务器 — 持久化串口通信 + Web 实时监视器。

## 功能特性

- **持久化串口连接** — 一次打开，持续接收数据到环形缓冲区
- **多串口支持** — 一个进程可同时打开多个串口，MCP 工具通过 `port` 参数区分，Web 终端自动分屏、可收起/展开/调宽，每个串口面板带控制按钮
- **Web 实时终端** — 浏览器实时串口终端，地址 http://localhost:9721
- **本地前端资源** — xterm.js 等静态资源随包本地提供，不依赖 CDN
- **多窗口分级别控制** — 首个标签页为控制端（🎮），后续为监视端（👁）
  - 控制端可连接/断开/发送，监视端仅查看
  - 监视端可 🤝 申请控制（10 秒超时自动同意）或 ⚡ 强制控制（立即接管）
  - 控制端断开时自动提升最老监视端
- **串口选择** — Web UI 下拉选择串口 + 波特率，实时刷新
- **集群客户端感知** — 状态栏显示所有在线客户端名称和 IP（点击展开）
- **终端光标输入** — 绿色闪烁块状光标 `█`，支持 ← → Home End Backspace Delete Ctrl+V
- **Ctrl+A~Z 控制字符** — 所有 Ctrl 组合键作为 ASCII 控制字符发送（0x01-0x1A）
- **ESC 释放输入** — 按 ESC 发送 0x1B 并释放键盘，恢复 VS Code 快捷键，点击输出区重新激活
- **工具栏折叠** — ◀ 按钮折叠工具按钮，只保留串口控制和状态栏
- **时间戳开关** — 🕐 切换每行时间戳显示（默认关闭）
- **命令回显开关** — 💬 切换命令回显（默认关闭，纯静默串口模式）
- **复制/保存** — 📋 复制全部输出，💾 保存为 .txt（支持文件选择器路径选择）
- **增量读取** — Agent 通过 serial_read 只读取上次之后的新数据
- **HTTP 自动注册** — `/send` 支持无连接 clientId：脚本/Agent 直接 POST 即可自动注册并接管控制权，无需预先建立 SSE 长连接（适合 send.ps1 / flash.ps1 等一次性命令脚本）
- **权限校验** — `/force-control` 严格校验 clientId 是否已注册，未注册返回 409（不再假成功）；`/request-control` 同样前置校验注册状态（未注册直接 409，不再 10 秒后才失败）
- **SSE 心跳** — 长连接每 20 秒发送心跳，避免代理/NAT 静默断开；同 clientId 重连自动顶掉旧连接，不会互相干扰
- **自动连接** — SERIAL_AUTO_CONNECT=true 时服务器启动即自动打开串口
- **端口扫描** — list_ports 列出所有可用串口
- **跨平台** — 原生支持 Windows 11、WSL 2、Ubuntu

## 安装

### 全局安装

```bash
npm install -g @yuanchilin/mcp-serial
```

### npx 直接运行

```bash
npx @yuanchilin/mcp-serial
```

### 本地开发

```bash
git clone <仓库地址>
cd mcp-serial
npm install
npm run build
npm start
```

## 快速启动

```bash
npm start
```

启动后：

- MCP 服务通过 stdio 提供
- Web 终端默认地址：http://localhost:9721
- 无串口也可启动

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| SERIAL_PORT | COM3 | 串口名称 |
| SERIAL_BAUDRATE | 115200 | 波特率 |
| SERIAL_AUTO_CONNECT | false | 启动时自动连接串口 |
| WEB_PORT | 9721 | Web 监视器端口 |
| HOST | 0.0.0.0 | Web 服务监听地址；局域网访问时保持 0.0.0.0 |
| WEB_AUTO_OPEN | false | 启动时自动打开浏览器（需显式设 true） |
| SERIAL_BUFFER_SIZE | 1048576 | 环形缓冲区最大容量（字节） |
| SERIAL_WEB_TOKEN | (空) | 可选访问令牌：设置后所有 POST /events /WS 需携带 `Authorization: Bearer <token>` 或 `?token=<token>`；Web 界面以 `http://host:9721/?token=<token>` 打开即可自动透传 |
| SERIAL_AGENT_TTL_MS | 1800000 | 无连接注册（http-agent）的过期时间（毫秒），超时自动清理，防止死 agent 长期占用控制权 |

## 可用 MCP 工具

| 工具 | 功能 |
|---|---|
| list_ports | 列出所有可用串口 |
| serial_start | 打开串口并开始持久化缓冲 |
| serial_stop | 关闭串口 |
| serial_status | 查询连接状态和统计信息 |
| serial_read | 增量读取缓冲区新数据 |
| serial_send | 发送命令并等待响应 |
| serial_write | 流式写入原始数据，不追加行尾，不等待响应 |
| serial_clear_buffer | 清空环形缓冲区 |
| open_web_monitor | 在 VS Code 内置浏览器中打开 Web 监视器 |

> 除 `list_ports` 和 `open_web_monitor` 外，所有 `serial_*` 工具都支持可选 `port` 参数；不传时自动选择唯一活动串口或默认串口。

### 多串口使用示例

```text
serial_start(port: "COM3")
serial_start(port: "COM4")
serial_send(port: "COM3", command: "help")
serial_read(port: "COM4")
serial_status()
serial_stop(port: "COM3")
serial_stop()   # 不传 port 时关闭所有串口
```

## 脚本命令

| 命令 | 说明 |
|---|---|
| `npm run build` | 编译 TypeScript + 复制 HTML 和 xterm 静态资源到 build/ |
| `npm start` | 启动编译后的服务器 |
| `npm run watch` | 监听模式：源码变化自动重新编译 |
| `npm test` | 运行自动化测试 |
| `npm run inspector` | 使用 MCP Inspector 调试 |

## 项目结构

```
src/
├── types.ts          # 共享类型定义
├── ring-buffer.ts    # 环形缓冲区
├── serial-manager.ts # 多串口管理器
├── serial-monitor.ts # 单个串口管理 + SSE 客户端管理 + 控制权管理
├── viewer.html       # 单串口终端 HTML（分屏 iframe 用）
├── multi.html        # 多串口分屏外壳
├── viewer-html.ts    # HTML 加载器
├── web-server.ts     # HTTP/SSE 服务器 + REST API
└── index.ts          # MCP 服务器、工具处理器、主入口

scripts/
└── copy-assets.mjs   # 构建后复制 HTML 和 xterm 静态资源到 build/

test/
└── *.test.js         # node:test 自动化测试
```

## 常见问题

### 局域网无法访问

- 默认监听 `0.0.0.0`，同一局域网通过 `http://电脑IP:9721` 访问
- Windows 需放行防火墙 TCP `9721` 端口
- 如果同网段 ping 不通，检查路由器是否开启 AP 隔离 / 客户端隔离

### 端口被占用

```bash
WEB_PORT=9722 npm start
```

PowerShell：

```powershell
$env:WEB_PORT="9722"; npm start
```

### WSL / Ubuntu 串口

- 串口路径使用 `/dev/ttyUSB0`、`/dev/ttyS0` 等
- 如无权限：`sudo usermod -a -G dialout $USER`

## 许可证

MIT
