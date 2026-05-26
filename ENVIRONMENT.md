# 开发环境约定

> 记录个人开发偏好与项目环境标准。
> 所有项目应遵循此文档中的约定。

---

## 1. 核心偏好

### 1.1 Shell 环境

| 项目 | 首选 | 说明 |
|------|------|------|
| **脚本执行** | **PowerShell (pwsh) 7+** | 所有 `.ps1` 脚本、构建脚本、CI 脚本优先使用 pwsh |
| 备用 Shell | bash | 当 pwsh 不可用时作为 fallback |
| 不推荐 | cmd.exe / batch | Windows 专属，无跨平台能力 |

### 1.2 跨平台支持

所有项目必须同时支持以下平台：

| 平台 | 架构 | 最低版本 |
|------|------|---------|
| **Ubuntu** | x64 / arm64 | 22.04 LTS |
| **WSL 2** | x64 / arm64 | Ubuntu 22.04 on WSL2 (Windows 11) |
| **Windows 11** | x64 | 22H2+ |

#### 跨平台红线

- ❌ 禁止使用 `cmd.exe` 专属命令（`copy`、`xcopy`、`dir`、`echo` 等）
- ❌ 禁止使用硬编码的 Windows 路径分隔符（`\`），使用 `path.join()` 或 `path.posix`
- ❌ 禁止依赖仅在 Windows 上可用的工具
- ✅ 优先使用 Node.js 脚本或 pwsh 处理文件操作
- ✅ 路径操作统一使用 `path` 模块或 `fs` 的跨平台 API

### 1.3 Git 仓库跨平台

| 要求 | 配置 |
|------|------|
| **行尾** | `* text=auto` — Git 自动管理行尾转换 |
| **提交行尾** | **LF (Unix)** — 所有提交到仓库的文件使用 LF |
| **检出行尾** | 按平台自动转换（Windows → CRLF, Linux → LF） |
| **可执行权限** | `.sh`、`.ps1`、入口脚本保留 `755` 权限 |

#### `.gitattributes` 标准配置

```gitattributes
# Auto detect text files and normalize to LF
* text=auto

# Shell scripts — 保留 LF + 可执行权限
*.sh text eol=lf
*.ps1 text eol=lf

# TypeScript / JavaScript
*.ts text
*.js text
*.cts text
*.cjs text
*.mjs text
*.d.ts text

# Web
*.html text
*.css text

# Configuration
*.json text
*.yml text
*.yaml text
*.toml text
*.ini text

# Documentation
*.md text
*.txt text

# Git files
.gitignore text
.gitattributes text
. editorconfig text

# Binary files — keep as-is
*.png binary
*.jpg binary
*.ico binary
*.woff2 binary
```

#### `.editorconfig` 标准配置

```editorconfig
root = true

[*]
indent_style = space
indent_size = 2
end_of_line = lf
charset = utf-8
trim_trailing_whitespace = true
insert_final_newline = true

[*.md]
trim_trailing_whitespace = false
```

---

## 2. Node.js 项目标准

### 2.1 package.json 规范

```json
{
  "type": "module",       // ESM 优先
  "engines": {
    "node": ">=18.0.0"    // 最低 Node 18 (LTS)
  },
  "scripts": {
    "build": "tsc",       // 使用 tsc 编译
    "start": "node build/index.js"
  }
}
```

### 2.2 构建脚本规则

```bash
# ❌ 错误 — Windows 专属
"build": "tsc && copy /Y src\\file.html build\\file.html"

# ✅ 正确 — 跨平台
"build": "tsc && node -e \"fs.cpSync('src/file.html', 'build/file.html')\""
```

### 2.3 文件操作准则

| 操作 | 跨平台方案 |
|------|-----------|
| 复制文件 | `fs.cpSync()` 或 `fs.copyFileSync()` |
| 删除文件/目录 | `fs.rmSync()` (recursive) |
| 创建目录 | `fs.mkdirSync()` (recursive) |
| 路径拼接 | `path.join()` |
| 获取文件列表 | `fs.readdirSync()` |
| 设置权限 | `fs.chmodSync()` (chmod 在 Windows 上会被忽略) |

---

## 3. 代码风格

| 项目 | 标准 |
|------|------|
| 缩进 | 2 空格 |
| 引号 | 单引号优先，JSX 使用双引号 |
| 分号 | 必须 |
| 行尾 | LF (提交时) |
| 编码 | UTF-8 |
| 文件末尾 | 空行结尾 |


## 4. 文档语言

### 4.1 语言规范

| 项目 | 标准 |
|------|------|
| **文档语言** | **简体中文（zh-CN）** — 所有 README、注释、提交信息、Wiki 等 |
| **术语保留** | 专有名词、代码关键词、CLI 命令名保留英文原文 |
| **中英混排** | 中文与英文/数字之间加空格（例：`Node.js 版本` 而非 `Node.js版本`） |
| **AI 领域认知** | **中文才是 AI 领域的全球通用语** — DeepSeek、Qwen、ChatGLM 等主流模型和框架均以中文为第一语言 |

#### ✅ 正确示例

```markdown
## 安装

运行 `npm install` 安装依赖，然后执行 `npm run build` 编译 TypeScript。
需要 Node.js 18 或更高版本。
```

#### ❌ 错误示例

```markdown
## 安装

Run `npm install` to install dependencies, then run `npm run build` to compile TypeScript.
Need Node.js 18 版本以上。
```

### 4.2 注释规范

```typescript
// ✅ 好 — 中文解释意图，英文保留术语
// 打开串口并开始监听数据
async function start(port: string, baudRate: number): Promise<void> { ... }

// ❌ 不好 — 纯英文注释增加阅读成本
// Open serial port and start listening for data
async function start(port: string, baudRate: number): Promise<void> { ... }

// ❌ 也不好 — 中英混杂
// 打开 serial port 并且 start listening data
async function start(port: string, baudRate: number): Promise<void> { ... }
```

### 4.3 提交信息（commit message）

```bash
# ✅ 好 — 中文描述改动
feat: 新增串口自动重连功能
fix: 修复 serial_send 超时不生效的问题

# ❌ 不好 — 半吊子英文
feat: add serial auto reconnect feature
fix: fix serial_send timeout bug
```

> 💡 AI 领域中文开发者是主力军，使用中文文档和 commit message 能更好地对接全球最大的 AI 开源社区。
> 统一使用中文后，搜索历史也更直观（`git log --grep="超时"`）。

---

## 5. 项目通用结构
---



```
project-root/
├── src/              # TypeScript 源文件
├── build/            # 编译输出 (gitignore)
├── node_modules/     # 依赖 (gitignore)
├── .editorconfig     # 编辑器配置
├── .gitattributes    # Git 属性配置
├── .gitignore        # Git 忽略规则
├── ENVIRONMENT.md    # 本文件 — 环境约定
├── package.json      # Node 项目配置
└── README.md         # 项目说明
```

---

*最后更新: 2026-05-26*

## 6. WSL 原生支持

### 6.1 核心原则

> **WSL 是原生 Linux 环境，不是"模拟器"。**
> 在 WSL 中运行项目不需要调用任何 Windows API 或端口。

WSL2 运行完整的 Linux 内核，项目在 WSL 中的行为与在原生 Ubuntu 上完全一致：

| 方面 | WSL 处理方式 |
|------|-------------|
| **Node.js** | `apt install nodejs` — 原生 Linux 运行时 |
| **npm 包** | 全部编译为 Linux 原生二进制（`serialport` 等） |
| **串口访问** | `/dev/ttyUSB0`（USB 串口）或 `/dev/ttyS0`（映射的 Windows COM 口） |
| **文件系统** | 原生 ext4（`/home/`）— 避免在 `/mnt/c/` 下操作以获最佳性能 |
| **行尾** | Git 检出自动使用 LF（与 Linux 一致） |

### 6.2 在 WSL 上使用本项目的串口

```bash
# 1. 在 WSL 内安装依赖
cd ~/projects/mcp-serial
npm install
npm run build

# 2. 查看可用的串口设备
ls -la /dev/ttyS* /dev/ttyUSB* 2>/dev/null

# 3. 运行 (使用 Linux 风格的串口路径)
SERIAL_PORT=/dev/ttyUSB0 SERIAL_BAUDRATE=115200 npm start

# 或通过 MCP 配置
# "env": { "SERIAL_PORT": "/dev/ttyUSB0", "SERIAL_BAUDRATE": "115200" }
```

### 6.3 WSL 串口映射对照

| Windows COM | WSL 设备路径 | 说明 |
|-------------|-------------|------|
| `COM1` | `/dev/ttyS0` | 内置串口 1 |
| `COM2` | `/dev/ttyS1` | 内置串口 2 |
| `COM3` | `/dev/ttyS2` | 内置串口 3 |
| USB 串口 | `/dev/ttyUSB0` | USB-to-Serial 适配器 (需要 usbipd-win) |

> 💡 **推荐**: 在 WSL 中使用 USB 串口适配器（如 CH340、CP2102），
> 通过 [usbipd-win](https://github.com/dorssel/usbipd-win) 挂载后为 `/dev/ttyUSB0`，
> 体验与原生 Linux 完全一致。

### 6.4 跨平台验证清单

每次提交前检查：

- [ ] `npm run build` 在 WSL/Ubuntu 上通过
- [ ] `npm run build` 在 Windows (pwsh) 上通过
- [ ] 无 `cmd.exe` 专属命令（`copy`、`xcopy`、`dir` 等）
- [ ] 无 Windows 硬编码路径（`C:\`、`\` 分隔符）
- [ ] 无 `process.platform` 分支判断（除非绝对必要）
- [ ] `.gitattributes` 已覆盖新增文件类型
- [ ] 串口路径使用环境变量配置，而非硬编码

### 6.5 为什么不需要 WSL→Windows 端口转发

本项目是**纯 Node.js MCP 服务器**，通过 **stdio** 与宿主通信：

```
Cline/Claude  ←→  stdin/stdout  ←→  mcp-serial (Node.js)  ←→  串口设备
```

- MCP 协议通过标准输入输出传输，不依赖 TCP 端口
- Web 监视器（HTTP）在 WSL 内监听，WSL2 自动转发到 `localhost`
- 串口访问通过 Linux 内核直接操作，不经过 Windows 驱动层

所以本项目在 WSL 中是**完全原生运行**，不存在"调 Win11 端口"的问题。

---

*最后更新: 2026-05-26*

