// ============================================================================
//  启动自检（smoke）：真的会失败的那种
//  —— 起一次 build/index.js，等启动横幅，并断言横幅里的版本号 == package.json 版本。
//  为什么不用 `timeout 5 node build/index.js || true`：`|| true` 会把一切错误吞掉，
//  那种"自检"永远绿，等于没验。
//  用法：npm run smoke
// ============================================================================
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const wantVersion = pkg.version;
const TIMEOUT_MS = 20000;

const child = spawn(process.execPath, ["build/index.js"], {
  env: {
    ...process.env,
    // 自检不碰真实串口、不开浏览器、监听随机端口（0 → 系统分配）
    SERIAL_AUTO_CONNECT: "false",
    WEB_AUTO_OPEN: "false",
    WEB_PORT: "0",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let out = "";
const collect = (d) => { out += d.toString(); };
child.stdout.on("data", collect);
child.stderr.on("data", collect);

const fail = (msg) => {
  try { child.kill(); } catch { /* ignore */ }
  console.error(`SMOKE FAIL: ${msg}`);
  console.error("---- 进程输出 ----\n" + out.split("\n").slice(-25).join("\n"));
  process.exit(1);
};

const timer = setTimeout(() => fail(`启动超时（${TIMEOUT_MS} ms）内没看到启动横幅`), TIMEOUT_MS);

let versionLine = null;
let webLine = null;
const poll = setInterval(() => {
  if (!versionLine) {
    const m = out.match(/\[MCP\] Serial Terminal v([0-9][^\s(]*)/);
    if (m) versionLine = m[1];
  }
  if (!webLine) {
    const m = out.match(/\[WebServer\] 串口实时终端: (http:\/\/\S+)/);
    if (m) webLine = m[1];
  }
  if (versionLine && webLine) {
    clearInterval(poll);
    clearTimeout(timer);
    if (versionLine !== wantVersion) {
      fail(`启动横幅里的版本 ${versionLine} 与 package.json 的 ${wantVersion} 不一致（构建产物过期？）`);
      return;
    }
    console.log(`SMOKE PASS: 版本 ${versionLine}，Web 服务 ${webLine}`);
    try { child.kill(); } catch { /* ignore */ }
    process.exit(0);
  }
}, 100);

child.on("exit", (code) => {
  if (versionLine && webLine) return;               // 正常收尾
  clearInterval(poll);
  clearTimeout(timer);
  fail(`进程提前退出（code=${code}）`);
});
