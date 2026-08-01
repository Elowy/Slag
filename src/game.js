/**
 * Slag — the match driver.
 *
 * `Game` owns everything that is a RULE rather than a simulation detail:
 * round flow (countdown → playing → matchEnd), reading the input for each
 * player, turning projectile impacts into score, deaths and respawns, and
 * choosing the arena for a new match.
 *
 * The split against the other modules is deliberate and strict:
 *   - `entities.js` moves tanks and projectiles and only REPORTS what happened
 *     (`bullet.hitTankIndex`, `bullet.explode`, `bullet.dead`);
 *   - `powerups.js` owns crates, modifiers and the rocket blast, and reports
 *     its victims through the `world.onHit` callback installed here;
 *   - this file decides what a report is worth.
 *
 * IMPORTANT INVARIANT — projectile slots
 * Every projectile pushed into `world.bullets` incremented its owner's
 * `activeBullets` counter. This module is the ONLY place that removes
 * projectiles from that list, so it must call `tank.releaseBullet()` for each
 * removal. Forgetting it silently starves the player of ammunition, which is
 * why the removal happens in exactly one function (`_sweepProjectiles`).
 */

import { CONFIG, PALETTE } from './config.js';
import { clamp, dist, pick, rand, shuffle } from './util.js';
import { ARENAS, buildArena } from './arena.js';
import { Tank, makeParticles, updateParticles } from './entities.js';
import { updatePickups, explodeRocket } from './powerups.js';
import { Audio } from './audio.js';
import { Input } from './input.js';

/** Invulnerability granted after a shield absorbed a lethal hit (seconds). */
const SHIELD_INVULN = 1.0;
/** Knock-back of an absorbed hit (px/s). */
const SHIELD_KNOCKBACK = 210;
/** Screen shake added by a tank exploding. */
const DEATH_SHAKE = 12;
/** A spawn point closer than this to a living tank counts as occupied. */
const SPAWN_BLOCK_DIST = 110;
/** Below this amplitude the screen shake is simply switched off. */
const SHAKE_EPSILON = 0.05;
/** Score range accepted from the lobby. */
const MIN_POINTS_TO_WIN = 1;
const MAX_POINTS_TO_WIN = 999;

/** Stereo pan (-1..1) derived from a world X coordinate. */
function panAt(world, x) {
  const width = (world && world.arena && world.arena.width) || CONFIG.arena.width;
  return clamp((x / width) * 2 - 1, -1, 1) * 0.8;
}

/** Adds screen shake without ever exceeding the configured maximum. */
function addShake(world, amount) {
  if (!world || !world.fx) return;
  const current = Number.isFinite(world.fx.shake) ? world.fx.shake : 0;
  world.fx.shake = Math.min(current + amount, CONFIG.fx.maxShake);
}

/**
 * A single deathmatch between 2-4 players.
 *
 * @example
 *   const game = new Game(lobby.playersForGame(), lobby.settings);
 *   game.update(1 / 120);          // called from the fixed-step loop
 *   drawGame(ctx, game, seconds);  // render.js reads game.world / game.state
 */
export class Game {
  /**
   * @param {Array<{index:number, deviceId:string, colorId:string, name:string}>} players
   * @param {{bounce:boolean, arenaId:string, pointsToWin:number}} settings
   */
  constructor(players, settings) {
    this.settings = normalizeSettings(settings);
    this.players = normalizePlayers(players);

    /** @type {'countdown'|'playing'|'matchEnd'} */
    this._state = 'countdown';
    /** Seconds left of the pre-match countdown. */
    this.countdown = CONFIG.match.countdown;
    /** Seconds left before the end screen accepts input. */
    this.endTimer = 0;
    /** Total elapsed match time in seconds (visual use only). */
    this.elapsed = 0;
    /** @type {null|object} the winning PlayerSlot, set when the match ends. */
    this.winner = null;

    /** Id of the arena used by the previous match, so 'random' can vary. */
    this._lastArenaId = null;

    /**
     * Device ids whose trigger edge has not reached a simulation step yet, plus
     * the per-device input views handed to the tanks. See `consumeInput()`.
     * @type {Set<string>}
     */
    this._pendingFire = new Set();
    /** @type {Map<string, object>} */
    this._inputViews = new Map();

    // The callback is installed once and kept stable: `powerups.js` reads it
    // off the world object on every blast.
    this.onHit = this.onHit.bind(this);

    /**
     * The shared simulation state every other module works on.
     * @type {{arena:object, tanks:Tank[], bullets:Array, particles:Array,
     *         pickups:Array, settings:object, fx:object, onHit:Function}}
     */
    this.world = {
      arena: buildArena(this._nextArenaDef()),
      tanks: [],
      bullets: [],
      particles: [],
      pickups: [],
      settings: this.settings,
      fx: { shake: 0, shakeX: 0, shakeY: 0, time: 0 },
      onHit: this.onHit,
    };
    this._lastArenaId = this.world.arena.id;

    this._buildTanks();
    this._beginCountdown();
  }

  // ---------------------------------------------------------------------------
  // Public read-only surface (render.js and main.js use these)
  // ---------------------------------------------------------------------------

  /** @returns {'countdown'|'playing'|'matchEnd'} */
  get state() {
    return this._state;
  }

  /** Convenience alias so the renderer does not have to reach into `world`. */
  get tanks() {
    return this.world.tanks;
  }

  /** @returns {object} the built arena of the current match. */
  get arena() {
    return this.world.arena;
  }

  /** True once the end screen has been up long enough to accept input. */
  get canExit() {
    return this._state === 'matchEnd' && this.endTimer <= 0;
  }

  /**
   * Standings, best player first: score desc, then kills desc, then fewer
   * deaths. Returns fresh plain objects, safe for the renderer to keep.
   * @returns {Array<{index:number, color:object, name:string, score:number,
   *                  kills:number, deaths:number, ownGoals:number}>}
   */
  scoreboard() {
    const rows = this.world.tanks.map((tank) => ({
      index: tank.index,
      color: tank.color,
      name: tank.name,
      score: tank.score,
      kills: tank.kills,
      deaths: tank.deaths,
      ownGoals: tank.ownGoals ?? 0,
    }));
    rows.sort((a, b) => (b.score - a.score) || (b.kills - a.kills) || (a.deaths - b.deaths));
    return rows;
  }

  // ---------------------------------------------------------------------------
  // Match lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Starts a brand new match with the very same players: fresh arena (a new
   * one when the lobby asked for 'random'), zeroed scores, empty world.
   */
  restart() {
    const world = this.world;

    world.arena = buildArena(this._nextArenaDef());
    this._lastArenaId = world.arena.id;

    // Wiping the arena reference also makes `updatePickups()` rebuild its own
    // bookkeeping, but the lists are cleared here so nothing survives a match.
    world.bullets.length = 0;
    world.particles.length = 0;
    world.pickups.length = 0;
    world.pickupState = null;
    world.fx.shake = 0;
    world.fx.shakeX = 0;
    world.fx.shakeY = 0;

    const spawns = this._shuffledSpawns();
    for (let i = 0; i < world.tanks.length; i++) {
      world.tanks[i].resetMatch(spawns[i % spawns.length]);
    }

    this.winner = null;
    this.endTimer = 0;
    this.elapsed = 0;
    this._beginCountdown();
  }

  /**
   * Remembers the trigger EDGE of the current frame. Called once per rendered
   * frame from `main.js`, before the fixed steps.
   *
   * A `firePressed` edge lives for exactly one poll, but above 120 Hz a frame
   * regularly runs zero fixed steps — a quick R2 tap that landed on such a
   * frame used to disappear without a shot. The edge is parked here instead and
   * the first step that runs picks it up.
   */
  consumeInput() {
    // Only the playing state consumes trigger edges; anything parked during the
    // countdown or the end screen would fire a phantom shot later on.
    if (this._state !== 'playing') {
      this._pendingFire.clear();
      return;
    }
    const players = this.players;
    for (let i = 0; i < players.length; i++) {
      const id = players[i].deviceId;
      if (Input.getState(id).firePressed) this._pendingFire.add(id);
    }
  }

  /**
   * The input a tank sees this step: the live device state plus any trigger
   * edge parked by `consumeInput()`. A copy, because the live state object is
   * owned by `input.js` and must never be written to.
   * @private
   * @param {string} deviceId
   * @returns {object} InputState-shaped view
   */
  _inputFor(deviceId) {
    const live = Input.getState(deviceId);
    let view = this._inputViews.get(deviceId);
    if (!view) {
      view = {};
      this._inputViews.set(deviceId, view);
    }
    view.moveX = live.moveX; view.moveY = live.moveY; view.moveMag = live.moveMag;
    view.aimX = live.aimX; view.aimY = live.aimY; view.aimMag = live.aimMag;
    view.fire = live.fire; view.fireHeld = live.fireHeld;
    view.confirmPressed = live.confirmPressed;
    view.cancelPressed = live.cancelPressed;
    view.prevPressed = live.prevPressed;
    view.nextPressed = live.nextPressed;
    view.startPressed = live.startPressed;
    view.upPressed = live.upPressed;
    view.downPressed = live.downPressed;
    view.anyPressed = live.anyPressed;
    // `delete` reports whether the edge was still pending — consume it here.
    view.firePressed = this._pendingFire.delete(deviceId) || live.firePressed;
    return view;
  }

  /**
   * Advances the whole match by one fixed step.
   * @param {number} dt seconds (the caller uses a fixed 1/120)
   */
  update(dt) {
    if (!(dt > 0)) return;

    const world = this.world;
    this.elapsed += dt;
    world.fx.time += dt;
    this._updateShake(dt);

    if (this._state === 'countdown') {
      this._updateCountdown(dt);
      // The crates are already on the field when the countdown reaches "GO",
      // instead of popping into existence a frame later.
      updatePickups(world, dt);
      updateParticles(world.particles, dt);
      return;
    }

    if (this._state === 'matchEnd') {
      // The tanks are frozen on the end screen, but shells already in the air
      // finish their flight so the last moment does not stop mid-motion.
      this.endTimer = Math.max(0, this.endTimer - dt);
      this._sweepProjectiles(dt);
      updateParticles(world.particles, dt);
      return;
    }

    // --- playing ------------------------------------------------------------
    const tanks = world.tanks;
    for (let i = 0; i < tanks.length; i++) {
      const tank = tanks[i];
      tank.update(dt, this._inputFor(tank.deviceId), world);
    }

    this._sweepProjectiles(dt);
    updatePickups(world, dt);
    updateParticles(world.particles, dt);
    this._updateRespawns();
    this._checkMatchEnd();
  }

  // ---------------------------------------------------------------------------
  // Hit handling — the single entry point for "tank X took a hit"
  // ---------------------------------------------------------------------------

  /**
   * Processes one hit. Called from this module for direct shell impacts and
   * from `powerups.js` (through `world.onHit`) for every rocket blast victim.
   *
   * Order of business:
   *   1. dead / invulnerable victims are ignored,
   *   2. a shield absorbs the hit: knock-back + mercy invulnerability, no score,
   *   3. otherwise the tank explodes; the attacker gets +1 kill and +1 point,
   *      an own goal only costs the victim a death (no point change, no kill).
   *
   * @param {number} victimIndex `tank.index` of the tank that was hit
   * @param {number} attackerIndex `tank.index` of the shooter (may equal victim)
   * @param {number} x impact position, used for knock-back and effects
   * @param {number} y
   */
  onHit(victimIndex, attackerIndex, x, y) {
    if (this._state === 'matchEnd') return;

    const world = this.world;
    const victim = this._tankByIndex(victimIndex);
    if (!victim || !victim.alive) return;
    if (victim.invulnTimer > 0) return;

    const px = Number.isFinite(x) ? x : victim.x;
    const py = Number.isFinite(y) ? y : victim.y;

    victim.hitFlash = CONFIG.tank.hitFlashTime;

    // 1. A shield eats the hit: nobody scores.
    if (this._absorbWithShield(victim, px, py)) return;

    // 2. Lethal hit.
    const attacker = this._tankByIndex(attackerIndex);
    const ownGoal = !attacker || attacker === victim;

    this._explodeTank(victim);
    victim.deaths += 1;

    if (ownGoal) {
      // Own goal: the death itself (and the respawn wait) is the whole penalty.
      // Deliberately no point loss — with bouncing shells own goals are common
      // enough that a -1 would drag every score below zero and a match to a
      // score limit would never end.
      victim.ownGoals += 1;
    } else {
      attacker.kills += 1;
      attacker.score += 1;
      Input.rumble(attacker.deviceId, 0.35, 0.55, 140);
    }
  }

  // ---------------------------------------------------------------------------
  // Internals — construction
  // ---------------------------------------------------------------------------

  /** Creates one tank per player on shuffled spawn points. @private */
  _buildTanks() {
    const spawns = this._shuffledSpawns();
    this.world.tanks = this.players.map(
      (player, i) => new Tank(player, spawns[i % spawns.length]),
    );
  }

  /**
   * Spawn points of the current arena in random order, so the same player does
   * not always start in the same corner.
   * @private
   * @returns {Array<{x:number, y:number, angle:number}>}
   */
  _shuffledSpawns() {
    const arena = this.world.arena;
    const spawns = arena && Array.isArray(arena.spawns) ? arena.spawns : [];
    if (spawns.length === 0) {
      return [{ x: CONFIG.arena.width * 0.5, y: CONFIG.arena.height * 0.5, angle: 0 }];
    }
    return shuffle(spawns);
  }

  /**
   * Arena definition for the next match: the fixed pick from the lobby, or a
   * random one that differs from the previous match when 'random' was chosen.
   * @private
   */
  _nextArenaDef() {
    const wanted = this.settings.arenaId;
    if (wanted && wanted !== 'random') {
      const found = ARENAS.find((a) => a.id === wanted);
      if (found) return found;
    }
    const pool = ARENAS.filter((a) => a.id !== this._lastArenaId);
    return pick(pool.length > 0 ? pool : ARENAS) || ARENAS[0];
  }

  // ---------------------------------------------------------------------------
  // Internals — round flow
  // ---------------------------------------------------------------------------

  /** @private */
  _beginCountdown() {
    this._state = 'countdown';
    this.countdown = CONFIG.match.countdown;
    // The first beep belongs to the first number shown on screen.
    Audio.play('countdown');
  }

  /**
   * Counts down to zero, beeping on every whole second and firing the 'go' cue
   * when the match starts.
   * @private
   */
  _updateCountdown(dt) {
    const before = this.countdown;
    this.countdown -= dt;

    const secondsBefore = Math.ceil(before);
    const secondsAfter = Math.ceil(Math.max(this.countdown, 0));
    if (secondsAfter < secondsBefore && secondsAfter >= 1) {
      Audio.play('countdown');
    }

    if (this.countdown <= 0) {
      this.countdown = 0;
      this._state = 'playing';
      Audio.play('go');
    }
  }

  /** Exponential decay of the screen shake plus its per-step offset. @private */
  _updateShake(dt) {
    const fx = this.world.fx;
    let shake = Number.isFinite(fx.shake) ? fx.shake : 0;
    shake *= Math.exp(-CONFIG.fx.shakeDecay * dt);
    if (shake < SHAKE_EPSILON) shake = 0;
    fx.shake = shake;
    // Offered for renderers that prefer a ready-made offset over their own noise.
    fx.shakeX = shake > 0 ? rand(-shake, shake) : 0;
    fx.shakeY = shake > 0 ? rand(-shake, shake) : 0;
  }

  /**
   * Moves every projectile, turns the reported impacts into hits, and removes
   * the dead ones — giving the shot slot back to its owner.
   * @private
   */
  _sweepProjectiles(dt) {
    const world = this.world;
    const bullets = world.bullets;

    for (let i = bullets.length - 1; i >= 0; i--) {
      const projectile = bullets[i];
      projectile.update(dt, world);

      // A shell reports its victim directly; a rocket reports through `explode`.
      if (projectile.hitTankIndex >= 0 && !projectile.hitResolved) {
        projectile.hitResolved = true;
        this.onHit(projectile.hitTankIndex, projectile.ownerIndex, projectile.x, projectile.y);
      }

      if (!projectile.dead) continue;

      if (projectile.explode) {
        // `explodeRocket()` calls back into `onHit()` for every victim.
        projectile.explode = false;
        explodeRocket(world, projectile.x, projectile.y, projectile.ownerIndex);
      }

      // THE critical line: without it `activeBullets` never drops back.
      this._releaseProjectile(projectile);
      bullets.splice(i, 1);
    }
  }

  /**
   * Gives one shot slot back to the tank that fired the projectile.
   * @private
   */
  _releaseProjectile(projectile) {
    const owner = this._tankByIndex(projectile.ownerIndex);
    if (owner) owner.releaseBullet();
  }

  /** Respawns every tank whose death timer has run out. @private */
  _updateRespawns() {
    const tanks = this.world.tanks;
    for (let i = 0; i < tanks.length; i++) {
      const tank = tanks[i];
      if (tank.alive || tank.respawnTimer > 0) continue;
      this._respawn(tank);
    }
  }

  /**
   * Puts a tank back on the arena at the free spawn point farthest from the
   * living opposition, with `CONFIG.tank.spawnInvuln` of invulnerability.
   * `Tank.respawnAt()` also drops every carried power-up, so dying always
   * costs the whole loadout.
   * @private
   */
  _respawn(tank) {
    const world = this.world;
    tank.respawnAt(this._chooseSpawn(tank));

    makeParticles(world.particles, tank.x, tank.y, {
      count: 1, kind: 'ring', color: tank.color.light,
      life: 0.5, size: tank.radius, grow: 60,
    });
    makeParticles(world.particles, tank.x, tank.y, {
      count: 14, kind: 'spark', color: tank.color.main,
      speed: 200, life: 0.4, size: 2.2,
    });
    Audio.play('spawn', { pan: panAt(world, tank.x) });
  }

  /**
   * Picks the spawn point that maximises the distance to the nearest living
   * opponent. Points occupied by a living tank are pushed to the back of the
   * ranking, and a tiny jitter breaks perfectly symmetric ties.
   * @private
   * @returns {{x:number, y:number, angle:number}}
   */
  _chooseSpawn(tank) {
    const world = this.world;
    const spawns = (world.arena && world.arena.spawns) || [];
    if (spawns.length === 0) {
      return { x: world.arena.width * 0.5, y: world.arena.height * 0.5, angle: 0 };
    }

    const enemies = world.tanks.filter((t) => t !== tank && t.alive);

    let best = spawns[0];
    let bestScore = -Infinity;
    for (let i = 0; i < spawns.length; i++) {
      const spawn = spawns[i];

      let nearest = Infinity;
      for (let e = 0; e < enemies.length; e++) {
        const d = dist(spawn.x, spawn.y, enemies[e].x, enemies[e].y);
        if (d < nearest) nearest = d;
      }
      if (!Number.isFinite(nearest)) nearest = world.arena.width; // nobody alive

      // "Free" simply means nobody is standing on it; occupied points stay in
      // the running (a 2 player match on a small arena may have no other), they
      // are just ranked far below every free one.
      const free = nearest > SPAWN_BLOCK_DIST;
      const score = (free ? 1e6 : 0) + nearest + rand(0, 8);
      if (score > bestScore) {
        bestScore = score;
        best = spawn;
      }
    }
    return best;
  }

  // ---------------------------------------------------------------------------
  // Internals — damage
  // ---------------------------------------------------------------------------

  /**
   * Spends one shield to survive an otherwise lethal hit.
   * @private
   * @returns {boolean} true when the hit was absorbed
   */
  _absorbWithShield(tank, x, y) {
    if (!(tank.shields > 0)) return false;

    const world = this.world;
    tank.shields -= 1;
    tank.invulnTimer = Math.max(tank.invulnTimer || 0, SHIELD_INVULN);

    // Knock the tank away from the impact so the player feels the save.
    let dx = tank.x - x;
    let dy = tank.y - y;
    const d = Math.hypot(dx, dy);
    if (d < 0.0001) {
      const a = rand(0, Math.PI * 2);
      dx = Math.cos(a);
      dy = Math.sin(a);
    } else {
      dx /= d;
      dy /= d;
    }
    tank.vx += dx * SHIELD_KNOCKBACK;
    tank.vy += dy * SHIELD_KNOCKBACK;

    makeParticles(world.particles, tank.x, tank.y, {
      count: 1, kind: 'ring', color: '#fca5a5',
      life: 0.42, size: tank.radius, grow: 34,
    });
    makeParticles(world.particles, tank.x, tank.y, {
      count: 12, kind: 'spark', color: '#ef4444',
      speed: 210, life: 0.35, size: 2.4,
    });
    Audio.play('shieldBreak', { pan: panAt(world, tank.x) });
    Input.rumble(tank.deviceId, 0.8, 0.5, 220);
    return true;
  }

  /** Blows a tank up: effects, sound, shake, rumble, and the death itself. @private */
  _explodeTank(tank) {
    const world = this.world;
    const color = tank.color;

    makeParticles(world.particles, tank.x, tank.y, {
      count: 1, kind: 'ring', color: color.light, life: 0.55, size: tank.radius, grow: 95,
    });
    makeParticles(world.particles, tank.x, tank.y, {
      count: 26, kind: 'spark', color: color.light, speed: 390, life: 0.5, size: 3,
    });
    makeParticles(world.particles, tank.x, tank.y, {
      count: 16, kind: 'debris', color: color.main, speed: 250, life: 0.85, size: 3.4,
    });
    makeParticles(world.particles, tank.x, tank.y, {
      count: 12, kind: 'smoke', color: '#4b5563', speed: 95, life: 1.2, size: 12, radius: 16,
    });

    const pan = panAt(world, tank.x);
    Audio.play('hit', { pan, volume: 0.85 });
    Audio.play('explode', { pan });
    addShake(world, DEATH_SHAKE);
    Input.rumble(tank.deviceId, 1, 0.85, 380);

    tank.die();
  }

  // ---------------------------------------------------------------------------
  // Internals — end of match
  // ---------------------------------------------------------------------------

  /**
   * Ends the match as soon as somebody reaches the score limit. When several
   * players cross the line inside the same step, the higher score wins and a
   * true draw is decided by the kill count.
   * @private
   */
  _checkMatchEnd() {
    const limit = this.settings.pointsToWin;
    const tanks = this.world.tanks;

    let best = null;
    for (let i = 0; i < tanks.length; i++) {
      const tank = tanks[i];
      if (tank.score < limit) continue;
      if (!best
        || tank.score > best.score
        || (tank.score === best.score && tank.kills > best.kills)) {
        best = tank;
      }
    }
    if (!best) return;

    this._state = 'matchEnd';
    this.endTimer = CONFIG.match.endScreenDelay;
    this.winner = this.players.find((p) => p.index === best.index) || null;

    makeParticles(this.world.particles, best.x, best.y, {
      count: 1, kind: 'ring', color: best.color.light, life: 0.8, size: 20, grow: 220,
    });
    Audio.play('win');
  }

  /** @private @returns {Tank|null} */
  _tankByIndex(index) {
    if (!Number.isFinite(index) || index < 0) return null;
    const tanks = this.world.tanks;
    for (let i = 0; i < tanks.length; i++) {
      if (tanks[i].index === index) return tanks[i];
    }
    return null;
  }
}

// =============================================================================
// Input normalization — the lobby is trusted, but the Game is also created by
// the tools (smoke test, single file build), so both are validated here.
// =============================================================================

/**
 * @param {object} settings
 * @returns {{bounce:boolean, arenaId:string, pointsToWin:number}}
 */
function normalizeSettings(settings) {
  const src = settings || {};
  const points = Number.isFinite(src.pointsToWin)
    ? Math.round(src.pointsToWin)
    : CONFIG.match.pointsToWin;

  return {
    // Bouncing is on unless it was explicitly switched off in the lobby.
    bounce: src.bounce !== false,
    arenaId: typeof src.arenaId === 'string' && src.arenaId ? src.arenaId : 'random',
    pointsToWin: clamp(points, MIN_POINTS_TO_WIN, MAX_POINTS_TO_WIN),
  };
}

/**
 * Re-indexes the player slots to a dense 0..n-1 range and resolves the palette
 * entry, so both `Tank` and the renderer can rely on `player.color`.
 * @param {Array<object>} players
 * @returns {Array<{index:number, deviceId:string|null, colorId:string,
 *                  name:string, color:object}>}
 */
function normalizePlayers(players) {
  const list = Array.isArray(players) ? players.slice(0, CONFIG.match.maxPlayers) : [];
  const used = new Set();

  return list.map((raw, i) => {
    const src = raw || {};
    let color = PALETTE.find((c) => c.id === src.colorId);
    if (!color || used.has(color.id)) {
      // Two players with the same colour would be indistinguishable: fall back
      // to the first free palette entry.
      color = PALETTE.find((c) => !used.has(c.id)) || PALETTE[i % PALETTE.length];
    }
    used.add(color.id);

    return {
      index: i,
      deviceId: src.deviceId != null ? src.deviceId : null,
      colorId: color.id,
      name: typeof src.name === 'string' && src.name ? src.name : `${i + 1}. játékos`,
      color,
    };
  });
}
