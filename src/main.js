/* StreamMask Desktop – main process */
const { app, BrowserWindow, WebContentsView, ipcMain, globalShortcut, Tray, Menu, nativeImage, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const mac = require('./mac');

const isMac = process.platform === 'darwin';
const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');
const DEFAULTS = {
  rules: [],                 // [{id, name, path, action:'hide'|'minimize'|'quit', relaunch:true}]
  guard: true,               // re-hide apps that pop up while live
  focus: true,               // switch Focus (Do Not Disturb) on while live
  hideSelf: true,            // keep StreamMask windows out of screen capture
  hideDesktop: false,        // hide Finder desktop icons while live
  maskWords: [],             // extra words masked inside the private browser
  homepage: 'https://duckduckgo.com'
};
let settings = { ...DEFAULTS };
function loadSettings() {
  try { settings = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8')) }; } catch (e) { settings = { ...DEFAULTS }; }
}
function saveSettings() { fs.mkdirSync(path.dirname(SETTINGS_FILE()), { recursive: true }); fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(settings, null, 2)); }

/* ---------------- live state ---------------- */
const live = { on: false, since: 0, snapshot: [], focusApplied: false, desktopHidden: false, log: [] };
let guardTimer = null;
let controlWin = null, tray = null;

function log(msg) {
  live.log.unshift({ t: Date.now(), msg });
  live.log = live.log.slice(0, 50);
  broadcast();
}
function publicState() {
  return { live: live.on, since: live.since, settings, log: live.log, focusReady: null, platform: process.platform };
}
function broadcast() {
  if (controlWin && !controlWin.isDestroyed()) controlWin.webContents.send('state', publicState());
  updateTray();
}

async function goLive() {
  if (live.on) return;
  live.on = true; live.since = Date.now(); live.snapshot = []; live.log = [];
  log('Going live…');
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
  if (settings.guard) guardTimer = setInterval(guardTick, 3000);
  log('LIVE');
}
async function guardTick() {
  if (!live.on) return;
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
function pbNewTab(url) {
  const view = new WebContentsView({
    webPreferences: {
      partition: 'persist:private', preload: path.join(__dirname, 'browser', 'preload-page.js'),
      contextIsolation: true, sandbox: false, nodeIntegration: false,
      additionalArguments: ['--streammask-words=' + Buffer.from(JSON.stringify(settings.maskWords || [])).toString('base64')]
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
ipcMain.handle('setLive', async (e, on) => { if (on) await goLive(); else await endLive(); return publicState(); });
ipcMain.handle('installedApps', async () => mac.installedApps());
ipcMain.handle('runningApps', async () => mac.runningBundleIds());
ipcMain.handle('appIcon', async (e, p) => { try { const img = await app.getFileIcon(p, { size: 'normal' }); return img.toDataURL(); } catch (x) { return null; } });
ipcMain.handle('saveSettings', (e, s) => { settings = { ...settings, ...s }; saveSettings(); if (controlWin) controlWin.setContentProtection(!!settings.hideSelf); broadcast(); return settings; });
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
