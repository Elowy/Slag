/**
 * Slag — a fénysáv kezelőgombja.
 *
 * MIÉRT KELL EHHEZ GOMB
 * A WebHID engedélykérője csak VALÓDI felhasználói gesztusból nyílik meg, és a
 * böngésző a gamepad-gombnyomást nem tekinti annak. Egy kontrollerrel tehát
 * nem lehet megnyitni az eszközválasztót — ezért van rá egy DOM-gomb.
 *
 * Oldalfrissítés után nem kell újra kattintani: a már megadott engedélyeket a
 * `Lightbar.restore()` némán visszaveszi.
 */

import { Lightbar } from './lightbar.js';

const el = {};
let installed = false;

function $(id) { return document.getElementById(id); }

/** A gomb felirata és a súgó mindig a modul valós állapotát mutatja. */
export function refreshLightbarUI() {
  if (!installed) return;
  const n = Lightbar.count;

  el.btn.textContent = n > 0 ? `Fénysáv: ${n} kontroller` : 'Kontroller fénye';
  el.btn.classList.toggle('live', n > 0);

  if (Lightbar.error) {
    el.status.textContent = Lightbar.error;
    el.status.classList.add('bad');
    return;
  }
  el.status.classList.remove('bad');
  el.status.textContent = n > 0
    ? 'A kontroller a játékos színében világít. Több kontrollernél a megadás sorrendje dönt.'
    : 'Kattints ide, és engedélyezd a kontrollert — a fénysávja a választott színedben fog világítani.';
}

/**
 * Beköti a gombot. Ha a böngésző nem tud WebHID-et, a doboz rejtve marad:
 * egy sose működő gomb rosszabb, mint a semmi.
 */
export function installLightbarUI() {
  const root = $('light');
  if (!root) return;

  el.root = root;
  el.btn = $('light-btn');
  el.status = $('light-status');

  if (!Lightbar.supported) return;   // marad `hidden`
  installed = true;
  root.hidden = false;

  el.btn.addEventListener('click', async () => {
    el.btn.disabled = true;
    try {
      await Lightbar.request();
    } finally {
      el.btn.disabled = false;
      refreshLightbarUI();
    }
  });

  // Korábban megadott engedélyek: kattintás nélkül visszavesszük őket.
  Lightbar.restore().then(refreshLightbarUI);

  // Kilépéskor ne maradjon égve a fény a kontrolleren. A `persisted` ág a
  // vissza-gombos gyorsítótár: onnan a lap visszatérhet, olyankor nem
  // engedjük el az eszközöket.
  window.addEventListener('pagehide', (ev) => { if (!ev.persisted) Lightbar.release(); });

  // Egy kihúzott kontroller magától kikerül a listából; a felirat kövesse.
  setInterval(refreshLightbarUI, 1000);

  refreshLightbarUI();
}

/** Meccs közben nincs mit állítani rajta: húzódjon félre. */
export function setLightbarPlaying(dimmed) {
  if (!installed) return;
  el.root.classList.toggle('playing', !!dimmed);
}
