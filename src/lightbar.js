/**
 * Slag — a kontroller fénysávja a játékos színében.
 *
 * MIÉRT NEM A GAMEPAD API
 * A Gamepad API-ban NINCS fényvezérlés: rezgés van (`vibrationActuator`), LED
 * nincs. A fénysávhoz nyers HID-riportot kell küldeni a kontrollernek, amit
 * böngészőből a **WebHID** tesz lehetővé.
 *
 * AMI EBBŐL KÖVETKEZIK — ezek nem hibák, hanem a WebHID adottságai:
 *  - Csak Chromium-alapú böngészőkben megy (Chrome, Edge, Opera). Firefoxban
 *    és Safariban nincs WebHID, ott ez a modul némán kikapcsol.
 *  - HTTPS (biztonságos kontextus) kell hozzá, ahogy a kontrollerekhez is.
 *  - A böngésző ENGEDÉLYT kér, eszközönként külön, és ehhez valódi kattintás
 *    kell — egy gamepad-gombnyomás nem elég neki. Ezért van rá külön gomb.
 *  - A WebHID és a Gamepad API nem osztozik azonosítón: nem lehet biztosan
 *    megmondani, melyik HID-eszköz melyik gamepad. A párosítás a MEGADÁS
 *    SORRENDJE szerint történik (első engedélyezett eszköz = 1. játékos).
 *
 * TÁMOGATOTT ESZKÖZÖK
 *  - DualSense (PS5) USB-n és Bluetooth-on
 *  - DualShock 4 (PS4) USB-n
 *
 * A két csatlakozási mód RIPORTJA ELTÉR: Bluetooth-on más a riport-azonosító,
 * minden bájt eggyel arrébb csúszik, és a végére CRC32 kell. A modul a
 * kontroller által meghirdetett kimeneti riportokból dönti el, melyik kell.
 */

const SONY = 0x054c;
/** DualSense, DualSense Edge, DualShock 4 (két revízió). */
const DUALSENSE_PIDS = [0x0ce6, 0x0df2];
const DS4_PIDS = [0x05c4, 0x09cc];

/** Riport-azonosítók. */
const RID_DS_USB = 0x02;
const RID_DS_BT = 0x31;
const RID_DS4_USB = 0x05;

/* ------------------------------------------------------------------------ *
 * CRC32 — a DualSense Bluetooth-riportjának lezárása
 * ------------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ------------------------------------------------------------------------ *
 * Riport-összeállítás
 * ------------------------------------------------------------------------ */

/** Melyik kimeneti riportokat hirdeti meg az eszköz. */
function outputReportIds(device) {
  const ids = new Set();
  const cols = device.collections || [];
  for (const c of cols) {
    for (const r of (c.outputReports || [])) ids.add(r.reportId);
  }
  return ids;
}

/**
 * Eldönti, milyen protokollal beszélünk az eszközzel.
 * @returns {{kind:string, reportId:number}|null}
 */
function detectProtocol(device) {
  const pid = device.productId;
  const ids = outputReportIds(device);

  if (DUALSENSE_PIDS.includes(pid)) {
    // Bluetooth-on a 0x31-es riport a használható; USB-n a 0x02-es.
    if (ids.has(RID_DS_BT)) return { kind: 'ds-bt', reportId: RID_DS_BT };
    if (ids.has(RID_DS_USB)) return { kind: 'ds-usb', reportId: RID_DS_USB };
    // Ha nem hirdet semmit, a kábeles a valószínűbb.
    return { kind: 'ds-usb', reportId: RID_DS_USB };
  }
  if (DS4_PIDS.includes(pid)) {
    if (ids.has(RID_DS4_USB)) return { kind: 'ds4-usb', reportId: RID_DS4_USB };
    // A DS4 Bluetooth-riportja külön formátum; nem támogatjuk.
    return null;
  }
  return null;
}

/**
 * A fénysáv-riport törzse (a riport-azonosító NÉLKÜL, ahogy a `sendReport`
 * várja).
 * @param {string} kind
 * @param {{r:number, g:number, b:number}} c
 * @returns {Uint8Array}
 */
function buildReport(kind, c) {
  const r = c.r & 0xff;
  const g = c.g & 0xff;
  const b = c.b & 0xff;

  if (kind === 'ds-usb') {
    const d = new Uint8Array(47);
    d[0] = 0xff;   // flags0: minden alrendszer módosítható
    d[1] = 0x57;   // flags1: ebben a 0x04 a fénysáv engedélyezése
    d[44] = r;
    d[45] = g;
    d[46] = b;
    return d;
  }

  if (kind === 'ds-bt') {
    // Bluetooth-on egy vezérlőbájt kerül a törzs elejére, minden más eggyel
    // arrébb csúszik, a végén pedig CRC32 zárja a csomagot.
    const d = new Uint8Array(77);
    d[0] = 0x02;
    d[1] = 0xff;
    d[2] = 0x57;
    d[45] = r;
    d[46] = g;
    d[47] = b;

    // A CRC a 0xA2 előtaggal és a riport-azonosítóval együtt számolódik.
    const seed = new Uint8Array(2 + 73);
    seed[0] = 0xa2;
    seed[1] = RID_DS_BT;
    seed.set(d.subarray(0, 73), 2);
    const crc = crc32(seed);
    d[73] = crc & 0xff;
    d[74] = (crc >>> 8) & 0xff;
    d[75] = (crc >>> 16) & 0xff;
    d[76] = (crc >>> 24) & 0xff;
    return d;
  }

  if (kind === 'ds4-usb') {
    const d = new Uint8Array(31);
    d[0] = 0xff;   // a fény és a rezgés is módosítható
    d[5] = r;
    d[6] = g;
    d[7] = b;
    return d;
  }

  return new Uint8Array(0);
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return { r: 255, g: 255, b: 255 };
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

/* ------------------------------------------------------------------------ *
 * Nyilvános felület
 * ------------------------------------------------------------------------ */

/** @type {Array<{device:object, kind:string, reportId:number, last:string}>} */
const bound = [];
let lastError = '';

export const Lightbar = {
  /** Van-e egyáltalán esély rá ebben a böngészőben. */
  get supported() {
    return typeof navigator !== 'undefined' && !!navigator.hid
      && typeof navigator.hid.requestDevice === 'function';
  },

  /** Hány kontroller fénye van a kezünkben. */
  get count() { return bound.length; },

  get error() { return lastError; },

  /**
   * Korábban már engedélyezett eszközök visszavétele — oldalfrissítés után
   * nem kell újra engedélyt kérni.
   */
  async restore() {
    if (!this.supported) return 0;
    try {
      const devices = await navigator.hid.getDevices();
      for (const d of devices) await this._bind(d);
    } catch (err) {
      lastError = String(err && err.message ? err.message : err);
    }
    return bound.length;
  },

  /**
   * Engedélykérés. VALÓDI kattintásból kell hívni — a böngésző gamepad-
   * gombnyomásra nem nyitja meg a választót.
   */
  async request() {
    lastError = '';
    if (!this.supported) {
      lastError = 'Ez a böngésző nem támogatja a WebHID-et (Chrome vagy Edge kell hozzá).';
      return 0;
    }
    try {
      const devices = await navigator.hid.requestDevice({
        filters: [
          ...DUALSENSE_PIDS.map((productId) => ({ vendorId: SONY, productId })),
          ...DS4_PIDS.map((productId) => ({ vendorId: SONY, productId })),
        ],
      });
      if (!devices || !devices.length) return bound.length;   // a felhasználó elvetette
      for (const d of devices) await this._bind(d);
    } catch (err) {
      lastError = String(err && err.message ? err.message : err);
    }
    return bound.length;
  },

  /** @private */
  async _bind(device) {
    if (!device || bound.some((b) => b.device === device)) return;
    const proto = detectProtocol(device);
    if (!proto) return;
    try {
      if (!device.opened) await device.open();
      bound.push({ device, kind: proto.kind, reportId: proto.reportId, last: '' });
      device.addEventListener('disconnect', () => {
        const i = bound.findIndex((b) => b.device === device);
        if (i >= 0) bound.splice(i, 1);
      });
    } catch (err) {
      lastError = String(err && err.message ? err.message : err);
    }
  },

  /**
   * A színek ráültetése a kontrollerekre, sorrend szerint.
   *
   * Csak akkor küld riportot, ha az adott eszköz színe TÉNYLEGESEN változott:
   * a lobbi képkockánként hívja, és egy HID-riport minden képkockában
   * fölösleges forgalom lenne.
   *
   * @param {Array<string>} colors hex színek, ülésrend szerint
   */
  apply(colors) {
    if (!bound.length || !Array.isArray(colors)) return;
    for (let i = 0; i < bound.length; i++) {
      const hex = colors[i];
      const b = bound[i];
      if (!hex || b.last === hex) continue;
      b.last = hex;
      const data = buildReport(b.kind, hexToRgb(hex));
      if (!data.length) continue;
      // Tűzz-és-felejtsd: egy elutasított riport nem állíthatja meg a játékot.
      b.device.sendReport(b.reportId, data).catch((err) => {
        lastError = String(err && err.message ? err.message : err);
      });
    }
  },

  /** Minden fény lekapcsolása (feketére állítás) és az eszközök elengedése. */
  async release() {
    for (const b of bound) {
      try {
        await b.device.sendReport(b.reportId, buildReport(b.kind, { r: 0, g: 0, b: 0 }));
        await b.device.close();
      } catch { /* zárás közben már mindegy */ }
    }
    bound.length = 0;
  },
};

/** Tesztelhetőség: a riport-összeállítás önmagában is ellenőrizhető. */
export const __test = { buildReport, crc32, detectProtocol, hexToRgb };
