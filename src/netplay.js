/**
 * Slag — online szoba: gazda és vendég.
 *
 * MODELL (szándékosan a legegyszerűbb, ami helyes)
 * A GAZDA gépén fut a lobbi és a szimuláció, pontosan úgy, mint offline. A
 * vendégek nem szimulálnak semmit: elküldik az inputjukat, és kirajzolják a
 * gazdától kapott pillanatképet. Így nincs kétféle igazság, nem tud
 * szétcsúszni a két gép állapota, és nem kell visszagörgetéses netcode.
 *
 * Ára: a vendég a saját mozgását is csak a kör megtétele után látja, tehát
 * a késleltetés érezhető. Cserébe mindig azt látja, ami tényleg történik.
 *
 * A vendég inputja EGYSZERŰEN egy eszköz a gazdánál (`Input.addRemoteDevice`),
 * így a lobbi és a meccs egyetlen külön ág nélkül kezeli: a vendég ugyanúgy
 * ül be egy helyre és nyom készre, mint aki ott ül a kanapén.
 */

import { Room, roomFromLink, defaultRelay } from './net.js';
import { Input } from './input.js';
import { buildArena } from './arena.js';
import { PALETTE, CONFIG } from './config.js';

/** Pillanatkép-küldés a meccs alatt / a lobbiban. */
const SNAP_HZ = 30;
const LOBBY_HZ = 12;
/** Input-küldés a vendégtől. */
const INPUT_HZ = 40;

/** Ennyi ideig tartunk életben egy vendéget, ha nem jön tőle input. */
const PEER_TIMEOUT_MS = 6000;

function colorOf(id) {
  for (let i = 0; i < PALETTE.length; i++) if (PALETTE[i].id === id) return PALETTE[i];
  return PALETTE[0];
}

/* ------------------------------------------------------------------------ *
 * Pillanatkép — sorosítás
 * ------------------------------------------------------------------------ */

function packLobby(lobby) {
  return {
    t: 'lobby',
    time: lobby.time,
    slots: lobby.slots.map((s) => (s ? {
      index: s.index, name: s.name, colorId: s.colorId, ready: !!s.ready,
      isBot: !!s.isBot, deviceLost: !!s.deviceLost, focus: s.focus,
      deviceLabel: s.deviceLabel, joinT: s.joinT, lostT: s.lostT,
      remote: typeof s.deviceId === 'string' && s.deviceId.startsWith('net-'),
    } : null)),
    rows: lobby.settingRows,
    settings: lobby.settings,
    canStart: lobby.canStart,
    readyCount: lobby.readyCount,
    readyHumans: lobby.readyHumans,
    humanCount: lobby.humanCount,
    botCount: lobby.botCount,
    hasGamepads: lobby.hasGamepads,
  };
}

function packGame(game) {
  const w = game.world;
  return {
    t: 'snap',
    st: game.state,
    cd: game.countdown,
    el: game.elapsed,
    arena: w.arena ? w.arena.id : null,
    pts: game.settings ? game.settings.pointsToWin : CONFIG.match.pointsToWin,
    bounce: game.settings ? game.settings.bounce !== false : true,
    win: game.winner ? game.winner.index : null,
    ce: !!game.canExit,
    pause: game.pause || null,
    fx: { sh: w.fx.shake, sx: w.fx.shakeX, sy: w.fx.shakeY, time: w.fx.time },
    tk: w.tanks.map((k) => ({
      i: k.index, n: k.name, c: k.colorId || (k.color && k.color.id),
      x: Math.round(k.x * 10) / 10, y: Math.round(k.y * 10) / 10,
      a: Math.round(k.angle * 1000) / 1000, ta: Math.round(k.turretAngle * 1000) / 1000,
      al: k.alive ? 1 : 0, sc: k.score, kl: k.kills, dt: k.deaths, og: k.ownGoals,
      iv: Math.round(k.invulnTimer * 100) / 100, hf: Math.round(k.hitFlash * 100) / 100,
      mf: Math.round(k.muzzleFlash * 100) / 100, tp: Math.round(k.trackPhase * 10) / 10,
      sh: k.shields, ra: k.rocketAmmo, pf: Math.round(k.pickupFlash * 100) / 100,
      rp: Math.round(k.respawnTimer * 100) / 100,
      pu: { rapid: Math.round(k.powerups.rapid * 100) / 100, speed: Math.round(k.powerups.speed * 100) / 100 },
    })),
    bl: w.bullets.map((b) => ({
      x: Math.round(b.x * 10) / 10, y: Math.round(b.y * 10) / 10,
      a: Math.round(b.angle * 1000) / 1000, o: b.ownerIndex,
      r: b.isRocket ? 1 : 0,
    })),
    pk: w.pickups.filter((p) => !p.dead).map((p) => ({
      x: Math.round(p.x), y: Math.round(p.y), d: p.defId, s: p.state,
      ft: Math.round(p.fallT * 100) / 100, b: Math.round(p.bob * 100) / 100,
      sp: Math.round(p.spin * 100) / 100,
    })),
  };
}

/* ------------------------------------------------------------------------ *
 * Vendégoldali nézet — annyit tud, amennyit a rajzoló kér
 * ------------------------------------------------------------------------ */

/** A gazdától kapott lobbi, `drawLobby()` által elvárt alakban. */
export class RemoteLobby {
  constructor() {
    this.time = 0;
    this._d = null;
  }

  apply(msg) { this._d = msg; }

  get slots() {
    const s = this._d ? this._d.slots : null;
    if (!s) return [null, null, null, null];
    return s.map((x) => (x ? { ...x, color: colorOf(x.colorId), deviceId: x.remote ? 'net' : 'local' } : null));
  }

  get settingRows() { return (this._d && this._d.rows) || []; }
  get settings() { return (this._d && this._d.settings) || {}; }
  get canStart() { return !!(this._d && this._d.canStart); }
  get readyCount() { return (this._d && this._d.readyCount) || 0; }
  get readyHumans() { return (this._d && this._d.readyHumans) || 0; }
  get humanCount() { return (this._d && this._d.humanCount) || 0; }
  get botCount() { return (this._d && this._d.botCount) || 0; }
  get hasGamepads() { return !!(this._d && this._d.hasGamepads); }
  get gamepadSupport() { return Input.gamepadSupport ? Input.gamepadSupport() : 'ok'; }
  get rowCount() { return 1 + this.settingRows.length; }

  get pendingSlots() {
    return this.slots.filter((s) => s && !s.ready && !s.isBot);
  }
}

/**
 * A gazdától kapott meccs, `drawGame()` által elvárt alakban.
 *
 * Két pillanatkép között lineárisan interpolálunk: 30 Hz-es csomagokból
 * enélkül látványosan lépkedne a kép.
 */
export class RemoteGame {
  constructor() {
    this.world = {
      arena: null, tanks: [], bullets: [], particles: [], pickups: [],
      settings: { bounce: true, pointsToWin: CONFIG.match.pointsToWin },
      fx: { shake: 0, shakeX: 0, shakeY: 0, time: 0 },
    };
    this.state = 'countdown';
    this.countdown = CONFIG.match.countdown;
    this.elapsed = 0;
    this.winner = null;
    this.pause = null;
    this.players = [];
    this._arenaId = null;
    this._prev = null;
    this._next = null;
    this._prevAt = 0;
    this._nextAt = 0;
    this._now = 0;
  }

  get canExit() { return !!(this._next && this._next.ce); }

  /** @param {object} msg a gazdától kapott `snap` */
  apply(msg, nowMs) {
    if (msg.arena !== null && msg.arena !== this._arenaId) {
      this._arenaId = msg.arena;
      this.world.arena = buildArena(msg.arena);
    }
    this._prev = this._next;
    this._prevAt = this._nextAt;
    this._next = msg;
    this._nextAt = nowMs;
    if (!this._prev) { this._prev = msg; this._prevAt = nowMs; }

    this.state = msg.st;
    this.countdown = msg.cd;
    this.elapsed = msg.el;
    this.pause = msg.pause;
    this.world.settings.bounce = msg.bounce;
    this.world.settings.pointsToWin = msg.pts;

    this.players = msg.tk.map((k) => ({
      index: k.i, name: k.n, colorId: k.c, color: colorOf(k.c), deviceId: null,
    }));
    this.winner = msg.win === null || msg.win === undefined
      ? null
      : this.players.find((p) => p.index === msg.win) || null;
  }

  /** Interpolált világ a rajzoláshoz. @param {number} nowMs */
  sample(nowMs) {
    this._now = nowMs;
    const a = this._prev;
    const b = this._next;
    if (!b) return this;

    const span = Math.max(1, this._nextAt - this._prevAt);
    // Kicsivel a legfrissebb csomag MÖGÖTT járunk, hogy legyen mit
    // interpolálni; enélkül minden csomagnál ugrana a kép.
    let f = (nowMs - this._nextAt) / span + 1;
    if (!(f > 0)) f = 0;
    if (f > 1.5) f = 1.5;

    const w = this.world;
    w.fx.shake = b.fx.sh; w.fx.shakeX = b.fx.sx; w.fx.shakeY = b.fx.sy;
    w.fx.time = b.fx.time;

    w.tanks = b.tk.map((k) => {
      const o = a && a.tk ? a.tk.find((p) => p.i === k.i) : null;
      const col = colorOf(k.c);
      return {
        index: k.i, name: k.n, colorId: k.c, color: col,
        radius: CONFIG.tank.radius,
        x: o ? o.x + (k.x - o.x) * f : k.x,
        y: o ? o.y + (k.y - o.y) * f : k.y,
        angle: o ? lerpAngle(o.a, k.a, f) : k.a,
        turretAngle: o ? lerpAngle(o.ta, k.ta, f) : k.ta,
        alive: k.al === 1,
        score: k.sc, kills: k.kl, deaths: k.dt, ownGoals: k.og,
        invulnTimer: k.iv, hitFlash: k.hf, muzzleFlash: k.mf, trackPhase: k.tp,
        shields: k.sh, rocketAmmo: k.ra, pickupFlash: k.pf, respawnTimer: k.rp,
        powerups: k.pu, deviceId: null,
      };
    });

    w.bullets = b.bl.map((p) => ({
      x: p.x, y: p.y, angle: p.a, ownerIndex: p.o, isRocket: p.r === 1,
      radius: p.r === 1 ? CONFIG.bullet.radius * 1.6 : CONFIG.bullet.radius,
      dead: false, trail: [],
    }));

    w.pickups = b.pk.map((p) => ({
      x: p.x, y: p.y, defId: p.d, state: p.s, fallT: p.ft,
      bob: p.b, spin: p.sp, dead: false, age: 0,
    }));

    return this;
  }

  scoreboard() {
    const rows = this.world.tanks.map((k) => ({
      index: k.index, color: k.color, name: k.name,
      score: k.score, kills: k.kills, deaths: k.deaths, ownGoals: k.ownGoals,
    }));
    rows.sort((x, y) => (y.score - x.score) || (y.kills - x.kills) || (x.deaths - y.deaths));
    return rows;
  }
}

function lerpAngle(a, b, f) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * f;
}

/* ------------------------------------------------------------------------ *
 * Vezérlő
 * ------------------------------------------------------------------------ */

export const NetPlay = {
  /** @type {'off'|'host'|'client'} */
  mode: 'off',
  /** @type {Room|null} */
  room: null,
  code: '',
  link: '',
  status: '',
  error: '',
  /** Vendégoldali nézetek. */
  lobbyView: new RemoteLobby(),
  gameView: new RemoteGame(),
  /** Gazdaoldalon: peerId → { deviceId, lastSeen }. */
  peers: new Map(),

  _lastSnap: 0,
  _lastInput: 0,
  _sawGame: false,

  /** Van-e szobakód a linkben (a lobbi ezzel ajánlja fel a csatlakozást). */
  get pendingRoomCode() { return roomFromLink(); },
  get relayUrl() { return defaultRelay(); },

  /** Új szoba nyitása gazdaként. @returns {Promise<string>} a link */
  async openRoom() {
    this.close();
    const room = new Room();
    this.room = room;
    this.mode = 'host';
    this.status = 'Szoba nyitása…';
    this.error = '';

    room.on('peer-join', (id) => this._addPeer(id));
    room.on('peer-left', (id) => this._dropPeer(id));
    room.on('message', (msg) => {
      if (msg.t === 'in') {
        const peer = this.peers.get(msg.from);
        if (!peer) { this._addPeer(msg.from); }
        const dev = this.peers.get(msg.from);
        if (dev) {
          dev.lastSeen = Date.now();
          Input.setRemoteState(dev.deviceId, msg);
        }
      }
    });

    try {
      const info = await room.host();
      this.code = info.code;
      this.link = info.link;
      this.status = 'A szoba nyitva';
      return this.link;
    } catch (err) {
      this.error = `Nem sikerült szobát nyitni: ${err.message}`;
      this.status = '';
      this.mode = 'off';
      this.room = null;
      throw err;
    }
  },

  /** Csatlakozás vendégként. @param {string} code */
  async joinRoom(code) {
    this.close();
    const room = new Room();
    this.room = room;
    this.mode = 'client';
    this.status = 'Csatlakozás…';
    this.error = '';
    this._sawGame = false;

    room.on('message', (msg) => {
      if (msg.t === 'lobby') { this.lobbyView.apply(msg); this._sawGame = false; }
      else if (msg.t === 'snap') { this.gameView.apply(msg, performance.now()); this._sawGame = true; }
    });
    room.on('host-gone', () => {
      this.error = 'A szoba gazdája kilépett';
      this.close();
    });

    try {
      await room.join(code);
      this.code = room.code;
      this.link = room.link;
      this.status = 'Csatlakozva';
    } catch (err) {
      this.error = `Nem sikerült csatlakozni: ${err.message}`;
      this.status = '';
      this.mode = 'off';
      this.room = null;
      throw err;
    }
  },

  /** Vendégoldalon: meccset látunk-e (vagy még a lobbit). */
  get showingGame() { return this.mode === 'client' && this._sawGame; },

  /** @private */
  _addPeer(id) {
    if (this.peers.has(id)) return;
    const deviceId = `net-${id.slice(0, 6)}`;
    Input.addRemoteDevice(deviceId, 'Online játékos');
    this.peers.set(id, { deviceId, lastSeen: Date.now() });
  },

  /** @private */
  _dropPeer(id) {
    const peer = this.peers.get(id);
    if (!peer) return;
    Input.removeRemoteDevice(peer.deviceId);
    this.peers.delete(id);
  },

  /**
   * Képkockánként hívandó.
   * @param {object|null} lobby a gazda lobbija (vagy null)
   * @param {object|null} game a gazda meccse (vagy null)
   */
  tick(lobby, game) {
    if (this.mode === 'off' || !this.room) return;
    const now = performance.now();

    if (this.mode === 'host') {
      // Kiesett vendégek takarítása.
      for (const [id, peer] of this.peers) {
        if (Date.now() - peer.lastSeen > PEER_TIMEOUT_MS) this._dropPeer(id);
      }
      const hz = game ? SNAP_HZ : LOBBY_HZ;
      if (now - this._lastSnap >= 1000 / hz) {
        this._lastSnap = now;
        if (game) this.room.send(packGame(game));
        else if (lobby) this.room.send(packLobby(lobby));
      }
      return;
    }

    // Vendég: a saját inputunk megy a gazdának.
    if (now - this._lastInput >= 1000 / INPUT_HZ) {
      this._lastInput = now;
      const packet = Input.serializeLocalInput();
      if (packet) {
        packet.t = 'in';
        this.room.send(packet, this.room.hostId);
      }
    }
  },

  close() {
    for (const id of Array.from(this.peers.keys())) this._dropPeer(id);
    if (this.room) this.room.close();
    this.room = null;
    this.mode = 'off';
    this.code = '';
    this.link = '';
    this.status = '';
    this._sawGame = false;
  },
};
