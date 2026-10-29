/* Platforma göre denetleyiciyi seçer.
 *
 * mac.js ve win.js aynı arayüzü sunar. Desteklenmeyen bir platformda sahte bir
 * modül dönmüyoruz: uygulamanın "gizledim" deyip hiçbir şey yapmaması, bir
 * gizlilik aracındaki en kötü hata. Onun yerine supported=false diyoruz ve
 * işlemler açıkça hata veriyor; arayüz de bunu kullanıcıya söylüyor.
 *
 * Linux neden yok: Wayland'da bir uygulama başka uygulamaların pencerelerini ne
 * listeleyebilir ne gizleyebilir — bu bir eksiklik değil, güvenlik tasarımı.
 * Ekran kaydından gizlenen pencere de Electron'da Linux'ta desteklenmiyor.
 * X11'de wmctrl ile kısmen mümkün, ama Ubuntu ve Fedora artık Wayland.
 */
const supported = process.platform === 'darwin' || process.platform === 'win32';

const impl = process.platform === 'darwin' ? require('./mac')
  : process.platform === 'win32' ? require('./win')
    : null;

const nope = () => { throw new Error('not supported on this platform'); };
const unsupported = {
  accessibilityEnabled: async () => false,
  isVisible: async () => false,
  listWindows: async () => [],
  matchWindows: () => [],
  setWindowMinimized: async () => {},
  hideProcess: async () => {},
  desktopIconsShown: async () => true,
  setDesktopIcons: async () => nope(),
  runningBundleIds: async () => [],
  isRunning: async () => false,
  setVisible: async () => nope(),
  setMinimized: async () => nope(),
  quit: async () => nope(),
  launch: async () => nope(),
  installedApps: async () => [],
  focusShortcutsInstalled: async () => false,
  setFocus: async () => false,
  FOCUS_ON: '',
  FOCUS_OFF: ''
};

module.exports = Object.assign({ supported, platform: process.platform }, impl || unsupported);
