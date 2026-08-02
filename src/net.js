/**
 * Slag — szoba-kapcsolat (kliensoldal).
 *
 * A `tools/relay-server.mjs` párja. Egyetlen felelőssége, hogy üzeneteket
 * juttasson el a szoba tagjai közé; a játékról semmit nem tud.
 *
 * SZEREPEK
 *   'host'   — ő futtatja a szimulációt, ő az igazság forrása
 *   'client' — csak inputot küld és pillanatképeket rajzol
 *
 * A relay címe innen jön, ebben a sorrendben:
 *   1. `?relay=` a linkben (így egy megosztott link a saját relayét is hozza)
 *   2. `window.SLAG_RELAY` (a tárhelyen egy sorral beállítható)
 *   3. ugyanaz az eredet, ahonnan a játék jött (ha egy gépen fut mindkettő)
 */

/** Ennyi ideig várunk egy HTTP hívásra, mielőtt hibának vesszük. */
const REQUEST_TIMEOUT_MS = 8000;
/** Az eseményfolyam újranyitása bontás után. */
const RECONNECT_MS = 1200;

function defaultRelay() {
  if (typeof window === 'undefined') return '';
  try {
    const fromLink = new URL(window.location.href).searchParams.get('relay');
    if (fromLink) return fromLink.replace(/\/+$/, '');
  } catch { /* rossz URL, megyünk tovább */ }
  if (typeof window.SLAG_RELAY === 'string' && window.SLAG_RELAY) {
    return window.SLAG_RELAY.replace(/\/+$/, '');
  }
  return window.location.origin;
}

/** A linkben kapott szobakód, ha van. */
export function roomFromLink() {
  if (typeof window === 'undefined') return '';
  try {
    const code = new URL(window.location.href).searchParams.get('szoba')
      || new URL(window.location.href).searchParams.get('room');
    return code ? code.toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
  } catch {
    return '';
  }
}

async function postJson(url, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { /* nem JSON */ }
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Egy szoba-kapcsolat. Eseményei:
 *   'message'   (payload)  — a többiektől érkező játéküzenet
 *   'peer-join' (id)
 *   'peer-left' (id)
 *   'host-gone' ()
 *   'open'      ()         — az eseményfolyam él
 *   'error'     (Error)
 */
export class Room {
  constructor(relayUrl) {
    this.relay = (relayUrl || defaultRelay()).replace(/\/+$/, '');
    this.code = '';
    this.id = '';
    this.hostId = '';
    this.role = '';
    this.open = false;
    this.lastError = null;

    this._events = new Map();
    this._source = null;
    this._closed = false;
    this._reconnect = null;
  }

  /** @param {string} name @param {Function} fn */
  on(name, fn) {
    if (!this._events.has(name)) this._events.set(name, []);
    this._events.get(name).push(fn);
    return this;
  }

  _emit(name, arg) {
    const list = this._events.get(name);
    if (!list) return;
    for (let i = 0; i < list.length; i++) {
      try { list[i](arg); } catch (err) { console.error('[net]', name, err); }
    }
  }

  /** Új szoba nyitása. @returns {Promise<{code:string, link:string}>} */
  async host() {
    const data = await postJson(`${this.relay}/api/room`, {});
    this.code = data.code;
    this.id = data.id;
    this.hostId = data.hostId || data.id;
    this.role = 'host';
    this._listen();
    return { code: this.code, link: this.link };
  }

  /** Csatlakozás meglévő szobához. @param {string} code */
  async join(code) {
    const clean = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!clean) throw new Error('Hiányzik a szobakód');
    const data = await postJson(`${this.relay}/api/room/${clean}/join`, {});
    this.code = clean;
    this.id = data.id;
    this.hostId = data.hostId;
    this.role = 'client';
    this._listen();
    return { code: this.code, id: this.id };
  }

  /** A megosztható link — a relay címét is viszi, hogy a másik fél megtalálja. */
  get link() {
    if (typeof window === 'undefined' || !this.code) return '';
    const url = new URL(window.location.href);
    url.searchParams.set('szoba', this.code);
    // Csak akkor tesszük bele, ha nem ugyanarról az eredetről szolgálják ki:
    // enélkül a link fölöslegesen hosszú és csúnya lenne.
    if (this.relay && this.relay !== window.location.origin) {
      url.searchParams.set('relay', this.relay);
    } else {
      url.searchParams.delete('relay');
    }
    url.hash = '';
    return url.toString();
  }

  /** @private Megnyitja (és bontás után újranyitja) az eseményfolyamot. */
  _listen() {
    if (this._closed) return;
    const url = `${this.relay}/api/room/${this.code}/events?id=${encodeURIComponent(this.id)}`;
    const src = new EventSource(url);
    this._source = src;

    src.onopen = () => {
      this.open = true;
      this.lastError = null;
      this._emit('open');
    };

    src.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.t === 'peer-join') { this._emit('peer-join', msg.from); return; }
      if (msg.t === 'peer-left') { this._emit('peer-left', msg.from); return; }
      if (msg.t === 'host-gone') { this._emit('host-gone'); return; }
      this._emit('message', msg);
    };

    src.onerror = () => {
      this.open = false;
      if (this._closed) return;
      try { src.close(); } catch { /* már zárva */ }
      // Az EventSource magától is újrapróbálna, de a szoba közben megszűnhet;
      // saját ütemben próbálkozunk, hogy a hibát is lássuk.
      clearTimeout(this._reconnect);
      this._reconnect = setTimeout(() => this._listen(), RECONNECT_MS);
    };
  }

  /**
   * Üzenet a szoba többi tagjának.
   * @param {object} payload tetszőleges JSON
   * @param {string} [to] konkrét címzett; enélkül mindenkinek
   */
  send(payload, to) {
    if (this._closed || !this.code || !this.id) return;
    const body = to ? { ...payload, to } : payload;
    // Tűzz-és-felejtsd: egy elveszett input- vagy állapotcsomag helyett a
    // következő úgyis frissebb. Hibát csak naplózunk.
    fetch(`${this.relay}/api/room/${this.code}/send?id=${encodeURIComponent(this.id)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      keepalive: true,
    }).catch(() => { /* a következő csomag pótolja */ });
  }

  close() {
    this._closed = true;
    this.open = false;
    clearTimeout(this._reconnect);
    if (this._source) {
      try { this._source.close(); } catch { /* már zárva */ }
      this._source = null;
    }
    if (this.code && this.id) {
      const url = `${this.relay}/api/room/${this.code}/leave?id=${encodeURIComponent(this.id)}`;
      try { navigator.sendBeacon(url, '{}'); } catch { /* nem baj */ }
    }
  }
}

/** Elérhető-e a relay? A lobbi ezzel tud őszinte hibaüzenetet adni. */
export async function relayReachable(relayUrl) {
  const base = (relayUrl || defaultRelay()).replace(/\/+$/, '');
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(`${base}/api/health`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return false;
    const data = await res.json();
    return !!(data && data.ok);
  } catch {
    return false;
  }
}

export { defaultRelay };
