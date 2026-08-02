/**
 * Slag - input module.
 *
 * Responsibilities (see SPEC section 4):
 *  - Poll every connected gamepad once per frame and expose a normalized
 *    `InputState` per device.
 *  - Expose two keyboard schemes (`kb-0`, `kb-1`) that behave exactly like a
 *    gamepad from the caller's point of view.
 *  - Edge detection (`*Pressed`) is computed from the previous frame snapshot,
 *    so a button held down only produces a single edge.
 *
 * Control layout (final, from the spec):
 *  - right stick  (axes[2], axes[3]) -> movement direction + speed
 *  - left stick   (axes[0], axes[1]) -> optional turret aiming
 *  - R2           (buttons[7])       -> analog fire
 *
 * The module never throws: every browser quirk (missing buttons, holes in the
 * gamepad array, absent vibration actuator, non-standard mapping) is guarded.
 */

import { CONFIG } from './config.js';

/* ------------------------------------------------------------------------ *
 * Standard gamepad mapping (PS5 DualSense reports `mapping === 'standard'`
 * in Chrome, Edge and recent Firefox). When the mapping is NOT standard we
 * still try the very same indices - they are correct for the vast majority of
 * drivers - but every read is bounds-checked, so a shorter array is harmless.
 * ------------------------------------------------------------------------ */

const BTN = {
  CROSS: 0,        // X / A
  CIRCLE: 1,       // O / B
  SQUARE: 2,
  TRIANGLE: 3,
  L1: 4,
  R1: 5,
  L2: 6,
  R2: 7,
  SHARE: 8,
  OPTIONS: 9,
  L3: 10,
  R3: 11,
  DPAD_UP: 12,
  DPAD_DOWN: 13,
  DPAD_LEFT: 14,
  DPAD_RIGHT: 15,
  PS: 16,
  TOUCHPAD: 17,
};

const AXIS = {
  LEFT_X: 0,
  LEFT_Y: 1,
  RIGHT_X: 2,
  RIGHT_Y: 3,
  L2: 4,           // only on some legacy / WebKit mappings
  R2: 5,           // only on some legacy / WebKit mappings
};

/** How many button slots we watch for the generic "any button" edge. */
const MAX_TRACKED_BUTTONS = 20;

/** Digital threshold for buttons that also report an analog `value`. */
const BUTTON_ANALOG_THRESHOLD = 0.5;

/** Two polls closer than this (ms) are treated as the same frame. */
const POLL_BUCKET_MS = 1;

/* ------------------------------------------------------------------------ *
 * Keyboard schemes
 * ------------------------------------------------------------------------ */

/**
 * Every binding uses `KeyboardEvent.code` (physical key) instead of `key`, so
 * the layout works on Hungarian, German, French, ... keyboards alike.
 */
const KEY_SCHEME_DEFS = [
  {
    id: 'kb-0',
    label: 'Billentyűzet A',
    up: ['KeyW'],
    down: ['KeyS'],
    left: ['KeyA'],
    right: ['KeyD'],
    aimUp: ['ArrowUp'],
    aimDown: ['ArrowDown'],
    aimLeft: ['ArrowLeft'],
    aimRight: ['ArrowRight'],
    fire: ['Space'],
    confirm: ['Enter'],
    cancel: ['Escape'],
    start: ['Enter'],
    prev: ['KeyQ', 'ArrowLeft'],
    tabNext: ['Tab'],
    next: ['KeyE', 'ArrowRight'],
    menuUp: ['KeyW', 'ArrowUp'],
    menuDown: ['KeyS', 'ArrowDown'],
  },
  {
    id: 'kb-1',
    label: 'Billentyűzet B',
    up: ['KeyI'],
    down: ['KeyK'],
    left: ['KeyJ'],
    right: ['KeyL'],
    aimUp: ['Numpad8'],
    aimDown: ['Numpad5'],
    aimLeft: ['Numpad4'],
    aimRight: ['Numpad6'],
    fire: ['Numpad0'],
    confirm: ['NumpadEnter'],
    cancel: ['NumpadDecimal', 'Backspace'],
    start: ['NumpadEnter'],
    prev: ['KeyU', 'Numpad4'],
    tabNext: ['Tab'],
    next: ['KeyO', 'Numpad6'],
    menuUp: ['KeyI', 'Numpad8'],
    menuDown: ['KeyK', 'Numpad5'],
  },
];

/** Keys whose browser default (scrolling, focus traversal) must be blocked. */
const PREVENT_DEFAULT_CODES = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Tab',
]);

/** Collect every code a scheme uses, for fast membership tests. */
function collectSchemeCodes(scheme) {
  const all = new Set();
  for (const key of Object.keys(scheme)) {
    const value = scheme[key];
    if (Array.isArray(value)) {
      for (const code of value) all.add(code);
    }
  }
  return all;
}

for (const scheme of KEY_SCHEME_DEFS) {
  scheme.all = collectSchemeCodes(scheme);
}

/* ------------------------------------------------------------------------ *
 * Small local helpers (kept local on purpose: input is the module we least
 * want to break because of an unrelated file)
 * ------------------------------------------------------------------------ */

function clamp01(v) {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : (v > 1 ? 1 : v);
}

function nowMs() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function deadzone() {
  const raw = CONFIG && CONFIG.input ? CONFIG.input.deadzone : undefined;
  const dz = Number.isFinite(raw) ? raw : 0.26;
  // A deadzone of >= 1 would make the stick unusable and divide by zero below.
  return dz < 0 ? 0 : (dz > 0.9 ? 0.9 : dz);
}

function triggerThreshold() {
  const raw = CONFIG && CONFIG.input ? CONFIG.input.triggerThreshold : undefined;
  return Number.isFinite(raw) ? clamp01(raw) : 0.35;
}

/**
 * Radial deadzone with re-normalization: inside the deadzone the output is
 * exactly 0, at the physical edge of the stick it is exactly 1, and there is
 * no jump at the deadzone border.
 * Writes into `out` to avoid per-frame allocations.
 */
function applyRadialDeadzone(x, y, dz, out) {
  const mag = Math.hypot(x, y);
  if (!(mag > dz)) {
    out.x = 0; out.y = 0; out.mag = 0;
    return out;
  }
  let norm = (mag - dz) / (1 - dz);
  if (norm > 1) norm = 1;
  const scale = norm / mag;
  out.x = x * scale;
  out.y = y * scale;
  out.mag = norm;
  return out;
}

/** Normalize a digital (-1/0/1) direction pair so diagonals are not faster. */
function digitalVector(x, y, out) {
  if (x === 0 && y === 0) {
    out.x = 0; out.y = 0; out.mag = 0;
    return out;
  }
  const mag = Math.hypot(x, y);
  out.x = x / mag;
  out.y = y / mag;
  out.mag = 1;
  return out;
}

/* ------------------------------------------------------------------------ *
 * Gamepad readers (all bounds-checked)
 * ------------------------------------------------------------------------ */

function readAxis(gp, index) {
  const axes = gp.axes;
  if (!axes || axes.length <= index) return 0;
  const v = axes[index];
  return Number.isFinite(v) ? v : 0;
}

function readButton(gp, index) {
  const buttons = gp.buttons;
  if (!buttons || buttons.length <= index) return false;
  const b = buttons[index];
  if (!b) return false;
  if (b.pressed) return true;
  return Number.isFinite(b.value) && b.value >= BUTTON_ANALOG_THRESHOLD;
}

/**
 * Analog trigger value (0..1).
 * Primary source is `buttons[7].value`; digital-only pads fall back to
 * `.pressed`; WebKit / legacy Firefox mappings expose R2 on `axes[5]` in the
 * -1..1 range instead.
 */
function readTrigger(gp) {
  const buttons = gp.buttons;
  if (buttons && buttons.length > BTN.R2) {
    const b = buttons[BTN.R2];
    if (b) {
      if (Number.isFinite(b.value) && b.value > 0) return clamp01(b.value);
      return b.pressed ? 1 : 0;
    }
  }
  const axes = gp.axes;
  if (axes && axes.length > AXIS.R2) {
    const v = axes[AXIS.R2];
    if (Number.isFinite(v)) return clamp01((v + 1) / 2);
  }
  return 0;
}

/** Snapshot list of gamepads; always an array, may contain nulls. */
function getPads() {
  try {
    if (typeof navigator === 'undefined') return [];
    const getter = navigator.getGamepads || navigator.webkitGetGamepads;
    if (typeof getter !== 'function') return [];
    const pads = getter.call(navigator);
    if (!pads) return [];
    return Array.prototype.slice.call(pads);
  } catch (err) {
    // Some browsers throw when the page is not focused / not secure.
    return [];
  }
}

/**
 * Why the browser is not handing us any gamepads.
 *
 * The Gamepad API is a secure-context feature: served over plain `http://`
 * from anything other than localhost, `navigator.getGamepads` is simply absent
 * and every controller silently fails to appear. That is the single most
 * likely way a working local build breaks once it is uploaded to a web server,
 * so the lobby says it out loud instead of showing the generic
 * "press a button on the controller" nudge forever.
 *
 * @returns {'ok'|'insecure'|'unsupported'}
 */
function gamepadAvailability() {
  if (typeof navigator === 'undefined') return 'unsupported';
  const getter = navigator.getGamepads || navigator.webkitGetGamepads;
  if (typeof getter === 'function') return 'ok';
  // No API at all. An insecure context is the actionable case: the page works,
  // the fix is HTTPS (or localhost), and only the host can apply it.
  if (typeof window !== 'undefined' && window.isSecureContext === false) return 'insecure';
  return 'unsupported';
}

function getPadByIndex(index) {
  const pads = getPads();
  for (let i = 0; i < pads.length; i++) {
    const pad = pads[i];
    if (pad && pad.index === index) return pad;
  }
  return null;
}

/* ------------------------------------------------------------------------ *
 * State objects
 * ------------------------------------------------------------------------ */

/**
 * @returns {object} a fresh neutral InputState.
 * `upPressed` / `downPressed` are an addition on top of the spec's field list:
 * the lobby needs D-pad up/down to move the setting focus, and the contract
 * has no dedicated field for it. Everything the spec lists is present.
 */
function makeState() {
  return {
    moveX: 0, moveY: 0, moveMag: 0,
    aimX: 0, aimY: 0, aimMag: 0,
    fire: 0, firePressed: false, fireHeld: false,
    confirmPressed: false,
    cancelPressed: false,
    prevPressed: false, nextPressed: false,
    tabPrevPressed: false, tabNextPressed: false,
    startPressed: false,
    upPressed: false, downPressed: false,
    anyPressed: false,
  };
}

function resetState(s) {
  s.moveX = 0; s.moveY = 0; s.moveMag = 0;
  s.aimX = 0; s.aimY = 0; s.aimMag = 0;
  s.fire = 0; s.firePressed = false; s.fireHeld = false;
  s.confirmPressed = false;
  s.cancelPressed = false;
  s.prevPressed = false; s.nextPressed = false;
  s.tabPrevPressed = false; s.tabNextPressed = false;
  s.startPressed = false;
  s.upPressed = false; s.downPressed = false;
  s.anyPressed = false;
}

function makePrev() {
  return {
    fire: false,
    confirm: false, cancel: false,
    prev: false, next: false,
    start: false,
    up: false, down: false,
  };
}

function resetPrev(p) {
  p.fire = false;
  p.confirm = false; p.cancel = false;
  p.prev = false; p.next = false;
  p.start = false;
  p.up = false; p.down = false;
}

/* ------------------------------------------------------------------------ *
 * Device registry
 * ------------------------------------------------------------------------ */

/** @type {Map<string, object>} internal device records, keyed by device id. */
const devices = new Map();
/** @type {Array<object>} keyboard records only - hot path for key events. */
const keyboardDevices = [];
/** @type {Array<object>} hálózaton lévő játékosok eszközei. */
const remoteDevices = [];

let initialized = false;
let lastPollTime = -Infinity;

/* ------------------------------------------------------------------------ *
 * Távoli játékosok
 * ------------------------------------------------------------------------ */

const REMOTE_EDGE_KEYS = ['fire', 'confirm', 'cancel', 'start', 'prev', 'next', 'up', 'down', 'tabPrev', 'tabNext'];

function makeRemoteEdges() {
  return {
    fire: false, confirm: false, cancel: false, start: false,
    prev: false, next: false, up: false, down: false,
    tabPrev: false, tabNext: false,
  };
}

/**
 * A SAJÁT gombéleink gyűjtője két hálózati küldés között.
 * Minden poll után ide OR-oljuk az éleket, a `serializeLocalInput()` üríti.
 */
const localEdges = makeRemoteEdges();

function clearLocalEdges() {
  for (let i = 0; i < REMOTE_EDGE_KEYS.length; i++) localEdges[REMOTE_EDGE_KEYS[i]] = false;
}

/** Egy helyi eszköz éleit hozzáadja a hálózati gyűjtőhöz. */
function accumulateLocalEdges(s) {
  if (s.firePressed) localEdges.fire = true;
  if (s.confirmPressed) localEdges.confirm = true;
  if (s.cancelPressed) localEdges.cancel = true;
  if (s.startPressed) localEdges.start = true;
  if (s.prevPressed) localEdges.prev = true;
  if (s.nextPressed) localEdges.next = true;
  if (s.tabPrevPressed) localEdges.tabPrev = true;
  if (s.tabNextPressed) localEdges.tabNext = true;
  if (s.upPressed) localEdges.up = true;
  if (s.downPressed) localEdges.down = true;
}

/**
 * A távoli eszköz állapotának összerakása pollonként.
 *
 * Az analóg mezők a legutóbb kapott csomagból jönnek, a gombélek pedig a
 * gyűjtőből — mindegyik pontosan egy pollig él, ahogy egy helyi eszközön is.
 */
function updateRemoteDevice(dev) {
  const s = dev.state;
  const r = dev.remote;

  s.moveX = r.moveX; s.moveY = r.moveY; s.moveMag = r.moveMag;
  s.aimX = r.aimX; s.aimY = r.aimY; s.aimMag = r.aimMag;
  s.fire = r.fire;
  s.fireHeld = r.fireHeld;

  const q = r.edges;
  s.firePressed = q.fire;
  s.confirmPressed = q.confirm;
  s.cancelPressed = q.cancel;
  s.startPressed = q.start;
  s.prevPressed = q.prev;
  s.nextPressed = q.next;
  s.tabPrevPressed = q.tabPrev;
  s.tabNextPressed = q.tabNext;
  s.upPressed = q.up;
  s.downPressed = q.down;
  s.anyPressed = q.fire || q.confirm || q.cancel || q.start || q.prev || q.next || q.up || q.down;

  for (let i = 0; i < REMOTE_EDGE_KEYS.length; i++) q[REMOTE_EDGE_KEYS[i]] = false;

  if (dev.suppressEdges) {
    clearEdges(s);
    dev.suppressEdges = false;
  }
}

function makeDeviceRecord(id, kind, label) {
  return {
    id,
    kind,
    label,
    connected: true,
    padIndex: -1,
    scheme: null,
    held: null,          // keyboard: currently held codes
    pressed: null,       // keyboard: codes pressed since the last poll
    state: makeState(),
    prev: makePrev(),
    prevButtons: new Array(MAX_TRACKED_BUTTONS).fill(false),
    // After a reset (blur, reconnect) the very first poll must not report
    // edges for buttons that were already held down.
    suppressEdges: true,
  };
}

function ensureKeyboardDevices() {
  if (keyboardDevices.length > 0) return;
  for (const scheme of KEY_SCHEME_DEFS) {
    const dev = makeDeviceRecord(scheme.id, 'keyboard', scheme.label);
    dev.scheme = scheme;
    dev.held = new Set();
    dev.pressed = new Set();
    devices.set(dev.id, dev);
    keyboardDevices.push(dev);
  }
}

function ensureGamepadDevice(pad) {
  if (!pad || !Number.isFinite(pad.index)) return null;
  const id = `gp-${pad.index}`;
  let dev = devices.get(id);
  if (!dev) {
    dev = makeDeviceRecord(id, 'gamepad', `Kontroller ${pad.index + 1}`);
    dev.padIndex = pad.index;
    devices.set(id, dev);
  }
  if (!dev.connected) {
    // Fresh connection: drop any stale edge information.
    resetDevice(dev);
  }
  dev.connected = true;
  dev.padIndex = pad.index;
  return dev;
}

function resetDevice(dev) {
  resetState(dev.state);
  resetPrev(dev.prev);
  dev.prevButtons.fill(false);
  dev.suppressEdges = true;
  if (dev.held) dev.held.clear();
  if (dev.pressed) dev.pressed.clear();
}

function resetAllDevices() {
  for (const dev of devices.values()) resetDevice(dev);
}

/** Gamepads first (by index), keyboards last - a stable, human-friendly order. */
function orderedDevices() {
  const gamepads = [];
  const keyboards = [];
  for (const dev of devices.values()) {
    if (dev.kind === 'gamepad') gamepads.push(dev);
    else keyboards.push(dev);
  }
  gamepads.sort((a, b) => a.padIndex - b.padIndex);
  return gamepads.concat(keyboards);
}

/* ------------------------------------------------------------------------ *
 * Event handlers
 * ------------------------------------------------------------------------ */

function onGamepadConnected(event) {
  if (event && event.gamepad) ensureGamepadDevice(event.gamepad);
}

function onGamepadDisconnected(event) {
  const pad = event && event.gamepad;
  if (!pad) return;
  const dev = devices.get(`gp-${pad.index}`);
  if (!dev) return;
  dev.connected = false;
  // Zero everything so a held trigger cannot stick the throttle on.
  resetDevice(dev);
}

function onKeyDown(event) {
  // Never swallow browser/OS shortcuts.
  if (event.ctrlKey || event.altKey || event.metaKey) return;
  const code = event.code;
  if (PREVENT_DEFAULT_CODES.has(code)) event.preventDefault();
  if (event.repeat) return;
  for (const dev of keyboardDevices) {
    if (dev.scheme.all.has(code)) {
      dev.held.add(code);
      dev.pressed.add(code);
    }
  }
}

function onKeyUp(event) {
  // Runs even with modifiers held, otherwise keys could get stuck.
  const code = event.code;
  if (PREVENT_DEFAULT_CODES.has(code)) event.preventDefault();
  for (const dev of keyboardDevices) dev.held.delete(code);
}

function onBlur() {
  resetAllDevices();
}

function onVisibilityChange() {
  if (typeof document !== 'undefined' && document.hidden) resetAllDevices();
}

/* ------------------------------------------------------------------------ *
 * Per-device update
 * ------------------------------------------------------------------------ */

const vecMove = { x: 0, y: 0, mag: 0 };
const vecAim = { x: 0, y: 0, mag: 0 };

function updateGamepadDevice(dev, pad) {
  const s = dev.state;
  const prev = dev.prev;
  const dz = deadzone();
  const threshold = triggerThreshold();

  // --- Movement: right stick, with the D-pad as a digital fallback ---------
  applyRadialDeadzone(readAxis(pad, AXIS.RIGHT_X), readAxis(pad, AXIS.RIGHT_Y), dz, vecMove);
  const dpadUp = readButton(pad, BTN.DPAD_UP);
  const dpadDown = readButton(pad, BTN.DPAD_DOWN);
  const dpadLeft = readButton(pad, BTN.DPAD_LEFT);
  const dpadRight = readButton(pad, BTN.DPAD_RIGHT);
  if (vecMove.mag === 0) {
    digitalVector((dpadRight ? 1 : 0) - (dpadLeft ? 1 : 0),
                  (dpadDown ? 1 : 0) - (dpadUp ? 1 : 0), vecMove);
  }
  s.moveX = vecMove.x; s.moveY = vecMove.y; s.moveMag = vecMove.mag;

  // --- Aiming: left stick only (drives the turret 'free' mode) -------------
  applyRadialDeadzone(readAxis(pad, AXIS.LEFT_X), readAxis(pad, AXIS.LEFT_Y), dz, vecAim);
  s.aimX = vecAim.x; s.aimY = vecAim.y; s.aimMag = vecAim.mag;

  // --- Fire trigger --------------------------------------------------------
  const fire = readTrigger(pad);
  const fireHeld = fire >= threshold;
  s.fire = fire;
  s.fireHeld = fireHeld;
  s.firePressed = fireHeld && !prev.fire;
  prev.fire = fireHeld;

  // --- Face / shoulder buttons --------------------------------------------
  const confirm = readButton(pad, BTN.CROSS);
  const cancel = readButton(pad, BTN.CIRCLE);
  const start = readButton(pad, BTN.OPTIONS);
  // A D-pad bal/jobb az ÉRTÉKÉ, az L1/R1 a LAPOKÉ. Korábban a kettő ugyanaz
  // volt; a menü lapokra bontásával kellett szétválasztani őket.
  const goPrev = dpadLeft;
  const goNext = dpadRight;
  const tabPrev = readButton(pad, BTN.L1);
  const tabNext = readButton(pad, BTN.R1);

  s.confirmPressed = confirm && !prev.confirm;
  s.cancelPressed = cancel && !prev.cancel;
  s.startPressed = start && !prev.start;
  s.prevPressed = goPrev && !prev.prev;
  s.nextPressed = goNext && !prev.next;
  s.tabPrevPressed = tabPrev && !prev.tabPrev;
  s.tabNextPressed = tabNext && !prev.tabNext;
  s.upPressed = dpadUp && !prev.up;
  s.downPressed = dpadDown && !prev.down;

  prev.confirm = confirm;
  prev.cancel = cancel;
  prev.start = start;
  prev.prev = goPrev;
  prev.next = goNext;
  prev.tabPrev = tabPrev;
  prev.tabNext = tabNext;
  prev.up = dpadUp;
  prev.down = dpadDown;

  // --- Generic "any button went down this frame" ---------------------------
  let any = s.firePressed;
  const buttons = pad.buttons;
  const count = buttons ? Math.min(buttons.length, MAX_TRACKED_BUTTONS) : 0;
  for (let i = 0; i < count; i++) {
    const b = buttons[i];
    const down = !!(b && (b.pressed || (Number.isFinite(b.value) && b.value >= BUTTON_ANALOG_THRESHOLD)));
    if (down && !dev.prevButtons[i]) any = true;
    dev.prevButtons[i] = down;
  }
  for (let i = count; i < MAX_TRACKED_BUTTONS; i++) dev.prevButtons[i] = false;
  s.anyPressed = any;

  if (dev.suppressEdges) {
    clearEdges(s);
    dev.suppressEdges = false;
  }
}

function heldAny(dev, codes) {
  for (let i = 0; i < codes.length; i++) {
    if (dev.held.has(codes[i])) return true;
  }
  return false;
}

function pressedAny(dev, codes) {
  for (let i = 0; i < codes.length; i++) {
    if (dev.pressed.has(codes[i])) return true;
  }
  return false;
}

function updateKeyboardDevice(dev) {
  const s = dev.state;
  const prev = dev.prev;
  const sc = dev.scheme;
  const threshold = triggerThreshold();

  // --- Movement (normalized, so diagonals are not faster) ------------------
  digitalVector((heldAny(dev, sc.right) ? 1 : 0) - (heldAny(dev, sc.left) ? 1 : 0),
                (heldAny(dev, sc.down) ? 1 : 0) - (heldAny(dev, sc.up) ? 1 : 0), vecMove);
  s.moveX = vecMove.x; s.moveY = vecMove.y; s.moveMag = vecMove.mag;

  // --- Aiming --------------------------------------------------------------
  digitalVector((heldAny(dev, sc.aimRight) ? 1 : 0) - (heldAny(dev, sc.aimLeft) ? 1 : 0),
                (heldAny(dev, sc.aimDown) ? 1 : 0) - (heldAny(dev, sc.aimUp) ? 1 : 0), vecAim);
  s.aimX = vecAim.x; s.aimY = vecAim.y; s.aimMag = vecAim.mag;

  // --- Fire ----------------------------------------------------------------
  const fireDown = heldAny(dev, sc.fire);
  const fire = fireDown ? 1 : 0;
  const fireHeld = fire >= threshold;
  s.fire = fire;
  s.fireHeld = fireHeld;
  // A tap that started and ended between two polls still fires once.
  s.firePressed = (fireHeld && !prev.fire) || pressedAny(dev, sc.fire);
  prev.fire = fireHeld;

  // --- Buttons (edge from the "pressed since last poll" set) ---------------
  s.confirmPressed = pressedAny(dev, sc.confirm);
  s.cancelPressed = pressedAny(dev, sc.cancel);
  s.startPressed = pressedAny(dev, sc.start);
  s.prevPressed = pressedAny(dev, sc.prev);
  s.nextPressed = pressedAny(dev, sc.next);
  s.tabNextPressed = pressedAny(dev, sc.tabNext);
  s.tabPrevPressed = false;
  s.upPressed = pressedAny(dev, sc.menuUp);
  s.downPressed = pressedAny(dev, sc.menuDown);
  s.anyPressed = dev.pressed.size > 0;

  prev.confirm = heldAny(dev, sc.confirm);
  prev.cancel = heldAny(dev, sc.cancel);
  prev.start = heldAny(dev, sc.start);
  prev.prev = heldAny(dev, sc.prev);
  prev.next = heldAny(dev, sc.next);
  prev.up = heldAny(dev, sc.menuUp);
  prev.down = heldAny(dev, sc.menuDown);

  dev.pressed.clear();

  if (dev.suppressEdges) {
    clearEdges(s);
    dev.suppressEdges = false;
  }
}

function clearEdges(s) {
  s.firePressed = false;
  s.confirmPressed = false;
  s.cancelPressed = false;
  s.prevPressed = false;
  s.nextPressed = false;
  s.startPressed = false;
  s.upPressed = false;
  s.downPressed = false;
  s.anyPressed = false;
}

/**
 * Sync the device registry with the browser's gamepad list and update every
 * device state. Called from `poll()` only.
 */
function refreshGamepads() {
  const pads = getPads();
  const seen = new Set();

  for (let i = 0; i < pads.length; i++) {
    const pad = pads[i];
    if (!pad) continue;                      // holes are normal in this array
    if (pad.connected === false) continue;
    const dev = ensureGamepadDevice(pad);
    if (!dev) continue;
    seen.add(dev.id);
    updateGamepadDevice(dev, pad);
  }

  // Anything we did not see this frame is gone: neutralize it.
  for (const dev of devices.values()) {
    if (dev.kind !== 'gamepad' || seen.has(dev.id)) continue;
    if (dev.connected) {
      dev.connected = false;
      resetDevice(dev);
    }
  }
}

/* ------------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------------ */

export const Input = {
  /** Install event handlers. Safe to call more than once. */
  init() {
    ensureKeyboardDevices();
    if (initialized) return;
    initialized = true;
    if (typeof window === 'undefined') return;

    window.addEventListener('gamepadconnected', onGamepadConnected);
    window.addEventListener('gamepaddisconnected', onGamepadDisconnected);
    window.addEventListener('keydown', onKeyDown, { passive: false });
    window.addEventListener('keyup', onKeyUp, { passive: false });
    window.addEventListener('blur', onBlur);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }
  },

  /**
   * Refresh every device state. Must be called exactly once per frame, before
   * the simulation steps. Calling it twice inside the same frame is a no-op,
   * so edges are never duplicated.
   */
  poll() {
    if (!initialized) this.init();
    const t = nowMs();
    if (t - lastPollTime < POLL_BUCKET_MS) return;
    lastPollTime = t;

    refreshGamepads();
    for (let i = 0; i < keyboardDevices.length; i++) {
      updateKeyboardDevice(keyboardDevices[i]);
    }
    for (let i = 0; i < remoteDevices.length; i++) {
      updateRemoteDevice(remoteDevices[i]);
    }

    // A helyi gombélek gyűjtése a hálózati küldéshez. Csak a SAJÁT
    // eszközöket nézzük — a távoliak élei már átjöttek a hálózaton.
    for (const dev of devices.values()) {
      if (dev.kind === 'remote' || !dev.connected) continue;
      accumulateLocalEdges(dev.state);
    }
  },

  /**
   * Távoli (hálózaton lévő) játékos felvétele eszközként.
   *
   * Így a lobbi és a meccs egyetlen sornyi külön ág nélkül kezeli: számukra
   * ez ugyanolyan eszköz, mint egy kontroller. A távoli fél csak a NYOMVA
   * TARTOTT állapotot küldi; az éleket itt, helyben számoljuk ki, mert egy
   * hálózaton átküldött "épp most nyomta meg" él elveszhet vagy duplázódhat.
   *
   * @param {string} id egyedi eszköz-azonosító (pl. `net-ab12`)
   * @param {string} label a lobbiban megjelenő név
   */
  addRemoteDevice(id, label) {
    if (!id || devices.has(id)) return;
    const dev = makeDeviceRecord(id, 'remote', label || 'Távoli játékos');
    dev.connected = true;
    dev.remote = {
      moveX: 0, moveY: 0, moveMag: 0, aimX: 0, aimY: 0, aimMag: 0,
      fire: 0, fireHeld: false, fresh: 0, edges: makeRemoteEdges(),
    };
    devices.set(id, dev);
    remoteDevices.push(dev);
  },

  /**
   * A távoli fél legfrissebb, nyomva tartott állapota.
   * @param {string} id
   * @param {object} payload `serializeLocalInput()` kimenete
   */
  setRemoteState(id, payload) {
    const dev = devices.get(id);
    if (!dev || dev.kind !== 'remote' || !payload) return;
    const r = dev.remote;
    r.moveX = Number.isFinite(payload.mx) ? payload.mx : 0;
    r.moveY = Number.isFinite(payload.my) ? payload.my : 0;
    r.moveMag = clamp01(payload.mm);
    r.aimX = Number.isFinite(payload.ax) ? payload.ax : 0;
    r.aimY = Number.isFinite(payload.ay) ? payload.ay : 0;
    r.aimMag = clamp01(payload.am);
    r.fire = clamp01(payload.f);
    r.fireHeld = !!payload.fh;
    // Az élek GYŰLNEK a következő pollig: két csomag is érkezhet egy poll
    // közé, és egyik gombnyomás sem veszhet el.
    const e = payload.e || {};
    const q = r.edges;
    for (const k of REMOTE_EDGE_KEYS) if (e[k]) q[k] = true;
    r.fresh = nowMs();
  },

  /** @param {string} id */
  removeRemoteDevice(id) {
    const dev = devices.get(id);
    if (!dev || dev.kind !== 'remote') return;
    devices.delete(id);
    const i = remoteDevices.indexOf(dev);
    if (i >= 0) remoteDevices.splice(i, 1);
  },

  /**
   * A SAJÁT eszközök állapota hálózatra csomagolva.
   *
   * Az analóg részt a legaktívabb helyi eszközről vesszük (így a távoli
   * játékos nincs egyetlen konkrét kontrollerhez kötve), a GOMBÉLEKET viszont
   * az utolsó küldés óta gyűjtjük össze. Egy él pontosan egy pollig él, tehát
   * ha csak a pillanatnyi állapotot küldenénk, két küldés közé eső gombnyomás
   * nyomtalanul elveszne — pont a lobbiban, ahol minden gombnyomás számít.
   *
   * A hívás ÜRÍTI a gyűjtőt, tehát küldésenként egyszer hívd.
   * @returns {object|null}
   */
  serializeLocalInput() {
    if (!initialized) this.init();
    let dev = null;
    for (const d of orderedDevices()) {
      if (d.kind === 'remote' || !d.connected) continue;
      const s = d.state;
      if (s.moveMag > 0 || s.aimMag > 0 || s.fireHeld) { dev = d; break; }
      if (!dev) dev = d;
    }
    if (!dev) return null;

    const s = dev.state;
    const e = localEdges;
    const packet = {
      mx: s.moveX, my: s.moveY, mm: s.moveMag,
      ax: s.aimX, ay: s.aimY, am: s.aimMag,
      f: s.fire, fh: !!s.fireHeld,
      e: {
        fire: e.fire, confirm: e.confirm, cancel: e.cancel, start: e.start,
        prev: e.prev, next: e.next, up: e.up, down: e.down,
        tabPrev: e.tabPrev, tabNext: e.tabNext,
      },
    };
    clearLocalEdges();
    return packet;
  },

  /**
   * Throws away the button EDGES of the current frame on every device (the
   * held/analog values are untouched) and suppresses the edges of the next
   * `poll()` as well.
   *
   * Needed when a key press is consumed by something outside the game loop —
   * the opening overlay is dismissed by any key, and that very same `Enter` /
   * `Space` would otherwise ALSO seat `kb-0` in a lobby slot.
   */
  consumeEdges() {
    for (const dev of devices.values()) {
      clearEdges(dev.state);
      if (dev.pressed) dev.pressed.clear();
      // The next poll must not re-create the edge for a key that is still down.
      dev.suppressEdges = true;
    }
  },

  /**
   * @returns {Array<{id:string, kind:'gamepad'|'keyboard', label:string, connected:boolean}>}
   * Gamepads first, then the two always-present keyboard devices. A gamepad
   * that was unplugged stays in the list with `connected: false`.
   */
  listDevices() {
    ensureKeyboardDevices();
    return orderedDevices().map((dev) => ({
      id: dev.id,
      kind: dev.kind,
      label: dev.label,
      connected: dev.connected,
    }));
  },

  /**
   * Él-e még az eszköz. A meccs ezzel veszi észre, ha egy kontroller
   * elaludt vagy lecsatlakozott — a billentyűzet mindig csatlakoztatott.
   * @param {string} deviceId
   * @returns {boolean}
   */
  isConnected(deviceId) {
    const dev = devices.get(deviceId);
    return !!(dev && dev.connected);
  },

  /**
   * @param {string} deviceId
   * @returns {object} the live InputState of the device, or a fresh neutral
   * state for unknown / disconnected ids.
   */
  getState(deviceId) {
    const dev = devices.get(deviceId);
    if (!dev || !dev.connected) return makeState();
    return dev.state;
  },

  /**
   * First device that pressed confirm (Cross / Enter) or the fire trigger
   * (R2 / Space) on THIS frame.
   * @param {Set<string>|Array<string>} [excludeIds] devices already taken.
   * @returns {string|null}
   */
  anyDevicePressingConfirm(excludeIds) {
    let excluded = null;
    if (excludeIds instanceof Set) excluded = excludeIds;
    else if (Array.isArray(excludeIds)) excluded = new Set(excludeIds);

    const list = orderedDevices();
    for (let i = 0; i < list.length; i++) {
      const dev = list[i];
      if (!dev.connected) continue;
      if (excluded && excluded.has(dev.id)) continue;
      const s = dev.state;
      if (s.confirmPressed || s.firePressed) return dev.id;
    }
    return null;
  },

  /** @returns {boolean} true if at least one gamepad is currently connected. */
  hasGamepads() {
    for (const dev of devices.values()) {
      if (dev.kind === 'gamepad' && dev.connected) return true;
    }
    return false;
  },

  /**
   * Whether the browser exposes the Gamepad API at all, and if not, why.
   * See `gamepadAvailability()` — `'insecure'` means the page is served over
   * plain http:// and only HTTPS (or localhost) will bring controllers back.
   * @returns {'ok'|'insecure'|'unsupported'}
   */
  gamepadSupport() {
    return gamepadAvailability();
  },

  /**
   * Best-effort haptics. Silently does nothing when the device has no
   * vibration actuator (keyboards, Safari, Firefox without haptics).
   * @param {string} deviceId
   * @param {number} strong 0..1 low frequency motor
   * @param {number} weak 0..1 high frequency motor
   * @param {number} durationMs
   */
  rumble(deviceId, strong = 0.6, weak = 0.3, durationMs = 120) {
    const dev = devices.get(deviceId);
    if (!dev || dev.kind !== 'gamepad' || !dev.connected) return;

    const pad = getPadByIndex(dev.padIndex);
    if (!pad) return;

    const strongMagnitude = clamp01(strong);
    const weakMagnitude = clamp01(weak);
    let duration = Number.isFinite(durationMs) ? durationMs : 120;
    if (duration < 0) duration = 0;
    if (duration > 5000) duration = 5000;

    try {
      const actuator = pad.vibrationActuator;
      if (actuator && typeof actuator.playEffect === 'function') {
        const result = actuator.playEffect('dual-rumble', {
          startDelay: 0,
          duration,
          strongMagnitude,
          weakMagnitude,
        });
        // The promise rejects on some drivers - swallow it.
        if (result && typeof result.catch === 'function') result.catch(() => {});
        return;
      }
      // Legacy Firefox style haptics.
      const legacy = pad.hapticActuators && pad.hapticActuators[0];
      if (legacy && typeof legacy.pulse === 'function') {
        const result = legacy.pulse(Math.max(strongMagnitude, weakMagnitude), duration);
        if (result && typeof result.catch === 'function') result.catch(() => {});
      }
    } catch (err) {
      // Haptics are a luxury: never let them break a frame.
    }
  },
};
