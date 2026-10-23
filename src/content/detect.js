/* ÜRETİLMİŞ DOSYA — elle düzenlemeyin.
 * Kaynak: StreamMask tarayıcı uzantısı, detect.js
 * Güncellemek için: npm run sync-engine
 */
/* StreamMask - algılama çekirdeği
 *
 * DOM'a dokunmaz: ayarlar girer, desenler çıkar; metin girer, maskelenmiş metin
 * çıkar. Böylece hem içerik betiği olarak yüklenir (self.StreamMaskDetect) hem de
 * Node'da birim testi yazılabilir (`npm test`). Regex tabanlı bir araçta yanlış
 * pozitif en büyük risk olduğu için her sayısal desenin checksum doğrulayıcısı var
 * ve testler bilinen tuzakları (fiyat, sürüm no, skor, sipariş no) kontrol eder.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.StreamMaskDetect = api;
})(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MASK = '*****';

  /* ================= doğrulayıcılar ================= */

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

  /* TR - T.C. Kimlik No */
  function tckn(s) {
    const d0 = s.replace(/\D/g, '');
    if (!/^[1-9]\d{10}$/.test(d0)) return false;
    const d = d0.split('').map(Number);
    const odd = d[0] + d[2] + d[4] + d[6] + d[8];
    const even = d[1] + d[3] + d[5] + d[7];
    if (((odd * 7 - even) % 10 + 10) % 10 !== d[9]) return false;
    return d.slice(0, 10).reduce((a, b) => a + b, 0) % 10 === d[10];
  }

  /* KR - 주민등록번호 (tarih kısmı geçerli olmalı) */
  function krRrn(s) {
    const d = s.replace(/\D/g, '');
    if (d.length !== 13) return false;
    const mm = +d.slice(2, 4), dd = +d.slice(4, 6);
    return mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31;
  }

  /* AR - CUIT/CUIL, mod 11 */
  function arCuit(s) {
    const d = s.replace(/\D/g, '');
    if (d.length !== 11) return false;
    const w = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
    const sum = w.reduce((a, wi, i) => a + wi * +d[i], 0);
    let c = 11 - (sum % 11);
    if (c === 11) c = 0;
    if (c === 10) return false;
    return c === +d[10];
  }

  /* BR - CPF, iki kontrol hanesi */
  function brCpf(s) {
    const d = s.replace(/\D/g, '');
    if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
    const dv = (len) => {
      let sum = 0;
      for (let i = 0; i < len; i++) sum += +d[i] * (len + 1 - i);
      const r = (sum * 10) % 11;
      return r === 10 ? 0 : r;
    };
    return dv(9) === +d[9] && dv(10) === +d[10];
  }

  /* BR - CNPJ */
  function brCnpj(s) {
    const d = s.replace(/\D/g, '');
    if (d.length !== 14 || /^(\d)\1{13}$/.test(d)) return false;
    const calc = (w) => {
      const sum = w.reduce((a, wi, i) => a + wi * +d[i], 0);
      const r = sum % 11;
      return r < 2 ? 0 : 11 - r;
    };
    return calc([5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]) === +d[12] &&
           calc([6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]) === +d[13];
  }

  /* ES - DNI / NIE, harf = sayı mod 23 */
  const DNI_LETTERS = 'TRWAGMYFPDXBNJZSQVHLCKE';
  function esDni(s) {
    const t = s.replace(/[\s-]/g, '').toUpperCase();
    let m = /^(\d{8})([A-Z])$/.exec(t);
    if (m) return DNI_LETTERS[+m[1] % 23] === m[2];
    m = /^([XYZ])(\d{7})([A-Z])$/.exec(t);
    if (!m) return false;
    const n = +(String('XYZ'.indexOf(m[1])) + m[2]);
    return DNI_LETTERS[n % 23] === m[3];
  }

  /* DE - Steuerliche Identifikationsnummer: ISO 7064 MOD 11,10 + tekrar kuralı.
   * Tekrar kuralı olmadan rastgele 11 haneli her sayının %10'u geçerli görünürdü. */
  function deTaxId(s) {
    const d = s.replace(/[\s/]/g, '');
    if (!/^[1-9]\d{10}$/.test(d)) return false;
    const head = d.slice(0, 10);
    const freq = {};
    for (const ch of head) freq[ch] = (freq[ch] || 0) + 1;
    const counts = Object.values(freq);
    const repeats = counts.filter(c => c > 1);
    if (repeats.length !== 1 || repeats[0] > 3) return false;
    let product = 10;
    for (const ch of head) {
      let sum = (+ch + product) % 10;
      if (sum === 0) sum = 10;
      product = (sum * 2) % 11;
    }
    let check = 11 - product;
    if (check === 10) check = 0;
    return check === +d[10];
  }

  /* FR - NIR (sosyal güvenlik): son iki hane 97 - (n mod 97). Korsika 2A/2B. */
  function frNir(s) {
    const t = s.replace(/[\s.]/g, '').toUpperCase();
    // cinsiyet 1 + yıl 2 + ay 2 + daire 2 (Korsika 2A/2B) + belediye 3 + sıra 3 + anahtar 2
    if (!/^[12]\d{4}(?:\d{2}|2[AB])\d{6}\d{2}$/.test(t)) return false;
    const body = t.slice(0, 13).replace('2A', '19').replace('2B', '18');
    const key = +t.slice(13);
    if (!/^\d{13}$/.test(body)) return false;
    return 97 - (Number(body) % 97) === key;
  }

  /* US - SSN: checksum yok, yapısal kurallar (ayraç zorunlu, yoksa her 9 haneyi yer) */
  function usSsn(s) {
    const d = s.replace(/\D/g, '');
    if (d.length !== 9) return false;
    const area = d.slice(0, 3), group = d.slice(3, 5), serial = d.slice(5);
    if (area === '000' || area === '666' || +area >= 900) return false;
    return group !== '00' && serial !== '0000';
  }

  /* JP - マイナンバー (12 hane, mod 11 kontrol hanesi)
   * Tek başına checksum yetmiyor: 12 haneli her sayının 1/11'i geçerli görünüyor,
   * yani sipariş ve kargo takip numaraları maskelenirdi. Bu yüzden ya gruplu yazım
   * (1234 5678 9012) ya da yakın bağlamda bir anahtar kelime istiyoruz. */
  const JP_CONTEXT = /(?:マイナンバー|個人番号|マイナ|個人識別|my\s?number)[^0-9]{0,14}$/i;
  function jpMyNumber(s, offset, text) {
    const d = s.replace(/[\s-]/g, '');
    if (!/^\d{12}$/.test(d)) return false;
    let sum = 0;
    for (let i = 0; i < 11; i++) {
      const n = 11 - i;                       // sağdan konum
      sum += +d[i] * (n <= 6 ? n + 1 : n - 5);
    }
    const r = sum % 11;
    if ((r <= 1 ? 0 : 11 - r) !== +d[11]) return false;
    if (/[\s-]/.test(s)) return true;
    if (typeof text === 'string' && typeof offset === 'number') {
      return JP_CONTEXT.test(text.slice(Math.max(0, offset - 28), offset));
    }
    return false;
  }

  /* IT - codice fiscale: yapısı çok özgün, CIN kontrol harfi */
  const CF_EVEN = { 0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, A: 0, B: 1, C: 2, D: 3, E: 4, F: 5, G: 6, H: 7, I: 8, J: 9, K: 10, L: 11, M: 12, N: 13, O: 14, P: 15, Q: 16, R: 17, S: 18, T: 19, U: 20, V: 21, W: 22, X: 23, Y: 24, Z: 25 };
  const CF_ODD = { 0: 1, 1: 0, 2: 5, 3: 7, 4: 9, 5: 13, 6: 15, 7: 17, 8: 19, 9: 21, A: 1, B: 0, C: 5, D: 7, E: 9, F: 13, G: 15, H: 17, I: 19, J: 21, K: 2, L: 4, M: 18, N: 20, O: 11, P: 3, Q: 6, R: 8, S: 12, T: 14, U: 16, V: 10, W: 22, X: 25, Y: 24, Z: 23 };
  function itCf(s) {
    const t = s.toUpperCase();
    if (!/^[A-Z]{6}\d{2}[ABCDEHLMPRST]\d{2}[A-Z]\d{3}[A-Z]$/.test(t)) return false;
    let sum = 0;
    for (let i = 0; i < 15; i++) sum += (i % 2 === 0 ? CF_ODD : CF_EVEN)[t[i]];
    return String.fromCharCode(65 + (sum % 26)) === t[15];
  }

  /* telefon: tarih, sürüm ve fiyat gibi sayı yığınlarını eler */
  function phoneDigits(s) {
    const d = s.replace(/\D/g, '');
    const seps = (s.match(/[ .\-()]/g) || []).length;
    if (d.length < 9 || d.length > 13) return false;
    if (/^(?:19|20)\d{2}[-./]\d{1,2}[-./]\d{1,2}/.test(s)) return false;   // 2026-09-25 08:57
    if (/^\d{1,2}[-./]\d{1,2}[-./](?:19|20)\d{2}/.test(s)) return false;   // 25.09.2026 14:30
    if (/^\d+(?:\.\d+){2,}$/.test(s)) return false;                        // 2.1.0.4567
    if (d.length === 9) return seps >= 2;                                  // 612 345 678
    return /^(90|0|5|\+)/.test(s.replace(/[\s().-]/g, '')) || s.startsWith('+') || seps >= 2 || d.length >= 11;
  }

  /* IP: kişisel olmayan adresler ve sürüm numaraları elenir (bağlam gerekir) */
  const IP_ALLOW = new Set(['0.0.0.0', '127.0.0.1', '255.255.255.255', '1.1.1.1', '8.8.8.8', '8.8.4.4', '192.168.1.1', '192.168.0.1']);
  const VERSION_WORD = /(?:version|sürüm|surum|versión|versao|versão|バージョン|버전|build|release|update|chrome|firefox|safari|edge|electron|node|python|unity|blender)\W{0,3}$/i;
  function ipv4(s, offset, text) {
    if (!s.split('.').every(p => +p <= 255)) return false;
    if (IP_ALLOW.has(s)) return false;
    if (typeof text === 'string' && typeof offset === 'number') {
      const before = text.slice(Math.max(0, offset - 24), offset);
      const after = text.slice(offset + s.length, offset + s.length + 2);
      if (/\.$/.test(before)) return false;
      if (/^\.\d/.test(after)) return false;
      if (/(?:^|[^\w])[vV]$/.test(before)) return false;
      if (/[\w)]\/$/.test(before)) return false;
      if (VERSION_WORD.test(before)) return false;
    }
    return true;
  }

  /* base58 cüzdan adresi: rastgele uzun kelimeleri elemek için karakter çeşitliliği */
  function base58Like(s) {
    if (/^bc1/.test(s)) return true;
    return /\d/.test(s) && /[A-Z]/.test(s) && /[a-z]/.test(s);
  }

  /* "api_key = ..." kalıbında değerin gerçekten sır gibi görünmesi */
  function secretValue(_m, _o, _t, caps) {
    const v = caps && caps[0];
    if (!v || v.length < 8) return false;
    if (/^(?:null|true|false|undefined|none|example|your[_-]?\w*|xxx+|\*+|changeme|placeholder|<[^>]+>|\$\{?\w+\}?)$/i.test(v)) return false;
    return /[A-Za-z]/.test(v) || /\d/.test(v);
  }

  /* ================= bölgesel kimlik desenleri ================= */

  const ID_PATTERNS = {
    TR: [{ re: () => /\b[1-9]\d{10}\b/g, check: tckn }],
    KR: [{ re: () => /\b\d{6}-[1-8]\d{6}\b/g, check: krRrn }],
    AR: [{ re: () => /\b(?:20|23|24|27|30|33|34)-?\d{8}-?\d\b/g, check: arCuit }],
    BR: [
      { re: () => /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g, check: brCpf },
      { re: () => /\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/g, check: brCnpj }
    ],
    ES: [{ re: () => /\b(?:[XYZ]\d{7}|\d{8})-?[A-HJ-NP-TV-Z]\b/g, check: esDni }],
    DE: [{ re: () => /\b[1-9]\d{10}\b/g, check: deTaxId }],
    FR: [{ re: () => /\b[12]\s?\d{2}\s?\d{2}\s?(?:\d{2}|2[AB])\s?\d{3}\s?\d{3}\s?\d{2}\b/g, check: frNir }],
    US: [{ re: () => /\b\d{3}-\d{2}-\d{4}\b/g, check: usSsn }],
    JP: [{ re: () => /\b(?:\d{4}[ -]\d{4}[ -]\d{4}|\d{12})\b/g, check: jpMyNumber }],
    IT: [{ re: () => /\b[A-Z]{6}\d{2}[ABCDEHLMPRST]\d{2}[A-Z]\d{3}[A-Z]\b/gi, check: itCf }]
  };
  const ID_REGIONS = Object.keys(ID_PATTERNS);
  /* 1.1.x'te kurulu olan bölgeler: güncelleme kimsenin korumasını azaltmasın */
  const LEGACY_REGIONS = ['TR', 'KR', 'AR'];
  const LANG_REGION = {
    tr: 'TR', ko: 'KR', pt: 'BR', es: 'ES', de: 'DE', fr: 'FR',
    en: 'US', ja: 'JP', it: 'IT'
  };
  function defaultRegions(uiLanguage) {
    const lang = String(uiLanguage || 'en').toLowerCase();
    const region = LANG_REGION[lang.split('-')[0]];
    const out = LEGACY_REGIONS.slice();
    if (region && !out.includes(region)) out.push(region);
    return out;
  }

  /* ================= sır / anahtar desenleri ================= */

  const SECRET_PATTERNS = [
    { re: () => /\bsk-(?:ant-|proj-|or-)?[A-Za-z0-9_-]{16,}/g },
    { re: () => /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
    { re: () => /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
    { re: () => /\bglpat-[A-Za-z0-9_-]{16,}\b/g },
    { re: () => /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g },
    { re: () => /\bAIza[0-9A-Za-z_-]{35,}/g },      // tam 35 + \b olsa daha uzun dizide hiç tutmaz, kuyruk açıkta kalır
    { re: () => /\bya29\.[0-9A-Za-z_-]{20,}/g },
    { re: () => /\bxox[baprse]-[0-9A-Za-z-]{10,}\b/g },
    { re: () => /\bxapp-\d-[A-Za-z0-9-]{10,}\b/g },
    { re: () => /\b[sr]k_(?:live|test)_[0-9A-Za-z]{16,}\b/g },
    { re: () => /\bnpm_[A-Za-z0-9]{30,}\b/g },
    { re: () => /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g },
    { re: () => /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },   // JWT
    { re: () => /\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/g },                                   // Telegram bot
    { re: () => /-----BEGIN[A-Z ]*PRIVATE KEY-----/g },
    { re: () => /\b0x[a-fA-F0-9]{40}\b/g },                                             // ETH
    { re: () => /\b(?:bc1[a-z0-9]{25,62}|[13][1-9A-HJ-NP-Za-km-z]{25,34})\b/g, check: base58Like },
    { re: () => /(?:api[_-]?keys?|secrets?|tokens?|passwd|password|private[_-]?key|access[_-]?key|client[_-]?secret|auth)["']?\s*[:=]\s*["']?([^\s"'`,;]{8,})/gi, group: 1, check: secretValue },
    { re: () => /\b(?:Bearer|Basic)\s+([A-Za-z0-9._~+/=-]{20,})/g, group: 1, check: secretValue }
  ];

  /* ================= desen listesi ================= */

  const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  /* JS'in "i" bayrağı Türkçe'nin noktalı/noktasız i çiftini bilmez: "İrem" özel
   * kelimesi "irem" yazımını yakalamıyordu. Bu dört harfi tek sınıfa indiriyoruz. */
  const dottedI = s => s.replace(/[iıIİ]/g, '[iıIİ]');

  function buildPatterns(settings) {
    const s = settings || {};
    const c = s.categories || {};
    const p = [];
    // \w yalnızca ASCII eşler: "müller@beispiel.de" adresinin başı açıkta kalıyordu,
    // "иван@mail.ru" ve "ahmet@köy.com" ise hiç yakalanmıyordu. Unicode harf sınıfı şart.
    if (c.email) p.push({ name: 'email', re: /[\p{L}\p{N}._%+'-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu });
    if (c.iban) p.push({ name: 'iban', re: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){3,7}(?:[ ]?[A-Z0-9]{1,4})?\b/g });
    if (c.card) p.push({ name: 'card', re: /\b(?:\d{4}[ -]?){3}\d{4}\b/g, check: luhn });
    if (c.id) {
      // null/undefined = otomatik (tarayıcı diline göre); [] = kullanıcı hepsini kapattı
      const regions = Array.isArray(s.idRegions)
        ? s.idRegions.filter(r => ID_PATTERNS[r])
        : defaultRegions(s.uiLanguage);
      for (const r of regions) {
        for (const def of ID_PATTERNS[r]) p.push({ name: 'id', region: r, re: def.re(), check: def.check });
      }
    }
    if (c.secret) {
      for (const def of SECRET_PATTERNS) p.push({ name: 'secret', re: def.re(), check: def.check, group: def.group });
    }
    if (c.phone) p.push({ name: 'phone', re: /(?<!\d|\d[.,:])\+?\(?\d{1,4}\)?(?:[ .-]?\(?\d{1,4}\)?){2,6}(?!\d|[.,:]\d)/g, check: phoneDigits });
    if (c.ip) p.push({ name: 'ip', re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, check: ipv4 });
    const words = (s.customWords || []).map(w => String(w).trim()).filter(w => w.length >= 2);
    if (c.custom && words.length) {
      words.sort((a, b) => b.length - a.length);
      p.push({ name: 'custom', re: new RegExp(words.map(w => dottedI(escapeRe(w))).join('|'), 'gi') });
    }
    return p;
  }

  /* ================= maske biçimleri ================= */

  /* Sabit ***** metni kısalttığı için tablo/satır düzenini kaydırıyordu.
   * 'same' aynı uzunlukta maskeler, 'partial' son 4 haneyi bırakır.
   * Sırlar ve özel kelimeler hiçbir biçimde kısmi gösterilmez. */
  const FULL_ONLY = new Set(['secret', 'custom']);

  function sameLength(s) {
    return s.replace(/[A-Za-z0-9]/g, '*');
  }
  function keepLast(s, keep) {
    let seen = 0;
    const chars = s.split('');
    for (let i = chars.length - 1; i >= 0; i--) {
      if (!/[A-Za-z0-9]/.test(chars[i])) continue;
      if (seen < keep) { seen++; continue; }
      chars[i] = '*';
    }
    return chars.join('');
  }
  function partial(s, name) {
    if (name === 'email') {
      const at = s.indexOf('@');
      return at > 0 ? s[0] + '***' + s.slice(at) : sameLength(s);
    }
    if (name === 'ip') {
      const parts = s.split('.');
      return parts[0] + '.*.*.*';
    }
    if (name === 'phone' || name === 'card' || name === 'iban' || name === 'id') return keepLast(s, 4);
    return sameLength(s);
  }

  function maskFor(match, name, style, label) {
    if (FULL_ONLY.has(name)) return style === 'same' ? sameLength(match) : (style === 'label' ? (label || MASK) : MASK);
    switch (style) {
      case 'same': return sameLength(match);
      case 'partial': return partial(match, name);
      case 'label': return label || MASK;
      default: return MASK;
    }
  }

  /* ================= metni maskele ================= */

  function maskText(text, patterns, options) {
    const opt = options || {};
    const style = opt.style || 'stars';
    const label = opt.label;
    let out = text, n = 0;
    const by = {};
    for (const p of patterns) {
      p.re.lastIndex = 0;
      out = out.replace(p.re, function () {
        const args = Array.prototype.slice.call(arguments);
        const full = args.pop();
        const offset = args.pop();
        const m = args.shift();
        const caps = args;                        // yakalama grupları
        if (p.check && !p.check(m, offset, full, caps)) return m;
        if (p.group) {
          const val = caps[p.group - 1];
          if (!val) return m;
          const i = m.lastIndexOf(val);
          if (i < 0) return m;
          n++; by[p.name] = (by[p.name] || 0) + 1;
          return m.slice(0, i) + maskFor(val, p.name, style, label) + m.slice(i + val.length);
        }
        n++; by[p.name] = (by[p.name] || 0) + 1;
        return maskFor(m, p.name, style, label);
      });
    }
    return { out, n, by };
  }

  return {
    MASK,
    buildPatterns,
    maskText,
    maskFor,
    defaultRegions,
    ID_REGIONS,
    LEGACY_REGIONS,
    validators: {
      luhn, tckn, krRrn, arCuit, brCpf, brCnpj, esDni, deTaxId, frNir,
      usSsn, jpMyNumber, itCf, phoneDigits, ipv4, base58Like, secretValue
    }
  };
});
