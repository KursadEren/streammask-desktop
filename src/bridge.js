/* StreamMask Desktop – köprü sunucusu
 *
 * Tarayıcı uzantısı ile masaüstü uygulamasını tek anahtara bağlar: yayına
 * geçtiğinde uygulamalar gizlenir VE tarayıcıda maskeleme açılır; hangisinden
 * başlatırsan başlat ikisi birlikte hareket eder.
 *
 * Bağımlılık eklemiyoruz (npm install gerektirmesin diye): WebSocket el sıkışması
 * ve çerçeveleme burada elle yapılıyor. Taşınan veri tek satırlık JSON olduğu için
 * ihtiyaç duyulan kısım küçük.
 *
 * Güvenlik: yalnızca 127.0.0.1 dinlenir ve her istemci bir jeton göndermek
 * zorundadır. Jeton şart, çünkü herhangi bir web sayfası da localhost'a WebSocket
 * açabilir (WebSocket'te CORS yoktur); jetonu yalnızca kullanıcının kendi
 * uygulamasının arayüzü gösterir.
 */
const http = require('http');
const crypto = require('crypto');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME = 1 << 20;            // 1 MB: bu protokolde taşınan her şeyden büyük

function accept(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

/* ---- çerçeve yazma (sunucu -> istemci, maskesiz) ---- */
function encode(data, opcode = 0x1) {
  const payload = Buffer.from(data);
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;          // FIN + opcode
  return Buffer.concat([header, payload]);
}

/* Kapanış çerçevesinin yükü: 2 bayt durum kodu + UTF-8 gerekçe. Kodu yazmazsak
 * tarayıcı gerekçenin ilk iki baytını durum kodu sanar. */
function encodeClose(code, reason) {
  const r = Buffer.from(String(reason || ''), 'utf8');
  const payload = Buffer.alloc(2 + r.length);
  payload.writeUInt16BE(code, 0);
  r.copy(payload, 2);
  return encode(payload, 0x8);
}

/* ---- çerçeve okuma (istemci -> sunucu, daima maskeli) ---- */
function createParser(onMessage, onClose, onPing) {
  let buf = Buffer.alloc(0);
  let fragments = [];
  let fragOpcode = 0;

  return function push(chunk) {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buf.length < offset + 2) return;
        len = buf.readUInt16BE(offset); offset += 2;
      } else if (len === 127) {
        if (buf.length < offset + 8) return;
        const big = buf.readBigUInt64BE(offset); offset += 8;
        if (big > BigInt(MAX_FRAME)) { onClose(1009, 'too large'); return; }
        len = Number(big);
      }
      if (len > MAX_FRAME) { onClose(1009, 'too large'); return; }
      if (!masked) { onClose(1002, 'unmasked frame'); return; }   // istemci çerçeveleri maskeli olmalı
      if (buf.length < offset + 4 + len) return;
      const key = buf.slice(offset, offset + 4); offset += 4;
      const payload = buf.slice(offset, offset + len);
      for (let i = 0; i < payload.length; i++) payload[i] ^= key[i & 3];
      buf = buf.slice(offset + len);

      if (opcode === 0x8) { onClose(1000, 'client closed'); return; }
      if (opcode === 0x9) { onPing(payload); continue; }
      if (opcode === 0xa) continue;                                // pong
      if (opcode === 0x0) {                                        // devam çerçevesi
        fragments.push(payload);
        if (fin) { onMessage(Buffer.concat(fragments).toString('utf8'), fragOpcode); fragments = []; }
        continue;
      }
      if (!fin) { fragments = [payload]; fragOpcode = opcode; continue; }
      onMessage(payload.toString('utf8'), opcode);
    }
  };
}

class Bridge {
  constructor() {
    this.server = null;
    this.clients = new Set();
    this.onCommand = null;
    this.getState = null;
    this.token = '';
    this.port = 0;
    this.onLog = null;
  }

  log(msg) { if (this.onLog) this.onLog(msg); }

  start({ port, token, getState, onCommand, onLog }) {
    this.stop();
    this.token = token;
    this.port = port;
    this.getState = getState;
    this.onCommand = onCommand;
    this.onLog = onLog;

    this.server = http.createServer((req, res) => {
      // Düz HTTP isteklerine bilgi sızdırma; yalnızca canlı olduğumuzu söyle
      res.writeHead(426, { 'Content-Type': 'text/plain' });
      res.end('StreamMask bridge: WebSocket only');
    });

    this.server.on('upgrade', (req, socket) => {
      const remote = socket.remoteAddress || '';
      if (!/^(::1|::ffff:127\.0\.0\.1|127\.0\.0\.1)$/.test(remote)) { socket.destroy(); return; }
      const key = req.headers['sec-websocket-key'];
      if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') { socket.destroy(); return; }
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Accept: ' + accept(key) + '\r\n\r\n'
      );
      this._attach(socket);
    });

    this.server.on('error', (e) => this.log('bridge: ' + e.message));
    this.server.listen(port, '127.0.0.1', () => this.log('bridge: listening on 127.0.0.1:' + port));
  }

  _attach(socket) {
    const client = { socket, authed: false, timer: null };
    socket.setNoDelay(true);

    const close = (code, reason) => {
      if (client.timer) clearTimeout(client.timer);
      this.clients.delete(client);
      try { socket.write(encodeClose(code || 1000, reason)); } catch (e) {}
      try { socket.destroy(); } catch (e) {}
    };

    // Jetonu makul sürede göndermeyen bağlantıyı kapat
    client.timer = setTimeout(() => { if (!client.authed) close(1008, 'auth timeout'); }, 5000);

    const parser = createParser(
      (text) => {
        let msg;
        try { msg = JSON.parse(text); } catch (e) { return; }
        if (!client.authed) {
          if (msg.type !== 'hello' || msg.token !== this.token) { close(1008, 'bad token'); return; }
          client.authed = true;
          clearTimeout(client.timer); client.timer = null;
          this.clients.add(client);
          this.log('bridge: extension connected');
          this.sendTo(client, { type: 'state', ...this.getState() });
          return;
        }
        if (msg.type === 'live' && this.onCommand) this.onCommand('live', !!msg.on);
        else if (msg.type === 'get') this.sendTo(client, { type: 'state', ...this.getState() });
      },
      close,
      (payload) => { try { socket.write(encode(payload, 0xa)); } catch (e) {} }
    );

    socket.on('data', chunk => { try { parser(chunk); } catch (e) { close(1011, 'parse error'); } });
    socket.on('error', () => close(1011, 'socket error'));
    socket.on('close', () => { if (client.timer) clearTimeout(client.timer); this.clients.delete(client); });
  }

  sendTo(client, obj) {
    try { client.socket.write(encode(JSON.stringify(obj))); } catch (e) { this.clients.delete(client); }
  }

  broadcast(obj) {
    for (const c of this.clients) this.sendTo(c, obj);
  }

  get connections() { return this.clients.size; }

  stop() {
    for (const c of this.clients) { try { c.socket.destroy(); } catch (e) {} }
    this.clients.clear();
    if (this.server) { try { this.server.close(); } catch (e) {} this.server = null; }
  }
}

module.exports = { Bridge, encode, encodeClose, accept, createParser };
