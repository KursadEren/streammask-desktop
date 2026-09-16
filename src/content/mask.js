/* StreamMask - içerik betiği
 * Sayfadaki kişisel bilgileri (telefon, e-posta, TC kimlik, IBAN, kart, IP,
 * özel kelimeler) bulur ve ***** ile değiştirir. Sayfa değiştikçe (SPA, sohbet,
 * sonsuz kaydırma) MutationObserver ile yeniden tarar. Maskeleme kapatıldığında
 * orijinal metinler geri yüklenir; sayfa yenilemeye gerek yoktur.
 */
(() => {
  if (window.__streamMaskLoaded) return;
  window.__streamMaskLoaded = true;

  const MASK = '*****';
  const DEFAULTS = {
    enabled: true,
    categories: { phone: true, email: true, tckn: true, iban: true, card: true, ip: true, custom: true },
    customWords: [],
    whitelist: []
  };

  const hasChrome = typeof chrome !== 'undefined' && !!(chrome.storage && chrome.storage.local && chrome.runtime && chrome.runtime.id);
  let settings = JSON.parse(JSON.stringify(DEFAULTS));
  let patterns = [];
  const records = new Map();      // TextNode -> { orig, masked, n }
  let observer = null;
  let active = false;
  let reportTimer = null;

  /* ---------- doğrulayıcılar (yanlış pozitifleri azaltır) ---------- */
  function luhn(s) {
    const d = s.replace(/\D/g, '');
    if (d.length < 13 || d.length > 19) return false;
    let sum = 0, alt = false;
    for (let i = d.length - 1; i >= 0; i--) {
      let n = +d[i];
      if (alt) { n *= 2; if (n > 9) n -= 9; }
      sum += n; alt = !alt;
    }
    return sum % 10 === 0;
  }
  function tckn(s) {
    if (!/^[1-9]\d{10}$/.test(s)) return false;
    const d = s.split('').map(Number);
    const odd = d[0] + d[2] + d[4] + d[6] + d[8];
    const even = d[1] + d[3] + d[5] + d[7];
    if (((odd * 7 - even) % 10 + 10) % 10 !== d[9]) return false;
    return d.slice(0, 10).reduce((a, b) => a + b, 0) % 10 === d[10];
  }
  function phoneDigits(s) {
    const d = s.replace(/\D/g, '');
    if (d.length < 10 || d.length > 13) return false;
    // 4 haneli yıl + 6 hane gibi tarih/sipariş kombinasyonlarını ele: TR numaraları 0/5/+90 ile başlar
    return /^(90|0|5|\+)/.test(s.replace(/[\s().-]/g, '')) || s.startsWith('+') || d.length >= 11;
  }
  function ipv4(s) {
    return s.split('.').every(p => +p <= 255) && s !== '0.0.0.0';
  }
  const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function buildPatterns() {
    const c = settings.categories || {};
    const p = [];
    if (c.email) p.push({ name: 'email', re: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g });
    if (c.iban)  p.push({ name: 'iban',  re: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){3,7}(?:[ ]?[A-Z0-9]{1,4})?\b/g });
    if (c.card)  p.push({ name: 'card',  re: /\b(?:\d{4}[ -]?){3}\d{4}\b/g, check: luhn });
    if (c.tckn)  p.push({ name: 'tckn',  re: /\b[1-9]\d{10}\b/g, check: tckn });
    if (c.phone) p.push({ name: 'phone', re: /(?<!\d)(?:\+?\d{1,3}[ .-]?)?\(?0?\d{3}\)?[ .-]?\d{3}[ .-]?\d{2}[ .-]?\d{2}(?!\d)/g, check: phoneDigits });
    if (c.ip)    p.push({ name: 'ip',    re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, check: ipv4 });
    const words = (settings.customWords || []).map(w => String(w).trim()).filter(w => w.length >= 2);
    if (c.custom && words.length) {
      words.sort((a, b) => b.length - a.length);
      p.push({ name: 'custom', re: new RegExp(words.map(escapeRe).join('|'), 'gi') });
    }
    patterns = p;
  }

  function maskText(text) {
    let out = text, n = 0;
    const by = {};
    for (const p of patterns) {
      p.re.lastIndex = 0;
      out = out.replace(p.re, m => {
        if (p.check && !p.check(m)) return m;
        n++; by[p.name] = (by[p.name] || 0) + 1;
        return MASK;
      });
    }
    return { out, n, by };
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
    if (!cur || cur.length < 5) return;
    const { out, n, by } = maskText(cur);
    if (n === 0) { if (rec) records.delete(node); return; }
    records.set(node, { orig: cur, masked: out, n, by });
    node.nodeValue = out;
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
  }

  function scan(root) {
    if (!root) return;
    if (root.nodeType === Node.TEXT_NODE) { processTextNode(root); return; }
    if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return;
    if (root.nodeType === Node.ELEMENT_NODE) {
      if (root.tagName === 'INPUT' || root.tagName === 'TEXTAREA') { processField(root); return; }
      if (SKIP_TAGS.has(root.tagName)) return;
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode(n) {
        if (n.nodeType === Node.ELEMENT_NODE) {
          if (n.tagName === 'INPUT' || n.tagName === 'TEXTAREA') return NodeFilter.FILTER_ACCEPT;
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
      if (node.nodeType === Node.TEXT_NODE) processTextNode(node);
      else processField(node);
    }
  }

  function injectStyle() {
    if (document.getElementById('__yk_style')) return;
    const st = document.createElement('style');
    st.id = '__yk_style';
    st.textContent =
      'input.__yk-secure{-webkit-text-security:disc!important}' +
      'textarea.__yk-secure{color:transparent!important;text-shadow:0 0 9px rgba(0,0,0,.55)!important}';
    (document.head || document.documentElement).appendChild(st);
  }

  function totalCount() {
    let c = 0;
    for (const r of records.values()) c += r.n;
    return c;
  }
  function countsBy() {
    const by = {};
    for (const r of records.values()) for (const k in r.by) by[k] = (by[k] || 0) + r.by[k];
    return by;
  }
  function reportCount() {
    if (!hasChrome) return;
    clearTimeout(reportTimer);
    reportTimer = setTimeout(() => {
      try { chrome.runtime.sendMessage({ type: 'count', count: active ? totalCount() : 0, by: active ? countsBy() : {} }); } catch (e) { /* bağlam kapanmış olabilir */ }
    }, 150);
  }

  function onInput(e) {
    if (!active) return;
    const el = e.target;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) processField(el);
  }

  function start() {
    if (active) return;
    active = true;
    buildPatterns();
    injectStyle();
    scan(document.documentElement);
    observer = new MutationObserver(muts => {
      for (const m of muts) {
        if (m.type === 'characterData') processTextNode(m.target);
        else if (m.type === 'childList') m.addedNodes.forEach(scan);
        else if (m.type === 'attributes') processField(m.target);
      }
      reportCount();
    });
    observer.observe(document.documentElement, {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ['value', 'type']
    });
    document.addEventListener('input', onInput, true);
    reportCount();
  }

  function stop() {
    if (!active) return;
    active = false;
    if (observer) { observer.disconnect(); observer = null; }
    document.removeEventListener('input', onInput, true);
    for (const [node, rec] of records) {
      if (node.nodeValue === rec.masked) node.nodeValue = rec.orig;
    }
    records.clear();
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
      if (Array.isArray(stored.customWords)) s.customWords = stored.customWords;
      if (Array.isArray(stored.whitelist)) s.whitelist = stored.whitelist;
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
      if (msg && msg.type === 'rescan') { if (active) scan(document.documentElement); sendResponse({ count: totalCount() }); }
    });
  } else {
    // Electron / test modu: chrome API yok, window.__YK_SETTINGS ile ayar verilir
    mergeSettings(window.__YK_SETTINGS);
    const boot = () => { if (document.documentElement) apply(); else setTimeout(boot, 5); };
    boot();
    window.__streamMask = { apply, stop, start, count: totalCount, maskText, setSettings(s) { mergeSettings(s); apply(); } };
  }
})();
