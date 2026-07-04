# mcp-serial

MCP 串口终端服务器 — 持久化串口通信 + Web 实时监视器。

隶属于 [MoterSoc](https://github.com/yuanchilin/MoterSoc) RISC-V SoC 项目，用于与 FPGA 板 UART 通信（指令加载、调试输出、交互式 Shell 等）。

## 功能特性

- **持久化串口连接** — 一次打开，持续接收数据到环形缓冲区
- **Web 实时终端** — 浏览器实时串口终端，地址 http://localhost:9721
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
- **自动连接** — SERIAL_AUTO_CONNECT=true 时服务器启动即自动打开串口
- **端口扫描** — list_ports 列出所有可用串口
- **跨平台** — 原生支持 Windows 11、WSL 2、Ubuntu

## 安装

### 方式一：npm 全局安装（推荐）

```bash
npm install -g @yuanchilin/mcp-serial
```

安装后可直接使用 `mcp-serial` 命令启动，或在 MCP 配置中使用 `npx @yuanchilin/mcp-serial`。

### 方式二：npx 直接运行

无需安装，直接在 MCP 配置中使用 `npx @yuanchilin/mcp-serial` 即可。

### 方式三：本地开发

```bash
git clone https://github.com/yuanchilin/mcp-serial.git
cd mcp-serial
npm install
npm run build
```

## 快速验证

### npm 全局安装

```bash
# 安装后直接运行
npm install -g @yuanchilin/mcp-serial
mcp-serial

# 或直接用 npx
npx @yuanchilin/mcp-serial
```

### 本地开发

```bash
# 1. 安装依赖
npm install

# 2. 编译 TypeScript
npm run build

# 3. 启动服务器（无串口也可启动，MCP 服务 + Web 监视器）
npm start
```

**启动成功输出示例：**

```
[MCP] Serial Terminal v2.2.0
[MCP] Web 终端: http://localhost:9721
[MCP] 自动连接: 禁用
[MCP] Web 自动打开: 启用
[WebServer] 串口实时终端: http://localhost:9721
```

> ⚠️ 如果 9721 端口被占用，Web 监视器会启动失败，更换端口即可：
> ```bash
> WEB_PORT=9722 npm start
> ```

> **WSL / Ubuntu 用户**：直接使用 `/dev/ttyUSB0` 或 `/dev/ttyS0` 等 Linux 串口路径。
> 本项目是纯 Node.js，在 WSL 中完全原生运行，无需端口转发。

## 脚本命令

| 命令 | 说明 |
|---|---|
| `npm run build` | 编译 TypeScript + 复制 HTML 到 build/ |
| `npm start` | 启动编译后的服务器 |
| `npm run watch` | 监听模式：源码变化自动重新编译 |
| `npm run inspector` | 使用 MCP Inspector 调试 |

## 项目结构

```
src/
├─── types.ts          # 共享类型定义
├─── ring-buffer.ts    # 环形缓冲区（O(1) head-index 算法）
├─── serial-monitor.ts # 串口管理 + SSE 客户端管理 + 控制权管理
├─── viewer.html       # Web 终端 HTML 模板（自包含单页面）
├─── viewer-html.ts    # HTML 加载器（运行时读取 viewer.html）
├─── web-server.ts     # HTTP/SSE 服务器 + REST API
└─── index.ts          # MCP 服务器、工具处理器、主入口
```

## Web 终端界面

```
+-----------------------------------------------------------------+
| 串口实时终端              [控制端]  COM4 @ 115200               |
+-----------------------------------------------------------------+
| 端口: [COM4] [刷新] 波特率: [115200] [连接] [断开]             |
| [申请控制] [强制控制]                                           |
| 3 个客户端: Chrome(控制) Edge(监视)                   1.2 KB    |
| [时间戳] [回显] [清屏] [自动滚动] [发送] [复制] [保存] [折叠]  |
+-----------------------------------------------------------------+
| 输出区域                                                        |
| Hello World                                                     |
| [点击此处激活输入]                                              |
+-----------------------------------------------------------------+
```

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| SERIAL_PORT | COM3 | 串口名称 |
| SERIAL_BAUDRATE | 115200 | 波特率 |
| SERIAL_AUTO_CONNECT | false | 启动时自动连接串口 |
| WEB_PORT | 9721 | Web 监视器端口 |
| WEB_AUTO_OPEN | true | 启动时自动打开浏览器 |
| SERIAL_BUFFER_SIZE | 1048576 | 环形缓冲区最大容量（字节） |

## 可用 MCP 工具

| 工具 | 功能 |
|---|---|
| list_ports | 列出所有可用串口 |
| serial_start | 打开串口并开始持久化缓冲 |
| serial_stop | 关闭串口 |
| serial_status | 查询连接状态和统计信息 |
| serial_read | 增量读取缓冲区新数据 |
| serial_send | 发送命令并等待响应 |
| serial_clear_buffer | 清空环形缓冲区 |
| open_web_monitor | 在 VS Code 内置浏览器中打开 Web 监视器 |

## 配合 Cline / Claude Desktop 使用

### Cline（VS Code）

添加到 `cline_mcp_settings.json` 或 VS Code 设置中的 `cline.mcpServers`：

**方式一：npx（推荐，无需手动安装）**

```json
{
  "mcpServers": {
    "mcp-serial": {
      "command": "npx",
      "args": ["-y", "@yuanchilin/mcp-serial"],
      "env": {
        "SERIAL_PORT": "COM3",
        "SERIAL_BAUDRATE": "115200",
        "SERIAL_AUTO_CONNECT": "true",
        "WEB_PORT": "9721"
      },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

**方式二：全局安装后使用命令**

```json
{
  "mcpServers": {
    "mcp-serial": {
      "command": "mcp-serial",
      "env": {
        "SERIAL_PORT": "COM3",
        "SERIAL_BAUDRATE": "115200",
        "SERIAL_AUTO_CONNECT": "true",
        "WEB_PORT": "9721"
      },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

**方式三：本地路径（开发时使用）**

```json
{
  "mcpServers": {
    "mcp-serial": {
      "command": "node",
      "args": ["路径/mcp-serial/build/index.js"],
      "env": {
        "SERIAL_PORT": "COM3",
        "SERIAL_BAUDRATE": "115200",
        "SERIAL_AUTO_CONNECT": "true",
        "WEB_PORT": "9721"
      },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

> **WSL / Ubuntu 用户**：将 `SERIAL_PORT` 改为 Linux 串口路径（如 `/dev/ttyUSB0` 或 `/dev/ttyS2`）。

### Claude Desktop

添加到 `claude_desktop_config.json`，配置格式同上。

## 常见问题

### 端口 9721 被占用

如果 9721 端口已被其他进程占用，Web 监视器会启动失败，日志如下：

```
[MCP] Serial Terminal v2.2.0
[MCP] Web 终端: http://localhost:9721
[MCP] 自动连接: 禁用
[WebServer] 端口 9721 已被占用，Web 监视器未启动
[WebServer] 请设置环境变量 WEB_PORT 更换端口
```

**解决办法：** 设置环境变量更换端口：

```bash
WEB_PORT=9722 npm start
# 或指定其他端口
WEB_PORT=9730 npm start
```

### WSL 环境检查

在 WSL 中运行前，建议检查环境和可用串口：

```bash
# 检查 Node.js 版本（要求 >= 18）
node --version    # 实测 v22.22.3 通过
npm --version     # 实测 10.9.8 通过

# 查看可用串口设备
ls -la /dev/ttyS* /dev/ttyUSB* 2>/dev/null

# 查看串口设备详情
cat /proc/tty/driver/serial
```

**WSL 串口映射对照：**

| Windows COM | WSL 设备路径 | 说明 |
|-------------|-------------|------|
| COM1 | /dev/ttyS0 | 内置串口 1 |
| COM2 | /dev/ttyS1 | 内置串口 2 |
| COM3 | /dev/ttyS2 | 内置串口 3 |
| COM4~COM8 | /dev/ttyS3~/dev/ttyS7 | 内置串口 4~8 |
| USB 串口 | /dev/ttyUSB0 | USB-to-Serial 适配器（需 usbipd-win） |

> 💡 **提示**：使用 USB 串口适配器（CH340、CP2102 等）时，需通过
> [usbipd-win](https://github.com/dorssel/usbipd-win) 挂载到 WSL，
> 挂载后设备路径为 `/dev/ttyUSB0`。

### 串口权限问题

在 WSL/Ubuntu 上访问串口需要相应权限：

```bash
# 将用户加入 dialout 组（推荐）
sudo usermod -a -G dialout $USER

# 或临时修改权限（不推荐）
sudo chmod 666 /dev/ttyS2
```

> 修改组后需要重新登录才能生效。

## 许可证

MIT
