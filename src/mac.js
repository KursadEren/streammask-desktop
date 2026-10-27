/* macOS controller: hide / minimize / quit / relaunch apps, list installed & running apps, Focus via Shortcuts. */
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const run = (cmd, args, timeout = 8000) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) return reject(new Error((stderr || err.message || '').trim()));
    resolve(String(stdout).trim());
  });
});
const osa = (script, timeout) => run('osascript', ['-e', script], timeout);
const safeId = id => /^[A-Za-z0-9._-]{2,200}$/.test(id);

async function runningBundleIds({ visibleOnly = false } = {}) {
  const filter = visibleOnly ? 'whose background only is false and visible is true' : 'whose background only is false';
  const out = await osa(`tell application "System Events" to get bundle identifier of every process ${filter}`);
  return out ? out.split(', ').map(s => s.trim()).filter(Boolean) : [];
}
async function isRunning(id) { return (await runningBundleIds()).includes(id); }

/* Erişilebilirlik izni olmadan System Events pencere işlemlerini sessizce
 * yutuyor: "set visible to false" hata vermeden hiçbir şey yapmıyor. Bir
 * gizlilik aracında bunu fark etmemek en kötüsü — kullanıcı günlükte
 * "hidden" görüp yayına çıkıyor, uygulama ekranda duruyor. Bu yüzden izni
 * kontrol ediyor ve her işlemin sonucunu doğruluyoruz. */
async function accessibilityEnabled() {
  const out = await osa('tell application "System Events" to get UI elements enabled', 6000).catch(() => 'false');
  return String(out).trim() === 'true';
}

async function isVisible(id) {
  const out = await osa(`tell application "System Events" to get visible of (first process whose bundle identifier is "${id}")`, 6000).catch(() => '');
  return String(out).trim() === 'true';
}

/* Gizleme/küçültme başarılı mı: işlem sonrası durumu tekrar okuyup karşılaştırır.
 * Başaramazsa hata fırlatır, çağıran da kullanıcıya doğruyu söyler. */
async function setVisible(id, visible) {
  if (!safeId(id)) throw new Error('bad id');
  await osa(`tell application "System Events" to set visible of (every process whose bundle identifier is "${id}") to ${visible}`);
  await new Promise(r => setTimeout(r, 250));
  if (await isVisible(id) !== visible) {
    throw new Error(await accessibilityEnabled()
      ? 'the app refused to be hidden'
      : 'Accessibility permission not granted');
  }
}

async function setMinimized(id, min) {
  if (!safeId(id)) throw new Error('bad id');
  await osa(`tell application "System Events" to tell (every process whose bundle identifier is "${id}") to set value of attribute "AXMinimized" of every window to ${min}`);
}
async function quit(id) {
  if (!safeId(id)) throw new Error('bad id');
  await osa(`tell application id "${id}" to quit`, 6000).catch(() => {});
}
async function launch(id) {
  if (!safeId(id)) throw new Error('bad id');
  await run('open', ['-b', id]);
}

/* ---------- pencere başlığına göre kurallar ----------
 * Uygulamanın tamamını değil tek pencereyi gizlemek için: başlığı eşleşen
 * pencere simge durumuna küçültülür, yayın bitince geri açılır.
 *
 * Eşleştirme AppleScript içinde değil JS'te yapılıyor: kullanıcının yazdığı
 * desen betiğe gömülseydi tırnak kaçışı bir enjeksiyon yüzeyi olurdu. Betik
 * yalnızca pencereleri listeler, kıyas burada yapılır. */
const asStr = s => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

async function listWindows() {
  const script = `tell application "System Events"
  set out to ""
  repeat with p in (every process whose background only is false)
    repeat with w in (every window of p)
      try
        set out to out & (name of p) & tab & (name of w) & linefeed
      end try
    end repeat
  end repeat
  return out
end tell`;
  const out = await osa(script, 12000).catch(() => '');
  return out.split('\n').map(line => {
    const i = line.indexOf('\t');
    if (i < 0) return null;
    const proc = line.slice(0, i).trim();
    const title = line.slice(i + 1).trim();
    return proc && title ? { process: proc, title } : null;
  }).filter(Boolean);
}

/* Türkçe'nin noktalı/noktasız i'si: "GARANTİ".toLowerCase() JavaScript'te
 * "garanti" değil "garanti̇" verir (İ, altta birleşen bir nokta bırakır), yani
 * desen hiçbir zaman tutmazdı. İki tarafı da aynı şekilde katlıyoruz. */
const foldTr = s => String(s).toLowerCase()
  .replace(/\u0307/g, '')          // İ küçülünce geriye kalan birleşen nokta: at
  .replace(/[ıİI]/g, 'i');         // kalan noktalı/noktasız i'leri tek harfe indir

function matchWindows(windows, patterns) {
  const pats = (patterns || [])
    .map(p => String(p).trim())
    .filter(p => p.length >= 2)
    .map(foldTr);
  if (!pats.length) return [];
  return windows.filter(w => {
    const hay = foldTr(w.process + ' ' + w.title);
    return pats.some(p => hay.includes(p));
  });
}

async function setWindowMinimized(proc, title, min) {
  const script = `tell application "System Events" to tell process ${asStr(proc)}
  try
    set value of attribute "AXMinimized" of (every window whose name is ${asStr(title)}) to ${min}
  end try
end tell`;
  await osa(script, 8000).catch(() => {});
}

/* Küçültülemeyen pencereler (tam ekran gibi) için son çare: uygulamayı gizle */
async function hideProcess(proc) {
  await osa(`tell application "System Events" to set visible of process ${asStr(proc)} to false`, 6000).catch(() => {});
}

/* ---------- installed apps ---------- */
const APP_DIRS = ['/Applications', '/System/Applications', '/System/Applications/Utilities', path.join(os.homedir(), 'Applications')];
function readPlist(p) {
  return run('plutil', ['-convert', 'json', '-o', '-', p]).then(j => JSON.parse(j)).catch(() => null);
}
async function installedApps() {
  const found = [];
  for (const dir of APP_DIRS) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.name.endsWith('.app')) found.push(full);
      else if (e.isDirectory() && dir === '/Applications') {
        try { for (const f of fs.readdirSync(full)) if (f.endsWith('.app')) found.push(path.join(full, f)); } catch (x) {}
      }
    }
  }
  const apps = [];
  await Promise.all(found.map(async p => {
    const info = await readPlist(path.join(p, 'Contents', 'Info.plist'));
    if (!info || !info.CFBundleIdentifier) return;
    if (info.LSUIElement === true || info.LSUIElement === '1' || info.LSBackgroundOnly) return;
    apps.push({ id: info.CFBundleIdentifier, name: info.CFBundleDisplayName || info.CFBundleName || path.basename(p, '.app'), path: p });
  }));
  apps.sort((a, b) => a.name.localeCompare(b.name));
  return apps;
}

/* ---------- Focus / Do Not Disturb via Shortcuts ---------- */
const FOCUS_ON = 'StreamMask Focus On';
const FOCUS_OFF = 'StreamMask Focus Off';
async function focusShortcutsInstalled() {
  try {
    const list = (await run('shortcuts', ['list'])).split('\n');
    return list.includes(FOCUS_ON) && list.includes(FOCUS_OFF);
  } catch (e) { return false; }
}
async function setFocus(on) {
  return run('shortcuts', ['run', on ? FOCUS_ON : FOCUS_OFF], 15000).then(() => true).catch(() => false);
}

/* ---------- Desktop icons (Finder) ---------- */
async function desktopIconsShown() {
  try { return (await run('defaults', ['read', 'com.apple.finder', 'CreateDesktop'])).trim() !== '0' && (await run('defaults', ['read', 'com.apple.finder', 'CreateDesktop'])).trim().toLowerCase() !== 'false'; }
  catch (e) { return true; }   // anahtar yoksa varsayılan: gösteriliyor
}
async function setDesktopIcons(show) {
  await run('defaults', ['write', 'com.apple.finder', 'CreateDesktop', '-bool', show ? 'true' : 'false']);
  await run('killall', ['Finder']).catch(() => {});
}

module.exports = { accessibilityEnabled, isVisible, listWindows, matchWindows, setWindowMinimized, hideProcess, desktopIconsShown, setDesktopIcons, runningBundleIds, isRunning, setVisible, setMinimized, quit, launch, installedApps, focusShortcutsInstalled, setFocus, FOCUS_ON, FOCUS_OFF };
