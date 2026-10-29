/* Paketi ad-hoc imzalar (electron-builder paketledikten sonra, dmg'den önce).
 *
 * Neden gerekli: imzalamayı tamamen kapatınca geriye Electron ikilisinin kendi
 * linker imzası kalıyor, ama o imza uygulamanın kaynaklarını kapsamıyor.
 * macOS 26 bunu "tanımlanamayan geliştirici" uyarısıyla değil,
 * "code has no resources but signature indicates they must be present" hatasıyla
 * reddediyor — kullanıcı sağ tık → Aç ile bile açamıyor.
 *
 * Ad-hoc imza (codesign --sign -) sertifika gerektirmez ve mührü bütün paketi
 * kapsayacak şekilde yeniden kurar. Gatekeeper yine "tanımlanamayan geliştirici"
 * der, ki imzasız bir uygulama için doğru ve beklenen davranış budur; kullanıcı
 * sağ tık → Aç diyerek açabilir.
 */
const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appPath = path.join(context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`);

  // --deep tam mührü yeniden kurar; imzasız dağıtımda doğru olan bu
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath],
    { stdio: 'inherit' });

  // Mühür gerçekten tuttu mu: sessizce bozuk bir paket yayımlamayalım
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath],
    { stdio: 'inherit' });

  console.log('  • ad-hoc signed and verified  file=' + path.basename(appPath));
};
