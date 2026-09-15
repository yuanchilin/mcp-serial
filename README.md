# mcp-serial

MCP 串口终端服务器 — 持久化串口通信 + Web 实时监视器。

## 功能特性

- **持久化串口** — 一次打开，持续缓冲，`serial_read` 增量读取
- **多串口并行、互不干扰** — 一个进程同时打开多路串口，每路独立持有串口/缓冲区/读游标/控制端/客户端/统计；数据类操作**必须显式指定 `port`**（多路时省略即报错并列出候选，绝不静默发错口）；控制权按端口独立，已有控制端的端口不会被新 clientId 夺走
- **端口可见性（仅本机可见）** — **本机持有该端口控制权**时可把端口标记为私有：**远程客户端看不到也连不上**（列表/状态里不出现、订阅与操作一律 404，连存在性都不暴露），切换瞬间断开该端口上已有的远程连接；本机监视端看得到开关但改不了；标记**落盘保存**（默认 `%APPDATA%\mcp-serial\private-ports.json` 或 `~/.config/mcp-serial/private-ports.json`）
- **Web 实时终端** — 浏览器串口终端 `http://localhost:9721`：左侧设置栏（端口 / 波特率 / 控制权 / 实时统计）+ 顶栏状态徽标，控制权分级（🎮 控制端 / 👁 监视端，可申请 / 强制接管）
- **界面自适应** — 宽屏侧栏可一键收起（状态本地记忆），窄屏（≤980px）自动收成抽屉；点击区 ≥28px，文字对比度 ≥4.5:1（WCAG AA）
- **终端外观** — 深色 / 亮色 / 护眼 / 高对比四套配色（界面与终端一起换）+ 字号增减（也支持 Ctrl+滚轮），选择记在浏览器本地
- **浏览器发文件** — 侧栏「发送文件」把**浏览器所在机器**上的文件按块（默认 16KB，可调块间延时）原始字节直写串口，用于灌固件 / HEX / SREC，带进度与取消
- **XMODEM 传输** — 侧栏「XMODEM 发送…」用 XMODEM / XMODEM-CRC / XMODEM-1K 协议推文件（适合只吃 XMODEM 的 bootloader）：逐块等 ACK、超时或校验错自动重传、末块自动补位、1K 被拒自动退回 128B；进度（块号/重传/速率）实时显示、可随时取消；同一端口同时只允许一个传输（传输期间普通发送会被拒绝）。MCP 侧对应 `serial_xmodem_send`
- **终端内容从空开始、历史按需载入** — 新建 WebSocket 连接**默认不补发**缓冲历史（新窗口 / 刷新后是空终端，「清屏」因此是纯窗口行为）；要看服务端缓冲内容点侧栏「载入历史缓冲」（等价于 WS `&replay=1`）
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
| 侧栏 | **端口下拉（就是操作端口切换器，选择即切换）** + 刷新、波特率（含「自定义…」）、连接/断开、控制权（当前控制端 + 申请 / 强制接管）、**可见性（仅本机可见，作用于当前这一路）**、清屏 / 复制 / 保存日志 / **载入历史缓冲**、**发送文件**（分块 + 块间延时 + 进度 + 取消）、**XMODEM 发送**（模式选择 + 「一直等」+ 进度 + 取消）、实时统计（已接收 / 缓冲占用 / 数据块 / 运行时长 / 在线客户端） |
| 终端 | xterm.js 真终端，点击后直接键盘输入；仅控制端可发送数据（键盘输入与文件传输同一规则） |

- 「清屏」只清浏览器显示与本地缓存，**不影响服务端环形缓冲区**（服务端用 MCP 工具 `serial_clear_buffer`）；它也是**纯粹的窗口行为**：清完刷新页面不会把历史倒回来（见下条）
- **终端内容默认从空开始，历史按需载入**：页面建立 WebSocket 时**不再自动补发**服务端缓冲历史 —— 新窗口、刷新后的页面一律从空开始（否则「清屏」一刷新就前功尽弃）。想看服务端缓冲里已有的内容，点侧栏的**「载入历史缓冲」**（追加在当前内容之后，并带一条分隔线；串口未连接时置灰）
- **「复制 / 保存日志 / 载入历史缓冲」按状态置灰**：终端还没有任何输出、或刚「清屏」之后，前两个置灰（悬停说明"暂无可复制/可保存的内容"），WS 收到数据后自动恢复；「载入历史缓冲」只在串口未连接时置灰 —— 不让按钮假装可用
- 快捷操作：`Ctrl + 滚轮` 缩放字号
- 指示灯的语义：绿=已连接、黄=连接中/监视端、红=断开（鼠标悬停有说明）
- 控制权与刷新：**刷新页面不会丢控制权**——控制端断开后有 `SERIAL_CONTROL_GRACE_MS`（默认 10s）宽限期，同一 clientId 回连即自动复权；真断开超过宽限期才自动移交给最老的剩余客户端（宽限期内别人仍可「强制接管」，此时原控制端回来也不会抢回）
- ⚠️ **可见性开关只在 `http://127.0.0.1:端口` 下可用**（本机判定 = 回环来源）。用局域网 IP（如 `http://192.168.1.10:9721`）打开的页面会被当作**远程**：看不到私有端口、也切不了开关。这是刻意选的严格口径，避免"同一个地址既算本机又算远程"
- **「仅本机可见」可以在连接之前就设好**：开关作用在**当前选中的那一路**上，端口**没打开也能设**（先把策略定好，打开后对远程即不可见）；只有**已经打开**的那一路才要求是该端口的**本机控制端**（避免本机监视端改在跑端口的暴露状态）。每路的私有状态各自独立、落盘保存，互不影响
- **发送相关控件如实反映角色**：串口未连接、或当前这一路是**监视端**时，「选择文件并发送…」连同**分块 (KB) / 块间延时**两个参数**一起置灰**（悬停说明原因：需要先「申请控制」或「强制接管」），不再是"点下去才弹提示"；取得控制权后一起恢复。**XMODEM 那一组同样按角色置灰**（模式下拉 / 「一直等」/ 「XMODEM 发送…」/ 「取消发送」），而且**监视端根本不会出现发送进度框**——传输进度只推给该端口的**控制端**页面（别人传完、失败或取消，都不会在监视端留下一个「发送失败」的框）。发送途中若丢了控制权或断开，结束后按钮保持灰着（不会无条件恢复）。服务端的 403 校验仍是最终防线
- 发送文件的 HTTP 接口：`POST /send-file?clientId=<控制端 id>`，请求体即原始字节，单块上限 1MB（前端默认 16KB/块）；非控制端返回 403，串口未打开返回 500
- **XMODEM 的 HTTP 接口**：`POST /xmodem-send?clientId=&port=&mode=auto|crc|checksum|1k[&timeoutMs=&handshakeMs=&retries=&pad=&label=]`，请求体即整份文件（≤16MB）；返回 `{ok,sentBytes,retries,blockSize,crc,elapsedMs,error?}`（失败 502）。
  `POST /xmodem-cancel {port,clientId}` 中断进行中的传输；进度通过该端口的 SSE 以 `event: xfer` 推送。
  要点：**同一端口同时只允许一个 XMODEM 传输**，传输期间 `/send`、`/send-file` 一律 409；对端串口**不能开回显**（回显的字节会被当成协议应答）；`auto` 模式由对端的握手字符决定校验方式（`'C'`=CRC16，`NAK`=8 位校验和），`1k` 若连续 3 次被 NAK 会自动退回 128 字节块
  - **「一直等」**：`handshakeMs=0` = 不等超时，一直等对端发出握手字符；`retries=0` = 单块无限重传；两者同时为 `0` 就是**传到成功或被取消为止**（页面「XMODEM 发送」下的复选框「一直等（直到对端回应，或我点取消）」默认勾选，勾上即发这两个 `0`）。`timeoutMs`（单块等 ACK）仍按规定值走，不会跟着变成无限
  - **取消是立刻的**：`POST /xmodem-cancel` 一到达就唤醒正在等应答的那一块（实测 6 ms 内结束，而不是枯等到本块 3s 超时）；页面点「取消发送」同理——按钮立刻变「正在取消…」、进度框立刻收起，不用等协议超时
- **发送前固件体检（只读识别，不改发送内容）**：选中文件后侧栏立刻给出格式与体检结论，颜色分三档（绿=正常 / 黄=有告警 / 红=有校验或格式错误）：
  - `Intel HEX` / `Motorola SREC`（含 S1/S2/S3 地址宽度）/ `裸二进制` / `文本（不是 HEX/SREC）` / `空文件`
  - 数据字节数、记录条数、地址范围与段数、入口地址（HEX 的 03/05、SREC 的 S7/S8/S9）
  - 逐行校验和、长度字段、地址宽度混用、S5/S6 计数一致性、结束记录缺失、**地址空洞**（分段镜像只写有数据的段，这不是错误，会标黄提示）
  - `.bin` 明确提示"不含地址信息 —— 烧写地址由板子 / bootloader 决定"；`.hex`/`.srec` 提示"文本记录格式，对端 bootloader 逐行解析，建议块间延时 10–50 ms"
  - **有校验/格式错误时，发送前必须确认一次**（「仍然发送 / 取消发送」），确认前一个字节都不会发出；良性告警只标黄、不打断
  - 文件超过 8 MB 只做头部判定（前端全量解析大文本会卡界面），提示里会标注"未做完整地址/校验检查"
  - 识别纯粹是提示层：发送依旧是原始字节直写，**文件内容与字节数不受任何影响**
  - 不做：不生成/不转换固件（bin→hex/srec 转换不在此工具范围内，用 `objcopy` / `srec_cat`）
- 终端历史：**默认不补发**（新窗口 / 刷新后从空开始）；需要时由页面显式请求 —— WebSocket `&replay=1`（页面的「载入历史缓冲」按钮走这条路），回放只发给该连接、不是广播。环形缓冲区本身不受影响，agent 的 `serial_read` 游标也不受影响
- **多串口：一个操作端口 + 下拉切换**。界面始终只有一路"操作端口"（终端、侧栏、统计、可见性开关都跟着它），切换就靠侧栏那个**端口下拉框**：
  - 选中的端口**已经在跑** → 只切换显示，**不重连、不断开别的端口**，那一路的终端历史原地保留
  - 选中的端口**没在跑** → 只把它设为"当前操作端口"（终端显示未连接、主按钮变「连接」）；**不会替用户打开端口**，要不要开由你点「连接」
  - 下拉里带 **●** 的项就是当前正在运行的端口；主按钮只有两种语义：当前这一路在跑 = 「断开」，没跑 = 「连接」
  - **刷新（F5 或侧栏「刷新」）不会改选操作端口**：回到上次停留的那一路 —— 它在跑就连上，没在跑就原样停在它上面显示未连接；只有"从没选过端口"时才兜底接上唯一在跑的那一路（不替用户猜端口）
  - 别处（MCP / 另一个页面）打开的端口会自动出现在下拉里（带 ●），但不会自动抢占页面当前显示的那一路
  - 「申请控制 / 强制接管 / 同意或拒绝」都**按端口**生效，作用于当前这一路（多路并存时省略端口会被服务端拒绝）

## MCP 工具

| 工具 | 功能 |
|---|---|
| list_ports | 列出所有可用串口（并标注哪些已被本服务打开） |
| serial_start | 打开一个串口（可同时打开多个，各自独立） |
| serial_stop | 关闭串口：**必须指定 `port`**；要一次全关必须显式 `all: true` |
| serial_read | 增量读取**指定串口**缓冲区的新数据 |
| serial_send | 向指定串口发送命令并等待响应，支持 timeout / line / marker / regex / length 五种结束策略 |
| serial_write | 向指定串口发送原始数据（不追加行尾、不等响应），用于逐字符交互输入 |
| serial_xmodem_send | 用 **XMODEM** 协议把本地文件发给设备（发送方向，适合只吃 XMODEM 的 bootloader）。`mode`：`auto`（按对端握手字符自动选 CRC16 / 8 位校验和）/ `crc` / `checksum` / `1k`；可调 `timeoutMs` / `handshakeMs` / `maxRetries` / `padByte`（`handshakeMs=0` = 一直等对端握手，`maxRetries=0` = 单块无限重传）。逐块等 ACK、超时或 NAK 自动重传（1K 被拒自动退回 128B）。返回成功与否、字节数、重传次数与吞吐；同一端口同时只允许一个传输 |
| serial_send_file | 把一个**文件**按原始字节推给**指定串口**（不追加行尾、不等响应；二进制安全）。用于把固件/HEX/SREC 等整份镜像灌给板子（如 UART 加载器）。可选 `chunkSize` / `chunkDelayMs` / `progressEvery`，返回字节数、耗时与吞吐 |
| serial_status | 查询状态：指定 `port` 看详情；省略则返回所有已打开串口的摘要 |
| serial_clear_buffer | 清空**指定串口**的环形缓冲区 |
| open_web_monitor | 在系统默认浏览器打开 Web 监视器 |

### 多串口寻址规则（不会"猜"端口）

数据类工具（`serial_read` / `serial_send` / `serial_write` / `serial_send_file` / `serial_clear_buffer`）都接受可选 `port`：

| 情况 | 行为 |
|---|---|
| 给了 `port` | 必须已打开；否则报错并列出当前已打开的端口 |
| 省略 `port`，恰好 **1 路**打开 | 使用那一路 |
| 省略 `port`，**0 路**打开 | 报错：请先 `serial_start` |
| 省略 `port`，**≥2 路**打开 | 报错：请显式指定 `port`，并列出候选 |

> 设计原则：**多路时绝不静默回退到某一路**（另一套实现会回退到"环境变量默认串口"，导致命令发错设备）。
> 控制权也是**按端口独立**的：A 口的控制端在 B 口没有权限；已有控制端的端口不会被新 clientId 静默夺走。

`serial_send` 示例：

```json
{ "port": "COM3", "command": "AT\r\n", "timeout": 3000, "responseMode": "line" }
{ "port": "COM3", "command": "AT\r\n", "timeout": 3000, "responseMode": "marker", "endMarker": "OK" }
{ "port": "COM3", "command": "AT\r\n", "timeout": 3000, "responseMode": "regex", "endMarker": "OK|ERROR" }
{ "port": "COM3", "command": "AT\r\n", "timeout": 3000, "responseMode": "length", "expectedLength": 8 }
```

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| SERIAL_PORT | COM3 | 串口名称（单路自动连接用；`serial_start` 省略 `port` 时也用它） |
| SERIAL_BAUDRATE | 115200 | 波特率 |
| SERIAL_AUTO_CONNECT | false | 启动时自动打开 `SERIAL_PORT` 指定的那一路 |
| **SERIAL_PORTS** | (空) | **启动即多开**：`COM3@115200,COM5@9600`（波特率可省略）。设置后以它为准，忽略 `SERIAL_AUTO_CONNECT` |
| WEB_PORT | 9721 | Web 监视器端口 |
| WEB_AUTO_OPEN | false | 启动时自动打开系统默认浏览器（显式设为 true 才开启；默认不打开任何窗口） |
| SERIAL_BUFFER_SIZE | 1048576 | **每路**环形缓冲区最大容量（字节） |
| SERIAL_RESPONSE_STABLE_MS | 2000 | `serial_send` 在 `timeout` 模式下判定响应稳定结束的静默窗口（毫秒）；调大可适配慢速设备 |
| SERIAL_CONTROL_GRACE_MS | 10000 | **控制权宽限期**（毫秒）：控制端连接断开后先保留其控制权，同一 clientId 在宽限期内回连（典型：浏览器刷新）自动复权；超过宽限期才把控制权移交给最老的剩余客户端；`0` = 立即移交（旧行为） |
| SERIAL_PRIVATE_PORTS | (空) | **初始**"仅本机可见"端口：`COM14,COM5`。仅当状态文件**不存在**时作为初始值；之后以界面开关 / 文件为准 |
| SERIAL_PRIVATE_FILE | (空) | 私有端口状态文件路径（默认走 OS 应用数据目录，见「功能特性」） |
| SERIAL_WEB_PASSWORD | (空) | Web 远程访问密码：本机访问免密；远程访问需密码登录（未设置时启动可手动输入一次；留空=免密模式，远程可直接访问） |
| SERIAL_WEB_TOKEN | (空) | 可选访问令牌；设置后 POST/events/WS 需 `Authorization: Bearer` 或 `?token=` |

### HTTP 接口（多串口）

| 接口 | 多串口行为 |
|---|---|
| `GET /status` | 带 `?port=` 返回该路详情；省略时"恰好一路"仍返回旧的扁平结构（向后兼容），0 路或 ≥2 路返回 `{ connected:false, multi, openPorts, ports[] }` 摘要 |
| `GET /ports` | 仍是裸数组，每个设备新增 `open` / `baudRate` 字段 |
| `GET /events` / WebSocket `/?port=` | **按端口订阅**；多路时未指定 `port` 会被拒绝（400 / 关闭连接），不会挂到某一路上。**默认不补发缓冲历史**，加 `&replay=1` 才补发一次 |
| `POST /send`、`/send-file` | 端口可来自 body.port 或 `?port=`；寻址失败 400、非该路控制端 403 |
| `POST /disconnect` | **必须给 `port`**；全关需 `all: true`（不传 port 返回 400 并说明） |
| `POST /request-control`、`/respond-control`、`/force-control` | 按端口生效（body 带 `port`；单路时可省略） |
| `GET /privacy`、`POST /privacy {port, private, clientId}` | **仅本机可访问**（远程一律 404）；设置还要求**是该端口的控制端**（否则 403）。切成私有时断开该端口的远程连接，响应返回 `kicked` 数量 |

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
| `npm run build` | 编译 TypeScript（并把 xterm 与 `viewer.html` 复制进 `build/`） |
| `npm start` | 启动编译后的服务器 |
| `npm test` | 单元测试（`node --test`，会先自动 build） |
| `npm run smoke` | 启动自检：真起一次进程，断言启动横幅里的版本 == `package.json` 版本 |
| `npm run test:ui` | 端到端 UI：A（布局/主题/单实例）+ D（假串口/WS/多路），用 chromium |
| `npm run test:ui:all` | 端到端全套（**含 B 段**：探测本机 `127.0.0.1:9721` 正在运行的实例，只能在你的机器上跑） |
| `npm run test:checks` | 针对性检查：端口切换/角色/F5/清屏回放 + 固件体检 + **XMODEM 端到端**（假板子按规范接收并故意丢块，校验重传后内容一致） |
| `npm run test:all` | 上面能自动跑的全跑一遍（不含 B 段） |
| `npm run watch` | 监听模式自动重编译 |
| `npm run inspector` | 使用 MCP Inspector 调试 |

端到端 UI 需要 Playwright 的浏览器：CI 用自带的 chromium（`npx playwright install chromium`）；
本机想用系统 Edge 就设环境变量 `UI_BROWSER=msedge`。

## CI / 发布

| 流程 | 触发 | 做什么 |
|---|---|---|
| `CI` | push / PR（任何分支） | 单元测试（Node **20 / 22 / 24** 矩阵 + Windows 一份）、启动自检、端到端 UI（A+D 段）与针对性检查 |
| `Release` | 推 `v*` tag，或手动 Run workflow | 版本/tag 校验 → 全量检查全绿 → `npm pack` → 建 GitHub Release 并把 `.tgz` 作为附件（**不依赖任何 npm 凭据**） |
| `Publish npm` | **手动** Run workflow（当前暂停 tag 触发） | 同上检查 → `npm publish`（Trusted Publishing + provenance） |

发布分两条通道，因为 npm 侧的授权可能被账号安全设置卡住：

```bash
# ① 打 tag → GitHub Release（附可直接安装的 .tgz），不需要个人凭据
git tag v2.6.1 && git push origin v2.6.1
npm i -g https://github.com/yuanchilin/mcp-serial/releases/download/v2.6.1/yuanchilin-mcp-serial-2.6.1.tgz

# ② npm 官方（需要 npm 账号授权，见下）—— 目前手动触发
#    Actions → Publish npm → Run workflow（dist-tag 填 latest）
```

> **npm 官方发布的授权前提**（二选一，都需要在 npmjs.com 上操作，且账号若开了 2FA 需通过验证）：
> - **Trusted Publishing（推荐，无需长期 token）**：包 `@yuanchilin/mcp-serial` → Settings → Trusted Publisher → GitHub Actions，
>   owner `yuanchilin`、repository `mcp-serial`、workflow filename `publish.yml`；
>   或在 npm 侧建 **granular access token**（勾 write + 选该包 + 允许绕过 2FA）后更新仓库 secret `NPM_TOKEN`。
> - 完成后再把 `publish.yml` 的 `push: tags` 触发器加回来，"打 tag 即发 npm"就恢复了。
> - 现状备注：该账号当前卡在 WebAuthn 安全密钥二次验证（需本人在设备上按 PIN/指纹），
>   因此日常发布走通道 ①；`publish.yml` 暂时不随 tag 触发，避免每次打 tag 都红一条。

> CI 里的端到端**不跑 B 段**（B 段是"探测本机正在运行的实例"，CI 没有这个对象）；
> 本机验收请用 `npm run test:ui:all`，它包含 B 段。

## 许可证

MIT