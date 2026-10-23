#!/usr/bin/env node
/* Maskeleme motorunu tarayıcı uzantısından kopyalar.
 *
 * Neden: src/content/mask.js uzun süre uzantının eski bir kopyasıydı ve geride
 * kaldı — uzantıda düzelen hatalar (bellek sızıntısı, IP yanlış pozitifi, ASCII
 * dışı e-posta sızıntısı) burada durmaya devam etti, yeni kategoriler hiç gelmedi.
 * İki kopyayı elle yakın tutmak işe yaramıyor, o yüzden tek kaynak uzantı:
 * burası onu çeker.
 *
 * Kullanım:
 *   npm run sync-engine
 *   STREAMMASK_EXT=/yol/streammask npm run sync-engine
 */
const fs = require('fs');
const path = require('path');

const CANDIDATES = [
  process.env.STREAMMASK_EXT,
  path.join(__dirname, '..', '..', 'streammask'),
  path.join(process.env.HOME || '', 'ClaudeYoutube', 'streammask')
].filter(Boolean);

const src = CANDIDATES.find(p => fs.existsSync(path.join(p, 'detect.js')));
if (!src) {
  console.error('Uzantı deposu bulunamadı. Denenen yerler:\n  ' + CANDIDATES.join('\n  ') +
    '\nSTREAMMASK_EXT ile yolu verin.');
  process.exit(1);
}

const outDir = path.join(__dirname, '..', 'src', 'content');
fs.mkdirSync(outDir, { recursive: true });

const header = (from) =>
  `/* ÜRETİLMİŞ DOSYA — elle düzenlemeyin.\n` +
  ` * Kaynak: StreamMask tarayıcı uzantısı, ${from}\n` +
  ` * Güncellemek için: npm run sync-engine\n` +
  ` */\n`;

const FILES = [
  ['detect.js', 'detect.js'],            // algılama çekirdeği (DOM'a dokunmaz)
  ['shadow-hook.js', 'shadow-hook.js'],  // gölge kök kancası (ana dünyada çalışır)
  ['content.js', 'mask.js']              // DOM katmanı; chrome API yoksa __YK_SETTINGS ile çalışır
];

for (const [from, to] of FILES) {
  const body = fs.readFileSync(path.join(src, from), 'utf8');
  fs.writeFileSync(path.join(outDir, to), header(from) + body);
  console.log('src/content/' + to + '  <-  ' + from);
}

const version = JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf8')).version;
fs.writeFileSync(path.join(outDir, 'ENGINE_VERSION'), version + '\n');
console.log('motor sürümü: ' + version);
