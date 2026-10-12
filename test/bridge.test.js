/* Köprünün WebSocket çerçevelemesi elle yazıldı (bağımlılık eklemeyelim diye).
 * Uzunluk kodlamaları, maskeleme ve kapanış kodu sessizce bozulabilecek yerler:
 * tarayıcı "bağlantı koptu" der, nedenini söylemez. Bu yüzden burada kilitli.
 */
const assert = require('assert');
const { encode, encodeClose, accept, createParser } = require('../src/bridge');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; }
  catch (e) { fail++; console.error('✗ ' + name + '\n    ' + (e && e.message || e)); }
}

/* İstemci çerçevesi: daima maskeli (RFC 6455) */
function clientFrame(payload, opcode = 0x1, mask = true, fin = true) {
  const data = Buffer.from(payload);
  const len = data.length;
  let head;
  if (len < 126) { head = Buffer.alloc(2); head[1] = len; }
  else if (len < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  head[0] = (fin ? 0x80 : 0) | opcode;
  if (!mask) return Buffer.concat([head, data]);
  head[1] |= 0x80;
  const key = Buffer.from([1, 2, 3, 4]);
  const masked = Buffer.from(data);
  for (let i = 0; i < masked.length; i++) masked[i] ^= key[i & 3];
  return Buffer.concat([head, key, masked]);
}

function collect() {
  const out = { messages: [], closes: [], pings: [] };
  out.push = createParser(
    (text) => out.messages.push(text),
    (code, reason) => out.closes.push({ code, reason }),
    (payload) => out.pings.push(payload.toString())
  );
  return out;
}

test('el sıkışma anahtarı (RFC 6455 örneği)', () => {
  assert.strictEqual(accept('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('kısa mesaj', () => {
  const c = collect();
  c.push(clientFrame('merhaba'));
  assert.deepStrictEqual(c.messages, ['merhaba']);
});

test('126+ bayt: 2 baytlık uzunluk', () => {
  const c = collect();
  const s = 'x'.repeat(300);
  c.push(clientFrame(s));
  assert.strictEqual(c.messages[0], s);
});

test('65536+ bayt: 8 baytlık uzunluk', () => {
  const c = collect();
  const s = 'y'.repeat(70000);
  c.push(clientFrame(s));
  assert.strictEqual(c.messages[0].length, 70000);
});

test('parçalı gelen tek çerçeve birleştirilir', () => {
  const c = collect();
  const frame = clientFrame('{"type":"hello"}');
  c.push(frame.slice(0, 3));
  c.push(frame.slice(3, 7));
  c.push(frame.slice(7));
  assert.deepStrictEqual(c.messages, ['{"type":"hello"}']);
});

test('arka arkaya iki çerçeve tek pakette', () => {
  const c = collect();
  c.push(Buffer.concat([clientFrame('bir'), clientFrame('iki')]));
  assert.deepStrictEqual(c.messages, ['bir', 'iki']);
});

test('devam çerçeveleri (fragmentation)', () => {
  const c = collect();
  c.push(clientFrame('mer', 0x1, true, false));
  c.push(clientFrame('haba', 0x0, true, true));
  assert.deepStrictEqual(c.messages, ['merhaba']);
});

test('maskesiz istemci çerçevesi reddedilir', () => {
  const c = collect();
  c.push(clientFrame('merhaba', 0x1, false));
  assert.deepStrictEqual(c.messages, []);
  assert.strictEqual(c.closes[0].code, 1002);
});

test('çok büyük çerçeve reddedilir', () => {
  const c = collect();
  const head = Buffer.alloc(10);
  head[0] = 0x81; head[1] = 127 | 0x80;
  head.writeBigUInt64BE(BigInt(1 << 30), 2);
  c.push(head);
  assert.strictEqual(c.closes[0].code, 1009);
});

test('ping -> pong yükü korunur', () => {
  const c = collect();
  c.push(clientFrame('yokla', 0x9));
  assert.deepStrictEqual(c.pings, ['yokla']);
});

test('istemci kapanışı bildirilir', () => {
  const c = collect();
  c.push(clientFrame('', 0x8));
  assert.strictEqual(c.closes[0].code, 1000);
});

test('sunucu çerçevesi maskesiz ve FIN işaretli', () => {
  const f = encode('selam');
  assert.strictEqual(f[0], 0x81, 'FIN + text opcode');
  assert.strictEqual(f[1] & 0x80, 0, 'sunucu maskelemez');
  assert.strictEqual(f[1] & 0x7f, 5);
  assert.strictEqual(f.slice(2).toString(), 'selam');
});

test('kapanış çerçevesi durum kodunu taşır', () => {
  // Kod yazılmazsa tarayıcı gerekçenin ilk iki baytını kod sanar
  const f = encodeClose(1008, 'bad token');
  assert.strictEqual(f[0], 0x88);
  const payload = f.slice(2);
  assert.strictEqual(payload.readUInt16BE(0), 1008);
  assert.strictEqual(payload.slice(2).toString(), 'bad token');
});

console.log(`\n${pass} geçti, ${fail} başarısız (köprü çerçeveleme)`);
process.exit(fail ? 1 : 0);
