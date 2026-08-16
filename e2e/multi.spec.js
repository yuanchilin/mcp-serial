// ============================================================================
//  multi.html 前端交互 E2E 测试 (Playwright + 系统 Edge)
//  不依赖真实串口：直接注入假面板 addPane('COMX')，验证纯前端交互逻辑
// ============================================================================
import { test, expect } from "@playwright/test";

async function addFakePane(page, port = "COMX") {
  await page.goto("/");
  await page.waitForFunction(() => typeof addPane === "function");
  await page.evaluate((p) => addPane(p), port);
}

test("✕ 折叠到工具栏，点标签恢复", async ({ page }) => {
  await addFakePane(page);
  const pane = page.locator(".pane");
  await expect(pane).toBeVisible();

  await page.click(".pane .close");
  await expect(pane).toBeHidden(); // 折叠后面板隐藏
  const mini = page.locator("#miniBar button");
  await expect(mini).toBeVisible();
  await expect(mini).toContainText("COMX");

  await mini.click();
  await expect(pane).toBeVisible(); // 点标签恢复
});

test("拖标题栏出网格 → 浮动窗口", async ({ page }) => {
  await addFakePane(page);
  const pane = page.locator(".pane");
  const panesBox = await page.locator("#panes").boundingBox();
  await page.locator(".pane-title").hover();
  await page.mouse.down();
  // 拖到网格上方外（明确越过 panes.top-20 判定阈值）
  await page.mouse.move(panesBox.x + 60, panesBox.y - 40, { steps: 10 });
  await page.mouse.up();
  await expect(pane).toHaveClass(/floating/);
});

test("拖拽右侧 resizer 调宽", async ({ page }) => {
  await addFakePane(page);
  const pane = page.locator(".pane");
  const before = await pane.evaluate((el) => el.getBoundingClientRect().width);

  const resizer = page.locator(".pane-resizer");
  const box = await resizer.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + 120);
  await page.mouse.down();
  await page.mouse.move(box.x + 200, box.y + 120, { steps: 8 });
  await page.mouse.up();

  const after = await pane.evaluate((el) => el.getBoundingClientRect().width);
  expect(after).toBeGreaterThan(before);
});

test("连接/断开按钮乐观更新（点击立即反馈）", async ({ page }) => {
  await addFakePane(page);
  const btn = page.locator(".conn-btn");
  // 新建面板 dataset.connected='1' → 按钮显示"断开"
  await expect(btn).toHaveText("断开");

  await btn.click(); // 断开：乐观更新立即变"连接"
  await expect(btn).toHaveText("连接");

  await btn.click(); // 连接：乐观更新立即变"断开"
  await expect(btn).toHaveText("断开");
});

test("全屏按钮存在且可点击", async ({ page }) => {
  await addFakePane(page);
  const fs = page.locator('.pane-head button[title="全屏"]');
  await expect(fs).toBeVisible();
  await fs.click(); // 点击不报错（真全屏在 headless 下受限，仅验证无异常）
});

test("折叠后再浮动/调宽互不影响", async ({ page }) => {
  await addFakePane(page);
  await page.click(".pane .close"); // 折叠
  await expect(page.locator(".pane")).toBeHidden();
  await page.click("#miniBar button"); // 恢复
  await expect(page.locator(".pane")).toBeVisible();
  // 恢复后仍可浮动
  const panesBox = await page.locator("#panes").boundingBox();
  await page.locator(".pane-title").hover();
  await page.mouse.down();
  await page.mouse.move(panesBox.x + 60, panesBox.y - 40, { steps: 10 });
  await page.mouse.up();
  await expect(page.locator(".pane")).toHaveClass(/floating/);
});

test("刷新后布局保持不变（宽度持久化）", async ({ page }) => {
  await addFakePane(page);
  // 拖宽
  const resizer = page.locator(".pane-resizer");
  const box = await resizer.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + 120);
  await page.mouse.down();
  await page.mouse.move(box.x + 160, box.y + 120, { steps: 6 });
  await page.mouse.up();
  const before = await page.locator(".pane").evaluate((el) => el.getBoundingClientRect().width);

  // 刷新后重注面板，宽度应恢复
  await page.reload();
  await page.waitForFunction(() => typeof addPane === "function");
  await page.evaluate((p) => addPane(p), "COMX");
  const after = await page.locator(".pane").evaluate((el) => el.getBoundingClientRect().width);
  expect(Math.abs(after - before)).toBeLessThan(2);
});

test("浮动窗口刷新后保持浮动", async ({ page }) => {
  await addFakePane(page);
  const panesBox = await page.locator("#panes").boundingBox();
  await page.locator(".pane-title").hover();
  await page.mouse.down();
  await page.mouse.move(panesBox.x + 60, panesBox.y - 40, { steps: 10 });
  await page.mouse.up();
  await expect(page.locator(".pane")).toHaveClass(/floating/);

  await page.reload();
  await page.waitForFunction(() => typeof addPane === "function");
  await page.evaluate((p) => addPane(p), "COMX");
  await expect(page.locator(".pane")).toHaveClass(/floating/);
});

test("— 收起按钮已删除（✕ 折叠替代）", async ({ page }) => {
  await addFakePane(page);
  await expect(page.locator('.pane-head button[title="收起/展开"]')).toHaveCount(0);
});

test("重叠浮动窗口点击谁谁置顶", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => typeof addPane === "function");
  await page.evaluate(() => { addPane("COMA"); addPane("COMB"); });
  // 两个浮动窗口部分重叠：COMB 盖住 COMA 右半
  await page.evaluate(() => { floatPane("COMA", 100, 80); floatPane("COMB", 250, 80); });
  const p0 = page.locator(".pane").nth(0); // COMA（被压在下）
  const p1 = page.locator(".pane").nth(1); // COMB（在上）
  const z1 = await p1.evaluate((el) => parseInt(el.style.zIndex) || 0);
  // 点击 COMA 标题的可见左段（未被 COMB 覆盖）→ COMA 应置顶
  await p0.locator(".pane-title").click({ position: { x: 20, y: 10 } });
  const z0After = await p0.evaluate((el) => parseInt(el.style.zIndex) || 0);
  expect(z0After).toBeGreaterThan(z1);
});

test("停靠窗口调宽互不影响另一个", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => typeof addPane === "function");
  await page.evaluate(() => { addPane("COMA"); addPane("COMB"); });
  const a = page.locator(".pane").nth(0);
  const b = page.locator(".pane").nth(1);
  const bBefore = await b.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width };
  });
  // 拖窄 A（resizer 左移 120px）
  const resizer = a.locator(".pane-resizer");
  const box = await resizer.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(box.x - 120, box.y + 100, { steps: 5 });
  await page.mouse.up();
  const bAfter = await b.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width };
  });
  // B 的位置与宽度应完全不变
  expect(Math.abs(bAfter.x - bBefore.x)).toBeLessThan(2);
  expect(Math.abs(bAfter.y - bBefore.y)).toBeLessThan(2);
  expect(Math.abs(bAfter.w - bBefore.w)).toBeLessThan(2);
});
