// 针对性检查：固件体检（bin / Intel HEX / SREC）——识别、地址范围、校验、发送前确认、不影响发送内容
// 只跑这一个脚本（不跑全量套件）
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const PORT = 9781;
const FIX = 'test/ui/.fixtures';
mkdirSync(FIX, { recursive: true });

// ---------- 用独立算法（不抄被测代码）构造样本 ----------
const hexRec = (type, addr, data) => {
  const b = [data.length, (addr >> 8) & 0xff, addr & 0xff, type, ...data];
  b.push((0x100 - (b.reduce((a, x) => a + x, 0) & 0xff)) & 0xff);
  return ':' + b.map(x => x.toString(16).toUpperCase().padStart(2, '0')).join('');
};
const srecRec = (type, addr, addrLen, data) => {
  const ab = []; for (let i = addrLen - 1; i >= 0; i--) ab.push((addr >> (8 * i)) & 0xff);
  const bytes = [ab.length + data.length + 1, ...ab, ...data];
  const cks = (~bytes.reduce((a, x) => a + x, 0)) & 0xff;
  return 'S' + type + [...bytes, cks].map(x => x.toString(16).toUpperCase().padStart(2, '0')).join('');
};
const d16 = Array.from({ length: 16 }, (_, i) => i + 1);
const d8 = [0xAA, 0xBB, 0xCC, 0xDD, 0x11, 0x22, 0x33, 0x44];

const goodHex = [
  hexRec(4, 0, [0x08, 0x00]),            // 基地址 0x08000000
  hexRec(0, 0x0000, d16),                // 16 字节
  hexRec(5, 0, [0x08, 0x00, 0x01, 0xC5]),// 入口 0x080001C5
  hexRec(4, 0, [0x08, 0x01]),            // 基地址 0x08010000（与上段隔 0x10000）
  hexRec(0, 0x0000, d8),                 // 8 字节
  ':00000001FF',
].join('\n') + '\n';
const badCksumHex = goodHex.split('\n').map((l, i) => (i === 1 ? ':' + l.slice(1, -2) + '00' : l)).join('\n');
const badLenHex = [hexRec(4, 0, [0x08, 0x00]), ':0500000001AA55', ':00000001FF'].join('\n') + '\n';
const noEofHex = [hexRec(4, 0, [0x08, 0x00]), hexRec(0, 0x0000, d8)].join('\n') + '\n';
const crlfBomHex = '\uFEFF' + goodHex.replace(/\n/g, '\r\n') + '\r\n';
const contigHex = [hexRec(4, 0, [0x08, 0x00]), hexRec(0, 0x0000, d16), ':00000001FF'].join('\n') + '\n';

const goodSrec = [
  srecRec('0', 0, 2, [...'HDR'].map(c => c.charCodeAt(0))),
  srecRec('3', 0x08000000, 4, d16),
  srecRec('5', 1, 2, []),
  srecRec('7', 0x080001C5, 4, []),
].join('\n') + '\n';
const mixedSrec = [
  srecRec('1', 0x0000, 2, d8),
  srecRec('3', 0x08000100, 4, d8),
  srecRec('7', 0x08000100, 4, []),
].join('\n') + '\n';
const badCountSrec = [
  srecRec('3', 0x08000000, 4, d8),
  srecRec('5', 7, 2, []),
  srecRec('7', 0x08000000, 4, []),
].join('\n') + '\n';

writeFileSync(`${FIX}/good.hex`, goodHex);
writeFileSync(`${FIX}/contig.hex`, contigHex);
writeFileSync(`${FIX}/bad-cksum.hex`, badCksumHex);
writeFileSync(`${FIX}/firmware.bin`, Buffer.from(Array.from({ length: 512 }, (_, i) => (i * 37) & 0xff)));

// ---------- 起夹具服务 ----------
const srv = spawn(process.execPath, ['test/ui/devserver.mjs'], {
  env: { ...process.env, DEV_PORT: String(PORT) }, stdio: ['pipe', 'pipe', 'pipe'],
});
srv.stderr.on('data', () => {});
const wait = (ms) => new Promise(r => setTimeout(r, ms));
for (let t0 = Date.now(); Date.now() - t0 < 15000;) {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/status`); if (r.ok) break; } catch (_) {}
  await wait(200);
}
const base = `http://127.0.0.1:${PORT}`;
const recvBytes = async () => (await (await fetch(`${base}/status?port=COM-ECHO`)).json()).stats.totalBytes;

const results = [];
const ok = (name, pass, detail) => { results.push(pass); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`); };

// 浏览器：CI 用 playwright 自带的 chromium；本机想用系统 Edge 就设 UI_BROWSER=msedge
const UI_CHANNEL = process.env.UI_BROWSER || '';
const browser = await chromium.launch(UI_CHANNEL ? { channel: UI_CHANNEL } : {});
try {
  const p = await browser.newPage({ viewport: { width: 1100, height: 760 } });
  await p.goto(`${base}/`, { waitUntil: 'load' });
  await wait(2500);
  await p.evaluate(() => window.forceControl());
  await wait(1200);

  // ---------- 页内纯函数：识别 / 地址 / 校验 ----------
  const pure = await p.evaluate((s) => {
    const r = (t) => {
      const x = inspectFirmwareText(t);
      return { kind: x.kind, bytes: x.bytes, segs: x.ranges.length, gaps: x.gaps.length, gap0: x.gaps[0] || null,
        entry: x.entry, aw: x.addrWidth, errs: x.errors, warns: x.warnings,
        start: x.ranges[0] ? x.ranges[0].start : null, end: x.ranges.length ? x.ranges[x.ranges.length - 1].end : null };
    };
    return { good: r(s.goodHex), badCk: r(s.badCksumHex), badLen: r(s.badLenHex), noEof: r(s.noEofHex),
      crlf: r(s.crlfBomHex), goodS: r(s.goodSrec), mixedS: r(s.mixedSrec), badCntS: r(s.badCountSrec),
      bin: r('\u0000\u0001\uFFFD\u0002binary\u0000'), empty: r('   \n  '), colonBad: r(':zzzz\n:00000001FF\n') };
  }, { goodHex, badCksumHex, badLenHex, noEofHex, crlfBomHex, goodSrec, mixedSrec, badCountSrec });

  ok('HEX：识别 + 数据量 + 两段地址 + 入口',
    pure.good.kind === 'hex' && pure.good.bytes === 24 && pure.good.segs === 2
    && pure.good.start === 0x08000000 && pure.good.end === 0x08010008 && pure.good.entry === 0x080001C5
    && pure.good.errs.length === 0, JSON.stringify(pure.good));
  ok('HEX：地址空洞被算出（0x08000010–0x08010000）',
    pure.good.gaps === 1 && pure.good.gap0.start === 0x08000010 && pure.good.gap0.end === 0x08010000,
    JSON.stringify(pure.good.gap0));
  ok('HEX：单行校验和错 → 报行号',
    pure.badCk.errs.length === 1 && /第 2 行校验和错误/.test(pure.badCk.errs[0]), JSON.stringify(pure.badCk.errs));
  ok('HEX：长度字段不符 → 报错',
    pure.badLen.errs.some(e => /长度字段/.test(e)), JSON.stringify(pure.badLen.errs));
  ok('HEX：缺结束记录 → 告警（不算错误）',
    pure.noEof.errs.length === 0 && pure.noEof.warns.some(w => /结束记录/.test(w)), JSON.stringify(pure.noEof.warns));
  ok('HEX：CRLF + BOM + 末尾空行 → 照样正确',
    pure.crlf.kind === 'hex' && pure.crlf.bytes === 24 && pure.crlf.errs.length === 0, JSON.stringify(pure.crlf.errs));
  ok('HEX：: 开头的坏行 → 判为 HEX 但报错',
    pure.colonBad.kind === 'hex' && pure.colonBad.errs.length >= 1, JSON.stringify(pure.colonBad.errs));

  ok('SREC：识别 + 32 位地址 + 入口',
    pure.goodS.kind === 'srec' && pure.goodS.aw === 32 && pure.goodS.bytes === 16
    && pure.goodS.entry === 0x080001C5 && pure.goodS.errs.length === 0, JSON.stringify(pure.goodS));
  ok('SREC：S1/S3 混用 → 告警',
    pure.mixedS.kind === 'srec' && pure.mixedS.warns.some(w => /地址宽度混用/.test(w)) && pure.mixedS.errs.length === 0,
    JSON.stringify(pure.mixedS.warns));
  ok('SREC：S5 计数与实际不符 → 告警',
    pure.badCntS.warns.some(w => /计数记录/.test(w)), JSON.stringify(pure.badCntS.warns));

  ok('二进制：判为 bin（不误判成文本格式）', pure.bin.kind === 'bin', JSON.stringify(pure.bin.kind));
  ok('空文件：判为 empty', pure.empty.kind === 'empty', JSON.stringify(pure.empty.kind));

  // ---------- UI：选文件后的体检提示 ----------
  const info = () => p.evaluate(() => {
    const el = document.getElementById('fwInfo');
    return { hidden: el.hidden, cls: el.className, text: el.textContent };
  });
  await p.setInputFiles('#filePick', `${FIX}/good.hex`);
  await p.waitForTimeout(2500);
  const i1 = await info();
  ok('UI：合法但分段 HEX → 黄提示（地址空洞要点出来，不算错误）',
    i1.hidden === false && i1.cls === 'fw-info warn' && /Intel HEX/.test(i1.text)
    && /0x08000000/.test(i1.text) && /校验通过/.test(i1.text) && /2 段/.test(i1.text)
    && /空洞/.test(i1.text) && /入口 0x080001C5/.test(i1.text), JSON.stringify(i1).slice(0, 200));
  await p.screenshot({ path: 'test-results/ui/ui-fwinfo.png' });
  const fwToast = await p.evaluate(() => [...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | '));
  ok('UI：体检结论同时给一条摘要提示（侧栏滚动/窄屏时也看得见）',
    /good\.hex/.test(fwToast) && /Intel HEX/.test(fwToast), fwToast);

  await p.setInputFiles('#filePick', `${FIX}/contig.hex`);
  await p.waitForTimeout(2000);
  const i1b = await info();
  ok('UI：连续镜像 HEX → 绿提示（无告警）',
    i1b.cls === 'fw-info ok' && /1 段/.test(i1b.text) && !/空洞/.test(i1b.text) && /校验通过/.test(i1b.text),
    i1b.text.split('\n')[0]);

  const beforeHex = await recvBytes();
  await p.setInputFiles('#filePick', `${FIX}/good.hex`);
  await p.waitForTimeout(2500);
  const afterHex = await recvBytes();
  ok('UI：识别不改变发送内容（服务端收到字节数 == 文件大小）',
    afterHex - beforeHex === Buffer.byteLength(goodHex),
    `${afterHex - beforeHex} vs 文件 ${Buffer.byteLength(goodHex)}`);

  await p.setInputFiles('#filePick', `${FIX}/firmware.bin`);
  await p.waitForTimeout(2000);
  const i2 = await info();
  ok('UI：bin → 提示"裸二进制 / 不含地址信息"',
    /裸二进制/.test(i2.text) && /不含地址信息/.test(i2.text) && !/Intel HEX/.test(i2.text), i2.text.split('\n')[0]);

  // ---------- 严重错误：发送前必须确认一次 ----------
  const beforeBad = await recvBytes();
  await p.setInputFiles('#filePick', `${FIX}/bad-cksum.hex`);
  await p.waitForTimeout(1200);
  const dlg = await p.evaluate(() => ({
    open: document.getElementById('confirmBox').classList.contains('open'),
    title: document.getElementById('cfTitle').textContent,
    msg: document.getElementById('cfMsg').textContent,
    yes: document.getElementById('cfYes').textContent,
    info: document.getElementById('fwInfo').className,
  }));
  ok('UI：校验错的文件 → 红提示 + 发送前弹确认（还没发出任何字节）',
    dlg.open === true && /校验\/格式错误/.test(dlg.title) && dlg.yes === '仍然发送'
    && /err/.test(dlg.info) && (await recvBytes()) === beforeBad,
    JSON.stringify({ dlg: dlg.title, recvUnchanged: (await recvBytes()) === beforeBad }));

  await p.evaluate(() => window.cfAnswer(false));      // 取消
  await p.waitForTimeout(1200);
  ok('UI：点「取消发送」→ 一个字节都没发出去',
    (await recvBytes()) === beforeBad, `recv=${await recvBytes()} before=${beforeBad}`);

  await p.setInputFiles('#filePick', `${FIX}/bad-cksum.hex`);
  await p.waitForTimeout(1200);
  await p.evaluate(() => window.cfAnswer(true));        // 仍然发送
  await p.waitForTimeout(2500);
  ok('UI：点「仍然发送」→ 原样发出（字节数增加 == 文件大小）',
    (await recvBytes()) - beforeBad === Buffer.byteLength(badCksumHex),
    `${(await recvBytes()) - beforeBad} vs 文件 ${Buffer.byteLength(badCksumHex)}`);

  const afterSend = await p.evaluate(() => ({
    btn: document.getElementById('sendFileBtn').disabled,
    kb: document.getElementById('chunkKB').disabled,
    delay: document.getElementById('chunkDelay').disabled,
  }));
  ok('UI：发完之后按钮与参数按角色恢复（控制端 → 仍可用）',
    afterSend.btn === false && afterSend.kb === false && afterSend.delay === false, JSON.stringify(afterSend));

  await p.close();
} finally {
  await browser.close();
  srv.kill();
}
const fail = results.filter(x => !x).length;
console.log(`\n固件体检检查：${results.length - fail} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
