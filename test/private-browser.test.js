/* Gizli tarayıcıdaki maskelemeyi gerçek Electron penceresinde sınar.
 *
 * Burada sınanan şey, birim testlerin göremediği kısım: maskeleme motoru
 * preload'un izole dünyasında gerçekten çalışıyor mu, ve gölge kök kancası
 * ana dünyaya enjekte edilip izole dünyadaki dinleyiciye ulaşıyor mu. İkisi de
 * sessizce bozulabilecek, yalnızca uygulamayı açınca fark edilecek şeyler.
 *
 * Çalıştırma:  npm run test:browser      (npx electron test/private-browser.test.js)
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SETTINGS = {
  enabled: true,
  categories: { phone: true, email: true, id: true, iban: true, card: true, ip: true, custom: true, secret: true },
  customWords: ['Ahmet Yılmaz'],
  idRegions: null,
  maskStyle: 'stars',
  uiLanguage: 'tr'
};

const PAGE = `<!doctype html><html lang="tr"><meta charset="utf-8"><body>
<p id="tel">Telefonum 0532 123 45 67</p>
<p id="mail">E-posta: müller@beispiel.de</p>
<p id="kart">Kart 4111 1111 1111 1111</p>
<p id="sir">Anahtar ghp_abcdefghijklmnopqrstuvwxyz0123456789</p>
<p id="ozel">Adı Ahmet Yılmaz</p>
<p id="surum">Sürüm v4.2.1.0 ve fiyat 1.299,90 TL</p>
<p id="localhost">Sunucu 127.0.0.1:8080</p>
<div id="host"></div>
<script>
  const sr = document.getElementById('host').attachShadow({ mode: 'open' });
  sr.innerHTML = '<p id="golge">Gölge: 0532 765 43 21, mail golge@example.com</p>' +
                 '<p id="golgeTuzak">Gölge sürüm 1.0.0.4</p>';
  // Bileşenler sayfa yüklendikten sonra da kurulabilir: geç gelen kökü de sına
  setTimeout(() => {
    const h2 = document.createElement('div');
    document.body.appendChild(h2);
    h2.attachShadow({ mode: 'open' }).innerHTML = '<p id="gec">Geç gölge: 0544 987 65 43</p>';
  }, 120);
</script>
</body></html>`;

const checks = [];
const ok = (name, pass, detail) => checks.push({ name, pass, detail });

app.whenReady().then(async () => {
  const file = path.join(os.tmpdir(), 'streammask-pb-test.html');
  fs.writeFileSync(file, PAGE, 'utf8');

  const win = new BrowserWindow({
    show: false, width: 900, height: 700,
    webPreferences: {
      // pbNewTab ile aynı kurulum
      preload: path.join(__dirname, '..', 'src', 'browser', 'preload-page.js'),
      contextIsolation: true, sandbox: false, nodeIntegration: false,
      additionalArguments: ['--streammask-settings=' +
        Buffer.from(JSON.stringify(SETTINGS)).toString('base64')]
    }
  });

  try {
    await win.loadFile(file);
    await new Promise(r => setTimeout(r, 600));          // geç gölge kök + tarama

    const res = await win.webContents.executeJavaScript(`(() => {
      const txt = id => (document.getElementById(id) || {}).textContent || '';
      const sr = document.getElementById('host').shadowRoot;
      const late = [...document.querySelectorAll('div')].map(d => d.shadowRoot)
        .filter(Boolean).map(r => r.textContent).join(' ');
      return {
        tel: txt('tel'), mail: txt('mail'), kart: txt('kart'), sir: txt('sir'),
        ozel: txt('ozel'), surum: txt('surum'), localhost: txt('localhost'),
        golge: sr ? sr.getElementById('golge').textContent : '',
        golgeTuzak: sr ? sr.getElementById('golgeTuzak').textContent : '',
        gec: late
      };
    })()`);

    const masked = s => /\*{3,}/.test(s);
    ok('telefon maskelendi', masked(res.tel), res.tel);
    ok('ASCII dışı e-posta maskelendi', masked(res.mail) && !res.mail.includes('mü'), res.mail);
    ok('kart maskelendi', masked(res.kart), res.kart);
    ok('API anahtarı maskelendi', masked(res.sir), res.sir);
    ok('özel kelime maskelendi', masked(res.ozel), res.ozel);
    ok('sürüm ve fiyat maskelenmedi', !masked(res.surum), res.surum);
    ok('localhost maskelenmedi', !masked(res.localhost), res.localhost);
    ok('gölge kök maskelendi', masked(res.golge), res.golge);
    ok('gölge kökteki tuzak maskelenmedi', !masked(res.golgeTuzak), res.golgeTuzak);
    ok('sonradan açılan gölge kök maskelendi', masked(res.gec), res.gec);
  } catch (e) {
    ok('sayfa yüklendi', false, String(e && e.message || e));
  }

  let fail = 0;
  for (const c of checks) {
    if (!c.pass) fail++;
    console.log((c.pass ? '✓ ' : '✗ ') + c.name + (c.pass ? '' : '\n    ' + c.detail));
  }
  console.log(`\n${checks.length - fail} geçti, ${fail} başarısız (gizli tarayıcı)`);
  win.destroy();
  app.exit(fail ? 1 : 0);
});
