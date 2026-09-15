// 测试夹具服务：免硬件（假串口 + 回显 + 可选的 XMODEM 假板子），用于确定性 UI 检查
// 生产代码里没有这里的任何东西。
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { SerialMonitor } from '../../build/serial-monitor.js';
import { PortRegistry } from '../../build/port-registry.js';
import { startWebServer } from '../../build/web-server.js';

const PORT = Number(process.env.DEV_PORT || 9741);

// ---------------------------------------------------------------------------
// 假板子的 XMODEM 接收端（按规范实现，仅夹具用）
//   · arm 之后周期性发握手字符（'C'=CRC16 / NAK=8 位校验和），模拟真实 bootloader
//   · 逐块校验 CRC/校验和与块号，回 ACK/NAK
//   · nakEvery=N：每 N 块故意 NAK 一次（验证发送端重传），收到重传后接受
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 8;
    for (let j = 0; j < 8; j++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
    t[i] = c;
  }
  return t;
})();
const crc16 = (buf) => {
  let crc = 0;
  for (const b of buf) crc = (((crc << 8) & 0xffff) ^ CRC_TABLE[((crc >> 8) ^ b) & 0xff]) & 0xffff;
  return crc;
};
const sum8 = (buf) => buf.reduce((a, x) => (a + x) & 0xff, 0);

class BoardXmodem {
  constructor() {
    this.reset();
  }
  reset() {
    this.armed = false;
    this.useCrc = true;
    this.nakEvery = 0;
    this.done = false;
    this.frame = null;
    this.expect = 0;
    this.chunks = [];
    this.blocks = 0;
    this.naks = 0;
    this.crcErrors = 0;
    this.nakedBlocks = new Set();
    this.timer = null;
    this.inject = null;
  }
  /** 开始周期性发握手字符（直到收到第一块） */
  arm(inject, { crc = true, nakEvery = 0 } = {}) {
    this.reset();
    this.armed = true;
    this.useCrc = crc !== false;
    this.nakEvery = Number(nakEvery) || 0;
    this.inject = inject;
    const hs = Buffer.from([this.useCrc ? 0x43 : 0x15]);
    inject(hs);
    this.timer = setInterval(() => {
      if (this.armed && !this.done && !this.frame && this.expect === 0) inject(hs);
    }, 1000);
    if (this.timer.unref) this.timer.unref();
  }
  disarm() {
    this.armed = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  feed(bytes) {
    if (!this.armed || this.done) return;
    for (const byte of bytes) {
      // 块边界上的 0x04 才是 EOT（数据区里的 0x04 是普通字节）
      if (!this.frame && byte === 0x04) {
        this.done = true;
        this.disarm();
        this.inject(Buffer.from([0x06]));
        continue;
      }
      if (!this.frame) {
        if (byte === 0x01 || byte === 0x02) this.frame = { stx: byte === 0x02, bytes: [byte] };
        continue;
      }
      this.frame.bytes.push(byte);
      const size = this.frame.stx ? 1024 : 128;
      const frameLen = 3 + size + (this.useCrc ? 2 : 1);
      if (this.frame.bytes.length < frameLen) continue;
      const b = Buffer.from(this.frame.bytes);
      this.frame = null;
      const seq = b[1];
      const invOk = (seq + b[2]) % 256 === 255;
      const payload = b.subarray(3, 3 + size);
      const sumOk = this.useCrc
        ? crc16(payload) === ((b[3 + size] << 8) | b[3 + size + 1])
        : sum8(payload) === b[3 + size];
      const nth = this.expect + 1;
      const seqOk = seq === nth % 256;
      const injectNak = this.nakEvery > 0 && nth % this.nakEvery === 0 && !this.nakedBlocks.has(nth);
      if (!invOk || !sumOk || !seqOk || injectNak) {
        if (!sumOk) this.crcErrors++;
        if (injectNak) this.nakedBlocks.add(nth);
        this.naks++;
        this.inject(Buffer.from([0x15]));
        continue;
      }
      this.blocks++;
      this.expect = nth;
      this.chunks.push(payload);
      this.inject(Buffer.from([0x06]));
    }
  }
  state() {
    const data = Buffer.concat(this.chunks);
    return {
      armed: this.armed,
      done: this.done,
      blocks: this.blocks,
      naks: this.naks,
      crcErrors: this.crcErrors,
      crc: this.useCrc,
      bytes: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
    };
  }
}

// ---------------------------------------------------------------------------
// 假串口：回显（普通终端检查要用）+ XMODEM 时把字节交给"板子"
// ---------------------------------------------------------------------------
const boards = new Map(); // port -> BoardXmodem

function fakeFactory(bufferMaxSize) {
  const m = new SerialMonitor(bufferMaxSize);
  const board = new BoardXmodem();
  m.__board = board;
  m.start = async (port, baudRate) => {
    m.port = port;
    m.baudRate = baudRate;
    m.startedAt = new Date();
    const sp = new EventEmitter();
    sp.isOpen = true;
    // 让"板子"能把数据灌进串口：走 monitor 自己的 ingest（缓冲区/WS/SSE 与 XMODEM 接收口都会收到）
    m.__inject = (bytes) => {
      const buf = Buffer.from(bytes);
      setTimeout(() => m.ingest(buf), 5);   // 模拟"写出去之后数据才回来"
    };
    sp.write = (data, cb) => {
      const buf = Buffer.from(data);
      if (m.isXferActive() && board.armed) {
        board.feed(buf);                        // bootloader 不回显，只按协议应答
      } else {
        m.__inject(buf);                        // 旧行为：回显（供终端/WS 相关检查）
      }
      if (typeof cb === 'function') cb(null);
      return true;
    };
    sp.close = (cb) => { if (typeof cb === 'function') cb(null); };
    m.serialPort = sp;
    boards.set(port, board);
  };
  m.stop = async () => {
    board.disarm();
    m.serialPort = null;
    m.startedAt = null;
  };
  return m;
}

const registry = new PortRegistry(1024, fakeFactory, {
  // 测试夹具：隐私状态写到临时文件，绝不触碰用户真实的 private-ports.json
  privacyFile: 'test/ui/.tmp-private-ports.json',
  privatePorts: [],
});
await registry.open('COM-ECHO', 115200);
startWebServer(PORT, registry, false, undefined, undefined, (p) => {
  console.error(`DEV SERVER READY http://127.0.0.1:${p}`);
});

// ---------------------------------------------------------------------------
// 仅测试夹具使用的入口（独立端口，生产代码里没有）：
//   POST /emit?text=xxx[&port=COM-ECHO2]        假板发数据（数据 → WS → 终端/统计）
//   POST /board/arm?port=&crc=1&nakEvery=N      让板子进入 XMODEM 接收模式（开始发握手）
//   POST /board/disarm?port=
//   GET  /board/state?port=                     取接收结果（块数/NAK 数/字节/ sha256）
// ---------------------------------------------------------------------------
const HELPER_PORT = PORT + 1;
http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${HELPER_PORT}`);
  const json = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  const which = url.searchParams.get('port') || 'COM-ECHO';
  const session = registry.get(which);

  if (req.method === 'POST' && url.pathname === '/emit') {
    const text = url.searchParams.get('text') || '';
    if (session && text && session.__inject) session.__inject(Buffer.from(text, 'utf8'));
    return json(200, { ok: true, port: which, bytes: Buffer.byteLength(text), total: session ? session.buffer.totalBytes : -1 });
  }
  if (req.method === 'POST' && url.pathname === '/board/arm') {
    if (!session || !session.__board || !session.__inject) return json(404, { error: 'no such port' });
    session.__board.arm(session.__inject, {
      crc: url.searchParams.get('crc') !== '0',
      nakEvery: Number(url.searchParams.get('nakEvery') || 0),
    });
    return json(200, { ok: true, port: which });
  }
  if (req.method === 'POST' && url.pathname === '/board/disarm') {
    if (session && session.__board) session.__board.disarm();
    return json(200, { ok: true, port: which });
  }
  if (req.method === 'GET' && url.pathname === '/board/state') {
    if (!session || !session.__board) return json(404, { error: 'no such port' });
    return json(200, { port: which, ...session.__board.state() });
  }
  res.writeHead(404);
  res.end('not found');
}).listen(HELPER_PORT, '127.0.0.1', () => {
  console.error(`DEV HELPER READY http://127.0.0.1:${HELPER_PORT}`);
});
