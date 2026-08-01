/**
 * Slag — the lobby: joining, colours and match settings.
 *
 * `Lobby` is a pure state machine over the input devices; it draws nothing.
 * `render.js` reads `slots`, `settingRows`, `devices` and `texts` and paints
 * them, `main.js` polls `started` and hands `playersForGame()` to the `Game`.
 *
 * FOCUS MODEL (the spec offers two options, this is the chosen one)
 * Left/right would collide between the colour picker and the shared settings,
 * so every player has a vertical FOCUS instead:
 *
 *     row 0 : own colour       (D-pad left/right cycles the colour)
 *     row 1 : Pattogó lövedék  (shared)
 *     row 2 : Pálya            (shared)
 *     row 3 : Cél              (shared)
 *
 * D-pad up/down moves that focus, left/right changes the value of the focused
 * row. Rows 1-3 are shared: whoever changes them changes them for everybody.
 *
 * INPUT IS CONSUMED PER FRAME, NOT PER STEP
 * `consumeInput()` reads every button edge and `update(dt)` only advances the
 * timers and the animations. The main loop calls `consumeInput()` exactly once
 * per rendered frame, outside its fixed-step accumulator, because above 120 Hz
 * a frame regularly runs ZERO steps — reading edges from inside the step loop
 * dropped ~17% of the presses at 144 Hz and ~50% at 240 Hz.
 *
 * `update(dt)` still falls back to reading the input itself as long as nobody
 * ever called `consumeInput()`, so the plain "just call update" contract of the
 * spec keeps working for other embedders.
 *
 * EDGE LATCHING
 * Every button is additionally latched per device (`_readEdges`), so even a
 * caller that reads the input several times for the same poll turns one
 * physical press into exactly one action.
 */

import { CONFIG, PALETTE } from './config.js';
import { clamp } from './util.js';
import { ARENAS } from './arena.js';
import { Audio } from './audio.js';
import { Input } from './input.js';
import { BOT_LEVELS, botLevel, botName } from './ai.js';

/** Focus row of the player's own colour. */
const ROW_COLOR = 0;

/** The shared setting rows, in focus order. */
const SETTING_ROWS = [
  { key: 'bots', label: 'Gépi ellenfelek' },
  { key: 'botLevel', label: 'Gép szintje' },
  { key: 'bounce', label: 'Pattogó lövedék' },
  { key: 'arena', label: 'Pálya' },
  { key: 'points', label: 'Cél' },
];

/** Total number of focusable rows: the colour row plus the shared settings. */
const ROW_COUNT = 1 + SETTING_ROWS.length;

/** Score limit range offered in the lobby. */
const MIN_POINTS = 5;
const MAX_POINTS = 30;
const POINTS_STEP = 5;

/** Minimum number of ready players before the match can start. */
const MIN_PLAYERS = 2;

/** Input is ignored for this long after the lobby (re)opens, in seconds. */
const REOPEN_INPUT_BLOCK = 0.45;

/**
 * A slot whose device has been gone for this long is released. Without it a
 * controller that runs out of battery locks its seat forever: a dead device
 * reports a neutral state, so its `Kör` (leave) edge can never arrive.
 */
const DEVICE_LOST_RELEASE = 6.0;

/** Every user visible string of the lobby, in Hungarian. */
const TEXTS = Object.freeze({
  title: 'SLAG',
  subtitle: 'Négyfős tankcsata egy képernyőn',
  emptySlot: 'Nyomj R2-t a csatlakozáshoz',
  emptySlotKeyboard: 'vagy Entert / Szóközt a billentyűzeten',
  joined: 'Csatlakozva',
  ready: 'Kész!',
  notReady: 'Nyomd meg a Keresztet, ha kész vagy',
  controlsHint: 'Kereszt: kész • Kör: kilépés • D-pad fel/le: sor • bal/jobb: érték',
  /** Per device "what do I press now" hint, keyed by device id (`*` = gamepad). */
  slotHint: Object.freeze({
    '*': 'Kereszt — kész   ·   Kör — kilépés',
    'kb-0': 'Enter — kész   ·   Esc — kilépés   ·   Q / E — szín',
    'kb-1': 'Numpad Enter — kész   ·   Numpad . — kilépés   ·   U / O — szín',
  }),
  settingsTitle: 'Beállítások',
  startHint: 'Options / Enter: indítás',
  waitHint: 'Legalább két kész játékos kell az indításhoz',
  noGamepad: 'Nyomj meg egy gombot a kontrolleren…',
  noGamepadHelp: 'A böngésző csak az első gombnyomás után látja a kontrollereket.',
  keyboardTitle: 'Billentyűzet is játszik:',
  keyboard: Object.freeze([
    '1. billentyűzet — mozgás: W A S D, célzás: nyilak, tűz: Szóköz, OK: Enter, szín: Q / E',
    '2. billentyűzet — mozgás: I J K L, célzás: Numpad 8/4/5/6, tűz: Numpad 0, OK: Numpad Enter, szín: U / O',
  ]),
  deviceLost: 'Kontroller lecsatlakozott',
  on: 'BE',
  off: 'KI',
  randomArena: 'Véletlen',
  pointsSuffix: ' pont',
});

/** Arena choices shown on the `Pálya` row: every arena plus `Véletlen`. */
const ARENA_OPTIONS = ARENAS.map((a) => ({ id: a.id, name: a.name }))
  .concat([{ id: 'random', name: TEXTS.randomArena }]);

/** Rounds a score limit onto the 5 point grid and clamps it into range. */
function normalizePoints(value) {
  const raw = Number.isFinite(value) ? value : CONFIG.match.pointsToWin;
  const snapped = Math.round(raw / POINTS_STEP) * POINTS_STEP;
  return clamp(snapped, MIN_POINTS, MAX_POINTS);
}

/**
 * The pre-match screen.
 *
 * @example
 *   const lobby = new Lobby();
 *   lobby.update(1 / 120);
 *   if (lobby.started) new Game(lobby.playersForGame(), lobby.settings);
 */
export class Lobby {
  constructor() {
    /** @type {Array<object|null>} exactly `CONFIG.match.maxPlayers` entries. */
    this._slots = new Array(CONFIG.match.maxPlayers).fill(null);

    /** @type {{bounce:boolean, arenaId:string, pointsToWin:number}} */
    this._settings = {
      bounce: true,
      arenaId: 'random',
      pointsToWin: normalizePoints(CONFIG.match.pointsToWin),
      /** Hány gépi ellenfél üljön be a szabad helyekre (0..maxPlayers-1). */
      bots: 0,
      /** A gépi ellenfelek szintje, lásd `BOT_LEVELS`. */
      botLevelId: 'normal',
    };

    this._started = false;
    this._inputBlock = REOPEN_INPUT_BLOCK;

    /**
     * Set once `consumeInput()` has been called from the outside. From then on
     * `update()` never reads the input itself, so the frame-synchronous path is
     * the only one and a press cannot be handled twice.
     */
    this._externalConsume = false;

    /** @type {Map<string, object>} per device button latches, see `_readEdges`. */
    this._latches = new Map();

    /** @type {Array<{id:string, kind:string, label:string, connected:boolean}>} */
    this._devices = [];
    this._hasGamepads = false;

    /** Seconds since the lobby opened — the renderer animates with it. */
    this.time = 0;
  }

  // ---------------------------------------------------------------------------
  // Public surface
  // ---------------------------------------------------------------------------

  /**
   * Live slot array (length 4). A slot is `null` when nobody occupies it,
   * otherwise a PlayerSlot enriched with lobby-only fields:
   * `color`, `ready`, `focus`, `deviceLabel`, `deviceLost`, `lostT`, `joinT`.
   * @returns {Array<object|null>}
   */
  get slots() {
    return this._slots;
  }

  /** @returns {{bounce:boolean, arenaId:string, pointsToWin:number}} */
  get settings() {
    return this._settings;
  }

  /**
   * @returns {boolean} at least two READY players (the spec's ">=2 kész slot").
   * A joined but not-ready seat does not block the match: it is simply left out
   * by `playersForGame()`. Requiring everybody to be ready meant that a single
   * stray `Space` — which seats `kb-0` — froze the lobby for everyone else.
   */
  get canStart() {
    // Legalább egy EMBER kell: négy bot egymás elleni meccse nem játék.
    // A botok viszont teljes értékű résztvevők, így egy kontrollerrel is
    // el lehet indítani egy meccset.
    return this.readyHumans >= 1 && this.readyCount >= MIN_PLAYERS;
  }

  /** @returns {number} kész, élő kontrollerrel rendelkező EMBERI játékosok. */
  get readyHumans() {
    let n = 0;
    for (let i = 0; i < this._slots.length; i++) {
      const slot = this._slots[i];
      if (slot && !slot.isBot && slot.ready && !slot.deviceLost) n += 1;
    }
    return n;
  }

  /** @returns {number} occupied slots whose device is alive and marked ready. */
  get readyCount() {
    let n = 0;
    for (let i = 0; i < this._slots.length; i++) {
      const slot = this._slots[i];
      if (slot && slot.ready && !slot.deviceLost) n += 1;
    }
    return n;
  }

  /**
   * @returns {Array<object>} occupied slots that are NOT ready yet — the
   * renderer names them, so nobody has to guess who is holding up the match.
   */
  get pendingSlots() {
    const out = [];
    for (let i = 0; i < this._slots.length; i++) {
      const slot = this._slots[i];
      if (slot && !slot.ready) out.push(slot);
    }
    return out;
  }

  /** @returns {boolean} true once somebody pressed Options / Enter to start. */
  get started() {
    return this._started;
  }

  /** @returns {number} how many slots are occupied. */
  get playerCount() {
    let n = 0;
    for (let i = 0; i < this._slots.length; i++) if (this._slots[i]) n += 1;
    return n;
  }

  /** @returns {Array<object>} the device list of the last `update()`. */
  get devices() {
    return this._devices;
  }

  /** @returns {boolean} false while the browser reports no gamepad at all. */
  get hasGamepads() {
    return this._hasGamepads;
  }

  /**
   * `'ok'` | `'insecure'` | `'unsupported'` — why no controller shows up.
   * `'insecure'` is the one the host can fix (serve over HTTPS); the lobby
   * renders it as a warning instead of the usual "press a button" nudge.
   * @returns {string}
   */
  get gamepadSupport() {
    return typeof Input.gamepadSupport === 'function' ? Input.gamepadSupport() : 'ok';
  }

  /** @returns {object} every Hungarian UI string the lobby needs. */
  get texts() {
    return TEXTS;
  }

  /** @returns {number} number of focusable rows (colour + shared settings). */
  get rowCount() {
    return ROW_COUNT;
  }

  /**
   * The shared settings bar, ready to be drawn.
   * @returns {Array<{key:string, label:string, value:string, row:number}>}
   */
  get settingRows() {
    return SETTING_ROWS.map((row, i) => ({
      key: row.key,
      label: row.label,
      value: this._settingValueText(row.key),
      row: i + 1,
    }));
  }

  /**
   * The player slots that will take part in the match, re-indexed to a dense
   * 0..n-1 range. The displayed name is kept, so "3. játékos" stays the third
   * player even if slots 1 and 2 are empty.
   * @returns {Array<{index:number, deviceId:string, colorId:string, name:string}>}
   */
  playersForGame() {
    const out = [];
    for (let i = 0; i < this._slots.length; i++) {
      const slot = this._slots[i];
      // A ready player whose controller died in the meantime would be an
      // unmovable tank on the field: leave them out too.
      if (!slot || !slot.ready || slot.deviceLost) continue;
      out.push({
        index: out.length,
        deviceId: slot.deviceId,
        colorId: slot.colorId,
        name: slot.name,
        isBot: !!slot.isBot,
        botLevel: slot.isBot ? slot.botLevelId : null,
      });
    }
    return out;
  }

  /**
   * Reopens the lobby after a match without losing the players: everybody
   * stays joined and ready, and input is ignored for a short moment so the
   * button press that closed the end screen does not start the next match.
   */
  reset() {
    this._started = false;
    this._inputBlock = REOPEN_INPUT_BLOCK;
    this.time = 0;
  }

  // ---------------------------------------------------------------------------
  // Update
  // ---------------------------------------------------------------------------

  /**
   * Reads and acts on every button edge — join, colour, settings, ready, leave
   * and start. MUST be called exactly once per rendered frame, from outside the
   * fixed-step loop, otherwise presses are lost on the zero-step frames that
   * every refresh rate above 120 Hz produces.
   */
  consumeInput() {
    this._externalConsume = true;
    this._readInput();
  }

  /**
   * One simulation step of the lobby: timers and animations only. Input is
   * handled by `consumeInput()` — unless nobody ever called it, in which case
   * this keeps the simpler "just call update(dt)" contract alive.
   * @param {number} dt seconds
   */
  update(dt) {
    const step = dt > 0 ? dt : 0;
    this.time += step;

    if (this._inputBlock > 0) this._inputBlock -= step;

    this._advanceSlots(step);

    if (!this._externalConsume) this._readInput();

    // A botok a beállításokból következnek, nem külön csatlakoznak: minden
    // lépésben újraegyeztetjük őket az emberi játékosokkal.
    this._syncBots();
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /** The actual input pass, shared by `consumeInput()` and the fallback. @private */
  _readInput() {
    this._devices = Input.listDevices();
    this._hasGamepads = Input.hasGamepads();

    // Latch every device, even while input is blocked: a button already held
    // down must not fire the instant the block expires.
    const edges = new Map();
    for (let i = 0; i < this._devices.length; i++) {
      const device = this._devices[i];
      edges.set(device.id, this._readEdges(device.id));
    }

    this._refreshPresence();

    if (this._inputBlock > 0 || this._started) return;

    // Devices whose confirm edge was already spent on "ready" or on joining, so
    // `_handleStart` must not spend it a second time. On the keyboard `Enter`
    // is bound to BOTH confirm and start: without this the very press that
    // marks the last player ready also starts the match, and nobody ever gets
    // to see the start prompt, change a colour or take their ready back.
    const spentConfirm = new Set();

    // 1. Players already in a slot: focus, colour, settings, ready, leave.
    for (let i = 0; i < this._slots.length; i++) {
      const slot = this._slots[i];
      if (!slot) continue;
      // A gépi ellenfél nem nyomkod semmit: nincs eszköze, amiről olvasni
      // lehetne, és a színét / készenlétét sem ő állítja.
      if (slot.isBot) continue;
      const edge = edges.get(slot.deviceId) || this._readEdges(slot.deviceId);

      if (edge.confirm && edge.start) {
        // One key, two meanings (keyboard `Enter`). One press is one action:
        // "ready" while there is still something to get ready for, "start" once
        // this player is ready and the lobby can actually start. Taking the
        // ready back stays possible with Kör / Esc.
        if (slot.ready && this.canStart) edge.confirm = false;
        else spentConfirm.add(slot.deviceId);
      } else if (edge.confirm) {
        spentConfirm.add(slot.deviceId);
      }

      this._handleSlot(slot, i, edge);
    }

    // 2. Free devices pressing confirm / fire join an empty slot.
    this._handleJoins(edges, spentConfirm);

    // 3. Options / Enter from any joined player starts the match.
    this._handleStart(edges, spentConfirm);
  }

  /**
   * Advances the per-slot timers: join animation and the grace period a slot
   * gets before a dead controller loses its seat.
   * @private
   */
  _advanceSlots(dt) {
    for (let i = 0; i < this._slots.length; i++) {
      const slot = this._slots[i];
      if (!slot) continue;
      slot.joinT = Math.min(1, slot.joinT + dt * 4);

      if (!slot.deviceLost) {
        slot.lostT = 0;
        continue;
      }
      slot.lostT += dt;
      if (slot.lostT >= DEVICE_LOST_RELEASE) {
        // Nothing can arrive from a disconnected device, so free the seat
        // instead of blocking the lobby until the page is reloaded.
        this._slots[i] = null;
        Audio.play('colorChange', { volume: 0.8, rate: 0.6 });
      }
    }
  }

  /** Marks slots whose device vanished (unplugged, flat battery). @private */
  _refreshPresence() {
    for (let i = 0; i < this._slots.length; i++) {
      const slot = this._slots[i];
      if (!slot) continue;
      // A bot mögött nincs eszköz: soha nem "veszíti el a kontrollerét".
      if (slot.isBot) continue;
      const device = this._findDevice(slot.deviceId);
      slot.deviceLost = !device || !device.connected;
      slot.deviceLabel = device ? device.label : slot.deviceLabel;
    }
  }

  /**
   * Turns the already edge-detected input flags into "acted on exactly once"
   * edges, so a frame made of several fixed steps cannot double-trigger.
   * @private
   * @param {string} deviceId
   * @returns {{confirm:boolean, cancel:boolean, prev:boolean, next:boolean,
   *            up:boolean, down:boolean, start:boolean, fire:boolean}}
   */
  _readEdges(deviceId) {
    let latch = this._latches.get(deviceId);
    if (!latch) {
      latch = {
        confirm: false, cancel: false, prev: false, next: false,
        up: false, down: false, start: false, fire: false,
      };
      this._latches.set(deviceId, latch);
    }

    const state = Input.getState(deviceId);
    const out = {
      confirm: state.confirmPressed && !latch.confirm,
      cancel: state.cancelPressed && !latch.cancel,
      prev: state.prevPressed && !latch.prev,
      next: state.nextPressed && !latch.next,
      up: state.upPressed && !latch.up,
      down: state.downPressed && !latch.down,
      start: state.startPressed && !latch.start,
      fire: state.firePressed && !latch.fire,
    };

    latch.confirm = !!state.confirmPressed;
    latch.cancel = !!state.cancelPressed;
    latch.prev = !!state.prevPressed;
    latch.next = !!state.nextPressed;
    latch.up = !!state.upPressed;
    latch.down = !!state.downPressed;
    latch.start = !!state.startPressed;
    latch.fire = !!state.firePressed;

    return out;
  }

  /** Applies one player's input to their slot. @private */
  _handleSlot(slot, slotIndex, edge) {
    // Vertical focus: own colour row <-> shared setting rows.
    if (edge.up) this._moveFocus(slot, -1);
    if (edge.down) this._moveFocus(slot, 1);

    // Horizontal: the value of the focused row.
    if (edge.prev) this._applyRow(slot, -1);
    if (edge.next) this._applyRow(slot, 1);

    // Ready / not ready.
    if (edge.confirm) {
      slot.ready = !slot.ready;
      Audio.play('join', { volume: slot.ready ? 1 : 0.6, rate: slot.ready ? 1 : 0.8 });
      if (slot.ready) Input.rumble(slot.deviceId, 0.4, 0.3, 110);
    }

    // Circle steps back: first it cancels the ready state, then it leaves.
    if (edge.cancel) {
      if (slot.ready) {
        slot.ready = false;
        Audio.play('colorChange', { volume: 0.7, rate: 0.8 });
      } else {
        this._slots[slotIndex] = null;
        Audio.play('colorChange', { volume: 0.8, rate: 0.6 });
      }
    }
  }

  /** @private */
  _moveFocus(slot, dir) {
    slot.focus = (slot.focus + dir + ROW_COUNT) % ROW_COUNT;
    Audio.play('colorChange', { volume: 0.35, rate: 1.4 });
  }

  /** Changes the value of the row the player currently focuses. @private */
  _applyRow(slot, dir) {
    if (slot.focus === ROW_COLOR) {
      this._cycleColor(slot, dir);
      return;
    }
    const row = SETTING_ROWS[slot.focus - 1];
    if (row) this._adjustSetting(row.key, dir);
  }

  /**
   * Steps to the next free palette entry. Colours taken by another slot are
   * skipped, so two players can never look the same.
   * @private
   */
  _cycleColor(slot, dir) {
    const taken = new Set();
    for (let i = 0; i < this._slots.length; i++) {
      const other = this._slots[i];
      if (other && other !== slot) taken.add(other.colorId);
    }

    let index = PALETTE.findIndex((c) => c.id === slot.colorId);
    if (index < 0) index = 0;

    for (let step = 0; step < PALETTE.length; step++) {
      index = (index + dir + PALETTE.length) % PALETTE.length;
      const candidate = PALETTE[index];
      if (taken.has(candidate.id)) continue;
      slot.colorId = candidate.id;
      slot.color = candidate;
      Audio.play('colorChange');
      return;
    }
  }

  /**
   * Ember mindig előbbre való a gépnél: ha minden szék foglalt, a legnagyobb
   * indexű bot áll fel a csatlakozó játékos kedvéért.
   * @private
   * @returns {number} a felszabadított slot indexe, vagy -1
   */
  _evictBotSeat() {
    for (let i = this._slots.length - 1; i >= 0; i--) {
      const slot = this._slots[i];
      if (slot && slot.isBot) {
        this._slots[i] = null;
        return i;
      }
    }
    return -1;
  }

  /** @returns {number} emberi (nem gépi) játékosok által elfoglalt székek. */
  get humanCount() {
    let n = 0;
    for (let i = 0; i < this._slots.length; i++) {
      const slot = this._slots[i];
      if (slot && !slot.isBot) n += 1;
    }
    return n;
  }

  /**
   * Ténylegesen beülő botok száma. A kért érték sosem szoríthat ki embert:
   * ha négyen ülnek a gépnél, a beállítástól függetlenül nulla bot fér be.
   * @returns {number}
   */
  get botCount() {
    const free = CONFIG.match.maxPlayers - this.humanCount;
    return clamp(this._settings.bots, 0, Math.max(0, free));
  }

  /**
   * Beülteti / felállítja a botokat, hogy a szabad székeken pontosan
   * `botCount` gépi ellenfél legyen. A botok a HÁTSÓ székeket foglalják, így
   * egy csatlakozó ember mindig a kisebb indexű helyre kerül.
   * @private
   */
  _syncBots() {
    const slots = this._slots;
    const want = this.botCount;
    const levelId = this._settings.botLevelId;

    const seated = [];
    for (let i = 0; i < slots.length; i++) {
      if (slots[i] && slots[i].isBot) seated.push(i);
    }

    // Túl sok bot: hátulról állnak fel.
    while (seated.length > want) {
      slots[seated.pop()] = null;
    }

    // Túl kevés: a leghátsó szabad székre ülnek be.
    while (seated.length < want) {
      let free = -1;
      for (let i = slots.length - 1; i >= 0; i--) {
        if (!slots[i]) { free = i; break; }
      }
      if (free < 0) break;
      slots[free] = this._makeBotSlot(free);
      seated.push(free);
    }

    // A szint a közös beállításból jön, futás közben is átállítható.
    for (let i = 0; i < seated.length; i++) {
      const slot = slots[seated[i]];
      if (!slot) continue;
      slot.botLevelId = levelId;
      slot.deviceLabel = botLevel(levelId).name;
    }
  }

  /** @private */
  _makeBotSlot(index) {
    const color = this._firstFreeColor();
    return {
      // --- PlayerSlot contract ---
      index,
      deviceId: null,
      colorId: color.id,
      name: botName(index),
      // --- lobby only ---
      color,
      // A gép nem nyomkod Keresztet: mindig kész.
      ready: true,
      focus: ROW_COLOR,
      deviceLabel: botLevel(this._settings.botLevelId).name,
      deviceLost: false,
      lostT: 0,
      joinT: 0,
      // --- bot only ---
      isBot: true,
      botLevelId: this._settings.botLevelId,
    };
  }

  /** @private */
  _adjustSetting(key, dir) {
    const settings = this._settings;

    if (key === 'bots') {
      const max = CONFIG.match.maxPlayers - 1;
      settings.bots = clamp(settings.bots + dir, 0, max);
    } else if (key === 'botLevel') {
      let index = BOT_LEVELS.findIndex((l) => l.id === settings.botLevelId);
      if (index < 0) index = 1;
      index = (index + dir + BOT_LEVELS.length) % BOT_LEVELS.length;
      settings.botLevelId = BOT_LEVELS[index].id;
    } else if (key === 'bounce') {
      settings.bounce = !settings.bounce;
    } else if (key === 'arena') {
      let index = ARENA_OPTIONS.findIndex((o) => o.id === settings.arenaId);
      if (index < 0) index = ARENA_OPTIONS.length - 1;
      index = (index + dir + ARENA_OPTIONS.length) % ARENA_OPTIONS.length;
      settings.arenaId = ARENA_OPTIONS[index].id;
    } else if (key === 'points') {
      settings.pointsToWin = normalizePoints(settings.pointsToWin + dir * POINTS_STEP);
    } else {
      return;
    }

    Audio.play('colorChange', { volume: 0.8, rate: 1.15 });
  }

  /** Human readable value of a shared setting row. @private */
  _settingValueText(key) {
    const settings = this._settings;
    if (key === 'bots') {
      if (settings.bots <= 0) return TEXTS.off;
      // A kért és a ténylegesen beférő szám eltérhet, ha sokan ülnek a gépnél
      // — ilyenkor az igazat mutatjuk, nem a kívánságot.
      const actual = this.botCount;
      return actual === settings.bots ? `${actual}` : `${actual} (${settings.bots} kérve)`;
    }
    if (key === 'botLevel') return botLevel(settings.botLevelId).name;
    if (key === 'bounce') return settings.bounce ? TEXTS.on : TEXTS.off;
    if (key === 'arena') {
      const option = ARENA_OPTIONS.find((o) => o.id === settings.arenaId);
      return option ? option.name : TEXTS.randomArena;
    }
    if (key === 'points') return `${settings.pointsToWin}${TEXTS.pointsSuffix}`;
    return '';
  }

  /**
   * Every connected device that is not bound to a slot yet and pressed
   * confirm (Cross / Enter) or the trigger (R2 / Space) takes the first free
   * slot. Several players can join within the same step.
   * @private
   */
  _handleJoins(edges, spentConfirm) {
    for (let i = 0; i < this._devices.length; i++) {
      const device = this._devices[i];
      if (!device.connected) continue;
      if (this._slotOf(device.id)) continue;

      const edge = edges.get(device.id);
      if (!edge || !(edge.confirm || edge.fire)) continue;
      // `Enter` joins AND starts on the keyboard: the press that seats a player
      // must not also start the match behind their back.
      if (edge.confirm && spentConfirm) spentConfirm.add(device.id);
      this._join(device);
    }
  }

  /** @private */
  _join(device) {
    let slotIndex = this._slots.indexOf(null);
    if (slotIndex < 0) slotIndex = this._evictBotSeat();
    if (slotIndex < 0) return; // all four seats are taken by humans

    const color = this._firstFreeColor();
    this._slots[slotIndex] = {
      // --- PlayerSlot contract ---
      index: slotIndex,
      deviceId: device.id,
      colorId: color.id,
      name: `${slotIndex + 1}. játékos`,
      // --- lobby only ---
      color,
      ready: false,
      focus: ROW_COLOR,
      deviceLabel: device.label,
      deviceLost: false,
      lostT: 0,
      joinT: 0,
    };

    Audio.play('join');
    Input.rumble(device.id, 0.5, 0.4, 150);
  }

  /** @private @returns {object} the first palette entry nobody uses. */
  _firstFreeColor() {
    const taken = new Set();
    for (let i = 0; i < this._slots.length; i++) {
      const slot = this._slots[i];
      if (slot) taken.add(slot.colorId);
    }
    return PALETTE.find((c) => !taken.has(c.id)) || PALETTE[0];
  }

  /** @private */
  _handleStart(edges, spentConfirm) {
    if (!this.canStart) return;
    for (let i = 0; i < this._slots.length; i++) {
      const slot = this._slots[i];
      if (!slot || slot.isBot) continue;
      const edge = edges.get(slot.deviceId);
      if (!edge || !edge.start) continue;
      // Same physical key as confirm on the keyboard — already used up.
      if (spentConfirm && spentConfirm.has(slot.deviceId)) continue;
      this._started = true;
      Audio.play('countdown', { volume: 1.1 });
      return;
    }
  }

  /** @private @returns {object|null} the slot bound to a device, if any. */
  _slotOf(deviceId) {
    for (let i = 0; i < this._slots.length; i++) {
      const slot = this._slots[i];
      if (slot && slot.deviceId === deviceId) return slot;
    }
    return null;
  }

  /** @private */
  _findDevice(deviceId) {
    for (let i = 0; i < this._devices.length; i++) {
      if (this._devices[i].id === deviceId) return this._devices[i];
    }
    return null;
  }
}
