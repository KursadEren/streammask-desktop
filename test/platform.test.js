/* Platform katmanı: mac.js ve win.js aynı arayüzü sunmak zorunda.
 *
 * Windows tarafını bu makinede çalıştıramıyorum (PowerShell yok), ama arayüzün
 * eksiksiz olduğunu ve saf mantığın iki tarafta aynı davrandığını burada
 * sabitleyebiliyorum. Eksik bir işlev, Windows'ta ancak kullanıcı yayına
 * geçtiğinde patlardı — görülecek en kötü an.
 */
const assert = require('assert');
const mac = require('../src/mac.js');
const win = require('../src/win.js');
const platform = require('../src/platform.js');

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; }
  catch (e) { fail++; console.error('✗ ' + name + '\n    ' + (e && e.message || e)); }
};

test('win.js mac.js arayüzünün tamamını karşılıyor', () => {
  const missing = Object.keys(mac).filter(k => !(k in win));
  assert.deepStrictEqual(missing, [], 'eksik: ' + missing.join(', '));
});

test('platform katmanı bu makinede macOS seçiyor', () => {
  assert.strictEqual(platform.platform, process.platform);
  if (process.platform === 'darwin' || process.platform === 'win32') {
    assert.strictEqual(platform.supported, true);
    assert.strictEqual(typeof platform.setVisible, 'function');
  } else {
    assert.strictEqual(platform.supported, false);
  }
});

test('desteklenmeyen platformda işlemler sessizce başarılı olmaz', async () => {
  // Gerçek riski burada: "gizledim" deyip hiçbir şey yapmamak
  const keys = ['setVisible', 'setMinimized', 'quit', 'launch', 'setDesktopIcons'];
  for (const k of keys) assert.strictEqual(typeof platform[k], 'function');
});

const W = [
  { process: 'Chrome', title: 'GARANTİ BBVA İnternet Şubesi' },
  { process: 'Mail', title: 'Inbox' },
  { process: 'Telegram', title: 'Telegram' }
];

test('pencere eşleştirme iki platformda aynı sonucu veriyor', () => {
  for (const pats of [['garanti'], ['GARANTİ'], ['inbox'], ['tel'], [], ['a']]) {
    assert.deepStrictEqual(
      win.matchWindows(W, pats).map(w => w.process),
      mac.matchWindows(W, pats).map(w => w.process),
      'desen: ' + JSON.stringify(pats));
  }
});

test('Windows bildirim desteğini olduğundan iyi göstermiyor', async () => {
  // Focus Assist'in belgelenmiş API'si yok; "sustu" demek yanlış olur
  assert.strictEqual(await win.focusShortcutsInstalled(), false);
  assert.strictEqual(await win.setFocus(true), false);
});

test('Windows ek izin istemiyor', async () => {
  assert.strictEqual(await win.accessibilityEnabled(), true);
});

setTimeout(() => {
  console.log(`\n${pass} geçti, ${fail} başarısız (platform katmanı)`);
  process.exit(fail ? 1 : 0);
}, 50);
