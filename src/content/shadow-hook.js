/* ÜRETİLMİŞ DOSYA — elle düzenlemeyin.
 * Kaynak: StreamMask tarayıcı uzantısı, shadow-hook.js
 * Güncellemek için: npm run sync-engine
 */
/* StreamMask - gölge kök kancası (sayfanın ana dünyasında çalışır)
 *
 * Neden gerekli: attachShadow() hiçbir MutationObserver kaydı üretmez, gölge kökün
 * içine eklenen düğümler de dış ağaçta görünmez. Bileşenler sayfa yüklendikten çok
 * sonra kurulabildiği için (custom element upgrade) ilk tarama yetmiyor. İçerik
 * betiği izole dünyada olduğundan Element.prototype'ı oradan yamalamak sayfanın
 * çağrılarını yakalamaz — bu yüzden bu küçük dosya "world": "MAIN" olarak yüklenir.
 *
 * Yaptığı tek şey: gölge kök açıldığında sahibi üzerinde özel bir olay tetiklemek.
 * Olayın içinde veri taşınmaz; içerik betiği olayın hedefinden host.shadowRoot'a
 * kendisi erişir. Kapalı (closed) kökler hiçbir dünyadan okunamaz, kapsam dışıdır.
 */
(() => {
  const proto = Element.prototype;
  const orig = proto.attachShadow;
  if (typeof orig !== 'function' || orig.__streamMask) return;

  function attachShadow(init) {
    const root = orig.call(this, init);
    const host = this;
    // Olayı eşzamanlı göndermiyoruz: attachShadow çoğu kez custom element
    // kurucusu içinde çağrılır, orada olay tetiklemek sayfayı bozabilir.
    Promise.resolve().then(() => {
      try { host.dispatchEvent(new CustomEvent('__streammask_shadow', { bubbles: true, composed: true })); } catch (e) { /* sayfa kapanmış olabilir */ }
    });
    return root;
  }
  attachShadow.__streamMask = true;
  try {
    Object.defineProperty(attachShadow, 'name', { value: 'attachShadow' });
    Object.defineProperty(attachShadow, 'length', { value: orig.length });
    proto.attachShadow = attachShadow;
  } catch (e) { /* dokunulamıyorsa sayfayı olduğu gibi bırak */ }
})();
