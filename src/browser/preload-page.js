/* Runs inside every private-browser page before page scripts: masks personal
 * info in place, using the same engine as the StreamMask browser extension
 * (src/content/*, refreshed with `npm run sync-engine`). */
const fs = require('fs');
const path = require('path');
const { webFrame } = require('electron');

const arg = process.argv.find(a => a.startsWith('--streammask-settings='));
let settings = { enabled: true, customWords: [] };
try { settings = JSON.parse(Buffer.from(arg.split('=')[1], 'base64').toString('utf8')); } catch (e) {}

/* Gölge kök kancası sayfanın ana dünyasında çalışmak zorunda: attachShadow
 * hiçbir MutationObserver kaydı üretmez ve izole dünyadan sayfanın kendi
 * prototipi yamalanamaz. Preload izole dünyada çalışır, webFrame.executeJavaScript
 * ise ana dünyada — gölge köklerin maskelenmesi buna bağlı. */
try {
  const hook = fs.readFileSync(path.join(__dirname, '..', 'content', 'shadow-hook.js'), 'utf8');
  webFrame.executeJavaScript(hook).catch(() => {});
} catch (e) { /* kanca yüklenemezse yalnızca gölge kökler maskesiz kalır */ }

/* detect.js hem tarayıcı hem Node altında çalışacak şekilde yazıldı; burada
 * CommonJS olarak yüklenir, mask.js ise onu self üzerinde arar. */
self.StreamMaskDetect = require('../content/detect.js');
window.__YK_SETTINGS = settings;
require('../content/mask.js');
