// 针对性检查（只验这两个 bug，不跑全量）：
//   ① 下拉切换操作端口时不得顺带打开端口；未连接的端口切走再切回来必须仍是"未连接"
//   ② 多路并存时「强制接管 / 申请控制 / 应答」必须真的生效（都带 port）
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const PORT = 9761;
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
const openPorts = async () => (await (await fetch(`${base}/status`)).json()).openPorts || [];
const controllerOf = async (p) => (await (await fetch(`${base}/status?port=${encodeURIComponent(p)}`)).json()).controllerClientId;

const results = [];
const ok = (name, pass, detail) => { results.push({ name, pass: pass ? 'PASS' : 'FAIL', detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`); };

const addOption = (page) => page.evaluate(() => {
  const sel = document.getElementById('ps');
  for (const p of ['COM-ECHO', 'COM-ECHO2']) {
    if (![...sel.options].some(o => o.value === p)) {
      const o = document.createElement('option'); o.value = p; o.dataset.base = p; o.textContent = p;
      sel.appendChild(o);
    }
  }
});
const pick = (page, p) => page.evaluate((v) => {
  const sel = document.getElementById('ps');
  sel.value = v; sel.dispatchEvent(new Event('change'));
}, p);
const ui = (page) => page.evaluate(() => ({
  ps: document.getElementById('ps').value,
  active: (typeof cur !== 'undefined' && cur) ? cur.port : null,
  connected: (typeof cur !== 'undefined' && cur) ? cur.connected : null,
  isCtrl: (typeof cur !== 'undefined' && cur) ? cur.isController : null,
  cb: document.getElementById('cb').textContent.trim(),
  badge: document.getElementById('badgeText').textContent,
}));

// 浏览器：CI 用 playwright 自带的 chromium；本机想用系统 Edge 就设 UI_BROWSER=msedge
const UI_CHANNEL = process.env.UI_BROWSER || '';
const browser = await chromium.launch(UI_CHANNEL ? { channel: UI_CHANNEL } : {});
try {
  const A = await browser.newPage({ viewport: { width: 1100, height: 700 } });
  await A.goto(`${base}/`, { waitUntil: 'load' });
  await wait(2500);
  await addOption(A);

  // ---------- ① 切换不改连接状态 ----------
  await pick(A, 'COM-ECHO2');                 // 未连接的端口
  await wait(1600);
  const s1 = await ui(A);
  ok('① 选一个未连接的端口 → 不会替用户打开它',
    s1.ps === 'COM-ECHO2' && s1.connected === false && s1.cb === '连接'
    && (await openPorts()).join() === 'COM-ECHO',
    JSON.stringify({ ui: s1, server: await openPorts() }));

  await pick(A, 'COM-ECHO');                  // 切到在跑的那一路
  await wait(1600);
  const s2 = await ui(A);
  ok('① 切到在跑的端口 → 立刻连上视图（只换显示）',
    s2.active === 'COM-ECHO' && s2.connected === true && s2.cb === '断开' && s2.isCtrl === true,
    JSON.stringify(s2));

  await pick(A, 'COM-ECHO2');                 // 再切回来
  await wait(1800);
  const s3 = await ui(A);
  ok('① 切走再切回来：未连接的端口仍是"未连接"（原 bug：这里会变成连接）',
    s3.active === 'COM-ECHO2' && s3.connected === false && s3.cb === '连接'
    && (await openPorts()).join() === 'COM-ECHO',
    JSON.stringify({ ui: s3, server: await openPorts() }));

  await A.evaluate(() => window.tc());        // 用户明确点「连接」才打开
  await wait(2200);
  const s4 = await ui(A);
  ok('① 点「连接」→ 才真的打开（两路并存）',
    s4.connected === true && s4.cb === '断开' && (await openPorts()).sort().join() === 'COM-ECHO,COM-ECHO2',
    JSON.stringify({ ui: s4, server: await openPorts() }));

  // ---------- ② 多路下的强制接管 / 申请 / 应答 ----------
  const B = await browser.newPage({ viewport: { width: 1100, height: 700 } });
  await B.goto(`${base}/`, { waitUntil: 'load' });
  await wait(2500);
  await addOption(B);
  await pick(B, 'COM-ECHO2');                 // 已在跑 → 只接上看（监视端）
  await wait(1800);
  const b1 = await ui(B);
  ok('② 第二页面接上已在跑的端口 → 监视端（不抢控制权）',
    b1.active === 'COM-ECHO2' && b1.isCtrl === false && /监视端/.test(b1.badge),
    JSON.stringify(b1));

  const cidB = await B.evaluate(() => sessionStorage.getItem('xtermCid'));
  const sendState = (pg) => pg.evaluate(() => ({
    btn: document.getElementById('sendFileBtn').disabled,
    btnTitle: document.getElementById('sendFileBtn').title,
    kb: document.getElementById('chunkKB').disabled,
    delay: document.getElementById('chunkDelay').disabled,
    kbTitle: document.getElementById('chunkKB').title,
  }));
  const sendMon = await sendState(B);
  ok('④ 监视端：发送按钮 + 分块/延时参数一起置灰，并说明原因',
    sendMon.btn === true && sendMon.kb === true && sendMon.delay === true
    && /监视端/.test(sendMon.btnTitle) && /监视端/.test(sendMon.kbTitle), JSON.stringify(sendMon));

  await B.evaluate(() => window.forceControl());   // 多路并存时强制接管（原 bug：400）
  await wait(1500);
  const b2 = await ui(B);
  const ctrlAfterForce = await controllerOf('COM-ECHO2');
  const bToast = await B.evaluate(() => [...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | '));
  ok('② 多路并存时「强制接管」生效（服务端控制端换成本页）',
    ctrlAfterForce === cidB && b2.isCtrl === true && /控制端/.test(b2.badge) && /强制接管/.test(bToast),
    JSON.stringify({ ctrl: String(ctrlAfterForce).slice(0, 8), mine: String(cidB).slice(0, 8), badge: b2.badge, toast: bToast }));

  const sendCtrl = await sendState(B);
  ok('④ 接管成功后：发送按钮与参数一起恢复可用',
    sendCtrl.btn === false && sendCtrl.kb === false && sendCtrl.delay === false, JSON.stringify(sendCtrl));

  // 申请控制：B 在 COM-ECHO 上是监视端（A 是控制端），申请后由 A 同意
  await pick(A, 'COM-ECHO');                  // A 保持在 COM-ECHO（控制端）
  await wait(1500);
  await pick(B, 'COM-ECHO');
  await wait(1800);
  const ctrlBeforeReq = await controllerOf('COM-ECHO');
  await B.evaluate(() => window.requestControl());
  await wait(1500);
  const dlg = await A.evaluate(() => ({
    open: document.getElementById('ctrlDialog').classList.contains('open'),
    msg: document.getElementById('ctrl-msg').textContent,
  }));
  ok('② 「申请控制」把请求送到该端口的控制端（含端口名）',
    dlg.open === true && /COM-ECHO/.test(dlg.msg), JSON.stringify({ dlg, ctrlBeforeReq: String(ctrlBeforeReq).slice(0, 8) }));

  await A.evaluate(() => window.respondControl(true));   // 控制端同意（应答也带 port）
  await wait(1500);
  const ctrlAfterResp = await controllerOf('COM-ECHO');
  ok('② 控制端「同意」后控制权真的转给申请人',
    ctrlAfterResp === cidB, JSON.stringify({ ctrl: String(ctrlAfterResp).slice(0, 8), mine: String(cidB).slice(0, 8) }));

  await B.close();

  // ---------- ③ F5（浏览器刷新）不得改选操作端口 ----------
  await pick(A, 'COM-ECHO');                  // 停在 COM-ECHO（在跑）
  await wait(1600);
  await A.reload({ waitUntil: 'load' });
  await wait(3000);
  const r1 = await ui(A);
  const saved1 = await A.evaluate(() => localStorage.getItem('activePort'));
  ok('③ 停在在跑的端口时 F5 → 仍停在它（连上、不掉）',
    r1.active === 'COM-ECHO' && r1.ps === 'COM-ECHO' && r1.connected === true && saved1 === 'COM-ECHO',
    JSON.stringify({ ui: r1, saved: saved1 }));

  await pick(A, 'COM-ECHO2');                 // 切到另一路（也在跑）
  await wait(1800);
  await A.reload({ waitUntil: 'load' });
  await wait(3000);
  const r2 = await ui(A);
  const saved2 = await A.evaluate(() => localStorage.getItem('activePort'));
  ok('③ 切到另一路后 F5 → 停在这一路，不会被换回上一路',
    r2.active === 'COM-ECHO2' && r2.ps === 'COM-ECHO2' && saved2 === 'COM-ECHO2',
    JSON.stringify({ ui: r2, saved: saved2 }));

  // ---------- ④ 发送按钮可用性：控制端可用 / 断开后置灰 ----------
  await pick(A, 'COM-ECHO2');
  await wait(1500);
  await A.evaluate(() => window.forceControl());   // 先拿下这一路控制权，避免受宽限期自动移交影响
  await wait(1500);
  const sendOn = await sendState(A);
  ok('④ 控制端：发送按钮与分块/延时参数都可用',
    sendOn.btn === false && sendOn.kb === false && sendOn.delay === false, JSON.stringify(sendOn));

  await A.evaluate(async () => { await window.dc(); });
  await wait(1600);
  const sendOff = await sendState(A);
  ok('④ 断开后：按钮与参数一起置灰并说明"未连接"',
    sendOff.btn === true && sendOff.kb === true && sendOff.delay === true && /未连接/.test(sendOff.btnTitle),
    JSON.stringify(sendOff));

  await A.close();

  // ---------- ⑤ 新连接从空开始；历史只能按需载入；清屏 + 刷新不会倒回 ----------
  const emit = (port, text) => fetch(`http://127.0.0.1:${PORT + 1}/emit?port=${port}&text=${text}`, { method: 'POST' });
  await emit('COM-ECHO', 'HIST-BEFORE-OPEN-2f9c');
  await wait(600);
  const bufBytes = (await (await fetch(`${base}/status?port=COM-ECHO`)).json()).stats.totalBytes;

  const C = await browser.newPage({ viewport: { width: 1100, height: 700 } });
  await C.goto(`${base}/`, { waitUntil: 'load' });
  await wait(2800);
  const fresh = await C.evaluate(() => ({
    logHas: cur.log.includes('HIST-BEFORE-OPEN-2f9c'),
    logLen: cur.log.length,
    copyDisabled: document.getElementById('copyBtn').disabled,
    histDisabled: document.getElementById('histBtn').disabled,
  }));
  ok('⑤ 新窗口默认不放历史：缓冲里有数据，终端却是空的',
    bufBytes > 0 && fresh.logHas === false && fresh.logLen === 0 && fresh.copyDisabled === true,
    JSON.stringify({ 缓冲字节: bufBytes, ...fresh }));

  await C.evaluate(() => window.loadHistory());
  await wait(2200);
  const loaded = await C.evaluate(() => ({
    hasHist: cur.log.includes('HIST-BEFORE-OPEN-2f9c'),
    copyDisabled: document.getElementById('copyBtn').disabled,
  }));
  ok('⑤ 点「载入历史缓冲」→ 历史才补进来（并按内容解除置灰）',
    loaded.hasHist === true && loaded.copyDisabled === false, JSON.stringify(loaded));

  await C.evaluate(() => window.clearScreen());
  await wait(400);
  await C.reload({ waitUntil: 'load' });
  await wait(2800);
  const afterReload = await C.evaluate(() => ({
    logHas: cur.log.includes('HIST-BEFORE-OPEN-2f9c'),
    logLen: cur.log.length,
    connected: cur.connected,
  }));
  const bufAfter = (await (await fetch(`${base}/status?port=COM-ECHO`)).json()).stats.totalBytes;
  ok('⑤ 清屏后刷新：历史不会又冒出来（服务端缓冲仍在）',
    afterReload.logHas === false && afterReload.logLen === 0 && afterReload.connected === true && bufAfter > 0,
    JSON.stringify({ ui: afterReload, 缓冲字节: bufAfter }));

  await C.close();
} finally {
  await browser.close();
  srv.kill();
}
const fail = results.filter(r => r.pass === 'FAIL').length;
console.log(`\n针对性检查：${results.length - fail} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
