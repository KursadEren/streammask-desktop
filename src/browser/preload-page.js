/* Runs inside every private-browser page before page scripts: masks personal info in place. */
const arg = process.argv.find(a => a.startsWith('--streammask-words='));
let words = [];
try { words = JSON.parse(Buffer.from(arg.split('=')[1], 'base64').toString('utf8')); } catch (e) {}
window.__YK_SETTINGS = { enabled: true, customWords: words };
require('../content/mask.js');
