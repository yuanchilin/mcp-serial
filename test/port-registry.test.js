// ============================================================================
//  多串口注册表：寻址规则 / 串扰负向 / 关闭策略
//  这是"多串口互不干扰"的核心回归测试：用注入的假会话，不需要真实硬件。
// ============================================================================
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PortRegistry } from "../build/port-registry.js";
import { RingBuffer } from "../build/ring-buffer.js";

/** 假会话：只实现注册表会用到的那部分接口，缓冲用真实 RingBuffer */
function fakeSession(bufferMaxSize) {
  const buffer = new RingBuffer(bufferMaxSize);
  const s = {
    port: "",
    baudRate: 0,
    buffer,
    _active: false,
    isActive() { return s._active; },
    async start(port, baudRate) { s.port = port; s.baudRate = baudRate; s._active = true; },
    async stop() { s._active = false; },
    getStatus() {
      return {
        connected: s._active,
        port: s.port,
        baudRate: s.baudRate,
        startedAt: null,
        uptimeMs: 0,
        stats: buffer.getStats(),
        clientCount: 0,
        controllerClientId: null,
        clients: [],
      };
    },
    dispose() { /* 测试桩 */ },
  };
  return s;
}

const makeRegistry = () => new PortRegistry(1024, fakeSession, {
  // 隔离：临时隐私文件，绝不读写用户真实的 private-ports.json
  privacyFile: join(mkdtempSync(join(tmpdir(), "mcp-priv-")), "private-ports.json"),
  privatePorts: [],
});

test("注册表：读操作不会造出幽灵条目（没有 getOrCreate）", async () => {
  const registry = makeRegistry();
  // 只读访问：不应产生任何会话
  assert.equal(registry.get("COM3"), undefined, "get() 不应创建会话");
  assert.deepEqual(registry.list(), [], "list() 应为空");
  assert.deepEqual(registry.openPortNames(), [], "不应有已打开端口");
  assert.equal(registry.activeCount(), 0);

  // 打开失败不应留下半成品（用会抛错的 start 模拟）
  const failing = new PortRegistry(1024, (max) => {
    const s = fakeSession(max);
    s.start = async () => { throw new Error("Access denied"); };
    return s;
  });
  await assert.rejects(() => failing.open("COM9", 115200), /Access denied/);
  assert.deepEqual(failing.openPortNames(), [], "打开失败后不应残留端口");
  assert.equal(failing.get("COM9"), undefined, "打开失败后不应残留会话");
});

test("寻址矩阵：省略 port 只在恰好一路时放行，0 路/多路都报错并列出候选", async () => {
  const registry = makeRegistry();

  // ── 0 路 ──
  const none = registry.resolve();
  assert.equal(none.ok, false);
  assert.match(none.error, /没有已打开的串口/, "0 路时应提示先 serial_start");

  // ── 1 路：省略 port 放行 ──
  await registry.open("COM3", 115200);
  const one = registry.resolve();
  assert.equal(one.ok, true);
  assert.equal(one.session.port, "COM3");

  // ── 2 路：省略 port 必须报错，且要列出两个候选 ──
  await registry.open("COM5", 9600);
  const two = registry.resolve();
  assert.equal(two.ok, false, "多路时省略 port 必须报错，绝不能猜一个");
  assert.match(two.error, /COM3/);
  assert.match(two.error, /COM5/);
  assert.match(two.error, /显式指定 port/);

  // ── 显式指定：存在的放行，不存在的报错并列出候选 ──
  const explicit = registry.resolve("COM5");
  assert.equal(explicit.ok, true);
  assert.equal(explicit.session.port, "COM5");

  const missing = registry.resolve("COM9");
  assert.equal(missing.ok, false);
  assert.match(missing.error, /COM9 未打开/);
  assert.match(missing.error, /当前已打开：COM3, COM5/);

  // 也支持查询串传来的字符串（含空格）
  assert.equal(registry.resolve(" COM3 ").ok, true, "端口名两侧空格应被容忍");
});

test("串扰负向测试：两路同时进数据，任何一路都读不到另一路的字节", async () => {
  const registry = makeRegistry();
  const a = await registry.open("COM3", 115200);
  const b = await registry.open("COM5", 9600);

  // 交替写入，模拟两路同时收发
  for (let i = 0; i < 5; i++) {
    a.buffer.append(`A${i};`);
    b.buffer.append(`B${i};`);
  }

  const readA = registry.resolve("COM3");
  const readB = registry.resolve("COM5");
  assert.equal(readA.ok && readB.ok, true);

  const textA = readA.session.buffer.getAll();
  const textB = readB.session.buffer.getAll();

  assert.equal(textA, "A0;A1;A2;A3;A4;", "A 口内容应完整且只有自己的数据");
  assert.equal(textB, "B0;B1;B2;B3;B4;", "B 口内容应完整且只有自己的数据");
  assert.ok(!textA.includes("B"), "A 口绝不能出现 B 口的数据");
  assert.ok(!textB.includes("A"), "B 口绝不能出现 A 口的数据");

  // 两路缓冲对象本身也必须相互独立
  assert.notEqual(readA.session.buffer, readB.session.buffer, "两路必须是不同的缓冲实例");

  // 清空 A 不应影响 B
  readA.session.buffer.clear();
  assert.equal(readA.session.buffer.getAll(), "");
  assert.equal(readB.session.buffer.getAll(), "B0;B1;B2;B3;B4;", "清空 A 不应影响 B");
});

test("关闭策略：必须指定 port，全关必须显式 all=true", async () => {
  const registry = makeRegistry();
  await registry.open("COM3", 115200);
  await registry.open("COM5", 9600);

  // 不传参数：拒绝，并提示怎么全关
  const noArgs = registry.planStop();
  assert.equal(noArgs.ok, false);
  assert.match(noArgs.error, /请指定要关闭的 port/);
  assert.match(noArgs.error, /all:true/);
  assert.match(noArgs.error, /COM3, COM5/);

  // 只关一路
  const one = registry.planStop("COM5");
  assert.equal(one.ok, true);
  assert.deepEqual(one.ports, ["COM5"]);

  // 关不存在的端口
  const bad = registry.planStop("COM9");
  assert.equal(bad.ok, false);
  assert.match(bad.error, /COM9 未在运行中/);

  // 显式全关
  const all = registry.planStop(undefined, true);
  assert.equal(all.ok, true);
  assert.deepEqual(all.ports, ["COM3", "COM5"], "全关应列出全部端口（排序）");

  // 真正执行：关闭即从注册表移除，不留幽灵条目
  const closed = await registry.closeAll();
  assert.deepEqual(closed, ["COM3", "COM5"]);
  assert.equal(registry.get("COM3"), undefined, "关闭后不应再能取到会话");
  assert.deepEqual(registry.openPortNames(), []);
  assert.equal(registry.activeCount(), 0);

  // 空注册表再全关：明确报错而不是静默成功
  const empty = registry.planStop(undefined, true);
  assert.equal(empty.ok, false);
  assert.match(empty.error, /没有已打开的串口/);
});

test("关闭一路不影响另一路（隔离性）", async () => {
  const registry = makeRegistry();
  const a = await registry.open("COM3", 115200);
  const b = await registry.open("COM5", 9600);
  a.buffer.append("keep-alive-A");
  b.buffer.append("keep-alive-B");

  await registry.close("COM3");

  assert.equal(registry.get("COM3"), undefined, "COM3 应已移除");
  const stillB = registry.resolve("COM5");
  assert.equal(stillB.ok, true, "COM5 应不受影响");
  assert.equal(stillB.session.buffer.getAll(), "keep-alive-B");
  assert.deepEqual(registry.openPortNames(), ["COM5"]);
});
