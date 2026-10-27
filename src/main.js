/* StreamMask Desktop – main process */
const { app, BrowserWindow, WebContentsView, ipcMain, globalShortcut, Tray, Menu, nativeImage, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const mac = require('./mac');
const { Bridge } = require('./bridge');
const detect = require('./content/detect.js');   // ülke listesi ve varsayılanlar için

const isMac = process.platform === 'darwin';
const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');
const DEFAULTS = {
  rules: [],                 // [{id, name, path, action:'hide'|'minimize'|'quit', relaunch:true}]
  titleRules: [],            // pencere başlığında geçen metinler: eşleşen pencere yayında küçültülür
  guard: true,               // re-hide apps that pop up while live
  focus: true,               // switch Focus (Do Not Disturb) on while live
  hideSelf: true,            // keep StreamMask windows out of screen capture
  hideDesktop: false,        // hide Finder desktop icons while live
  maskWords: [],             // extra words masked inside the private browser
  // Gizli tarayıcıdaki maskeleme, uzantıyla aynı motoru kullanır (src/content/)
  maskCategories: { phone: true, email: true, id: true, iban: true, card: true, ip: true, custom: true, secret: true },
  maskIdRegions: null,       // null = sistem diline göre otomatik
  maskStyle: 'stars',        // stars | same | partial | label
  homepage: 'https://duckduckgo.com',
  bridge: true,              // let the browser extension and this app share one switch
  bridgePort: 47811,
  bridgeToken: ''            // first run generates one; paste it into the extension
};
let settings = { ...DEFAULTS };
function loadSettings() {
  try { settings = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8')) }; } catch (e) { settings = { ...DEFAULTS }; }
  if (!settings.bridgeToken) { settings.bridgeToken = crypto.randomBytes(16).toString('hex'); saveSettings(); }
}
function saveSettings() { fs.mkdirSync(path.dirname(SETTINGS_FILE()), { recursive: true }); fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(settings, null, 2)); }

/* ---------------- browser extension bridge ----------------
 * Uzantı ile tek anahtar: buradan yayına geçince tarayıcıda maskeleme açılır,
 * uzantıdan Yayın Modu açılınca da buradaki kurallar çalışır. Yalnızca 127.0.0.1
 * dinlenir ve jeton zorunludur (ayrıntı: src/bridge.js). */
const bridge = new Bridge();
function bridgeState() { return { live: live.on, since: live.since }; }
function applyBridge() {
  bridge.stop();
  if (!settings.bridge) return;
  bridge.start({
    port: Number(settings.bridgePort) || 47811,
    token: settings.bridgeToken,
    getState: bridgeState,
    onCommand: (cmd, value) => {
      if (cmd !== 'live') return;
      if (value && !live.on) { log('Extension went live – applying rules'); goLive(); }
      else if (!value && live.on) { log('Extension ended the stream – restoring'); endLive(); }
    },
    onLog: (m) => log(m)
  });
}

/* ---------------- live state ---------------- */
const live = { on: false, since: 0, snapshot: [], focusApplied: false, desktopHidden: false, titleHidden: [], log: [] };
let guardTimer = null;
let controlWin = null, tray = null;

function log(msg) {
  live.log.unshift({ t: Date.now(), msg });
  live.log = live.log.slice(0, 50);
  broadcast();
}
function publicState() {
  return {
    live: live.on, since: live.since, settings, log: live.log, focusReady: null,
    platform: process.platform, bridgeClients: bridge.connections,
    maskMeta: { regions: detect.ID_REGIONS, defaultRegions: detect.defaultRegions(app.getLocale()) }
  };
}
function broadcast() {
  if (controlWin && !controlWin.isDestroyed()) controlWin.webContents.send('state', publicState());
  bridge.broadcast({ type: 'state', ...bridgeState() });
  updateTray();
}

async function goLive() {
  if (live.on) return;
  live.on = true; live.since = Date.now(); live.snapshot = []; live.log = [];
  log('Going live…');
  // İzin yoksa gizleme komutları hata vermeden hiçbir şey yapmıyor; sessiz
  // kalmak yerine en başta söylüyoruz, kullanıcı korunduğunu sanmasın.
  if ((settings.rules.length || (settings.titleRules || []).length) && !(await mac.accessibilityEnabled())) {
    log('⚠︎ Accessibility permission missing — apps and windows will NOT be hidden. System Settings → Privacy & Security → Accessibility.');
  }
  const running = await mac.runningBundleIds().catch(() => []);
  for (const rule of settings.rules) {
    const wasRunning = running.includes(rule.id);
    if (!wasRunning) { live.snapshot.push({ ...rule, wasRunning: false }); continue; }
    try {
      if (rule.action === 'hide') await mac.setVisible(rule.id, false);
      else if (rule.action === 'minimize') await mac.setMinimized(rule.id, true);
      else if (rule.action === 'quit') await mac.quit(rule.id);
      live.snapshot.push({ ...rule, wasRunning: true });
      log(`${rule.name}: ${rule.action === 'hide' ? 'hidden' : rule.action === 'minimize' ? 'minimized' : 'quit'}`);
    } catch (e) { log(`${rule.name}: failed (${e.message}) – grant Automation/Accessibility permission`); }
  }
  if (settings.focus) {
    if (await mac.focusShortcutsInstalled()) {
      live.focusApplied = await mac.setFocus(true);
      log(live.focusApplied ? 'Focus (Do Not Disturb) on' : 'Focus shortcut failed');
    } else log('Focus shortcuts not installed – notifications are NOT silenced');
  }
  if (settings.hideDesktop) {
    try { if (await mac.desktopIconsShown()) { await mac.setDesktopIcons(false); live.desktopHidden = true; log('Desktop icons hidden'); } }
    catch (e) { log('Desktop icons: failed (' + e.message + ')'); }
  }
  await applyTitleRules().catch(e => log('Title rules: failed (' + e.message + ')'));
  if (settings.guard) guardTimer = setInterval(guardTick, 3000);
  log('LIVE');
}
/* Başlığı eşleşen pencereleri küçült. Günlüğe yalnızca uygulama adı yazılır:
 * pencere başlığı ("Gelen Kutusu — ad@mail.com") kişisel bilgi içerebiliyor ve
 * bu günlük yayında ekranda duruyor olabilir. */
async function applyTitleRules() {
  const pats = settings.titleRules || [];
  if (!pats.length) return 0;
  const self = app.getName();
  const wins = (await mac.listWindows().catch(() => [])).filter(w => w.process !== self);
  let n = 0;
  for (const w of mac.matchWindows(wins, pats)) {
    if (live.titleHidden.some(h => h.process === w.process && h.title === w.title)) continue;
    await mac.setWindowMinimized(w.process, w.title, true);
    live.titleHidden.push({ process: w.process, title: w.title });
    log(`${w.process}: a window matching your title rules was minimized`);
    n++;
  }
  return n;
}
async function restoreTitleRules() {
  for (const h of live.titleHidden) await mac.setWindowMinimized(h.process, h.title, false);
  if (live.titleHidden.length) log(`${live.titleHidden.length} window(s) restored`);
  live.titleHidden = [];
}

async function guardTick() {
  if (!live.on) return;
  await applyTitleRules().catch(() => {});      // yayında açılan pencereleri de yakala
  const visible = await mac.runningBundleIds({ visibleOnly: true }).catch(() => null);
  if (!visible) return;
  for (const rule of settings.rules) {
    if (!visible.includes(rule.id)) continue;
    try {
      if (rule.action === 'hide') { await mac.setVisible(rule.id, false); log(`${rule.name} popped up – hidden again`); }
      else if (rule.action === 'quit') { await mac.quit(rule.id); log(`${rule.name} popped up – quit again`); }
      if (!live.snapshot.some(s => s.id === rule.id)) live.snapshot.push({ ...rule, wasRunning: true });
    } catch (e) {}
  }
}
async function endLive() {
  if (!live.on) return;
  clearInterval(guardTimer); guardTimer = null;
  live.on = false;
  live.snapshot = live.snapshot;
  log('Ending stream – restoring…');
  for (const s of live.snapshot) {
    if (!s.wasRunning) continue;
    try {
      if (s.action === 'hide') await mac.setVisible(s.id, true);
      else if (s.action === 'minimize') await mac.setMinimized(s.id, false);
      else if (s.action === 'quit' && s.relaunch !== false) await mac.launch(s.id);
      log(`${s.name}: restored`);
    } catch (e) { log(`${s.name}: restore failed (${e.message})`); }
  }
  if (live.focusApplied) { await mac.setFocus(false); live.focusApplied = false; log('Focus off'); }
  await restoreTitleRules().catch(() => {});
  if (live.desktopHidden) { try { await mac.setDesktopIcons(true); log('Desktop icons restored'); } catch (e) { log('Desktop icons: restore failed'); } live.desktopHidden = false; }
  live.snapshot = [];
  log('Offline');
}

/* ---------------- control panel ---------------- */
function createControl() {
  controlWin = new BrowserWindow({
    width: 560, height: 720, minWidth: 480, minHeight: 560,
    title: 'StreamMask Desktop', backgroundColor: '#0f0e1a',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    webPreferences: { preload: path.join(__dirname, 'preload-control.js'), contextIsolation: true, sandbox: true }
  });
  controlWin.setContentProtection(!!settings.hideSelf);
  controlWin.loadFile(path.join(__dirname, 'ui', 'control.html'));
  controlWin.on('close', e => { if (!app.isQuitting) { e.preventDefault(); controlWin.hide(); } });
  controlWin.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}
function showControl() { if (!controlWin) createControl(); controlWin.show(); controlWin.focus(); }

/* ---------------- private browser ---------------- */
let pb = null; // { win, chrome, tabs:[{id, view}], active }
const CHROME_H = 86;
let tabSeq = 0;
function pbLayout() {
  if (!pb) return;
  const [w, h] = pb.win.getContentSize();
  pb.chrome.setBounds({ x: 0, y: 0, width: w, height: CHROME_H });
  for (const t of pb.tabs) t.view.setBounds(t.id === pb.active ? { x: 0, y: CHROME_H, width: w, height: h - CHROME_H } : { x: 0, y: 0, width: 0, height: 0 });
}
function pbSend() {
  if (!pb) return;
  pb.chrome.webContents.send('tabs', {
    active: pb.active,
    tabs: pb.tabs.map(t => ({
      id: t.id, title: t.view.webContents.getTitle() || 'New tab', url: t.view.webContents.getURL(),
      loading: t.view.webContents.isLoading(), canBack: t.view.webContents.navigationHistory.canGoBack(), canFwd: t.view.webContents.navigationHistory.canGoForward()
    }))
  });
}
/* Sayfaya gönderilen maskeleme ayarları. Yeni ayar yalnızca yeni sekmelerde
 * ve yeniden yüklemede geçerli olur; açık sekmeler için pbReloadAll çağrılır. */
function maskArg() {
  const payload = {
    enabled: true,
    categories: settings.maskCategories,
    customWords: settings.maskWords || [],
    idRegions: settings.maskIdRegions,
    maskStyle: settings.maskStyle,
    uiLanguage: app.getLocale()
  };
  return '--streammask-settings=' + Buffer.from(JSON.stringify(payload)).toString('base64');
}
function pbReloadAll() {
  if (!pb) return;
  for (const t of pb.tabs) { try { t.view.webContents.reload(); } catch (e) {} }
}

function pbNewTab(url) {
  const view = new WebContentsView({
    webPreferences: {
      partition: 'persist:private', preload: path.join(__dirname, 'browser', 'preload-page.js'),
      contextIsolation: true, sandbox: false, nodeIntegration: false,
      additionalArguments: [maskArg()]
    }
  });
  const id = ++tabSeq;
  const tab = { id, view };
  pb.tabs.push(tab);
  pb.win.contentView.addChildView(view);
  const wc = view.webContents;
  for (const ev of ['page-title-updated', 'did-navigate', 'did-navigate-in-page', 'did-start-loading', 'did-stop-loading', 'did-fail-load']) wc.on(ev, () => pbSend());
  wc.setWindowOpenHandler(({ url }) => { pbNewTab(url); return { action: 'deny' }; });
  wc.on('destroyed', () => pbCloseTab(id, true));
  wc.loadURL(url || settings.homepage).catch(() => {});
  pb.active = id;
  pbLayout(); pbSend();
  return tab;
}
function pbCloseTab(id, alreadyDestroyed) {
  if (!pb) return;
  const i = pb.tabs.findIndex(t => t.id === id);
  if (i < 0) return;
  const [t] = pb.tabs.splice(i, 1);
  try { pb.win.contentView.removeChildView(t.view); } catch (e) {}
  if (!alreadyDestroyed) try { t.view.webContents.close(); } catch (e) {}
  if (pb.active === id) pb.active = pb.tabs.length ? pb.tabs[Math.max(0, i - 1)].id : null;
  if (!pb.tabs.length) pbNewTab();
  pbLayout(); pbSend();
}
function normalizeUrl(input) {
  const s = input.trim();
  if (!s) return settings.homepage;
  if (/^[a-z]+:\/\//i.test(s)) return s;
  if (/^[\w.-]+\.[a-z]{2,}(\/.*)?$/i.test(s) || /^localhost(:\d+)?/.test(s)) return 'https://' + s;
  return 'https://duckduckgo.com/?q=' + encodeURIComponent(s);
}
function openPrivateBrowser() {
  if (pb && !pb.win.isDestroyed()) { pb.win.show(); pb.win.focus(); return; }
  const win = new BrowserWindow({
    width: 1180, height: 800, minWidth: 640, minHeight: 400, title: 'StreamMask Private Browser',
    backgroundColor: '#14131f', titleBarStyle: isMac ? 'hiddenInset' : 'default', trafficLightPosition: { x: 12, y: 12 }
  });
  win.setContentProtection(true);   // invisible to screen capture (macOS sharingType none / Windows WDA_EXCLUDEFROMCAPTURE)
  const chrome = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'browser', 'preload-chrome.js'), contextIsolation: true, sandbox: true } });
  win.contentView.addChildView(chrome);
  chrome.webContents.loadFile(path.join(__dirname, 'browser', 'chrome.html'));
  pb = { win, chrome, tabs: [], active: null };
  win.on('resize', pbLayout);
  win.on('closed', () => { pb = null; });
  chrome.webContents.on('did-finish-load', () => { if (!pb.tabs.length) pbNewTab(); pbSend(); });
}
const pbActive = () => pb && pb.tabs.find(t => t.id === pb.active);

/* ---------------- IPC ---------------- */
ipcMain.handle('state', () => publicState());
ipcMain.handle('focusReady', () => mac.focusShortcutsInstalled());
ipcMain.handle('accessibilityReady', () => mac.accessibilityEnabled());
ipcMain.handle('setLive', async (e, on) => { if (on) await goLive(); else await endLive(); return publicState(); });
ipcMain.handle('installedApps', async () => mac.installedApps());
ipcMain.handle('runningApps', async () => mac.runningBundleIds());
ipcMain.handle('appIcon', async (e, p) => { try { const img = await app.getFileIcon(p, { size: 'normal' }); return img.toDataURL(); } catch (x) { return null; } });
ipcMain.handle('saveSettings', (e, s) => {
  const before = settings.bridge + ':' + settings.bridgePort + ':' + settings.bridgeToken;
  const maskBefore = maskArg();
  settings = { ...settings, ...s };
  saveSettings();
  if (controlWin) controlWin.setContentProtection(!!settings.hideSelf);
  if (before !== settings.bridge + ':' + settings.bridgePort + ':' + settings.bridgeToken) applyBridge();
  if (maskBefore !== maskArg()) pbReloadAll();
  broadcast();
  return settings;
});
ipcMain.handle('openPrivateBrowser', () => { openPrivateBrowser(); });
ipcMain.handle('openExternal', (e, url) => shell.openExternal(url));
ipcMain.handle('openShortcuts', () => shell.openExternal('shortcuts://'));

ipcMain.on('pb', (e, msg) => {
  if (!pb) return;
  const t = pbActive();
  switch (msg.type) {
    case 'new': pbNewTab(); break;
    case 'close': pbCloseTab(msg.id); break;
    case 'switch': pb.active = msg.id; pbLayout(); pbSend(); break;
    case 'go': if (t) t.view.webContents.loadURL(normalizeUrl(msg.url)).catch(() => {}); break;
    case 'back': if (t && t.view.webContents.navigationHistory.canGoBack()) t.view.webContents.navigationHistory.goBack(); break;
    case 'forward': if (t && t.view.webContents.navigationHistory.canGoForward()) t.view.webContents.navigationHistory.goForward(); break;
    case 'reload': if (t) t.view.webContents.reload(); break;
    case 'home': if (t) t.view.webContents.loadURL(settings.homepage); break;
  }
});

/* ---------------- tray & shortcuts ---------------- */
function trayIcon() {
  const img = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon.png')).resize({ width: 18, height: 18 });
  return img;
}
function updateTray() {
  if (!tray) return;
  tray.setTitle(live.on ? ' LIVE' : '');
  tray.setToolTip(live.on ? 'StreamMask – LIVE' : 'StreamMask Desktop');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: live.on ? 'End stream (restore apps)' : 'Go live (hide apps)', click: () => (live.on ? endLive() : goLive()) },
    { label: 'Open Private Browser', click: openPrivateBrowser },
    { label: 'Show control panel', click: showControl },
    { type: 'separator' },
    { label: 'Quit StreamMask', click: () => { app.isQuitting = true; app.quit(); } }
  ]));
}

app.whenReady().then(() => {
  loadSettings();
  applyBridge();
  createControl();
  tray = new Tray(trayIcon());
  updateTray();
  tray.on('click', showControl);
  globalShortcut.register('CommandOrControl+Shift+L', () => (live.on ? endLive() : goLive()));
  globalShortcut.register('CommandOrControl+Shift+P', () => { if (pb && pb.win.isVisible() && pb.win.isFocused()) pb.win.hide(); else openPrivateBrowser(); });
  app.on('activate', showControl);
});
app.on('before-quit', async e => {
  if (live.on) { e.preventDefault(); app.isQuitting = true; await endLive(); app.quit(); }
  else app.isQuitting = true;
});
app.on('window-all-closed', () => { /* keep running in tray */ });
app.on('will-quit', () => bridge.stop());
