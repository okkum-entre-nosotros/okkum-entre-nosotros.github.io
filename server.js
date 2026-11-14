// Servidor de OKKUM: sirve la página y retransmite el walkie-talkie por WebSocket.
// Sin dependencias: solo necesita Node 18 o superior.   Uso:  node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8'
};
const PRIVATE = new Set(['server.js', 'package.json', 'package-lock.json']);

/* ---------- Archivos estáticos ---------- */
const server = http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (e) { res.writeHead(400); return res.end(); }
  if (p === '/' ) p = '/index.html';
  if (p === '/health') { res.writeHead(200); return res.end('ok'); }
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT + path.sep) || PRIVATE.has(path.basename(file)) || file.split(path.sep).some(s => s.startsWith('.'))) {
    res.writeHead(404); return res.end('No encontrado');
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('No encontrado'); }
    const ext = path.extname(file).toLowerCase();
    const nocache = ext === '.html' || path.basename(file) === 'sw.js' || ext === '.webmanifest';
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': nocache ? 'no-cache' : 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(data);
  });
});

/* ---------- WebSocket mínimo (RFC 6455) ---------- */
const rooms = new Map(); // nombre -> Set<socket>
const MAX_FRAME = 64 * 1024;
const MAX_MSG = 20 * 1024;

function frame(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, payload]);
}
function send(sock, obj) {
  if (sock.destroyed || !sock.writable) return;
  sock.write(frame(1, Buffer.from(JSON.stringify(obj))));
}
function peersUpdate(name) {
  const set = rooms.get(name);
  if (!set) return;
  for (const s of set) send(s, { t: 'peers', n: set.size - 1 });
}
function leave(sock) {
  const name = sock.room;
  if (!name) return;
  sock.room = null;
  const set = rooms.get(name);
  if (!set) return;
  set.delete(sock);
  if (set.size === 0) rooms.delete(name); else peersUpdate(name);
}
function onMessage(sock, text) {
  let m;
  try { m = JSON.parse(text); } catch (e) { return; }
  if (!m || typeof m.t !== 'string') return;
  // límite: 60 mensajes por segundo por conexión
  const now = Date.now();
  if (now - sock.win > 1000) { sock.win = now; sock.count = 0; }
  if (++sock.count > 60) return;

  if (m.t === 'join') {
    if (typeof m.room !== 'string' || !/^[a-z0-9-]{1,64}$/.test(m.room)) return;
    leave(sock);
    if (!rooms.has(m.room)) rooms.set(m.room, new Set());
    const set = rooms.get(m.room);
    if (set.size >= 50) return;
    set.add(sock); sock.room = m.room;
    peersUpdate(m.room);
  } else if (m.t === 'msg') {
    if (!sock.room || (m.k !== 'voz' && m.k !== 'perfil')) return;
    const set = rooms.get(sock.room);
    if (!set) return;
    const out = frame(1, Buffer.from(JSON.stringify({ t: 'msg', k: m.k, d: m.d })));
    for (const s of set) if (s !== sock && !s.destroyed && s.writable) s.write(out);
  } else if (m.t === 'ping') {
    send(sock, { t: 'pong' });
  }
}

server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || new URL(req.url, 'http://x').pathname !== '/ws' || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
    sock.write('HTTP/1.1 400 Bad Request\r\n\r\n'); return sock.destroy();
  }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  sock.setNoDelay(true);
  sock.room = null; sock.win = 0; sock.count = 0; sock.alive = true;
  let buf = Buffer.alloc(0);

  sock.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const fin = (buf[0] & 0x80) !== 0, op = buf[0] & 0x0f, masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; const b = buf.readBigUInt64BE(2); if (b > BigInt(MAX_FRAME)) return sock.destroy(); len = Number(b); off = 10; }
      if (!masked || len > MAX_FRAME) return sock.destroy();
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4);
      const data = Buffer.from(buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      buf = buf.subarray(off + 4 + len);
      if (op === 8) { sock.end(frame(8, Buffer.alloc(0))); return; }
      if (op === 9) { sock.write(frame(10, data)); continue; }
      if (op === 10) { sock.alive = true; continue; }
      if (op === 1 && fin && data.length <= MAX_MSG) onMessage(sock, data.toString('utf8'));
      else if (op !== 1 || !fin) return sock.destroy(); // no se admiten binarios ni fragmentos
    }
  });
  sock.on('close', () => leave(sock));
  sock.on('error', () => sock.destroy());
  sock.on('pong', () => { sock.alive = true; });
  sock.hb = setInterval(() => { // mantiene viva la conexión tras proxies y detecta caídas
    if (sock.destroyed) return clearInterval(sock.hb);
    if (sock.alive === false) return sock.destroy();
    sock.alive = false; sock.write(frame(9, Buffer.alloc(0)));
  }, 30000);
  sock.on('close', () => clearInterval(sock.hb));
});

server.listen(PORT, () => console.log('OKKUM listo en http://localhost:' + PORT));
