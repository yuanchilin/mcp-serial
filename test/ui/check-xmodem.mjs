// 针对性检查：XMODEM 传输（端到端，免硬件）
//  · 页面驱动一次真传输（假板子按规范接收，且故意每 3 块 NAK 一次 → 必须重传后成功）
//  · 校验：接收到的（补位后）内容 SHA256 == 本地按同规则算出的 SHA256
//  · 并发保护：传输中普通 /send-file 必须 409
//  · 取消：/xmodem-cancel 能让传输干净失败
//  · 校验和模式：arm(crc=0) 时自动检测为 8 位校验和
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';

const PORT = 9799;   // 注意：别和本地手动起的夹具（9791）撞端口
const FIX = 'test/ui/.fixtures';
mkdirSync(FIX, { recursive: true });
const HELPER = `http://127.0.0.1:${PORT + 1}`;
const BASE = `http://127.0.0.1:${PORT}`;

const srv = spawn(process.execPath, ['test/ui/devserver.mjs'], {
  env: { ...process.env, DEV_PORT: String(PORT) }, stdio: ['pipe', 'pipe', 'pipe'],
});
srv.stderr.on('data', () => {});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
for (let t0 = Date.now(); Date.now() - t0 < 15000;) {
  try { const r = await fetch(`${BASE}/status`); if (r.ok) break; } catch (_) {}
  await wait(200);
}

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
/** 与 XMODEM 末块补位规则一致：补齐到 128 的整数倍，补 0x1A */
const pad128 = (src) => {
  const rest = src.length % 128;
  if (rest === 0) return Buffer.from(src);
  return Buffer.concat([src, Buffer.alloc(128 - rest, 0x1a)]);
};

/** 生成 4 KB 伪随机但确定的固件样本 */
const src = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 97 + (i >> 3)) & 0xff));
const srcPath = `${FIX}/xmodem-src.bin`;
writeFileSync(srcPath, src);

const results = [];
const ok = (name, pass, detail) => { results.push(pass); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`); };
const boardState = async (port = 'COM-ECHO') => (await (await fetch(`${HELPER}/board/state?port=${port}`)).json());
const armBoard = (q) => fetch(`${HELPER}/board/arm?port=COM-ECHO&${q}`, { method: 'POST' }).then((r) => r.json());
const waitDone = async (ms = 30000) => {
  for (let t0 = Date.now(); Date.now() - t0 < ms;) {
    const st = await boardState();
    if (st.done) return st;
    await wait(200);
  }
  return await boardState();
};
/**
 * 等条件成立（成立时返回那次取值，超时返回最后一次取值）。
 * 用来取代"固定 sleep"：选完文件到服务端真的进入传输态，慢机器 / 无头浏览器上要几百 ms 到数秒，
 * 固定 sleep 会假失败（这条曾经让 CI 挂掉）。
 */
const until = async (fn, ms = 15000, step = 100) => {
  const t0 = Date.now();
  let v = await fn();
  while (!v && Date.now() - t0 < ms) { await wait(step); v = await fn(); }
  return v;
};
/** 服务端对该端口的视角（客户端数 / 当前控制端） */
const serverCtrl = async () => (await (await fetch(`${BASE}/status?port=COM-ECHO`)).json());
/** 看门狗：「一直等」+ 无限重传本身可以永不返回，但测试脚本不许跟着一起挂死 */
const watchdog = setTimeout(() => { console.error('看门狗：测试超过 300s 未结束，判失败'); process.exit(1); }, 300000);
watchdog.unref?.();

const UI_CHANNEL = process.env.UI_BROWSER || '';
const browser = await chromium.launch(UI_CHANNEL ? { channel: UI_CHANNEL } : {});
try {
  // ---------- ① 页面驱动的 XMODEM-CRC 传输（每 3 块故意 NAK 一次）----------
  const p = await browser.newPage({ viewport: { width: 1100, height: 760 } });
  await p.goto(`${BASE}/`, { waitUntil: 'load' });
  // 等"服务端已经看到这个页面"再抢控制权，抢完再等控制权真的落地 —— 后续直连 API 全靠这个 cid
  const registered = await until(async () => (await serverCtrl()).clientCount > 0, 20000);
  const cid = await p.evaluate(() => sessionStorage.getItem('xtermCid'));   // 控制端身份（后续直接调 API 要用）
  await p.evaluate(() => window.forceControl());
  const gotCtrl = await until(async () => (await serverCtrl()).controllerClientId === cid, 15000);
  ok('① 页面拿到该端口控制权（后面直连 API 都用这个 cid）',
    registered === true && !!cid && gotCtrl === true,
    JSON.stringify({ registered, cid, gotCtrl }));
  await armBoard('crc=1&nakEvery=3');

  // ---------- ①' 监视端页面：不该出现发送进度框（尤其别人传输失败/取消之后）----------
  const M = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await M.goto(`${BASE}/`, { waitUntil: 'load' });
  await wait(2600);
  await M.evaluate(() => {
    const sel = document.getElementById('ps');
    if (![...sel.options].some((o) => o.value === 'COM-ECHO')) {
      const o = document.createElement('option');
      o.value = 'COM-ECHO'; o.dataset.base = 'COM-ECHO'; o.textContent = 'COM-ECHO';
      sel.appendChild(o);
    }
  });
  if (!(await M.evaluate(() => !!(cur && cur.connected)))) {
    await M.evaluate(() => { const s = document.getElementById('ps'); s.value = 'COM-ECHO'; s.dispatchEvent(new Event('change')); });
    await wait(2000);
  }
  const monState = (pg) => pg.evaluate(() => ({
    connected: !!(cur && cur.connected),
    isCtrl: !!(cur && cur.isController),
    progHidden: document.getElementById('fileProg').hidden,
    cancelDisabled: document.getElementById('cancelSendBtn').disabled,
  }));
  await until(async () => (await monState(M)).connected === true, 15000);
  const m1 = await monState(M);
  ok('① 监视端页面：不发进度框、取消按钮置灰（本来就不该能发）',
    m1.connected === true && m1.isCtrl === false && m1.progHidden === true && m1.cancelDisabled === true,
    JSON.stringify(m1));

  await p.evaluate(() => window.pickXmodemFile());         // 走 XMODEM 分支
  await p.setInputFiles('#filePick', srcPath);             // 触发 change → 体检 → 传输
  // 等"传输真的开始了"再断言 409：板子收到字节 == 服务端确实在传（固定 sleep 在无头浏览器上会假失败）
  const started = await until(async () => (await boardState()).bytes > 0, 20000);
  // 传输进行中：普通发送必须被拒绝（两条字节流不能混）
  const busy = await p.evaluate(async () => {
    const r = await fetch(location.origin + '/send-file?clientId=' + encodeURIComponent(sessionStorage.getItem('xtermCid')) + '&port=COM-ECHO',
      { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: new Uint8Array([1, 2, 3]) });
    return { status: r.status, body: await r.text() };
  });  ok('① 传输进行中：普通 /send-file 被拒绝（409，避免字节流互相污染）',
    started === true && busy.status === 409 && /XMODEM/.test(busy.body), JSON.stringify({ started, ...busy }));

  const st = await waitDone(40000);
  await wait(900);   // 等 HTTP 响应回到页面（完成 toast 是那一刻才发的）
  const expectHash = sha256(pad128(src));
  ok('① 页面驱动的 XMODEM-CRC 传输完成，且接收内容与源文件（按补位规则）逐字节一致',
    st.done === true && st.crc === true && st.bytes === pad128(src).length && st.sha256 === expectHash,
    JSON.stringify({ done: st.done, crc: st.crc, blocks: st.blocks, naks: st.naks, bytes: st.bytes, 期望字节: pad128(src).length }));
  ok('① 故意制造的 NAK 触发了重传，且最终仍然完整（NAK 次数 > 0）',
    st.naks >= 1 && st.crcErrors === 0,
    JSON.stringify({ naks: st.naks, crcErrors: st.crcErrors, blocks: st.blocks }));

  const ui = await p.evaluate(() => ({
    toast: [...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | '),
    progName: document.getElementById('fileProgName').textContent,
    progText: document.getElementById('fileProgText').textContent,
    rate: document.getElementById('fileRate').textContent,
  }));
  ok('① UI 侧有进度与完成反馈（进度条信息 + 完成 toast）',
    /XMODEM/.test(ui.progName) && /完成/.test(ui.toast + ui.rate),
    JSON.stringify(ui).slice(0, 300));
  const m2 = await monState(M);
  ok('① 别人传输完成后，监视端也没有残留进度框', m2.progHidden === true, JSON.stringify(m2));
  // 注意：P 必须一直开着 —— 关掉它，宽限期过后控制权会自动移交到 M（监视端），后面的 API 调用就会 403

  // ---------- ② 校验和模式（对端以 NAK 握手 → 自动退回 8 位校验和）----------
  await armBoard('crc=0&nakEvery=0');
  const direct = await fetch(`${BASE}/xmodem-send?clientId=${encodeURIComponent(cid)}&port=COM-ECHO&mode=auto&label=probe.bin`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: src,
  });
  const dres = await direct.json();
  const st2 = await boardState();
  ok('② 对端用 NAK 握手时自动走 8 位校验和，并传完（内容一致）',
    direct.status === 200 && dres.ok === true && dres.crc === false && st2.sha256 === sha256(pad128(src)),
    JSON.stringify({ status: direct.status, crc: dres.crc, bytes: dres.sentBytes, blocks: st2.blocks }));

  // ---------- ③ 取消：长传输中途取消要干净失败 ----------
  await armBoard('crc=1&nakEvery=1');                     // 每块都先 NAK 一次 → 拉长传输
  const big = Buffer.concat([src, src, src, src]);        // 16 KB
  const inflight = fetch(`${BASE}/xmodem-send?clientId=${encodeURIComponent(cid)}&port=COM-ECHO&mode=crc&label=big.bin`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: big,
  }).then((r) => r.json()).catch((e) => ({ fetchError: String(e) }));
  await wait(900);
  const tCancel = Date.now();
  const cancel = await fetch(`${BASE}/xmodem-cancel`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ port: 'COM-ECHO', clientId: cid }),
  }).then((r) => r.json());
  const cres = await inflight;
  const cancelMs = Date.now() - tCancel;
  await wait(400);
  const st3 = await boardState();
  ok('③ 取消生效：传输以"已取消"失败，且没有把 16 KB 传完',
    cancel.cancelled === true && cres.ok === false && /取消/.test(cres.error || '') && st3.done === false,
    JSON.stringify({ cancel, err: cres.error, done: st3.done, blocks: st3.blocks }));
  ok('③ 取消要"立刻"生效（不能让协议枯等到本块超时 3s）',
    cancelMs < 1500, `从点取消到传输结束 ${cancelMs} ms`);

  // 收尾：取消后端口应恢复可用（并发锁要释放）
  const after = await fetch(`${BASE}/status?port=COM-ECHO`).then((r) => r.json());
  ok('③ 取消后并发锁释放（端口仍可用）', after.connected === true, JSON.stringify({ connected: after.connected }));

  // 你报的 bug：别人传输失败后，监视端一直挂着"发送失败"的框
  await wait(5600);   // 等过兜底收起时间（5s）
  const m3 = await monState(M);
  const m3txt = await M.evaluate(() => document.getElementById('fileRate').textContent);
  ok('③ 别人传输失败/取消后，监视端不会一直挂着"失败"框',
    m3.progHidden === true, JSON.stringify({ ...m3, fileRate: m3txt }));
  await M.close();

  // ---------- ④ 「一直等」：对端还没进接收模式就开始发，2.5 秒后才回应也必须传完 ----------
  await fetch(`${HELPER}/board/disarm?port=COM-ECHO`, { method: 'POST' });
  await wait(300);
  const src4 = Buffer.from(Array.from({ length: 1200 }, (_, i) => (i * 11) & 0xff));
  const inflight4 = fetch(`${BASE}/xmodem-send?clientId=${encodeURIComponent(cid)}&port=COM-ECHO&mode=auto&retries=0&handshakeMs=0&label=wait.bin`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: src4,
  }).then((r) => r.json()).catch((e) => ({ fetchError: String(e) }));
  await wait(2500);                       // 这段时间对端一直没回应：发送端必须"一直等"
  const waiting = await fetch(`${BASE}/status?port=COM-ECHO`).then((r) => r.json());
  await armBoard('crc=1&nakEvery=0');     // 现在才让对端进入接收模式
  const r4 = await inflight4;
  const st4 = await boardState();
  ok('④ 「一直等」：对端晚 2.5 秒才回应也照样传完（不再握手超时放弃）',
    waiting.connected === true && r4.ok === true && st4.done === true && st4.sha256 === sha256(pad128(src4)),
    JSON.stringify({ ok: r4.ok, err: r4.error, blocks: st4.blocks, bytes: st4.bytes }));

  // ---------- ⑤ 页面点「取消发送」：要立刻停 + 立刻收起进度框 ----------
  const p2 = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await p2.goto(`${BASE}/`, { waitUntil: 'load' });
  const cid2 = await p2.evaluate(() => sessionStorage.getItem('xtermCid'));
  await until(async () => (await serverCtrl()).clientCount >= 2, 20000);   // 等这一页也被服务端看到
  await p2.evaluate(() => window.forceControl());
  await until(async () => (await serverCtrl()).controllerClientId === cid2, 15000);
  await armBoard('crc=1&nakEvery=1');                 // 每块先 NAK 一次 → 传得慢，留出取消的时间
  const bigPath = `${FIX}/xmodem-big.bin`;
  writeFileSync(bigPath, Buffer.concat([src, src, src]));
  await p2.evaluate(() => window.pickXmodemFile());
  await p2.setInputFiles('#filePick', bigPath);
  // 先确认"确实在传"（页面在传 + 板子已收到字节），否则取消按钮点了会立刻返回、测出来的 0ms 是假的
  const running = await until(async () => {
    const ui = await p2.evaluate(() => ({
      sending: !!sending,
      visible: !document.getElementById('fileProg').hidden,
      rate: document.getElementById('fileRate').textContent,
    }));
    return (ui.sending && ui.visible && (await boardState()).bytes > 0) ? ui : null;
  }, 20000);
  const cancelUi = await p2.evaluate(async () => {
    const t0 = performance.now();
    window.cancelSend();
    for (let i = 0; i < 200; i++) {                   // 最多等 2s
      if (document.getElementById('fileProg').hidden) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    return { ms: Math.round(performance.now() - t0), hidden: document.getElementById('fileProg').hidden };
  });
  ok('⑤ 页面点「取消发送」：立刻停止并收起进度框（≤1s）',
    !!running && running.sending === true && running.visible === true && cancelUi.hidden === true && cancelUi.ms <= 1000,
    JSON.stringify({ 取消前: running, 取消后: cancelUi }));
  await p2.close();

  await p.close();
} finally {
  clearTimeout(watchdog);
  await browser.close();
  srv.kill();
}
const fail = results.filter((x) => !x).length;
console.log(`\nXMODEM 检查：${results.length - fail} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
