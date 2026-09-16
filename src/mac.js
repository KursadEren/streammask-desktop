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

async function setVisible(id, visible) {
  if (!safeId(id)) throw new Error('bad id');
  await osa(`tell application "System Events" to set visible of (every process whose bundle identifier is "${id}") to ${visible}`);
}
async function setMinimized(id, min) {
  if (!safeId(id)) throw new Error('bad id');
  await osa(`tell application "System Events" to tell (every process whose bundle identifier is "${id}") to set value of attribute "AXMinimized" of every window to ${min}`).catch(() => {});
}
async function quit(id) {
  if (!safeId(id)) throw new Error('bad id');
  await osa(`tell application id "${id}" to quit`, 6000).catch(() => {});
}
async function launch(id) {
  if (!safeId(id)) throw new Error('bad id');
  await run('open', ['-b', id]);
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

module.exports = { runningBundleIds, isRunning, setVisible, setMinimized, quit, launch, installedApps, focusShortcutsInstalled, setFocus, FOCUS_ON, FOCUS_OFF };
