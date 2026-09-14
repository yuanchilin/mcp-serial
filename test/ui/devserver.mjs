// 临时开发服务：免硬件（假串口 + 回显），用于在浏览器里确定性复现 UI bug
import { SerialMonitor } from '../../build/serial-monitor.js';
import { PortRegistry } from '../../build/port-registry.js';
import { startWebServer } from '../../build/web-server.js';

const PORT = Number(process.env.DEV_PORT || 9741);

/** 回显板：写进去的字节原样回来，走真实的缓冲 + WS 分发路径 */
function echoFactory(bufferMaxSize) {
  const m = new SerialMonitor(bufferMaxSize);
  m.start = async (port, baudRate) => {
    m.port = port;
    m.baudRate = baudRate;
    m.startedAt = new Date();
    m.serialPort = {
      isOpen: true,
      write(data, cb) {
        const text = typeof data === 'string' ? data : data.toString('utf8');
        setTimeout(() => {
          m.buffer.append(text);
          m.broadcastWS(Buffer.from(text, 'utf8'));
        }, 10);
        if (typeof cb === 'function') cb(null);
        return true;
      },
      close(cb) { if (typeof cb === 'function') cb(null); },
      removeAllListeners() { /* noop */ },
    };
  };
  m.stop = async () => { m.serialPort = null; m.startedAt = null; };
  return m;
}

const registry = new PortRegistry(1024, echoFactory, {
  // 测试夹具：隐私状态写到临时文件，绝不触碰用户真实的 private-ports.json
  privacyFile: 'test/ui/.tmp-private-ports.json',
  privatePorts: [],
});
await registry.open('COM-ECHO', 115200);
startWebServer(PORT, registry, false, undefined, undefined, (p) => {
  console.error(`DEV SERVER READY http://127.0.0.1:${p}`);
});

// ---------------------------------------------------------------------------
// 仅测试夹具使用的"假板发数据"入口（独立端口，生产代码里没有这个东西）：
//   POST http://127.0.0.1:PORT+1/emit?text=xxx[&port=COM-ECHO2]
// 让"数据 -> WS -> 终端渲染 / 统计面板 / 多路互不串台"这类检查变成确定性的，
// 不再依赖真实板子是否说话。
// ---------------------------------------------------------------------------
import http from 'node:http';
const HELPER_PORT = PORT + 1;
http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${HELPER_PORT}`);
  if (req.method === 'POST' && url.pathname === '/emit') {
    const text = url.searchParams.get('text') || '';
    const which = url.searchParams.get('port') || 'COM-ECHO';
    const session = registry.get(which);
    if (session && text) {
      session.buffer.append(text);
      session.broadcastWS(Buffer.from(text, 'utf8'));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, port: which, bytes: Buffer.byteLength(text), total: session ? session.buffer.totalBytes : -1 }));
    return;
  }
  res.writeHead(404);
  res.end('not found');
}).listen(HELPER_PORT, '127.0.0.1', () => {
  console.error(`DEV HELPER READY http://127.0.0.1:${HELPER_PORT}/emit`);
});
