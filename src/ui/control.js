const $ = id => document.getElementById(id);
let state = null, apps = null, iconCache = {}, running = [];

async function icon(p) { if (!p) return ''; if (!iconCache[p]) iconCache[p] = (await window.api.appIcon(p)) || ''; return iconCache[p]; }
function since(ts) { const m = Math.max(0, Math.round((Date.now() - ts) / 60000)); return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + (m % 60) + ' min'; }

async function render() {
  const s = state.settings;
  $('live').classList.toggle('on', state.live);
  $('liveText').textContent = state.live ? 'End stream' : 'Go live';
  $('liveSub').textContent = state.live ? `LIVE for ${since(state.since)} · apps hidden, restore on end` : 'Hides the apps below, silences notifications';
  $('guard').checked = !!s.guard; $('focus').checked = !!s.focus; $('hideSelf').checked = !!s.hideSelf; $('hideDesktop').checked = !!s.hideDesktop;
  $('bridge').checked = !!s.bridge;
  $('bridgeCard').style.display = s.bridge ? '' : 'none';
  $('bridgeToken').textContent = s.bridgeToken || '';
  const n = state.bridgeClients || 0;
  $('bridgeStatus').innerHTML = n
    ? `<b style="color:var(--grn)">${n} browser${n > 1 ? 's' : ''} connected</b> · port ${s.bridgePort}`
    : `Waiting for the extension · port ${s.bridgePort}`;
  // rules
  const box = $('rules'); box.innerHTML = '';
  if (!s.rules.length) box.innerHTML = '<div class="empty">No apps yet. Add WhatsApp, Mail, Telegram, Discord, Slack…</div>';
  for (const r of s.rules) {
    const row = document.createElement('div'); row.className = 'row';
    const isRun = running.includes(r.id);
    row.innerHTML = `<img src="${await icon(r.path)}" alt=""><span class="n">${r.name}</span><span class="st ${isRun ? 'run' : ''}">${isRun ? 'running' : 'not running'}</span>
      <select><option value="hide">Hide</option><option value="minimize">Minimize</option><option value="quit">Quit &amp; relaunch after</option></select><button class="x" title="Remove">×</button>`;
    row.querySelector('select').value = r.action;
    row.querySelector('select').onchange = e => { r.action = e.target.value; save(); };
    row.querySelector('.x').onclick = () => { s.rules = s.rules.filter(x => x.id !== r.id); save(); };
    box.appendChild(row);
  }
  // words
  const chips = $('chips'), input = $('wordInput');
  chips.querySelectorAll('.chip').forEach(c => c.remove());
  s.maskWords.forEach((w, i) => { const c = document.createElement('span'); c.className = 'chip'; c.textContent = w; const b = document.createElement('button'); b.textContent = '×'; b.onclick = () => { s.maskWords.splice(i, 1); save(); }; c.appendChild(b); chips.insertBefore(c, input); });
  renderMasking();
  // pencere başlığı kuralları
  const tb = $('titlechips'), ti = $('titleInput');
  tb.querySelectorAll('.chip').forEach(c => c.remove());
  (s.titleRules || []).forEach((w, i) => {
    const c = document.createElement('span');
    c.className = 'chip';
    c.textContent = w;
    const b = document.createElement('button');
    b.textContent = '×';
    b.onclick = () => { s.titleRules.splice(i, 1); save(); };
    c.appendChild(b);
    tb.insertBefore(c, ti);
  });
  // log
  $('log').innerHTML = (state.log.length ? state.log : [{ t: Date.now(), msg: 'Ready.' }]).map(l => `<div><b>${new Date(l.t).toLocaleTimeString()}</b> ${l.msg}</div>`).join('');
}
const CATS = [['phone','Phone'],['email','E-mail'],['id','ID number'],['iban','IBAN'],
              ['card','Card'],['ip','IP address'],['secret','API key'],['custom','Your words']];

/* Hangi ülkelerin kimlik desenleri etkin: açıkça seçilmediyse sistem diline göre */
function activeRegions() {
  const s = state.settings;
  return Array.isArray(s.maskIdRegions) ? s.maskIdRegions : (state.maskMeta?.defaultRegions || []);
}
function renderMasking() {
  const s = state.settings;
  const cats = s.maskCategories || {};
  const box = $('cats');
  box.innerHTML = '';
  for (const [key, label] of CATS) {
    const l = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = cats[key] !== false;
    cb.onchange = () => { s.maskCategories = { ...cats, [key]: cb.checked }; save(); };
    l.appendChild(cb);
    l.appendChild(document.createTextNode(label));
    box.appendChild(l);
  }
  document.querySelectorAll('#maskStyle button').forEach(b => {
    b.classList.toggle('on', b.dataset.style === (s.maskStyle || 'stars'));
    b.onclick = () => { s.maskStyle = b.dataset.style; save(); };
  });
  const rb = $('regions');
  rb.innerHTML = '';
  const on = new Set(activeRegions());
  for (const r of (state.maskMeta?.regions || [])) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = r;
    b.className = on.has(r) ? 'on' : '';
    b.onclick = () => {
      const cur = new Set(activeRegions());
      if (cur.has(r)) cur.delete(r); else cur.add(r);
      s.maskIdRegions = (state.maskMeta?.regions || []).filter(x => cur.has(x));
      save();
    };
    rb.appendChild(b);
  }
}

async function save() { state.settings = await window.api.saveSettings(state.settings); render(); }
async function refreshFocus() {
  const ok = await window.api.focusReady();
  const c = $('focusCard');
  c.className = 'card ' + (ok ? 'ok' : 'warn');
  c.innerHTML = ok ? '<b>Ready.</b> Shortcuts "StreamMask Focus On" and "StreamMask Focus Off" found.'
    : `<b>One-time setup (30 s):</b> macOS only lets Focus be switched through Shortcuts. In the Shortcuts app create two shortcuts:<br>
       1. <b>StreamMask Focus On</b> → action "Set Focus" → Do Not Disturb → On (until turned off)<br>
       2. <b>StreamMask Focus Off</b> → action "Set Focus" → Do Not Disturb → Off<br>
       <button class="btn" id="openSc" style="margin-top:6px">Open Shortcuts</button> <button class="btn" id="recheck" style="margin-top:6px">Check again</button>`;
  if (!ok) { $('openSc').onclick = () => window.api.openShortcuts(); $('recheck').onclick = refreshFocus; }
}

async function init() {
  state = await window.api.state();
  running = await window.api.runningApps().catch(() => []);
  render(); refreshFocus();
  window.api.onState(s => { state = s; render(); });
  setInterval(async () => { running = await window.api.runningApps().catch(() => running); if (state.live) render(); }, 5000);

  $('live').onclick = async () => { $('live').disabled = true; state = await window.api.setLive(!state.live); $('live').disabled = false; render(); };
  $('guard').onchange = e => { state.settings.guard = e.target.checked; save(); };
  $('hideDesktop').onchange = e => { state.settings.hideDesktop = e.target.checked; save(); };
  $('focus').onchange = e => { state.settings.focus = e.target.checked; save(); };
  $('hideSelf').onchange = e => { state.settings.hideSelf = e.target.checked; save(); };
  $('openPB').onclick = () => window.api.openPrivateBrowser();
  const tbox = $('titlechips'), tinp = $('titleInput');
  tbox.onclick = () => tinp.focus();
  tinp.onkeydown = e => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const w = tinp.value.trim();
      tinp.value = '';
      // tek harflik desen neredeyse her pencereyi yakalar
      if (w.length < 2) { tinp.placeholder = 'At least two characters'; return; }
      state.settings.titleRules = state.settings.titleRules || [];
      if (!state.settings.titleRules.some(x => x.toLowerCase() === w.toLowerCase())) {
        state.settings.titleRules.push(w);
        save();
      }
    } else if (e.key === 'Backspace' && !tinp.value && (state.settings.titleRules || []).length) {
      state.settings.titleRules.pop(); save();
    }
  };
  $('bridge').onchange = e => { state.settings.bridge = e.target.checked; save(); };
  $('copyToken').onclick = async () => {
    try { await navigator.clipboard.writeText(state.settings.bridgeToken || ''); $('copyToken').textContent = 'Copied'; setTimeout(() => { $('copyToken').textContent = 'Copy'; }, 1500); } catch (x) {}
  };
  $('newToken').onclick = () => {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    state.settings.bridgeToken = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
    save();                          // jeton değişince köprü kendiliğinden yeniden kurulur
  };
  setInterval(async () => { const s = await window.api.state(); state.bridgeClients = s.bridgeClients; render(); }, 4000);
  $('gh').onclick = e => { e.preventDefault(); window.api.openExternal('https://github.com/KursadEren/streammask-desktop'); };
  $('addApp').onclick = async () => {
    const p = $('picker'); p.classList.toggle('open');
    if (!p.classList.contains('open')) return;
    $('search').value = ''; $('search').focus();
    if (!apps) { $('items').innerHTML = '<div class="empty">Scanning /Applications…</div>'; apps = await window.api.installedApps(); }
    renderPicker('');
  };
  $('search').oninput = e => renderPicker(e.target.value);
  const chips = $('chips'), input = $('wordInput');
  chips.onclick = () => input.focus();
  const SENS = [/[\w.+-]+@[\w-]+\.[\w.-]+/, /(?:\d[ .-]?){9,}/, /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,}/];
  input.onkeydown = e => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault(); const w = input.value.trim(); input.value = '';
      if (w.length < 2) return;
      if (SENS.some(r => r.test(w))) { input.placeholder = "Numbers, cards, IBANs and e-mails are masked automatically – don't save them here"; return; }
      if (!state.settings.maskWords.some(x => x.toLowerCase() === w.toLowerCase())) { state.settings.maskWords.push(w); save(); }
    } else if (e.key === 'Backspace' && !input.value && state.settings.maskWords.length) { state.settings.maskWords.pop(); save(); }
  };
}
async function renderPicker(q) {
  const box = $('items'); box.innerHTML = '';
  const ql = q.toLowerCase();
  const list = apps.filter(a => !state.settings.rules.some(r => r.id === a.id) && (!ql || a.name.toLowerCase().includes(ql))).slice(0, 40);
  if (!list.length) { box.innerHTML = '<div class="empty">No match.</div>'; return; }
  for (const a of list) {
    const it = document.createElement('div'); it.className = 'it';
    it.innerHTML = `<img src="${await icon(a.path)}" alt=""><span>${a.name}</span>`;
    it.onclick = () => { state.settings.rules.push({ id: a.id, name: a.name, path: a.path, action: 'hide', relaunch: true }); $('picker').classList.remove('open'); save(); };
    box.appendChild(it);
  }
}
init();
