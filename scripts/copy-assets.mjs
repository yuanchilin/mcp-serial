import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");
const buildDir = join(root, "build");
const xtermPkg = join(root, "node_modules", "@xterm", "xterm");

// 复制 Web 终端 HTML
cpSync(join(srcDir, "viewer.html"), join(buildDir, "viewer.html"));
cpSync(join(srcDir, "multi.html"), join(buildDir, "multi.html"));

// 保留入口可执行权限
chmodSync(join(buildDir, "index.js"), 0o755);

// 复制 xterm 静态资源到 build/vendor/xterm
const vendorOut = join(buildDir, "vendor", "xterm");
mkdirSync(vendorOut, { recursive: true });

const files = [
  ["css/xterm.css", "xterm.css"],
  ["lib/xterm.js", "xterm.js"],
  ["lib/xterm.mjs", "xterm.mjs"],
];

let copiedXterm = false;
for (const [srcRel, destName] of files) {
  const src = join(xtermPkg, srcRel);
  if (existsSync(src)) {
    copyFileSync(src, join(vendorOut, destName));
    copiedXterm = true;
  }
}

if (!copiedXterm) {
  console.warn("[copy-assets] 警告: 未找到 @xterm/xterm 静态资源，请先执行 npm install");
}

console.log("[copy-assets] viewer.html 和 xterm 静态资源已复制到 build/");
