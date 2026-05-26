# mcp-serial

MCP 串口终端服务器 — 持久化串口通信 + Web 实时监视器。

隶属于 [MoterSoc](https://github.com/yuanchilin/MoterSoc) RISC-V SoC 项目，用于与 FPGA 板 UART 通信（指令加载、调试输出、交互式 Shell 等）。

## 功能特性

- **持久化串口连接** — 一次打开，持续接收数据到环形缓冲区
- **Web 实时监视器** — 浏览器实时终端，地址 http://localhost:9721（可通过 WEB_PORT 配置）
- **增量读取** — Agent 通过 serial_read 只读取上次之后的新数据
- **命令发送+等待响应** — serial_send 发送命令并等待返回，超时可配置
- **自动连接** — SERIAL_AUTO_CONNECT=true 时服务器启动即自动打开串口
- **端口扫描** — list_ports 列出所有可用串口
- **跨平台** — 原生支持 Windows 11、WSL 2、Ubuntu

## 安装

```bash
npm install
npm run build
```

## 快速验证

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
[MCP] Serial Terminal v2.1.0
[MCP] Web 终端: http://localhost:9721
[MCP] 自动连接: 禁用
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
├─── serial-monitor.ts # 串口管理（修复了 send() 双定时器问题）
├─── viewer.html       # Web 终端 HTML 模板（独立文件，方便定制）
├─── viewer-html.ts    # HTML 加载器（运行时读取 viewer.html）
├─── web-server.ts     # HTTP/SSE 服务器（动态主机地址解析）
└─── index.ts          # MCP 服务器、工具处理器、主入口
```

核心优化（v2.1.0+）：
- **RingBuffer**：头索引替代 shift()，出队 O(1)
- **send()**：单一超时 + 轮询，响应收集更可靠
- **Web 终端**：使用 `window.location.origin`，支持任意主机/端口
- **模块化**：代码拆分为独立模块，便于维护

## MCP 配置

### Cline（VS Code）

添加到 `cline_mcp_settings.json` 或 VS Code 设置中的 `cline.mcpServers`：

**Windows（COM 口）：**
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

**WSL / Ubuntu（Linux 串口路径）：**
```json
{
  "mcpServers": {
    "mcp-serial": {
      "command": "node",
      "args": ["/home/用户名/projects/mcp-serial/build/index.js"],
      "env": {
        "SERIAL_PORT": "/dev/ttyS2",
        "SERIAL_BAUDRATE": "115200",
        "SERIAL_AUTO_CONNECT": "false",
        "WEB_PORT": "9722"
      },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

### Claude Desktop

添加到 `claude_desktop_config.json`，配置格式同上。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| SERIAL_PORT | COM3 | 串口名称 |
| SERIAL_BAUDRATE | 115200 | 波特率 |
| SERIAL_AUTO_CONNECT | false | 启动时自动连接串口 |
| WEB_PORT | 9721 | Web 监视器端口 |
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

## 配合 Cline 使用

配置完成后，Cline 可以通过以下工具与 FPGA 的 UART 交互：

1. `serial_start` — 打开串口
2. `serial_send` — 向 SoC 发送命令（如查看内存、检查寄存器）
3. `serial_read` — 增量读取设备输出
4. `serial_stop` — 关闭串口

Web 监视器 (http://localhost:9721) 实时显示所有串口数据。

## 常见问题

### 端口 9721 被占用

如果 9721 端口已被其他进程占用，Web 监视器会启动失败，日志如下：

```
[MCP] Serial Terminal v2.1.0
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
