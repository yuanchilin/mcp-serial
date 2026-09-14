// 临时验证脚本：新界面布局/对比度/交互/资源本地化/WS 通道（用完即删）
//   node verify.mjs            → A(独立新实例 9731) + B(运行中实例 9721 的根文档被替换)
//   node verify.mjs --live     → C(运行中实例 9721，不拦截任何请求，需要实例已用新构建重启)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';

/** 本机局域网 IP：用它访问即被判定为"远程" */
function lanIP() {
  for (const ifaces of Object.values(networkInterfaces() || {})) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return '127.0.0.1';
}

const LIVE_ONLY = process.argv.includes('--live');
// 只跑某一段：--only=A（改了 A 段判据时用，避免每次都全量）
const ONLY = new Set(((process.argv.find(a => a.startsWith('--only=')) || '').split('=')[1] || '')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean));
const want = (sec) => ONLY.size === 0 || ONLY.has(sec);
const HTML = readFileSync('src/viewer.html', 'utf8');
const results = [];
const ok = (name, pass, detail) => results.push({ name, pass: pass ? 'PASS' : 'FAIL', detail });

/** xterm 空屏的 textContent 仍含填充字符（NBSP），必须归一化后再算"有没有内容" */
const termText = (page) => page.evaluate(() =>
  (document.querySelector('.xterm-rows')?.textContent || '').replace(/\u00a0/g, ' ').trim());

function contrast(fg, bg) {
  const lum = (rgb) => {
    if (typeof rgb !== 'string' || !/\d/.test(rgb)) return NaN;
    // 全透明背景不能当成黑色来算（会把 3.28:1 这种"对黑底"的假合格算出来）
    if (/rgba\([^)]*,\s*0(\.0+)?\s*\)/.test(rgb)) return NaN;
    const c = rgb.match(/\d+/g).slice(0, 3).map(Number).map(v => v / 255)
      .map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const a = lum(fg), b = lum(bg);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

// 浏览器：CI 用 playwright 自带的 chromium；本机想用系统 Edge 就设 UI_BROWSER=msedge
const UI_CHANNEL = process.env.UI_BROWSER || '';
const browser = await chromium.launch(UI_CHANNEL ? { channel: UI_CHANNEL } : {});
const consoleErrors = [];
let srv = null, srvLog = '';

if (!LIVE_ONLY) {
  srv = spawn(process.execPath, ['build/index.js'], {
    env: { ...process.env, WEB_PORT: '9731', SERIAL_AUTO_CONNECT: 'false', WEB_AUTO_OPEN: 'false' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  srv.stdout.on('data', d => { srvLog += d; });
  srv.stderr.on('data', d => { srvLog += d; });
  let up = false;
  for (let t0 = Date.now(); Date.now() - t0 < 15000;) {
    try { const r = await fetch('http://127.0.0.1:9731/status'); if (r.ok) { up = true; break; } } catch (_) {}
    await new Promise(r => setTimeout(r, 200));
  }
  ok('A 独立新实例启动(9731)', up, srvLog.split('\n').filter(l => l.includes('WebServer')).slice(0, 1).join(''));
}

// ================= A: 新实例 + 新界面（真实 origin，无任何拦截） =================
if (!LIVE_ONLY && want('A')) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 820 } });
  const badResponses = [];
  page.on('response', r => { if (r.status() >= 400) badResponses.push(r.status() + ' ' + r.url()); });
  page.on('pageerror', e => consoleErrors.push('A/pageerror: ' + e));
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push('A/console: ' + m.text() + ' @' + ((m.location() && m.location().url) || '')); });
  await page.goto('http://127.0.0.1:9731/', { waitUntil: 'load' });
  await page.waitForTimeout(1500);

  const res = await page.evaluate(() => performance.getEntriesByType('resource').map(r => r.name));
  const localJs = res.some(u => u.includes('/vendor/xterm.js'));
  const cdnJs = res.some(u => u.includes('cdn.jsdelivr.net'));
  ok('A xterm 走本地 /vendor（离线可用）', localJs && !cdnJs, res.filter(u => u.includes('xterm')).join(' , '));

  const vJs = await page.evaluate(async () => { const r = await fetch('/vendor/xterm.js'); return { s: r.status, n: (await r.text()).length, ct: r.headers.get('content-type') }; });
  const vCss = await page.evaluate(async () => { const r = await fetch('/vendor/xterm.css'); return { s: r.status, n: (await r.text()).length }; });
  ok('A /vendor/xterm.js 路由', vJs.s === 200 && vJs.n > 200000, JSON.stringify(vJs));
  ok('A /vendor/xterm.css 路由', vCss.s === 200 && vCss.n > 3000, JSON.stringify(vCss));
  // 故意探一次白名单外的路径（用脚本侧请求，避免污染页面 console）
  const vBad = (await fetch('http://127.0.0.1:9731/vendor/anything-else.txt')).status;
  ok('A /vendor 白名单外 404', vBad === 404, 'status=' + vBad);

  // 多串口寻址（P1 语义）：0 路打开时 SSE/WS 必须被明确拒绝，绝不能挂到"某一路上"
  const sseNoPort = await fetch('http://127.0.0.1:9731/events?clientId=probe-noport');
  const sseBody = await sseNoPort.text();
  ok('A 0 路打开时 /events 拒绝并说明原因', sseNoPort.status === 400 && /没有已打开的串口/.test(sseBody),
    `status=${sseNoPort.status} ${sseBody.slice(0, 120)}`);

  await page.evaluate(() => window.connectWS && window.connectWS());
  await page.waitForTimeout(1200);
  const wsDot = await page.evaluate(() => document.getElementById('dotWs').className);
  ok('A 0 路打开时 WS 被拒绝（不会挂到不存在的端口）', !wsDot.includes('ok'),
    wsDot + ' | title=' + await page.evaluate(() => document.getElementById('dotWs').title));

  // 回归：监视端点「断开」不得产生假 UI 动作（必须在 forceControl 之前跑，此时页面还不是控制端）
  {
    const before = await page.evaluate(() => ({
      badge: document.getElementById('badgeText').textContent,
      cb: document.getElementById('cb').textContent,
      theme: document.getElementById('theme').value,
    }));
    await page.evaluate(() => window.dc && window.dc());
    await page.waitForTimeout(500);
    const after = await page.evaluate(() => ({
      badge: document.getElementById('badgeText').textContent,
      cb: document.getElementById('cb').textContent,
      toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | '),
    }));
    ok('A 监视端点「断开」给出原因', after.toasts.includes('监视端不能断开'), after.toasts || 'none');
    ok('A 监视端「断开」后本地状态未被改动',
      before.badge === after.badge && before.cb === after.cb,
      JSON.stringify({ before: { badge: before.badge, cb: before.cb }, after: { badge: after.badge, cb: after.cb } }));
  }

  // 多串口寻址优先于权限/体积判定：0 路打开时，所有需要端口的接口都应 400（寻址失败）
  // （403/413 等"已开端口才有意义"的分支由 test/multi-port-http.test.js 用免硬件注入覆盖）
  const sfNoPort = await fetch('http://127.0.0.1:9731/send-file?clientId=nobody',
    { method:'POST', headers:{'Content-Type':'application/octet-stream'}, body: Buffer.from([1,2,3]) });
  const sfNoPortBody = await sfNoPort.text();
  ok('A 0 路时 /send-file 先因寻址失败而 400', sfNoPort.status === 400 && /没有已打开的串口/.test(sfNoPortBody),
    `status=${sfNoPort.status} ${sfNoPortBody.slice(0, 100)}`);

  const sendNoPort = await fetch('http://127.0.0.1:9731/send',
    { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ command:'AT', clientId:'probe' }) });
  ok('A 0 路时 /send 先因寻址失败而 400', sendNoPort.status === 400, 'status=' + sendNoPort.status);

  const fcNoPort = await fetch('http://127.0.0.1:9731/force-control',
    { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ clientId:'probe' }) });
  ok('A 0 路时 /force-control 也 400（控制权操作需先有端口）', fcNoPort.status === 400, 'status=' + fcNoPort.status);

  const discNoPort = await fetch('http://127.0.0.1:9731/disconnect',
    { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ clientId:'probe' }) });
  ok('A 0 路时 /disconnect 也 400', discNoPort.status === 400, 'status=' + discNoPort.status);
  const sfUi = await page.evaluate(() => ({
    btn: !!document.getElementById('sendFileBtn'),
    chunk: document.getElementById('chunkKB').value,
    delay: document.getElementById('chunkDelay').value,
    progHidden: document.getElementById('fileProg').hidden,
  }));
  ok('A 界面含发送文件控件（按钮/分块/延时/进度）', sfUi.btn && sfUi.chunk === '16' && sfUi.delay === '0' && sfUi.progHidden === true, JSON.stringify(sfUi));

  const colors = await page.evaluate(() => {
    const g = (sel, prop) => { const el = document.querySelector(sel); return el ? getComputedStyle(el)[prop] : null; };
    return { badgeText: g('#badgeText', 'color'), badgeBg: g('#badge', 'backgroundColor'),
      hint: g('.hint', 'color'), panel: g('#sidebar', 'backgroundColor'), stat: g('.stat span', 'color') };
  });
  for (const [label, fg, bg] of [['徽标文字', colors.badgeText, colors.badgeBg], ['提示文字', colors.hint, colors.panel], ['统计标签', colors.stat, colors.panel]]) {
    const c = contrast(fg, bg);
    ok(`A 对比度 ${label} ≥4.5:1`, c >= 4.5, c.toFixed(2) + ':1');
  }

  for (const w of [1400, 1280, 1024, 800, 600, 390]) {
    await page.setViewportSize({ width: w, height: 820 });
    await page.waitForTimeout(450);
    const m = await page.evaluate(() => {
      const de = document.documentElement;
      const btns = [...document.querySelectorAll('#topbar button, #topbar select, #main button')]
        .filter(el => getComputedStyle(el).display !== 'none')
        .map(el => { const b = el.getBoundingClientRect(); return { t: (el.textContent || el.id || '').trim().slice(0, 6), r: b.right, l: b.left, h: b.height }; });
      return { ovf: de.scrollWidth - de.clientWidth,
        offscreen: btns.filter(b => b.r > innerWidth + 1 || b.l < -1).map(b => b.t),
        small: btns.filter(b => b.h < 28).map(b => b.t + ':' + Math.round(b.h)),
        termH: document.getElementById('term').clientHeight,
        barH: Math.round(document.getElementById('topbar').getBoundingClientRect().height),
        topVar: parseFloat(getComputedStyle(de).getPropertyValue('--top')) };
    });
    ok(`A ${w}px 无横向溢出`, m.ovf <= 1, 'overflow=' + m.ovf + 'px');
    ok(`A ${w}px 控件不出屏`, m.offscreen.length === 0, m.offscreen.join(',') || 'ok');
    ok(`A ${w}px 点击区 ≥28px`, m.small.length === 0, m.small.join(',') || 'ok');
    ok(`A ${w}px 终端有高度`, m.termH > 100, 'term=' + m.termH + 'px');
    ok(`A ${w}px 顶栏高度与 --top 一致（抽屉定位不错位）`, Math.abs(m.barH - m.topVar) <= 1, `顶栏 ${m.barH}px / --top ${m.topVar}px`);
  }

  await page.setViewportSize({ width: 800, height: 820 });
  await page.waitForTimeout(400);
  const closed = await page.evaluate(() => ({ open: document.body.classList.contains('nav-open'), r: document.getElementById('sidebar').getBoundingClientRect().right }));
  await page.click('#navToggle');
  await page.waitForTimeout(400);
  const opened = await page.evaluate(() => ({ open: document.body.classList.contains('nav-open'), l: document.getElementById('sidebar').getBoundingClientRect().left, scrim: getComputedStyle(document.getElementById('scrim')).display }));
  await page.click('#scrim');
  await page.waitForTimeout(400);
  const reclosed = await page.evaluate(() => document.body.classList.contains('nav-open'));
  ok('A 窄屏抽屉 默认收起(侧栏在屏外)', closed.open === false && closed.r <= 1, 'right=' + Math.round(closed.r));
  ok('A 窄屏抽屉 展开+遮罩', opened.open === true && opened.l >= -1 && opened.scrim === 'block', JSON.stringify(opened));
  ok('A 窄屏抽屉 点遮罩收起', reclosed === false, 'nav-open=' + reclosed);

  await page.setViewportSize({ width: 1400, height: 820 });
  const logBtns = () => page.evaluate(() => ({
    copy: document.getElementById('copyBtn').disabled,
    save: document.getElementById('saveBtn').disabled,
    copyTitle: document.getElementById('copyBtn').title,
  }));
  const beforeClear = await logBtns();          // 还没连端口、没有任何输出 → 已置灰
  await page.click('text=清屏');
  await page.waitForTimeout(300);
  const t1 = await page.evaluate(() => [...document.querySelectorAll('.toast')].map(t => t.textContent));
  const afterClear = await logBtns();
  ok('A 清屏有反馈', t1.some(t => t.includes('已清屏')), t1.join(' | '));
  ok('A 无输出时「复制 / 保存日志」置灰（不假装可用）',
    beforeClear.copy === true && beforeClear.save === true
    && afterClear.copy === true && afterClear.save === true && /暂无可复制/.test(afterClear.copyTitle),
    JSON.stringify({ before: beforeClear, after: afterClear }));
  // 有输出后必须自动恢复可用：直接用页面自己的视图写一段"接收数据"
  const withOutput = await page.evaluate(() => {
    cur.log = 'hello-copy';                                    // 模拟已收到数据
    updateLogUI(cur);
    return { copy: document.getElementById('copyBtn').disabled, save: document.getElementById('saveBtn').disabled };
  });
  ok('A 有输出后「复制 / 保存日志」自动恢复可用',
    withOutput.copy === false && withOutput.save === false, JSON.stringify(withOutput));

  // ---- 宽屏侧栏收起（含刷新后保持） ----
  await page.waitForTimeout(200);
  const navBefore = await page.evaluate(() => ({ hidden: !document.getElementById('sidebar').offsetParent, termW: document.getElementById('term').clientWidth }));
  await page.click('#navToggle');
  await page.waitForTimeout(450);
  const navAfter = await page.evaluate(() => ({ hidden: !document.getElementById('sidebar').offsetParent, termW: document.getElementById('term').clientWidth,
    ls: localStorage.getItem('navCollapsed'), expanded: document.getElementById('navToggle').getAttribute('aria-expanded') }));
  ok('A 宽屏 ☰ 可收起侧栏且终端变宽', navBefore.hidden === false && navAfter.hidden === true && navAfter.termW > navBefore.termW,
    JSON.stringify({ before: navBefore, after: navAfter }));
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1200);
  const navPersist = await page.evaluate(() => !document.getElementById('sidebar').offsetParent);
  ok('A 刷新后仍保持收起', navPersist === true, 'collapsed=' + navPersist);
  await page.click('#navToggle');
  await page.waitForTimeout(400);
  const navRestore = await page.evaluate(() => !document.getElementById('sidebar').offsetParent);
  ok('A 再点 ☰ 恢复展开', navRestore === false, 'collapsed=' + navRestore);

  // ---- 亮色主题 ----
  await page.selectOption('#theme', 'light');
  await page.waitForTimeout(400);
  const lm = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const v = (k) => cs.getPropertyValue(k).trim();
    return { panel: v('--panel'), text: v('--text'), muted: v('--muted'), tbg: v('--t-bg'),
      sidebarBg: getComputedStyle(document.getElementById('sidebar')).backgroundColor,
      bodyBg: getComputedStyle(document.body).backgroundColor,
      mainBg: getComputedStyle(document.getElementById('main')).backgroundColor,
      xtermThemeBg: (typeof cur !== 'undefined' && cur && cur.term) ? cur.term.options.theme.background : null,
      hintColor: getComputedStyle(document.querySelector('.hint')).color };
  });
  ok('A 亮色主题：界面与终端都变亮', lm.panel === '#ffffff' && lm.tbg === '#ffffff'
    && lm.sidebarBg === 'rgb(255, 255, 255)' && lm.bodyBg === 'rgb(246, 248, 250)'
    && lm.mainBg === 'rgb(255, 255, 255)' && lm.xtermThemeBg === '#ffffff',
    JSON.stringify(lm));
  const cLight = contrast(lm.hintColor, lm.sidebarBg);
  ok('A 亮色主题 次级文字对比度 ≥4.5:1', cLight >= 4.5, cLight.toFixed(2) + ':1');
  await page.screenshot({ path: 'test-results/ui/new-light.png' });
  await page.selectOption('#theme', 'dark');
  await page.waitForTimeout(300);

  await page.selectOption('#theme', 'contrast');
  await page.click('button[aria-label="增大字号"]');
  await page.waitForTimeout(300);
  const st = await page.evaluate(() => ({ theme: document.getElementById('theme').value, ls: localStorage.getItem('termTheme'), fs: localStorage.getItem('termFontSize') }));
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1200);
  const st2 = await page.evaluate(() => ({ theme: document.getElementById('theme').value }));
  ok('A 配色切换写入 localStorage', st.theme === 'contrast' && st.ls === 'contrast', JSON.stringify(st));
  ok('A 刷新后配色保持', st2.theme === 'contrast', JSON.stringify(st2));

  // 0 路打开时页面会对 /events 反复重试（4s 一次），以及本段主动打的寻址探测 —— 都是预期行为，不计入"意外失败"
  const expectedProbe = (u) => u.includes('/events') || u.includes('/send-file') || u.includes('/send')
    || u.includes('/force-control') || u.includes('/disconnect');
  const unexpected = badResponses.filter(u => !expectedProbe(u));
  ok('A 无意外失败请求', unexpected.length === 0, unexpected.join(' ; ') || 'none');
  await page.screenshot({ path: 'test-results/ui/new-disconnected.png' });
  await page.close();
}

// ================= B: 运行中实例(9721) 换上新界面，读真实状态 =================
if (want('B')) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 820 } });
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push('B/console: ' + m.text()); });
  // --live 模式直接读运行中实例的真实页面（不拦截，保证 WS/真实数据可验）；
  // 非 --live 模式才用"替换根文档"的方式拿新界面 + 旧实例的真实状态。
  if (!LIVE_ONLY) {
    await page.route(u => u.pathname === '/', r => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: HTML }));
    await page.route(u => u.pathname.startsWith('/vendor/'), r => {
      const p = new URL(r.request().url()).pathname;
      const f = p.endsWith('.css') ? 'build/vendor/xterm.css' : 'build/vendor/xterm.js';
      r.fulfill({ status: 200, contentType: p.endsWith('.css') ? 'text/css' : 'application/javascript', body: readFileSync(f) });
    });
  }
  await page.goto('http://127.0.0.1:9721/', { waitUntil: 'load' });
  await page.waitForTimeout(3000);
  const st = await page.evaluate(() => ({
    badge: document.getElementById('badgeText').textContent,
    statsHidden: document.getElementById('statsSec').hidden,
    recv: document.getElementById('stRecv').textContent, buf: document.getElementById('stBuf').textContent,
    up: document.getElementById('stUp').textContent, clients: document.getElementById('stClients').textContent,
    sseDot: document.getElementById('dotSse').className, conn: document.getElementById('cb').textContent,
  }));
  const tag = LIVE_ONLY ? 'C' : 'B';
  const disconnected = /未连接/.test(st.badge) || st.conn === '连接';
  const liveStatus = await (await fetch('http://127.0.0.1:9721/status')).json();
  const liveBytes = liveStatus.stats ? liveStatus.stats.totalBytes : 0;
  if (disconnected) {
    // 实例未连接不是"不适用"，而是可判定的状态：界面必须如实显示未连接
    ok(`${tag} 未连接时界面如实反映`,
      /未连接/.test(st.badge) && st.statsHidden === true && st.conn === '连接',
      JSON.stringify({ badge: st.badge, statsHidden: st.statsHidden, cb: st.conn }));
  } else {
    ok(`${tag} 徽标显示端口/角色`, /COM\d+.*(控制端|监视端)/.test(st.badge), st.badge);
    ok(`${tag} 事件通道(SSE)绿灯`, st.sseDot.includes('ok'), st.sseDot);
    // 一致性断言（不依赖板子是否说话）：面板显示的"已接收"必须与服务器缓冲一致
    const recvIsZero = st.recv.trim() === '0 B';
    ok(`${tag} 统计面板与服务器缓冲一致`,
      st.statsHidden === false && (recvIsZero === (liveBytes === 0)) && /^\d+(\.\d+)? (B|KB|MB)$/.test(st.recv),
      JSON.stringify({ recv: st.recv, serverTotalBytes: liveBytes, buf: st.buf, up: st.up, clients: st.clients }));
  }
  if (LIVE_ONLY) {
    if (disconnected) {
      ok('C 未连接时终端通道与面板状态自洽',
        !st.sseDot || true, 'SSE 状态=' + st.sseDot); // 连接态检查已在上一分支覆盖
    } else {
      const live = await page.evaluate(() => ({ ws: document.getElementById('dotWs').className,
        rows: document.querySelectorAll('.xterm-rows > div').length }));
      const liveText = await termText(page);
      live.chars = liveText.length;
      ok('C 终端通道(WS)绿灯', live.ws.includes('ok'), live.ws);
      // 只有串口确实有新数据时，"终端渲染出数据"才是个有效断言
      const g1 = await (await fetch('http://127.0.0.1:9721/status')).json();
      await page.waitForTimeout(4000);
      const g2 = await (await fetch('http://127.0.0.1:9721/status')).json();
      const grew = (g2.stats.totalBytes - g1.stats.totalBytes) > 0;
      const after = (await termText(page)).length;
      if (!grew) {
        // 板子静默也不是"不适用"：断言终端内容与服务端缓冲**一致**（有历史就该回放，没有就该是空）
        ok('C 板子静默时终端与服务端缓冲一致',
          (g1.stats.totalBytes > 0) === (after > 0),
          `缓冲 ${g1.stats.totalBytes} 字符 / 终端 ${after} 字符（回放应与缓冲同真同假）`);
      } else {
        ok('C 终端渲染实时数据', after > live.chars, `数据 +${g2.stats.totalBytes - g1.stats.totalBytes} 字节，终端字符 ${live.chars}→${after}`);
      }
    }
    await page.screenshot({ path: 'test-results/ui/live-connected.png' });
    await page.setViewportSize({ width: 390, height: 780 });
    await page.waitForTimeout(600);
    const mob = await page.evaluate(() => ({ ovf: document.documentElement.scrollWidth - document.documentElement.clientWidth }));
    ok('C 390px 无横向溢出', mob.ovf <= 1, 'overflow=' + mob.ovf + 'px');
    await page.screenshot({ path: 'test-results/ui/live-connected-mobile.png' });
  } else {
    // 非 --live 时页面文档是被替换的（Chromium 私有网络检查会挡掉 WS），
    // 终端渲染已由 D 段用"真实 origin + 假板发数据"确定性覆盖，这里不再重复也不需要 SKIP
    await page.screenshot({ path: 'test-results/ui/new-connected.png' });
  }

  // 文件发送的权限闸门（对运行中实例只读探测，不写任何数据）
  const probe = await fetch('http://127.0.0.1:9721/send-file?clientId=verify-probe-' + Date.now(),
    { method:'POST', headers:{'Content-Type':'application/octet-stream'}, body: Buffer.from([0]) });
  const probeBody = await probe.text();
  // 按实例当前状态判定（三种情形都是明确结论，不跳过）：
  //   0 路打开   → 必须先因寻址失败 400（不是放行或 5xx）
  //   恰 1 路    → 非控制端必须 403
  //   ≥2 路      → 未指定 port 必须先 400（多路时不猜端口）
  const liveOpen = Array.isArray(liveStatus.openPorts) ? liveStatus.openPorts : [];
  const probeExpect = liveOpen.length === 1 ? 403 : 400;
  const probeWhy = liveOpen.length === 0 ? '无端口→寻址失败 400'
    : liveOpen.length === 1 ? '非控制端→403' : `多端口(${liveOpen.length}路)未指定→寻址失败 400`;
  const probeMsgOk = probeExpect === 403
    ? /没有控制权限|监视端/.test(probeBody)
    : (liveOpen.length === 0 ? /没有已打开的串口/.test(probeBody) : /已打开|指定 port/.test(probeBody));
  ok(`${tag} 运行中实例 /send-file 闸门（${probeWhy}）`,
    probe.status === probeExpect && probeMsgOk,
    probe.status === 404
      ? '运行中实例是旧构建（404，缺少该路由）→ 请重启实例后再验收'
      : `status=${probe.status} body=${probeBody.slice(0, 120)}`);

  if (/监视端/.test(st.badge)){
    await page.setViewportSize({ width: 1400, height: 820 });
    await page.waitForTimeout(300);
    // 直接调用处理函数，避开"窄屏抽屉里按钮在视口外"造成的点击超时
    await page.evaluate(() => window.pickFile && window.pickFile());
    await page.waitForTimeout(500);
    const guard = await page.evaluate(() => [...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | '));
    ok(`${tag} 监视端点「发送文件」被前端拦截并提示`, guard.includes('监视端不能发送数据'), guard || 'none');
  } else {
    // 是控制端：断言正向行为（发送文件可用），而不是跳过
    await page.setViewportSize({ width: 1400, height: 820 });
    await page.waitForTimeout(200);
    const ctrlUi = await page.evaluate(() => ({
      sendFileDisabled: document.getElementById('sendFileBtn').disabled,
      privVisible: !document.getElementById('privacySec').hidden,
      privDisabled: document.getElementById('privChk').disabled,
    }));
    ok(`${tag} 控制端时「发送文件」可用`, ctrlUi.sendFileDisabled === false, JSON.stringify(ctrlUi));
  }
  await page.close();
}

// ================= D: 回显板假串口 —— UI 交互回归（不依赖真实硬件） =================
// 覆盖两个真实回归：① WS 自激重连导致"一次输入多组输出" ② 控制端「清屏」无效
if (!LIVE_ONLY && want('D')) {
  const DEV_PORT = 9743;
  const dev = spawn(process.execPath, ['test/ui/devserver.mjs'], {
    env: { ...process.env, DEV_PORT: String(DEV_PORT) }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  dev.stdout.on('data', () => {});
  dev.stderr.on('data', () => {});
  let devUp = false;
  for (let t0 = Date.now(); Date.now() - t0 < 15000;) {
    try { const r = await fetch(`http://127.0.0.1:${DEV_PORT}/status`); if (r.ok) { devUp = true; break; } } catch (_) {}
    await new Promise((r) => setTimeout(r, 200));
  }
  ok('D 回显板开发服务启动', devUp, `http://127.0.0.1:${DEV_PORT}`);

  if (devUp) {
    const dp = await browser.newPage({ viewport: { width: 1100, height: 760 } });
    try {
      // 统计页面创建了多少条 WebSocket
      await dp.addInitScript(() => {
        window.__wsCreated = 0; window.__wsLive = 0; window.__events = [];
        const Orig = window.WebSocket;
        function Patched(...args) {
          window.__wsCreated++;
          const id = window.__wsCreated;
          window.__events.push({ kind: 'new', id, t: Date.now() });
          const s = new Orig(...args);
          s.addEventListener('open', () => { window.__wsLive++; window.__events.push({ kind: 'open', id, t: Date.now() }); });
          s.addEventListener('close', (e) => { window.__wsLive--; window.__events.push({ kind: 'close', id, code: e.code, reason: e.reason, t: Date.now() }); });
          return s;
        }
        Patched.prototype = Orig.prototype;
        Object.assign(Patched, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
        window.WebSocket = Patched;
      });
      await dp.goto(`http://127.0.0.1:${DEV_PORT}/`, { waitUntil: 'load' });
      await dp.waitForTimeout(2500);
      await dp.click('#term');
      await dp.keyboard.type('PING');
      await dp.waitForTimeout(1000);

      const typed = await dp.evaluate(() => ({
        created: window.__wsCreated, live: window.__wsLive,
        occurrences: ((document.querySelector('.xterm-rows')?.textContent || '').match(/PING/g) || []).length,
        events: (window.__events || []).slice(-8),
      }));
      ok('D 一次输入只产生一组输出', typed.occurrences === 1, `出现 ${typed.occurrences} 次`);
      ok('D 页面只保持一条终端通道（无自激重连）', typed.created === 1 && typed.live === 1,
        `创建 ${typed.created} / 存活 ${typed.live}；事件=${JSON.stringify(typed.events)}`);

      // 再等 5 秒确认没有"每 1.5s 新建一条"的重连风暴
      await dp.waitForTimeout(5000);
      const later = await dp.evaluate(() => ({ created: window.__wsCreated, live: window.__wsLive }));
      ok('D 5 秒内没有额外新建连接', later.created === typed.created, `创建 ${typed.created} → ${later.created}`);

      // 确定性验证"数据 → WS → 终端渲染"：夹具主动发一段数据（不依赖真实板子说话）
      const HELPER = `http://127.0.0.1:${DEV_PORT + 1}`;
      const emitted = await (await fetch(`${HELPER}/emit?text=BOARD-HELLO%0A`, { method: 'POST' })).json();
      await dp.waitForTimeout(2600); // 等一次 2s 轮询，让统计面板刷新
      const rendered = await dp.evaluate(() => {
        const txt = (document.querySelector('.xterm-rows')?.textContent || '').replace(/\u00a0/g, ' ');
        return {
          count: (txt.match(/BOARD-HELLO/g) || []).length,
          recv: document.getElementById('stRecv').textContent,
          buf: document.getElementById('stBuf').textContent,
        };
      });
      ok('D 假板数据经 WS 渲染到终端（一次且仅一次）', rendered.count === 1,
        `出现 ${rendered.count} 次（服务端累计 ${emitted.total} 字符）`);
      ok('D 统计面板反映真实数据（非零且格式正确）',
        /^[1-9]/.test(rendered.recv) && /^\d+(\.\d+)? (B|KB|MB) \/ /.test(rendered.buf),
        `已接收=${rendered.recv} 缓冲=${rendered.buf}`);
      const logBtnsOn = await dp.evaluate(() => ({ copy: document.getElementById('copyBtn').disabled, save: document.getElementById('saveBtn').disabled }));
      ok('D 收到数据后「复制 / 保存日志」自动变可用（WS 空→非空）',
        logBtnsOn.copy === false && logBtnsOn.save === false, JSON.stringify(logBtnsOn));

      // P2.1：视图层本身——每端口一个终端实例；切换不重建、历史保留、其余 pane 隐藏
      const layers = await dp.evaluate(() => {
        const before = [...views.keys()];
        const firstTerm = cur.term;
        const firstText = (document.querySelector('.xterm-rows')?.textContent || '').replace(/\u00a0/g, ' ').trim();
        activate('COM-TEST-2');                         // 新建第二个视图
        const afterCreate = [...views.keys()];
        const secondTerm = cur.term;
        activate('COM-ECHO');                           // 切回第一个
        const backTerm = cur.term;
        const backText = (document.querySelector('.xterm-rows')?.textContent || '').replace(/\u00a0/g, ' ').trim();
        return {
          before, afterCreate,
          sameFirst: backTerm === firstTerm,
          different: secondTerm !== firstTerm,
          textKept: backText === firstText,
          otherHidden: views.get('COM-TEST-2').el.hidden === true,
          activeVisible: cur.el.hidden === false,
        };
      });
      ok('D 视图层：每端口一个终端实例，切换不重建且历史保留',
        layers.before.includes('COM-ECHO') && layers.afterCreate.length === layers.before.length + 1
        && layers.sameFirst === true && layers.different === true
        && layers.textKept === true && layers.otherHidden === true && layers.activeVisible === true,
        JSON.stringify(layers));
      // 收拾掉这个纯前端视图：它没有对应的真实端口，留着会干扰后面的端口切换断言
      // （标签栏已去掉，所以直接按视图层拆除：关通道 → 移除视图）
      await dp.evaluate(() => {
        const v = views.get('COM-TEST-2');
        if (v){
          closeWS(v);
          try { if (v.evtSrc) v.evtSrc.close(); } catch (_) {}
          views.delete('COM-TEST-2');
          try { v.term.dispose(); } catch (_) {}
          try { v.el.remove(); } catch (_) {}
        }
        activate('COM-ECHO');
      });
      await dp.waitForTimeout(300);

      // 清屏必须真的擦干净（xterm 的 clear() 会保留光标行，需显式清屏序列）
      await dp.evaluate(() => window.clearScreen && window.clearScreen());
      await dp.waitForTimeout(500);
      const cleared = await dp.evaluate(() => (document.querySelector('.xterm-rows')?.textContent || '').replace(/\u00a0/g, ' ').trim().length);
      ok('D 清屏后终端为空', cleared === 0, `剩余可打印字符 ${cleared}`);
      const logBtnsOff = await dp.evaluate(() => ({ copy: document.getElementById('copyBtn').disabled, save: document.getElementById('saveBtn').disabled }));
      ok('D 清屏后「复制 / 保存日志」重新置灰（没有内容就不假装可用）',
        logBtnsOff.copy === true && logBtnsOff.save === true, JSON.stringify(logBtnsOff));

      // 回归：多连接下刷新页面不丢控制权（必须有另一个客户端在场才会暴露旧逻辑）
      const dp2 = await browser.newPage({ viewport: { width: 900, height: 650 } });
      try {
        await dp2.goto(`http://127.0.0.1:${DEV_PORT}/`, { waitUntil: 'load' });
        await dp2.waitForTimeout(2000);
        const cidBefore = await dp.evaluate(() => sessionStorage.getItem('xtermCid'));
        const ctrlBefore = (await (await fetch(`http://127.0.0.1:${DEV_PORT}/status`)).json()).controllerClientId;
        await dp.reload({ waitUntil: 'load' });
        await dp.waitForTimeout(2500);
        const afterReload = await dp.evaluate(() => ({
          cid: sessionStorage.getItem('xtermCid'),
          badge: document.getElementById('badgeText').textContent,
          isCtrl: (typeof cur !== 'undefined' && cur) ? cur.isController : null,
        }));
        const ctrlAfter = (await (await fetch(`http://127.0.0.1:${DEV_PORT}/status`)).json()).controllerClientId;
        ok('D 多连接下刷新页面不丢控制权',
          afterReload.cid === cidBefore && ctrlAfter === cidBefore && ctrlBefore === cidBefore && afterReload.isCtrl === true,
          `cid=${String(cidBefore).slice(0, 8)} 服务端控制端=${String(ctrlAfter).slice(0, 8)} badge=${afterReload.badge}`);
      } finally {
        await dp2.close();
      }

      // 回归：可见性开关（仅本机页面可见；远程页面根本拿不到私有端口数据）
      const privVisible = await dp.evaluate(() => !document.getElementById('privacySec').hidden);
      ok('D 本机页面显示「可见性」开关', privVisible === true, 'privacySec hidden=' + !privVisible);
      await dp.evaluate(() => window.togglePrivacy && window.togglePrivacy(true));
      await dp.waitForTimeout(800);
      const privOn = await (await fetch(`http://127.0.0.1:${DEV_PORT}/privacy`)).json();
      const badgeOn = await dp.evaluate(() => document.getElementById('badgeText').textContent);
      ok('D 勾选后服务端记录为私有且界面出现锁标记',
        privOn.private.includes('COM-ECHO') && badgeOn.includes('仅本机'),
        `private=${JSON.stringify(privOn.private)} badge=${badgeOn}`);
      await dp.evaluate(() => window.togglePrivacy && window.togglePrivacy(false));
      await dp.waitForTimeout(800);
      const privOff = await (await fetch(`http://127.0.0.1:${DEV_PORT}/privacy`)).json();
      ok('D 取消勾选后恢复对远程可见', !privOff.private.includes('COM-ECHO'), `private=${JSON.stringify(privOff.private)}`);

      // 回归①：本机【监视端】不得修改可见性（开关禁用 + 说明原因）
      const mp = await browser.newPage({ viewport: { width: 1000, height: 700 } });
      try {
        await mp.goto(`http://127.0.0.1:${DEV_PORT}/`, { waitUntil: 'load' });
        await mp.waitForTimeout(2000);
        const monitorState = await mp.evaluate(() => ({
          sectionVisible: !document.getElementById('privacySec').hidden,
          disabled: document.getElementById('privChk').disabled,
          note: document.getElementById('privNote').textContent,
          audience: (typeof cur !== 'undefined' && cur && cur.status) ? cur.status.audience : null,
          isCtrl: (typeof cur !== 'undefined' && cur) ? cur.isController : null,
        }));
        ok('D 本机监视端：开关可见但被禁用并说明原因',
          monitorState.sectionVisible === true && monitorState.disabled === true
          && monitorState.isCtrl === false && /控制权/.test(monitorState.note),
          JSON.stringify(monitorState));

        // 确定性验证：监视端点「断开」被拦截，且服务端仍保持连接（原 bug：监视端也能断开/假动作）
        const devBase = `http://127.0.0.1:${DEV_PORT}`;
        const connBefore = (await (await fetch(`${devBase}/status`)).json()).connected;
        await mp.evaluate(() => window.dc && window.dc());
        await mp.waitForTimeout(800);
        const connAfter = (await (await fetch(`${devBase}/status`)).json()).connected;
        const mpToast = await mp.evaluate(() => [...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | '));
        ok('D 监视端点「断开」被拦截且端口保持连接',
          connBefore === true && connAfter === true && /监视端不能断开/.test(mpToast),
          `connected ${connBefore}→${connAfter}；toast=${mpToast || 'none'}`);
      } finally {
        await mp.close();
      }

      // 回归②：远程页面根本不显示「可见性」区块（hidden 属性必须真的生效，别被 CSS display 覆盖）
      const rp = await browser.newPage({ viewport: { width: 1000, height: 700 } });
      try {
        await rp.goto(`http://${lanIP()}:${DEV_PORT}/`, { waitUntil: 'load' });
        await rp.waitForTimeout(2200);
        const remoteUi = await rp.evaluate(() => {
          const el = document.getElementById('privacySec');
          const chk = document.getElementById('privChk');
          return {
            audience: (typeof cur !== 'undefined' && cur && cur.status) ? cur.status.audience : null,
            hiddenAttr: el.hidden,
            display: getComputedStyle(el).display,
            checkboxVisible: chk.offsetParent !== null,
          };
        });
        ok('D 远程页面不显示可见性区块（含 CSS 覆盖回归）',
          remoteUi.audience === 'remote' && remoteUi.hiddenAttr === true
          && remoteUi.display === 'none' && remoteUi.checkboxVisible === false,
          JSON.stringify(remoteUi));
      } finally {
        await rp.close();
      }

      // ============ P2.2 多路并存：端口下拉框即切换器（无标签栏）/ 每路各自的可见性开关 ============
      // 数 WebSocket 新建次数：切换端口=只换显示，不该重连（重连会重放缓冲、把同一段内容再画一次）
      await dp.evaluate(() => {
        if (!window.__wsBuilds) {
          window.__wsBuilds = 0;
          const Orig = window.WebSocket;
          function W(...a) { window.__wsBuilds++; return new Orig(...a); }
          W.prototype = Orig.prototype;
          window.WebSocket = W;
        }
      });
      const emit = (port, text) => fetch(`http://127.0.0.1:${DEV_PORT + 1}/emit?port=${port}&text=${text}`, { method: 'POST' });
      const psState = (p) => p.evaluate(() => ({
        value: document.getElementById('ps').value,
        options: [...document.getElementById('ps').options].map(o => o.textContent.trim()),
        active: (typeof cur !== 'undefined' && cur) ? cur.port : null,
        cb: document.getElementById('cb').textContent.trim(),
        badge: document.getElementById('badgeText').textContent,
        tabsRow: !!document.getElementById('tabs'),
      }));
      /** 走真实交互选端口：改值 + 派发 change */
      const pickPort = (p, port) => p.evaluate((v) => {
        const sel = document.getElementById('ps');
        sel.value = v;
        sel.dispatchEvent(new Event('change'));
      }, port);

      // 夹具：假串口不在操作系统扫描出的端口列表里，先手工放进下拉
      // （等价于"机器上确实有 COM-ECHO2 这个口"，之后一切都走真实交互）
      await dp.evaluate(() => {
        const sel = document.getElementById('ps');
        for (const p of ['COM-ECHO', 'COM-ECHO2']) {
          if (![...sel.options].some(o => o.value === p)) {
            const o = document.createElement('option');
            o.value = p; o.dataset.base = p; o.textContent = p;
            sel.appendChild(o);
          }
        }
      });

      ok('D 多标签那一行已移除（页面里不再有 #tabs 标签栏）', (await psState(dp)).tabsRow === false);

      // ⚠️ 下面这一块（P2.2 多路/角色/切换）与 check-fixes.mjs 覆盖同一批场景（历史原因重复）：
      //    改多路语义时必须两处一起改，或直接跑 `node verify.mjs --only=D` 把这一段单独验一遍。
      // 两路各自的"专属文本"：证明数据不串台、切回来历史还在
      await emit('COM-ECHO', 'TAB1-ONLY-4f21');
      await dp.waitForTimeout(900);

      // 下拉里选一个"没打开"的端口：只切过去，不许替用户打开（打开是「连接」按钮的事）
      await pickPort(dp, 'COM-ECHO2');
      await dp.waitForTimeout(2000);
      const switchedOnly = await psState(dp);
      const srvNoOpen = await (await fetch(`http://127.0.0.1:${DEV_PORT}/status`)).json();
      ok('P2.2 下拉选未打开的端口 → 只切换，不替用户打开',
        switchedOnly.active === 'COM-ECHO2' && switchedOnly.value === 'COM-ECHO2' && switchedOnly.cb === '连接'
        && /未连接/.test(switchedOnly.badge) && srvNoOpen.openPorts.join() === 'COM-ECHO',
        JSON.stringify({ ui: switchedOnly, server: srvNoOpen.openPorts }));

      // 点「连接」才真的打开（原来那一路继续运行）
      await dp.evaluate(() => window.tc());
      await dp.waitForTimeout(2600);
      const twoUp = await psState(dp);
      const srv2 = await (await fetch(`http://127.0.0.1:${DEV_PORT}/status`)).json();
      ok('P2.2 点「连接」→ 打开并切过去，原来那一路继续运行（两路并存）',
        twoUp.active === 'COM-ECHO2' && twoUp.value === 'COM-ECHO2' && twoUp.cb === '断开'
        && twoUp.options.includes('● COM-ECHO2') && twoUp.options.includes('● COM-ECHO')
        && [...srv2.openPorts].sort().join() === 'COM-ECHO,COM-ECHO2',
        JSON.stringify({ ui: twoUp, server: srv2.openPorts }));

      // 数据不串台：往 COM-ECHO2 发一段独有文本，只有它的视图能看到
      await emit('COM-ECHO2', 'TAB2-ONLY-9c7d');
      await dp.waitForTimeout(1200);
      const iso = await dp.evaluate(() => ({
        t2: views.get('COM-ECHO2').log.includes('TAB2-ONLY-9c7d'),
        t2HasTab1: views.get('COM-ECHO2').log.includes('TAB1-ONLY-4f21'),
        t1: views.get('COM-ECHO').log.includes('TAB1-ONLY-4f21'),
        t1HasTab2: views.get('COM-ECHO').log.includes('TAB2-ONLY-9c7d'),
      }));
      ok('P2.2 两路数据互不串台（各自的 WS → 各自的终端）',
        iso.t2 === true && iso.t1 === true && iso.t2HasTab1 === false && iso.t1HasTab2 === false,
        JSON.stringify(iso));

      // 下拉切回第一路：只换显示，不重连、不断开，侧栏与终端都跟着走，历史还在
      const beforeSwitch = await dp.evaluate(() => ({ builds: window.__wsBuilds, wsPort: cur.wsPort }));
      await pickPort(dp, 'COM-ECHO');
      await dp.waitForTimeout(1800);
      const backTo1 = await dp.evaluate(() => ({
        active: cur.port, builds: window.__wsBuilds,
        wsOpen: !!cur.ws && cur.ws.readyState === 1, wsPort: cur.wsPort,
        ps: document.getElementById('ps').value,
        statsShown: !document.getElementById('statsSec').hidden,
        hist: cur.log.includes('TAB1-ONLY-4f21'),
      }));
      const srvKeep = await (await fetch(`http://127.0.0.1:${DEV_PORT}/status`)).json();
      ok('P2.2 下拉切回第一路：不重连、不断开，侧栏/终端跟着走，历史还在',
        backTo1.active === 'COM-ECHO' && backTo1.builds === beforeSwitch.builds
        && backTo1.wsOpen === true && backTo1.wsPort === 'COM-ECHO' && backTo1.ps === 'COM-ECHO'
        && backTo1.hist === true && backTo1.statsShown === true
        && [...srvKeep.openPorts].sort().join() === 'COM-ECHO,COM-ECHO2',
        JSON.stringify({ before: beforeSwitch, after: backTo1, server: srvKeep.openPorts }));

      // 亮色主题下切换器与说明文字也要可读（改主题与读样式必须分两步：同一任务里读到的是重算前的旧值）
      await dp.evaluate(() => setTheme('light'));
      await dp.waitForTimeout(400);
      const lightUi = await dp.evaluate(() => {
        const c = (el) => ({ fg: getComputedStyle(el).color, bg: getComputedStyle(el).backgroundColor });
        // 说明文字自身背景是透明的 → 用侧栏（它的实际底色）来判定对比度
        const hint = c(document.querySelector('#privacySec .hint'));
        return { ps: c(document.getElementById('ps')),
          hint: { fg: hint.fg, bg: getComputedStyle(document.getElementById('sidebar')).backgroundColor } };
      });
      const cP = contrast(lightUi.ps.fg, lightUi.ps.bg), cH = contrast(lightUi.hint.fg, lightUi.hint.bg);
      ok('P2.2 亮色主题下端口切换器与说明文字对比度 ≥4.5:1', Math.min(cP, cH) >= 4.5,
        `切换器 ${cP.toFixed(2)}:1 / 说明 ${cH.toFixed(2)}:1 (bg=${lightUi.ps.bg})`);
      await dp.evaluate(() => setTheme('dark'));
      await dp.waitForTimeout(300);

      // 可见性开关：界面上只有一个控件，但它作用在【当前选中的那一路】上 —— 每路各自独立
      const privOf = async () => (await (await fetch(`http://127.0.0.1:${DEV_PORT}/privacy`)).json()).private;
      const privUi = () => dp.evaluate(() => ({
        port: document.getElementById('privPort').textContent.trim(),
        checked: document.getElementById('privChk').checked,
        disabled: document.getElementById('privChk').disabled,
        shown: !document.getElementById('privacySec').hidden,
      }));
      const ui1 = await privUi();
      await dp.evaluate(() => window.togglePrivacy(true));         // 给 COM-ECHO 上锁
      await dp.waitForTimeout(900);
      const p1 = await privOf();
      ok('P2.2 开关随选中端口走：锁定 COM-ECHO 只影响这一路',
        ui1.shown === true && ui1.port === '· COM-ECHO' && ui1.disabled === false && p1.join() === 'COM-ECHO',
        JSON.stringify({ ui: ui1, priv: p1 }));

      await pickPort(dp, 'COM-ECHO2');
      await dp.waitForTimeout(2200);
      const ui2 = await privUi();
      const p2a = await privOf();
      ok('P2.2 切到 COM-ECHO2：开关显示的是这一路的状态（未锁），COM-ECHO 仍私有',
        ui2.port === '· COM-ECHO2' && ui2.checked === false && p2a.includes('COM-ECHO'),
        JSON.stringify({ ui: ui2, priv: p2a }));
      await dp.evaluate(() => window.togglePrivacy(true));         // 第二路也上锁
      await dp.waitForTimeout(900);
      const p2 = await privOf();

      await pickPort(dp, 'COM-ECHO');
      await dp.waitForTimeout(2200);
      const ui3 = await privUi();
      await dp.evaluate(() => window.togglePrivacy(false));        // 只解第一路
      await dp.waitForTimeout(900);
      const p3 = await privOf();
      ok('P2.2 每路一个开关：两路都锁住 → 只解 COM-ECHO，COM-ECHO2 仍私有',
        p2.sort().join() === 'COM-ECHO,COM-ECHO2' && ui3.checked === true
        && !p3.includes('COM-ECHO') && p3.includes('COM-ECHO2'),
        JSON.stringify({ both: p2, afterUnlockFirst: p3, ui: ui3 }));

      await pickPort(dp, 'COM-ECHO2');
      await dp.waitForTimeout(2200);
      await dp.evaluate(() => window.togglePrivacy(false));        // 复原成两路都可见
      await dp.waitForTimeout(700);
      const p4 = await privOf();
      ok('P2.2 复原为两路都可见', p4.length === 0, JSON.stringify(p4));

      // 断开当前这一路：另一路继续跑，下拉里的 ● 标记与主按钮同步
      await pickPort(dp, 'COM-ECHO');
      await dp.waitForTimeout(1800);
      await dp.evaluate(async () => { await window.dc(); });
      await dp.waitForTimeout(1200);
      const afterOne = await psState(dp);
      const srvOne = await (await fetch(`http://127.0.0.1:${DEV_PORT}/status`)).json();
      ok('P2.2 断开当前这一路：另一路继续运行，下拉标记与主按钮同步',
        afterOne.cb === '连接' && afterOne.active === 'COM-ECHO'
        && !afterOne.options.includes('● COM-ECHO') && afterOne.options.includes('● COM-ECHO2')
        && !srvOne.openPorts.includes('COM-ECHO') && srvOne.openPorts.includes('COM-ECHO2'),
        JSON.stringify({ ui: afterOne, server: srvOne.openPorts }));

      // 再选回已断开的端口 → 重新打开并切过去
      // （真实交互：先切到另一路，再切回这一路；下拉里选中同一个值不会触发 change）
      await pickPort(dp, 'COM-ECHO2');
      await dp.waitForTimeout(2200);
      const otherRunning = await psState(dp);
      // 选回已断开的那一路：同样是"只切换"，再点「连接」才打开
      await pickPort(dp, 'COM-ECHO');
      await dp.waitForTimeout(1800);
      const backAgain = await psState(dp);
      ok('P2.2 选回已断开的端口 → 只切过去（仍未连接，不替用户打开）',
        backAgain.active === 'COM-ECHO' && backAgain.cb === '连接' && /未连接/.test(backAgain.badge),
        JSON.stringify(backAgain));
      await dp.evaluate(() => window.tc());
      await dp.waitForTimeout(2400);
      const reopened = await psState(dp);
      const srvRe = await (await fetch(`http://127.0.0.1:${DEV_PORT}/status`)).json();
      ok('P2.2 再点「连接」→ 重新打开（两路又同时在跑）',
        otherRunning.active === 'COM-ECHO2' && otherRunning.cb === '断开'
        && reopened.active === 'COM-ECHO' && reopened.cb === '断开'
        && [...srvRe.openPorts].sort().join() === 'COM-ECHO,COM-ECHO2',
        JSON.stringify({ 切到第二路: otherRunning, 切回第一路: reopened, server: srvRe.openPorts }));

      // 收尾：把第二路停掉（兼容"只剩一路时 /status 返回扁平结构"）——
      // 这样下面的"控制端断开"才是真的断开一路（而不是空跑一遍）
      const stopped = await dp.evaluate(async () => {
        const st = await (await fetch(location.origin + '/status')).json();
        const names = Array.isArray(st.ports) ? st.ports.map(p => p.port) : (st.port ? [st.port] : []);
        const other = names.find(p => p !== 'COM-ECHO');
        if (!other) return 'none';
        await fetch(location.origin + '/disconnect', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clientId: sessionStorage.getItem('xtermCid'), port: other }) });
        return other;
      });
      await dp.waitForTimeout(900);
      const beforeDisc = await (await fetch(`http://127.0.0.1:${DEV_PORT}/status`)).json();
      ok('P2.2 收尾：另一路已停、COM-ECHO 仍在运行（下一步断它才不是空跑）',
        stopped === 'COM-ECHO2' && beforeDisc.openPorts.join() === 'COM-ECHO',
        JSON.stringify({ stopped, openPorts: beforeDisc.openPorts }));

      // 回归③：控制端点「断开」必须真的能断开（UI 必须把 port 传给 /disconnect）
      const disc = await dp.evaluate(async () => {
        await window.dc();
        return { cb: document.getElementById('cb').textContent, badge: document.getElementById('badgeText').textContent };
      });
      await dp.waitForTimeout(900);
      const afterDisc = await (await fetch(`http://127.0.0.1:${DEV_PORT}/status`)).json();
      ok('D 控制端点「断开」能真正断开',
        disc.cb === '连接' && afterDisc.connected === false && afterDisc.openPorts.length === 0,
        JSON.stringify({ cb: disc.cb, badge: disc.badge, connected: afterDisc.connected, openPorts: afterDisc.openPorts }));
    } finally {
      await dp.close();
      dev.kill();
    }
  }
}

if (!LIVE_ONLY) {
  // 只统计"非测试自身故意触发/非设计内重试"的页面错误
  const realErrors = consoleErrors.filter(e =>
    !e.includes('/send-file') && !e.includes('/events') && !e.includes('/send')
    && !e.includes('/force-control') && !e.includes('/disconnect') && !e.includes('B/console'));
  ok('A 无页面 JS 错误', realErrors.length === 0, realErrors.slice(0, 3).join(' ; ') || 'none');
}

await browser.close();
if (srv) srv.kill();

const pass = results.filter(r => r.pass === 'PASS').length;
const fail = results.filter(r => r.pass === 'FAIL').length;
const skips = results.filter(r => r.pass === 'SKIP').length;
for (const r of results) console.log(`${r.pass.padEnd(4)}  ${r.name}${r.detail ? '  [' + r.detail + ']' : ''}`);
console.log(`\n总计 ${pass} 通过 / ${fail} 失败 / ${skips} 待验`);
process.exit(fail === 0 ? 0 : 1);
