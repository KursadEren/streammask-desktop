/* Pencere başlığı eşleştirmesi. AppleScript tarafı sınanamaz (gerçek pencere ve
 * erişilebilirlik izni ister), ama hangi pencerenin gizleneceğine karar veren
 * mantık saf ve burada kilitli: fazla gizlemek kullanıcının yayınını bozar. */
const assert = require('assert');
const { matchWindows } = require('../src/mac.js');

let pass = 0, fail = 0;
const test = (name, fn) => { try { fn(); pass++; } catch (e) { fail++; console.error('✗ ' + name + '\n    ' + e.message); } };

const W = [
  { process: 'Mail', title: 'Gelen Kutusu — kursad@example.com' },
  { process: 'Safari', title: 'Garanti BBVA İnternet Şubesi' },
  { process: 'Code', title: 'main.js — streammask' },
  { process: 'Telegram', title: 'Telegram' },
  { process: 'Messages', title: 'Ayşe' }
];
const names = r => r.map(w => w.process).sort();

test('başlıkta geçen metin yakalanır', () => {
  assert.deepStrictEqual(names(matchWindows(W, ['garanti'])), ['Safari']);
  assert.deepStrictEqual(names(matchWindows(W, ['gelen kutusu'])), ['Mail']);
});

test('uygulama adı da aranır', () => {
  assert.deepStrictEqual(names(matchWindows(W, ['telegram'])), ['Telegram']);
});

test('büyük-küçük harf farketmez', () => {
  assert.deepStrictEqual(names(matchWindows(W, ['MAIL'])), ['Mail']);
});

/* "GARANTİ".toLowerCase() JavaScript'te "garanti" değil "garanti̇" verir: İ,
 * altta birleşen bir nokta bırakır. Katlama olmadan desen hiç tutmaz. */
test('Türkçe İ ve ı her yazımda eşleşir', () => {
  for (const p of ['GARANTİ', 'Garanti', 'garanti', 'GARANTI']) {
    assert.deepStrictEqual(names(matchWindows(W, [p])), ['Safari'], p + ' eşleşmeliydi');
  }
  const tr = [{ process: 'Safari', title: 'IŞIK Üniversitesi' }];
  for (const p of ['ışık', 'IŞIK', 'Işık']) {
    assert.strictEqual(matchWindows(tr, [p]).length, 1, p + ' eşleşmeliydi');
  }
});

test('birden fazla desen birleşir', () => {
  assert.deepStrictEqual(names(matchWindows(W, ['garanti', 'messages'])), ['Messages', 'Safari']);
});

test('boş liste hiçbir şey gizlemez', () => {
  assert.strictEqual(matchWindows(W, []).length, 0);
  assert.strictEqual(matchWindows(W, null).length, 0);
});

test('tek harflik desen yok sayılır', () => {
  // "a" neredeyse her pencereyi yakalar; kullanıcının yayınını kör etmemeli
  assert.strictEqual(matchWindows(W, ['a']).length, 0);
  assert.strictEqual(matchWindows(W, [' ', '']).length, 0);
});

test('eşleşmeyen desen bir şey döndürmez', () => {
  assert.strictEqual(matchWindows(W, ['bulunmayan']).length, 0);
});

console.log(`\n${pass} geçti, ${fail} başarısız (pencere kuralları)`);
process.exit(fail ? 1 : 0);
