/* ÜRETİLMİŞ DOSYA — elle düzenlemeyin.
 * Kaynak: StreamMask tarayıcı uzantısı, content.js
 * Güncellemek için: npm run sync-engine
 */
/* StreamMask - içerik betiği
 * Sayfadaki kişisel bilgileri (telefon, e-posta, kimlik, IBAN, kart, IP, API
 * anahtarları, özel kelimeler) bulup maskeler. Algılama mantığı detect.js'te;
 * bu dosya yalnızca DOM tarafını yapar: tarama, MutationObserver, Shadow DOM,
 * form alanları ve geri yükleme. Maskeleme kapatıldığında orijinal metinler geri
 * gelir; sayfa yenilemeye gerek yoktur.
 */
(() => {
  if (window.__streamMaskLoaded) return;
  window.__streamMaskLoaded = true;

  const D = self.StreamMaskDetect;
  if (!D) return;                     // detect.js yüklenmediyse sayfaya hiç dokunma

  const DEFAULTS = {
    enabled: true,
    categories: { phone: true, email: true, id: true, iban: true, card: true, ip: true, custom: true, secret: true },
    customWords: [],
    whitelist: [],
    idRegions: null,                  // null = tarayıcı diline göre otomatik
    maskStyle: 'stars'                // stars | same | partial | label
  };

  const hasChrome = typeof chrome !== 'undefined' && !!(chrome.storage && chrome.storage.local && chrome.runtime && chrome.runtime.id);
  const uiLanguage = hasChrome && chrome.i18n ? chrome.i18n.getUILanguage() : 'en';
  const i18n = k => (hasChrome && chrome.i18n && chrome.i18n.getMessage(k)) || '';

  let settings = JSON.parse(JSON.stringify(DEFAULTS));
  let patterns = [];
  let maskOptions = { style: 'stars', label: D.MASK };

  const records = new Map();          // TextNode -> { orig, masked, n, by }
  const totals = { n: 0, by: {} };    // artımlı toplam: her mutation'da defteri gezmeyelim
  let sweepAt = 600;                  // defter bu boyuta gelince ölü düğümleri ayıkla
  const secured = new Set();          // nokta gösterimine aldığımız form alanları
  let observer = null;
  const shadowObservers = new Map();  // ShadowRoot -> MutationObserver
  const shadowStyles = [];            // Shadow DOM'a eklediğimiz <style> düğümleri
  const MAX_SHADOW = 500;             // patolojik sayfalarda gözlemci patlamasını önle
  let active = false;
  let reportTimer = null;

  function maskText(text) {
    return D.maskText(text, patterns, maskOptions);
  }
  function buildPatterns() {
    patterns = D.buildPatterns({
      categories: settings.categories,
      customWords: settings.customWords,
      idRegions: settings.idRegions,
      uiLanguage
    });
    maskOptions = { style: settings.maskStyle || 'stars', label: i18n('maskLabel') || '[•••]' };
  }

  /* ---------- DOM tarama ---------- */
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'SVG', 'CANVAS']);

  function inEditable(el) {
    for (let e = el; e; e = e.parentElement) {
      if (e.isContentEditable) return true;
    }
    return false;
  }

  function processTextNode(node) {
    const parent = node.parentElement;
    if (!parent || SKIP_TAGS.has(parent.tagName) || parent.id === '__yk_style') return;
    if (inEditable(parent)) return;
    const cur = node.nodeValue;
    const rec = records.get(node);
    if (rec && cur === rec.masked) return;         // bizim yazdığımız, değişmemiş
    if (!cur || cur.length < 5) { forget(node, rec); return; }
    const { out, n, by } = maskText(cur);
    if (n === 0) { forget(node, rec); return; }
    if (rec) bump(rec, -1);
    const next = { orig: cur, masked: out, n, by };
    records.set(node, next);
    bump(next, 1);
    node.nodeValue = out;
    if (records.size >= sweepAt) sweep();
  }

  /* ---------- defter bakımı ---------- */
  function bump(rec, sign) {
    totals.n += sign * rec.n;
    for (const k in rec.by) {
      const v = (totals.by[k] || 0) + sign * rec.by[k];
      if (v > 0) totals.by[k] = v; else delete totals.by[k];
    }
  }
  function forget(node, rec) {
    if (!rec) return;
    records.delete(node);
    bump(rec, -1);
  }
  /* DOM'dan kopmuş düğümler defteri sonsuza kadar büyütüyordu (sohbet akışları,
   * sanal listeler). Kopmuş düğümün metnini geri yazıp defterden düşürüyoruz:
   * görünmediği için geri yazmak zararsız, tekrar DOM'a eklenirse yeniden maskelenir. */
  function sweep() {
    for (const [node, rec] of records) {
      if (node.isConnected) continue;
      if (node.nodeValue === rec.masked) node.nodeValue = rec.orig;
      records.delete(node);
      bump(rec, -1);
    }
    sweepAt = Math.max(600, records.size * 2);
  }

  const FORM_SKIP = new Set(['password', 'hidden', 'checkbox', 'radio', 'submit', 'button', 'file', 'range', 'color', 'image', 'reset']);
  function processField(el) {
    const tag = el.tagName;
    if (tag !== 'INPUT' && tag !== 'TEXTAREA') return;
    const t = (el.type || 'text').toLowerCase();
    if (FORM_SKIP.has(t)) return;
    const v = el.value || '';
    const hit = t === 'tel' || t === 'email' || (v.length >= 5 && maskText(v).n > 0);
    el.classList.toggle('__yk-secure', hit);
    if (hit) secured.add(el); else secured.delete(el);
  }

  /* Shadow DOM: TreeWalker gölge sınırını geçmez, bu yüzden her gölge kökü ayrıca
   * taranır ve kendi MutationObserver'ı ile izlenir. Stil de kökün içine ayrıca
   * enjekte edilmeli, yoksa form alanı nokta gösterimine geçmez.
   * Kapalı (closed) gölge kökleri içerik betiğinden erişilemez; onlar kapsam dışı. */
  function observeShadow(sr) {
    if (!sr || shadowObservers.has(sr) || shadowObservers.size >= MAX_SHADOW) return;
    const o = new MutationObserver(onMutations);
    shadowObservers.set(sr, o);
    injectStyle(sr);
    o.observe(sr, OBSERVE_OPTS);
    scan(sr);
  }

  /* Gölge kök kancası (shadow-hook.js, ana dünya) buraya haber verir. Maskeleme
   * henüz başlamadıysa kuyruğa alıyoruz: ayarlar storage'dan gelene kadar sayfa
   * zaten bileşen kurmaya başlamış olabilir. */
  const pendingShadowHosts = [];
  function onShadowEvent(e) {
    const host = (e.composedPath && e.composedPath()[0]) || e.target;
    if (!host || !host.shadowRoot) return;
    if (!active) {
      if (pendingShadowHosts.length < MAX_SHADOW) pendingShadowHosts.push(host);
      return;
    }
    observeShadow(host.shadowRoot);
  }
  document.addEventListener('__streammask_shadow', onShadowEvent, true);

  function drainShadowQueue() {
    while (pendingShadowHosts.length) {
      const host = pendingShadowHosts.pop();
      if (host.shadowRoot) observeShadow(host.shadowRoot);
    }
  }

  function scan(root) {
    if (!root) return;
    if (root.nodeType === Node.TEXT_NODE) { processTextNode(root); return; }
    const isFragment = root.nodeType === Node.DOCUMENT_FRAGMENT_NODE;
    if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE && !isFragment) return;
    if (root.nodeType === Node.ELEMENT_NODE) {
      if (root.shadowRoot) observeShadow(root.shadowRoot);
      if (root.tagName === 'INPUT' || root.tagName === 'TEXTAREA') { processField(root); return; }
      if (SKIP_TAGS.has(root.tagName)) return;
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode(n) {
        if (n.nodeType === Node.ELEMENT_NODE) {
          if (n.tagName === 'INPUT' || n.tagName === 'TEXTAREA' || n.shadowRoot) return NodeFilter.FILTER_ACCEPT;
          if (SKIP_TAGS.has(n.tagName)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_SKIP;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const batch = [];
    let n;
    while ((n = walker.nextNode())) batch.push(n);
    for (const node of batch) {
      if (node.nodeType === Node.TEXT_NODE) { processTextNode(node); continue; }
      if (node.shadowRoot) observeShadow(node.shadowRoot);
      processField(node);
    }
  }

  const STYLE_CSS =
    'input.__yk-secure{-webkit-text-security:disc!important}' +
    'textarea.__yk-secure{color:transparent!important;text-shadow:0 0 9px rgba(0,0,0,.55)!important}';
  let styleRetry = false;
  function injectStyle(root) {
    const host = root === document ? (document.head || document.documentElement) : root;
    if (!host) {
      // Preload'da belge henüz yok; hazır olunca tekrar dene
      if (root === document && !styleRetry) {
        styleRetry = true;
        document.addEventListener('DOMContentLoaded', () => { styleRetry = false; if (active) injectStyle(document); }, { once: true });
      }
      return;
    }
    if (root === document && document.getElementById('__yk_style')) return;
    const st = document.createElement('style');
    st.id = '__yk_style';
    st.textContent = STYLE_CSS;
    host.appendChild(st);
    if (root !== document) shadowStyles.push(st);
  }

  function totalCount() { return totals.n; }
  function countsBy() { return Object.assign({}, totals.by); }
  function reportCount() {
    if (!hasChrome) return;
    clearTimeout(reportTimer);
    reportTimer = setTimeout(() => {
      try { chrome.runtime.sendMessage({ type: 'count', count: active ? totalCount() : 0, by: active ? countsBy() : {} }); } catch (e) { /* bağlam kapanmış olabilir */ }
    }, 150);
  }

  function onInput(e) {
    if (!active) return;
    // Gölge DOM'dan gelen olayda e.target gölge sahibine dönüşür; gerçek alanı al
    const el = (e.composedPath && e.composedPath()[0]) || e.target;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) processField(el);
  }

  const OBSERVE_OPTS = {
    childList: true, subtree: true, characterData: true,
    attributes: true, attributeFilter: ['value', 'type']
  };
  function onMutations(muts) {
    for (const m of muts) {
      if (m.type === 'characterData') processTextNode(m.target);
      else if (m.type === 'childList') m.addedNodes.forEach(scan);
      else if (m.type === 'attributes') processField(m.target);
    }
    reportCount();
  }

  function start() {
    if (active) return;
    active = true;
    buildPatterns();
    injectStyle(document);
    scan(document);
    drainShadowQueue();
    observer = new MutationObserver(onMutations);
    /* documentElement'e değil belgeye bağlanıyoruz: Electron preload'unda betik
     * belge oluşmadan önce çalışıyor ve o sırada duran documentElement sayfa
     * ayrıştırılırken değiştiriliyor — gözlemci ölü düğümde kalıp hiçbir şeyi
     * maskelemiyordu. Belge düğümünün kimliği ise korunuyor. */
    observer.observe(document, OBSERVE_OPTS);
    document.addEventListener('input', onInput, true);
    reportCount();
  }

  function stop() {
    if (!active) return;
    active = false;
    if (observer) { observer.disconnect(); observer = null; }
    for (const o of shadowObservers.values()) o.disconnect();
    shadowObservers.clear();
    while (shadowStyles.length) {
      const st = shadowStyles.pop();
      if (st.parentNode) st.parentNode.removeChild(st);
    }
    document.removeEventListener('input', onInput, true);
    for (const [node, rec] of records) {
      if (node.nodeValue === rec.masked) node.nodeValue = rec.orig;
    }
    records.clear();
    totals.n = 0; totals.by = {};
    sweepAt = 600;
    for (const el of secured) el.classList.remove('__yk-secure');
    secured.clear();
    document.querySelectorAll('.__yk-secure').forEach(el => el.classList.remove('__yk-secure'));
    reportCount();
  }

  function shouldRun() {
    if (!settings.enabled) return false;
    const host = location.hostname;
    if (!host) return true;
    return !(settings.whitelist || []).some(w => host === w || host.endsWith('.' + w));
  }

  function apply() {
    if (shouldRun()) {
      if (active) { stop(); }   // ayar değişti: temiz başla
      start();
    } else {
      stop();
    }
  }

  /* ---------- ilk yükleme: ayarlar gelene kadar sayfayı gizle (flaş önleme) ---------- */
  let hideStyle = null;
  function hidePage() {
    try {
      if (!document.documentElement) { hideStyle = null; return; }
      hideStyle = document.createElement('style');
      hideStyle.id = '__yk_hide';
      hideStyle.textContent = 'html{visibility:hidden!important}';
      document.documentElement.appendChild(hideStyle);
    } catch (e) { hideStyle = null; }
  }
  function revealPage() {
    if (hideStyle && hideStyle.parentNode) hideStyle.parentNode.removeChild(hideStyle);
    hideStyle = null;
  }

  function mergeSettings(stored) {
    const s = JSON.parse(JSON.stringify(DEFAULTS));
    if (stored && typeof stored === 'object') {
      if (typeof stored.enabled === 'boolean') s.enabled = stored.enabled;
      if (stored.categories) Object.assign(s.categories, stored.categories);
      if (stored.categories && typeof stored.categories.id !== 'boolean' && typeof stored.categories.tckn === 'boolean') s.categories.id = stored.categories.tckn;
      if (Array.isArray(stored.customWords)) s.customWords = stored.customWords;
      if (Array.isArray(stored.whitelist)) s.whitelist = stored.whitelist;
      if (Array.isArray(stored.idRegions)) s.idRegions = stored.idRegions;
      if (typeof stored.maskStyle === 'string') s.maskStyle = stored.maskStyle;
    }
    settings = s;
  }

  if (hasChrome) {
    hidePage();
    const safety = setTimeout(revealPage, 1500);
    chrome.storage.local.get('settings', st => {
      mergeSettings(st.settings);
      apply();
      clearTimeout(safety);
      revealPage();
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.settings) return;
      mergeSettings(changes.settings.newValue); apply();
    });
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg && msg.type === 'rescan') { if (active) scan(document); sendResponse({ count: totalCount() }); }
    });
  } else {
    // Test/önizleme modu: chrome API yok, window.__YK_SETTINGS ile ayar verilebilir
    mergeSettings(window.__YK_SETTINGS);
    apply();
    window.__yayinKalkani = { apply, stop, start, count: totalCount, maskText, setSettings(s) { mergeSettings(s); apply(); } };
  }
})();
