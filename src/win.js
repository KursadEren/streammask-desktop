/* Windows controller: mac.js ile aynı arayüz, PowerShell + Win32 ile.
 *
 * macOS'taki karşılığından bir farkı var: burada Erişilebilirlik gibi bir izin
 * yok. Aynı kullanıcının süreçlerinin pencerelerini gizlemek için yükseltilmiş
 * yetki de gerekmiyor, yani mac tarafındaki "komut sessizce yutuldu" sorunu
 * burada yaşanmıyor. Yine de her işlemin sonucunu doğruluyoruz.
 *
 * Kimlik olarak paket kimliği değil süreç adı kullanılıyor ("chrome", "Discord"),
 * çünkü Windows'ta paket kimliği diye bir şey yok.
 */
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PS = process.env.SystemRoot
  ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell.exe';

function ps(script, timeout = 12000) {
  return new Promise((resolve, reject) => {
    execFile(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || err.message || '').trim()));
        resolve(String(stdout).trim());
      });
  });
}

async function psJson(script, timeout) {
  const out = await ps(script + ' | ConvertTo-Json -Compress -Depth 3', timeout).catch(() => '');
  if (!out) return [];
  try {
    const v = JSON.parse(out);
    return Array.isArray(v) ? v : [v];
  } catch (e) { return []; }
}

const safeId = id => /^[A-Za-z0-9 ._+-]{1,120}$/.test(id);
/* PowerShell tek tırnaklı dizgede yalnızca tek tırnak kaçışı ister */
const q = s => "'" + String(s).replace(/'/g, "''") + "'";

/* ---------- Win32 yardımcısı ----------
 * ShowWindow başka bir sürecin penceresini gizler; gizlenen pencere görev
 * çubuğundan da kaybolur, yayında istediğimiz tam olarak bu. */
const WIN32 = `
Add-Type -Namespace SM -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
'@ -ErrorAction SilentlyContinue
`;
const SW = { hide: 0, show: 5, minimize: 6, restore: 9 };

/* ---------- süreçler ---------- */
async function runningBundleIds({ visibleOnly = false } = {}) {
  const rows = await psJson(
    `Get-Process | Where-Object { $_.MainWindowHandle -ne 0 }` +
    `${visibleOnly ? '' : ''} | Select-Object -ExpandProperty ProcessName | Sort-Object -Unique`);
  const names = rows.map(r => (typeof r === 'string' ? r : r && r.ProcessName)).filter(Boolean);
  if (!visibleOnly) return names;
  const vis = await psJson(WIN32 +
    `Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and [SM.Native]::IsWindowVisible($_.MainWindowHandle) }` +
    ` | Select-Object -ExpandProperty ProcessName | Sort-Object -Unique`);
  return vis.map(r => (typeof r === 'string' ? r : r && r.ProcessName)).filter(Boolean);
}
async function isRunning(id) { return (await runningBundleIds()).includes(id); }

async function isVisible(id) {
  if (!safeId(id)) return false;
  const out = await ps(WIN32 +
    `$p = Get-Process -Name ${q(id)} -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1;` +
    `if ($p) { [SM.Native]::IsWindowVisible($p.MainWindowHandle) } else { 'none' }`).catch(() => 'none');
  return String(out).trim().toLowerCase() === 'true';
}

/* Pencereyi gizle/göster ve sonucu doğrula: "yaptım" deyip yapmamak yok */
async function setVisible(id, visible) {
  if (!safeId(id)) throw new Error('bad id');
  await ps(WIN32 +
    `Get-Process -Name ${q(id)} -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } |` +
    ` ForEach-Object { [void][SM.Native]::ShowWindow($_.MainWindowHandle, ${visible ? SW.show : SW.hide}) }`);
  await new Promise(r => setTimeout(r, 250));
  if (await isVisible(id) !== visible) throw new Error('the window did not change state');
}

async function setMinimized(id, min) {
  if (!safeId(id)) throw new Error('bad id');
  await ps(WIN32 +
    `Get-Process -Name ${q(id)} -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } |` +
    ` ForEach-Object { [void][SM.Native]::ShowWindow($_.MainWindowHandle, ${min ? SW.minimize : SW.restore}) }`);
}

/* Önce nazikçe kapat (kaydedilmemiş iş kaybolmasın), sonra zorlamadan vazgeç */
async function quit(id) {
  if (!safeId(id)) throw new Error('bad id');
  await ps(`Get-Process -Name ${q(id)} -ErrorAction SilentlyContinue | ForEach-Object { [void]$_.CloseMainWindow() }`, 8000)
    .catch(() => {});
}
async function launch(id) {
  if (!safeId(id)) throw new Error('bad id');
  await ps(`Start-Process ${q(id)}`, 8000);
}

/* ---------- kurulu uygulamalar ----------
 * Başlat menüsü kısayolları; Get-StartApps her sürümde yok, kısayolları
 * doğrudan okumak daha güvenilir. */
const START_DIRS = [
  path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
  path.join(process.env.ProgramData || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs')
];
async function installedApps() {
  const found = new Map();
  for (const dir of START_DIRS) {
    if (!dir || !fs.existsSync(dir)) continue;
    const walk = d => {
      let entries = [];
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
      for (const e of entries) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.toLowerCase().endsWith('.lnk')) {
          const name = path.basename(e.name, path.extname(e.name));
          if (!found.has(name)) found.set(name, { id: name, name, path: full });
        }
      }
    };
    walk(dir);
  }
  // Çalışan süreçler kesin doğru kimliği verir, kısayol adları her zaman eşleşmez
  for (const n of await runningBundleIds()) {
    if (!found.has(n)) found.set(n, { id: n, name: n, path: '' });
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/* ---------- pencere başlığı kuralları ---------- */
async function listWindows() {
  const rows = await psJson(
    `Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } |` +
    ` Select-Object ProcessName, MainWindowTitle`);
  return rows
    .map(r => ({ process: r.ProcessName, title: r.MainWindowTitle }))
    .filter(w => w.process && w.title);
}

/* Türkçe'nin noktalı/noktasız i'si: "GARANTİ".toLowerCase() "garanti" vermez */
const foldTr = s => String(s).toLowerCase().replace(/̇/g, '').replace(/[ıİI]/g, 'i');
function matchWindows(windows, patterns) {
  const pats = (patterns || []).map(p => String(p).trim()).filter(p => p.length >= 2).map(foldTr);
  if (!pats.length) return [];
  return windows.filter(w => {
    const hay = foldTr(w.process + ' ' + w.title);
    return pats.some(p => hay.includes(p));
  });
}

async function setWindowMinimized(proc, title, min) {
  if (!safeId(proc)) return;
  await ps(WIN32 +
    `Get-Process -Name ${q(proc)} -ErrorAction SilentlyContinue |` +
    ` Where-Object { $_.MainWindowTitle -eq ${q(title)} } |` +
    ` ForEach-Object { [void][SM.Native]::ShowWindow($_.MainWindowHandle, ${min ? SW.minimize : SW.restore}) }`)
    .catch(() => {});
}
async function hideProcess(proc) { await setVisible(proc, false).catch(() => {}); }

/* ---------- izinler ----------
 * Windows'ta pencere gizlemek için ek izin gerekmiyor; mac.js ile aynı arayüzü
 * koruyabilmek için hep true dönüyor. */
async function accessibilityEnabled() { return true; }

/* ---------- bildirimler ----------
 * Focus Assist'in belgelenmiş bir API'si yok. Yanlış bir kayıt defteri anahtarıyla
 * oynayıp "sustu" demektense desteklemediğimizi söylüyoruz: kullanıcı bildirimlerin
 * susturulduğunu sanmasın. */
async function focusShortcutsInstalled() { return false; }
async function setFocus() { return false; }

/* ---------- masaüstü simgeleri ---------- */
async function desktopIconsShown() {
  const out = await ps(
    `(Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced'` +
    ` -Name HideIcons -ErrorAction SilentlyContinue).HideIcons`).catch(() => '');
  return String(out).trim() !== '1';
}
async function setDesktopIcons(show) {
  await ps(
    `Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced'` +
    ` -Name HideIcons -Value ${show ? 0 : 1} -Type DWord;` +
    ` Stop-Process -Name explorer -Force`, 15000);
}

module.exports = {
  accessibilityEnabled, isVisible, listWindows, matchWindows, setWindowMinimized, hideProcess,
  desktopIconsShown, setDesktopIcons, runningBundleIds, isRunning, setVisible, setMinimized,
  quit, launch, installedApps, focusShortcutsInstalled, setFocus,
  FOCUS_ON: '', FOCUS_OFF: ''
};
