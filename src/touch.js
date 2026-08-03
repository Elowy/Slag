/**
 * Slag — érintőképernyős kezelés (telefon, tablet).
 *
 * MIÉRT ÍGY
 * A játék minden szereplője — ember, bot, hálózati vendég — ugyanolyan
 * `InputState`-et állít elő, és a lobbi meg a meccs nem tudja, honnan jön. Az
 * érintőképernyő is csak egy újabb ilyen forrás: ez a modul a képernyőre
 * rajzolt karokból és gombokból ugyanazt a csomagot rakja össze, amit egy
 * kontroller adna (`Input.setTouchState`). Ezért a lobbi, a meccs, a szünet és
 * az online szoba EGYETLEN sornyi külön ág nélkül kezeli a telefont is.
 *
 * A KÉT KEZELÉSI MÓD
 *  - Meccs közben: bal hüvelykujj = kar (a torony a menetiránnyal fordul),
 *    jobb alsó sarok = TŰZ. Aki külön akar célozni, a jobb oldal üres részén
 *    húzva megkapja a célzókart is.
 *  - Menüben: nagy, koppintható gombok — nyilak, Kereszt, Kör, Start, lapváltás.
 *
 * A KOORDINÁTÁKRÓL
 * Minden méret a játék 1600x900-as belső terében van megadva, és a
 * `screenToArena()` fordítja oda az ujjak helyét. Így a kezelőszervek pont
 * ugyanúgy skálázódnak és pozicionálódnak, mint a játék képe — a levágott
 * (letterbox) sávokba nem lóghatnak ki.
 */

import { Input } from './input.js';
import { screenToArena } from './render.js';

/** A kar sugara: ennyi elmozdulás a teljes kitérés. */
const STICK_R = 110;
/** Ekkora elmozdulás alatt nem mozdul semmi (remegő ujj). */
const STICK_DEAD = 12;

/** A bal (mozgás) és a jobb (célzás) félteke határa. */
const SPLIT_LEFT = 720;
const SPLIT_RIGHT = 880;

/** Meccs közbeni, rögzített helyű gombok. */
const GAME_BUTTONS = [
  { id: 'fire', edge: 'fire', hold: true, x: 1420, y: 730, r: 96, label: 'TŰZ' },
  // A négy SAROK mind foglalt: ott ülnek a játékos-kártyák (14..340 és
  // 1260..1586). A jobb felsőt ráadásul az online panel is takarja, ami a
  // vászon FÖLÖTT van, tehát elnyelné a koppintást. A kártya jobb széle (340)
  // és az eredményjelző bal széle (kb. 700) közötti rés az egyetlen, ami
  // mindegyiket elkerüli.
  { id: 'pause', edge: 'start', hold: false, x: 430, y: 62, r: 42, label: '❚❚' },
];

/**
 * Menübeli gombok. A bal alsó sarokban a nyilak, a jobb alsóban a
 * megerősítés — ugyanaz a kézállás, mint egy kontrolleren.
 */
const MENU_BUTTONS = [
  { id: 'up', edge: 'up', x: 210, y: 610, r: 52, label: '▲' },
  { id: 'down', edge: 'down', x: 210, y: 790, r: 52, label: '▼' },
  { id: 'prev', edge: 'prev', x: 100, y: 700, r: 52, label: '◀' },
  { id: 'next', edge: 'next', x: 320, y: 700, r: 52, label: '▶' },
  // A lapváltók a kártyák alatti üres sávban (a kártyák 470-nél véget érnek,
  // az összegző sor 630-nál kezdődik) — így semmit nem takarnak.
  { id: 'tabPrev', edge: 'tabPrev', x: 520, y: 552, r: 44, label: '«' },
  { id: 'tabNext', edge: 'tabNext', x: 1080, y: 552, r: 44, label: '»' },
  { id: 'confirm', edge: 'confirm', x: 1450, y: 730, r: 68, label: '✕' },
  { id: 'cancel', edge: 'cancel', x: 1310, y: 800, r: 48, label: '○' },
  { id: 'start', edge: 'start', x: 1470, y: 590, r: 48, label: 'START' },
];

/* ------------------------------------------------------------------------ *
 * Állapot
 * ------------------------------------------------------------------------ */

/** @type {Map<number, object>} az aktív ujjak, azonosító szerint. */
const points = new Map();

const state = {
  /** Volt-e már egyáltalán érintés ezen a gépen. */
  used: false,
  /** `'menu'` amíg nem meccs van, `'game'` meccs közben. */
  mode: 'menu',
  /** Az élek gyűjtője a következő küldésig. */
  edges: {},
  move: { active: false, baseX: 0, baseY: 0, x: 0, y: 0, dx: 0, dy: 0, mag: 0 },
  aim: { active: false, baseX: 0, baseY: 0, x: 0, y: 0, dx: 0, dy: 0, mag: 0 },
  fire: 0,
  /** Éppen lenyomva tartott gombok azonosítói (a rajzoló ettől világítja ki). */
  pressed: new Map(),
};

function buttons() {
  return state.mode === 'game' ? GAME_BUTTONS : MENU_BUTTONS;
}

function hitButton(x, y) {
  const list = buttons();
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    // Kicsit nagyobb találati kör, mint a rajzolt: a hüvelykujj nem precíz.
    const r = b.r + 14;
    if ((x - b.x) ** 2 + (y - b.y) ** 2 <= r * r) return b;
  }
  return null;
}

/** A kar kitérése a kiindulási ponthoz képest, holtsávval és normálva. */
function updateStick(stick) {
  let dx = stick.x - stick.baseX;
  let dy = stick.y - stick.baseY;
  const len = Math.hypot(dx, dy);
  if (len <= STICK_DEAD) { stick.dx = 0; stick.dy = 0; stick.mag = 0; return; }
  const mag = Math.min(1, (len - STICK_DEAD) / (STICK_R - STICK_DEAD));
  stick.dx = dx / len;
  stick.dy = dy / len;
  stick.mag = mag;
}

/** A pillanatnyi állapot átadása az input rétegnek. */
function push() {
  if (!state.used) return;
  const m = state.move;
  const a = state.aim;
  Input.setTouchState({
    mx: m.dx * m.mag, my: m.dy * m.mag, mm: m.mag,
    ax: a.dx * a.mag, ay: a.dy * a.mag, am: a.mag,
    f: state.fire, fh: state.fire > 0,
    e: state.edges,
  });
  state.edges = {};
}

/* ------------------------------------------------------------------------ *
 * Érintés-események
 * ------------------------------------------------------------------------ */

function activate() {
  if (state.used) return;
  state.used = true;
  Input.enableTouchDevice();
}

function onStart(ev) {
  activate();
  const list = ev.changedTouches;
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    const p = screenToArena(t.clientX, t.clientY);
    const btn = hitButton(p.x, p.y);

    if (btn) {
      state.edges[btn.edge] = true;
      state.pressed.set(btn.id, true);
      if (btn.hold) state.fire = 1;
      points.set(t.identifier, { role: 'button', btn });
      continue;
    }

    // Menüben a gombokon kívül nincs teendő: a képernyő közepén húzogatás
    // ne állítson semmit.
    if (state.mode !== 'game') { points.set(t.identifier, { role: 'none' }); continue; }

    if (p.x < SPLIT_LEFT) {
      state.move.active = true;
      state.move.baseX = p.x; state.move.baseY = p.y;
      state.move.x = p.x; state.move.y = p.y;
      updateStick(state.move);
      points.set(t.identifier, { role: 'move' });
    } else if (p.x > SPLIT_RIGHT) {
      state.aim.active = true;
      state.aim.baseX = p.x; state.aim.baseY = p.y;
      state.aim.x = p.x; state.aim.y = p.y;
      updateStick(state.aim);
      points.set(t.identifier, { role: 'aim' });
    } else {
      points.set(t.identifier, { role: 'none' });
    }
  }
  if (ev.cancelable) ev.preventDefault();
  push();
}

function onMove(ev) {
  const list = ev.changedTouches;
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    const rec = points.get(t.identifier);
    if (!rec) continue;
    if (rec.role !== 'move' && rec.role !== 'aim') continue;
    const p = screenToArena(t.clientX, t.clientY);
    const stick = rec.role === 'move' ? state.move : state.aim;
    stick.x = p.x; stick.y = p.y;
    updateStick(stick);
  }
  if (ev.cancelable) ev.preventDefault();
  push();
}

function releasePoint(id) {
  const rec = points.get(id);
  if (!rec) return;
  points.delete(id);

  if (rec.role === 'move') {
    state.move.active = false;
    state.move.dx = 0; state.move.dy = 0; state.move.mag = 0;
  } else if (rec.role === 'aim') {
    state.aim.active = false;
    state.aim.dx = 0; state.aim.dy = 0; state.aim.mag = 0;
  } else if (rec.role === 'button') {
    state.pressed.delete(rec.btn.id);
    if (rec.btn.hold) {
      // Csak akkor engedjük el a ravaszt, ha MÁS ujj sem tartja.
      let stillHeld = false;
      for (const other of points.values()) {
        if (other.role === 'button' && other.btn.hold) stillHeld = true;
      }
      if (!stillHeld) state.fire = 0;
    }
  }
}

function onEnd(ev) {
  const list = ev.changedTouches;
  for (let i = 0; i < list.length; i++) releasePoint(list[i].identifier);
  if (ev.cancelable) ev.preventDefault();
  push();
}

/** Elveszett érintések (hívás, értesítés, gesztus): mindent elengedünk. */
function onCancel(ev) {
  for (const id of [...points.keys()]) releasePoint(id);
  state.fire = 0;
  if (ev && ev.cancelable) ev.preventDefault();
  push();
}

/* ------------------------------------------------------------------------ *
 * Nyilvános felület
 * ------------------------------------------------------------------------ */

export const TouchUI = {
  /** Van-e egyáltalán érintőképernyő ezen a gépen. */
  get available() {
    if (typeof window === 'undefined') return false;
    return ('ontouchstart' in window)
      || (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0);
  },

  /** Használta-e már valaki (csak ekkor rajzolunk kezelőszerveket). */
  get used() { return state.used; },

  get mode() { return state.mode; },

  /**
   * Beköti az érintés-eseményeket a vászonra.
   *
   * `passive: false`, mert a `preventDefault()` nélkül a böngésző görgetne,
   * nagyítana vagy „húzd le a frissítéshez” gesztust indítana a játék helyett.
   *
   * @param {HTMLCanvasElement} canvas
   */
  install(canvas) {
    if (!canvas || !canvas.addEventListener) return;
    // Az ELSŐ érintés bárhol a lapon bekapcsolja a kezelőszerveket — a
    // kezdőfátylat is ujjal tünteti el az ember, és onnantól már látszódnia
    // kell a gomboknak. Enélkül a lobbi üresen fogadná, és külön kellene még
    // egyszer a vászonra koppintania.
    if (typeof window !== 'undefined') {
      window.addEventListener('touchstart', activate, { passive: true, once: true });
    }
    canvas.addEventListener('touchstart', onStart, { passive: false });
    canvas.addEventListener('touchmove', onMove, { passive: false });
    canvas.addEventListener('touchend', onEnd, { passive: false });
    canvas.addEventListener('touchcancel', onCancel, { passive: false });
    // Háttérbe kerülve ne ragadjon be egy nyomva tartott ravasz.
    if (typeof window !== 'undefined') window.addEventListener('blur', () => onCancel(null));
  },

  /**
   * Meccs van-e épp. A hívó képkockánként állítja; a kezelőszervek ettől
   * váltanak karokra vagy menügombokra.
   * @param {boolean} inMatch
   */
  setMode(inMatch) {
    const next = inMatch ? 'game' : 'menu';
    if (next === state.mode) return;
    // Módváltáskor minden ujj „elenged”: egy meccs végén nyomva tartott ravasz
    // nem nyomkodhatja a menüt.
    onCancel(null);
    state.mode = next;
  },

  /**
   * A rajzoláshoz szükséges leírás. `null`, ha nincs mit kirajzolni.
   * @returns {object|null}
   */
  get layout() {
    if (!state.used) return null;
    return {
      mode: state.mode,
      buttons: buttons(),
      pressed: state.pressed,
      move: state.move,
      aim: state.aim,
      stickRadius: STICK_R,
    };
  },
};

export const __touchTest = { hitButton, updateStick, state, GAME_BUTTONS, MENU_BUTTONS };
