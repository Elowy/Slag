/**
 * Slag — gameplay entities: tanks, projectiles and particles.
 *
 * This module owns the *simulation* of a single entity. It deliberately does
 * NOT own match rules: scoring, deaths, respawn point selection and the
 * processing of a hit are the job of `game.js`. Entities only report what
 * happened through plain data fields (`bullet.hitTankIndex`, `bullet.explode`,
 * `bullet.dead`) so the game loop can react to them once per frame.
 *
 * Two conventions matter for the rest of the codebase:
 *
 *  1. Every movement / shooting number is read through `effective(tank, key)`
 *     from `./powerups.js`. Never read `CONFIG.tank.maxSpeed` and friends
 *     directly here, otherwise active power-ups would be ignored.
 *
 *  2. `tank.activeBullets` is incremented when a projectile is fired and must
 *     be decremented by the owner of the projectile list (`game.js`) through
 *     `tank.releaseBullet()` when that projectile leaves the world.
 */

import { CONFIG, PALETTE } from './config.js';
import { clamp, lerp, angleLerp, angleDiff, len, rand } from './util.js';
import { resolveCircle, bulletCollide } from './arena.js';
import { Audio } from './audio.js';
import { Input } from './input.js';
import { effective, updateTankPowerups } from './powerups.js';

const TAU = Math.PI * 2;

// --- Tank handling constants -------------------------------------------------
// The right stick gives the DESIRED heading. The hull turns towards it and can
// only thrust along its own nose, so a full reversal has to be driven through a
// turn. Without a throttle gate the tank would happily accelerate backwards
// into a wall while spinning, which is impossible to control.

/** Above this heading error (~110 deg) the throttle is capped hard. */
const TURN_GATE = 1.92;
/** Throttle multiplier once the heading error reaches `TURN_GATE`. */
const MISALIGNED_THROTTLE = 0.25;
/**
 * Fraction of the friction that is relieved at full throttle. `friction` alone
 * would limit the tank to `accel / friction` px/s, well below `maxSpeed`; while
 * the player is on the gas most of the drag is lifted so the configured top
 * speed is actually reachable, and released input brings the full drag back.
 */
const DRAG_RELIEF = 0.78;
/** Sideways damping — treads grip much harder laterally than they roll. */
const LATERAL_GRIP = 9.0;
/** Arena pixels travelled per tread link, used for the animated `trackPhase`. */
const TRACK_PITCH = 7;

/** Muzzle flash duration in seconds. */
const MUZZLE_FLASH_TIME = 0.07;
/** Backwards kick applied to the hull when firing (px/s). */
const BULLET_RECOIL = 55;
const ROCKET_RECOIL = 120;

/** Speed above which the treads throw up dust, and how often. */
const DUST_SPEED = 95;
const DUST_INTERVAL = 0.07;

/** Safety cap on projectile sub-steps per simulation step. */
const MAX_SUBSTEPS = 24;
/** How far a bounced projectile is nudged out of a wall per attempt. */
const WALL_PUSH = 1.25;

/** Hard cap on the particle list; the oldest entries are dropped above it. */
export const MAX_PARTICLES = 700;

/** Frozen fallback so a tank without an input device simply stands still. */
const NEUTRAL_INPUT = Object.freeze({
  moveX: 0, moveY: 0, moveMag: 0,
  aimX: 0, aimY: 0, aimMag: 0,
  fire: 0, firePressed: false, fireHeld: false,
});

/** Wraps an angle into (-PI, PI]. */
function wrapAngle(a) {
  let x = (a + Math.PI) % TAU;
  if (x < 0) x += TAU;
  return x - Math.PI;
}

/** Framerate independent interpolation factor for an exponential approach. */
function approach(rate, dt) {
  return 1 - Math.exp(-rate * dt);
}

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

// =============================================================================
// Tank
// =============================================================================

/**
 * A player controlled tank.
 *
 * `player` is a PlayerSlot enriched by `game.js`: `{ index, deviceId, color }`.
 * If only `colorId` is present the palette entry is resolved here, so the
 * class is usable with a raw PlayerSlot too.
 */
export class Tank {
  /**
   * @param {{index:number, deviceId?:string, color?:object, colorId?:string, name?:string}} player
   * @param {{x:number, y:number, angle:number}} spawn
   */
  constructor(player, spawn) {
    const p = player || {};

    this.index = Number.isFinite(p.index) ? p.index : 0;
    this.color = p.color
      || PALETTE.find((c) => c.id === p.colorId)
      || PALETTE[this.index % PALETTE.length];
    this.deviceId = p.deviceId != null ? p.deviceId : null;
    /** Gépi játékos-e. Csak jelölés: a mozgásszabályok azonosak. */
    this.isBot = !!p.isBot;
    this.name = p.name || `${this.index + 1}. játékos`;

    /** Collision radius; pickups and blasts measure against this. */
    this.radius = CONFIG.tank.radius;

    // --- match statistics (owned by game.js, never touched by update()) ---
    this.score = 0;
    this.kills = 0;
    this.deaths = 0;
    /** Deaths caused by the tank's own shell; shown in the HUD, costs no point. */
    this.ownGoals = 0;

    /** Live projectiles of this tank; see `releaseBullet()`. */
    this.activeBullets = 0;

    /** 0..1 tread animation phase, advanced by the distance travelled. */
    this.trackPhase = 0;

    // --- power-up state (see powerups.js) ---
    this.powerups = { rapid: 0, speed: 0 };
    this.rocketAmmo = 0;
    this.shields = 0;
    this.pickupFlash = 0;
    /** Id of the most recently collected power-up, for the HUD flash. */
    this.lastPickupId = null;

    // internal timers
    this.dustTimer = 0;

    this.placeAt(spawn);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle helpers used by game.js
  // ---------------------------------------------------------------------------

  /**
   * Moves the tank to a spawn point and puts it into a fresh, alive state.
   * Score and power-ups are left untouched — see `respawnAt()` / `resetMatch()`.
   * @param {{x:number, y:number, angle:number}} spawn
   */
  placeAt(spawn) {
    const s = spawn || {};
    this.x = Number.isFinite(s.x) ? s.x : CONFIG.arena.width * 0.5;
    this.y = Number.isFinite(s.y) ? s.y : CONFIG.arena.height * 0.5;
    this.vx = 0;
    this.vy = 0;
    this.angle = Number.isFinite(s.angle) ? s.angle : 0;
    this.turretAngle = this.angle;
    /** Heading the turret aims for while in 'free' mode. */
    this.turretTarget = this.angle;
    this.turretMode = 'follow';
    this.turretIdle = 0;

    this.alive = true;
    this.respawnTimer = 0;
    this.invulnTimer = CONFIG.tank.spawnInvuln;
    this.reload = 0;
    this.hitFlash = 0;
    this.muzzleFlash = 0;
  }

  /**
   * Respawns the tank after a death: places it and clears every carried
   * power-up, so a run cannot be snowballed through deaths.
   * Plays no sound — `game.js` owns the 'spawn' cue.
   * @param {{x:number, y:number, angle:number}} spawn
   */
  respawnAt(spawn) {
    this.placeAt(spawn);
    this.powerups.rapid = 0;
    this.powerups.speed = 0;
    this.rocketAmmo = 0;
    this.shields = 0;
    this.pickupFlash = 0;
    this.lastPickupId = null;
  }

  /**
   * Full reset for a brand new match: respawn plus zeroed statistics.
   * @param {{x:number, y:number, angle:number}} spawn
   */
  resetMatch(spawn) {
    this.respawnAt(spawn);
    this.score = 0;
    this.kills = 0;
    this.deaths = 0;
    this.ownGoals = 0;
    this.activeBullets = 0;
  }

  /**
   * Marks the tank as destroyed. Scoring stays with `game.js`; this only flips
   * the simulation state and starts the respawn countdown.
   */
  die() {
    if (!this.alive) return;
    this.alive = false;
    this.respawnTimer = CONFIG.tank.respawnDelay;
    this.vx = 0;
    this.vy = 0;
    this.invulnTimer = 0;
    this.powerups.rapid = 0;
    this.powerups.speed = 0;
    this.rocketAmmo = 0;
    this.shields = 0;
  }

  /**
   * Gives back one projectile slot. `game.js` MUST call this exactly once for
   * every projectile it removes from `world.bullets`, using the projectile's
   * `ownerIndex` to find the right tank. Without it a player runs out of
   * ammunition permanently.
   */
  releaseBullet() {
    if (this.activeBullets > 0) this.activeBullets -= 1;
  }

  // ---------------------------------------------------------------------------
  // Per-step simulation
  // ---------------------------------------------------------------------------

  /**
   * Advances the tank by one fixed step.
   *
   * NOTE: this already calls `updateTankPowerups(this, dt)`; `game.js` must not
   * tick the power-up timers a second time.
   *
   * @param {number} dt seconds
   * @param {object} state InputState (null is treated as neutral)
   * @param {{arena:object, bullets:Array, tanks:Array, particles:Array, settings:object, fx:object}} world
   */
  update(dt, state, world) {
    const s = state || NEUTRAL_INPUT;

    updateTankPowerups(this, dt);
    this.reload = Math.max(0, this.reload - dt);
    this.hitFlash = Math.max(0, this.hitFlash - dt);
    this.muzzleFlash = Math.max(0, this.muzzleFlash - dt);

    if (!this.alive) {
      this.respawnTimer = Math.max(0, this.respawnTimer - dt);
      return;
    }

    this.invulnTimer = Math.max(0, this.invulnTimer - dt);
    this.updateMovement(dt, s, world);
    this.updateTurret(dt, s);
    this.tryFire(s, world);
  }

  /**
   * Hull steering and driving. The right stick is a heading request: the hull
   * rotates towards it and thrusts along its own nose only.
   * @private
   */
  updateMovement(dt, s, world) {
    const maxSpeed = effective(this, 'maxSpeed');
    const accel = effective(this, 'accel');
    const turnSpeed = effective(this, 'turnSpeed');

    const mag = clamp(s.moveMag || 0, 0, 1);
    let throttle = 0;

    if (mag > 0.0001) {
      const desired = Math.atan2(s.moveY, s.moveX);
      const diff = angleDiff(desired, this.angle);
      const misalign = Math.abs(diff);

      // Turn towards the requested heading.
      this.angle = wrapAngle(this.angle + diff * approach(turnSpeed, dt));

      // Throttle falls off quadratically with the heading error, so a
      // full reversal turns on the spot first and only then drives away.
      const k = clamp(misalign / TURN_GATE, 0, 1);
      throttle = mag * lerp(1, MISALIGNED_THROTTLE, k * k);

      this.vx += Math.cos(this.angle) * accel * throttle * dt;
      this.vy += Math.sin(this.angle) * accel * throttle * dt;
    }

    // Friction, split into a rolling and a lateral component.
    const fwdX = Math.cos(this.angle);
    const fwdY = Math.sin(this.angle);
    let vForward = this.vx * fwdX + this.vy * fwdY;
    let vLateral = -this.vx * fwdY + this.vy * fwdX;

    const rollDrag = CONFIG.tank.friction * (1 - DRAG_RELIEF * clamp(throttle, 0, 1));
    vForward *= Math.exp(-rollDrag * dt);
    vLateral *= Math.exp(-LATERAL_GRIP * dt);

    this.vx = vForward * fwdX - vLateral * fwdY;
    this.vy = vForward * fwdY + vLateral * fwdX;

    // Speed ceiling.
    const speed = len(this.vx, this.vy);
    if (speed > maxSpeed && speed > 0) {
      const k = maxSpeed / speed;
      this.vx *= k;
      this.vy *= k;
    }

    this.x += this.vx * dt;
    this.y += this.vy * dt;

    this.resolveWalls(world);
    this.updateTracks(dt, fwdX, fwdY, world);
  }

  /**
   * Pushes the hull out of every wall it overlaps and kills the velocity
   * component pointing into the last contact normal.
   * @private
   */
  resolveWalls(world) {
    const arena = world && world.arena;
    if (!arena || !arena.walls) return;

    const res = resolveCircle(this.x, this.y, this.radius, arena.walls);
    if (res && res.hit) {
      this.x = res.x;
      this.y = res.y;
      const into = this.vx * res.nx + this.vy * res.ny;
      if (into < 0) {
        this.vx -= into * res.nx;
        this.vy -= into * res.ny;
      }
    }

    // Defensive clamp: even if a wall set is malformed the tank stays visible.
    const w = arena.width || CONFIG.arena.width;
    const h = arena.height || CONFIG.arena.height;
    this.x = clamp(this.x, this.radius, w - this.radius);
    this.y = clamp(this.y, this.radius, h - this.radius);
  }

  /**
   * Advances the tread animation and puffs a little dust at speed.
   * @private
   */
  updateTracks(dt, fwdX, fwdY, world) {
    const travel = (this.vx * fwdX + this.vy * fwdY) * dt;
    let phase = (this.trackPhase + travel / TRACK_PITCH) % 1;
    if (phase < 0) phase += 1;
    this.trackPhase = phase;

    this.dustTimer -= dt;
    if (this.dustTimer > 0) return;
    this.dustTimer = DUST_INTERVAL;
    if (len(this.vx, this.vy) < DUST_SPEED) return;

    makeParticles(world && world.particles, this.x - fwdX * this.radius, this.y - fwdY * this.radius, {
      count: 1,
      kind: 'smoke',
      color: '#6b7280',
      speed: 26,
      life: 0.34,
      size: 5,
    });
  }

  /**
   * Turret aiming. The left stick is optional: touching it switches to 'free'
   * aiming, leaving it idle for `CONFIG.input.turretIdleReturn` seconds eases
   * the barrel back over the hull.
   * @private
   */
  updateTurret(dt, s) {
    const aimMag = s.aimMag || 0;

    if (aimMag > 0) {
      this.turretMode = 'free';
      this.turretIdle = 0;
      this.turretTarget = Math.atan2(s.aimY, s.aimX);
    } else {
      this.turretIdle += dt;
      if (this.turretMode === 'free' && this.turretIdle >= CONFIG.input.turretIdleReturn) {
        this.turretMode = 'follow';
      }
    }

    const target = this.turretMode === 'free' ? this.turretTarget : this.angle;
    this.turretAngle = wrapAngle(
      angleLerp(this.turretAngle, target, approach(CONFIG.tank.turretTurnSpeed, dt)),
    );
  }

  /**
   * Fires if the trigger is down and the tank is allowed to shoot. Holding R2
   * keeps firing at the reload rate — the reload timer is the rate limit, not
   * the player's thumb. Shooting is allowed while spawn-invulnerable.
   * @private
   * @returns {Bullet|Rocket|null} the spawned projectile, if any
   */
  tryFire(s, world) {
    if (!(s.firePressed || s.fireHeld)) return null;
    if (this.reload > 0) return null;
    if (this.activeBullets >= effective(this, 'maxActiveBullets')) return null;
    return this.fire(world);
  }

  /**
   * Spawns one projectile along the CURRENT TURRET ANGLE (never the hull
   * angle). A rocket is used while `rocketAmmo > 0`.
   * @param {object} world
   * @returns {Bullet|Rocket|null}
   */
  fire(world) {
    if (!world || !Array.isArray(world.bullets)) return null;

    const useRocket = this.rocketAmmo > 0;
    const angle = this.turretAngle;
    const dirX = Math.cos(angle);
    const dirY = Math.sin(angle);

    // Spawn at the muzzle, unless the muzzle is buried in a wall (hugging a
    // corner) — then fall back to the hull centre so nobody shoots through it.
    let mx = this.x + dirX * CONFIG.tank.barrelLength;
    let my = this.y + dirY * CONFIG.tank.barrelLength;
    const probe = useRocket ? CONFIG.bullet.radius * 1.5 : CONFIG.bullet.radius;
    if (world.arena && world.arena.walls && bulletCollide(mx, my, probe, world.arena.walls)) {
      mx = this.x;
      my = this.y;
    }

    const projectile = useRocket
      ? new Rocket(mx, my, angle, this.index, world.settings)
      : new Bullet(mx, my, angle, this.index, world.settings);

    world.bullets.push(projectile);
    this.activeBullets += 1;
    this.reload = effective(this, 'reloadTime');
    this.muzzleFlash = MUZZLE_FLASH_TIME;
    if (useRocket) this.rocketAmmo -= 1;

    // Recoil pushes the hull away from the shot.
    const kick = useRocket ? ROCKET_RECOIL : BULLET_RECOIL;
    this.vx -= dirX * kick;
    this.vy -= dirY * kick;

    const pan = panAt(world, this.x);
    if (useRocket) {
      makeParticles(world.particles, mx, my, {
        count: 10, kind: 'smoke', color: '#fdba74', speed: 130,
        life: 0.5, size: 6, angle: angle + Math.PI, spread: 1.1,
      });
      Audio.play('rocketFire', { pan });
      Input.rumble(this.deviceId, 0.75, 0.5, 170);
      addShake(world, 3);
    } else {
      makeParticles(world.particles, mx, my, {
        count: 5, kind: 'spark', color: this.color.light, speed: 220,
        life: 0.16, size: 2, angle, spread: 0.8,
      });
      Audio.play('shoot', { pan, rate: rand(0.95, 1.06) });
      Input.rumble(this.deviceId, 0.4, 0.22, 80);
    }

    return projectile;
  }
}

// =============================================================================
// Projectiles
// =============================================================================

/**
 * Shared movement / collision core of `Bullet` and `Rocket`.
 *
 * Motion is sub-stepped in increments of at most `radius * 0.5` so a fast
 * projectile can never tunnel through a thin wall inside one simulation step.
 */
class Projectile {
  /**
   * @param {number} x
   * @param {number} y
   * @param {number} angle radians
   * @param {number} ownerIndex index of the firing tank
   * @param {{speed:number, life:number, radius:number, trailLength:number, maxBounces:number}} opts
   */
  constructor(x, y, angle, ownerIndex, opts) {
    this.x = x;
    this.y = y;
    this.angle = angle;
    this.speed = opts.speed;
    this.vx = Math.cos(angle) * opts.speed;
    this.vy = Math.sin(angle) * opts.speed;

    this.ownerIndex = ownerIndex;
    this.life = opts.life;
    this.maxLife = opts.life;
    this.radius = opts.radius;
    this.bounces = 0;
    this.maxBounces = opts.maxBounces;
    this.trailLength = opts.trailLength;

    /** Recent positions, newest last — purely visual. */
    this.trail = [];
    this.age = 0;
    this.dead = false;

    /**
     * True once the projectile has been observed OUTSIDE its owner's hull.
     * Until then it can never hit that owner — see `canHitOwner()`.
     */
    this.clearedOwner = false;

    /**
     * Index of the tank this projectile hit, or -1 for "no hit yet".
     * `game.js` reads this after `update()` and turns it into score / death.
     * A `Rocket` leaves it at -1 and reports through `explode` instead.
     */
    this.hitTankIndex = -1;

    /** True when `game.js` must run `explodeRocket()` at this position. */
    this.explode = false;

    this.isRocket = false;
  }

  /**
   * Advances the projectile by one fixed step, sub-stepping the motion.
   * @param {number} dt seconds
   * @param {object} world
   */
  update(dt, world) {
    if (this.dead) return;

    this.age += dt;
    this.pushTrail();

    this.life -= dt;
    if (this.life <= 0) {
      this.onExpire(world);
      if (this.dead) return;
    }

    const travel = len(this.vx, this.vy) * dt;
    const steps = clamp(Math.ceil(travel / (this.radius * 0.5)), 1, MAX_SUBSTEPS);
    const stepDt = dt / steps;
    for (let i = 0; i < steps && !this.dead; i++) {
      this.step(stepDt, world);
    }

    this.afterUpdate(dt, world);
  }

  /** @private */
  pushTrail() {
    this.trail.push({ x: this.x, y: this.y });
    while (this.trail.length > this.trailLength) this.trail.shift();
  }

  /** One sub-step: move, then test walls, then test tanks. @private */
  step(dt, world) {
    this.x += this.vx * dt;
    this.y += this.vy * dt;

    const walls = world && world.arena ? world.arena.walls : null;
    if (walls) {
      const hit = bulletCollide(this.x, this.y, this.radius, walls);
      if (hit) {
        this.onWall(hit, world);
        if (this.dead) return;
      }
    }

    this.checkTankHits(world);
  }

  /**
   * Circle-circle test against every living tank. Invulnerable tanks are
   * transparent: the projectile flies straight through them.
   *
   * Reporting the hit is left to `onTankHit()`, because a rocket reports
   * through `explode` instead of `hitTankIndex`.
   * @private
   * @returns {boolean} true when a tank was hit
   */
  checkTankHits(world) {
    const tanks = (world && world.tanks) || [];
    for (let i = 0; i < tanks.length; i++) {
      const tank = tanks[i];
      if (!tank) continue;

      const isOwner = tank.index === this.ownerIndex;
      const reach = (tank.radius || CONFIG.tank.radius) + this.radius;
      const dx = tank.x - this.x;
      const dy = tank.y - this.y;
      const inside = dx * dx + dy * dy <= reach * reach;

      // The clearance flag is tracked even while the owner is dead or
      // invulnerable, so it always reflects the real geometry.
      if (isOwner && !inside) this.clearedOwner = true;

      if (!tank.alive) continue;
      if (tank.invulnTimer > 0) continue;
      if (!inside) continue;
      if (isOwner && !this.canHitOwner()) continue;

      this.onTankHit(tank, world);
      return true;
    }
    return false;
  }

  /**
   * A freshly fired projectile ignores its owner until it has either bounced
   * or lived long enough to have cleared the barrel.
   *
   * The extra `clearedOwner` precondition is what makes the rule usable in
   * practice: a shell fired point blank at a wall (or spawned at the hull
   * centre because the muzzle was buried in one) bounces back before it ever
   * left the tank, and `bounces > 0` alone would turn that into an instant
   * suicide. A projectile that never left the hull simply cannot hit it.
   * @private
   */
  canHitOwner() {
    return this.clearedOwner && (this.bounces > 0 || this.age > CONFIG.bullet.selfHitGrace);
  }

  /**
   * Nudges the projectile out of the geometry it is stuck in, along `nx, ny`.
   * @private
   * @returns {boolean} false when it could not be freed (wedged in a corner)
   */
  pushOutOfWall(nx, ny, walls) {
    for (let i = 0; i < 8; i++) {
      if (!bulletCollide(this.x, this.y, this.radius, walls)) return true;
      this.x += nx * WALL_PUSH;
      this.y += ny * WALL_PUSH;
    }
    return !bulletCollide(this.x, this.y, this.radius, walls);
  }

  /** Mirrors the velocity on a wall normal. @private */
  reflect(nx, ny) {
    const into = this.vx * nx + this.vy * ny;
    if (into < 0) {
      this.vx -= 2 * into * nx;
      this.vy -= 2 * into * ny;
    }
    this.angle = Math.atan2(this.vy, this.vx);
  }

  // --- hooks, overridden by the concrete projectiles -------------------------

  /** Wall contact. @private */
  onWall(hit, world) { this.dead = true; }

  /** Tank contact; the hook is responsible for reporting the hit. @private */
  onTankHit(tank, world) { this.dead = true; }

  /** Lifetime ran out. @private */
  onExpire(world) { this.dead = true; }

  /** Runs once per simulation step after the sub-steps. @private */
  afterUpdate(dt, world) {}
}

/**
 * Standard cannon shell: fast, bounces off walls while the match setting
 * allows it, dies on the first tank it touches.
 */
export class Bullet extends Projectile {
  /**
   * @param {number} x
   * @param {number} y
   * @param {number} angle radians
   * @param {number} ownerIndex
   * @param {{bounce?:boolean}} [settings] match settings; `bounce === false`
   *        makes the shell die on its first wall contact.
   */
  constructor(x, y, angle, ownerIndex, settings) {
    // The bounce count is FIXED at 2 by design; the lobby toggle only chooses
    // between 2 and 0. The value is captured at spawn time so a mid-flight
    // settings change cannot alter a shell already in the air.
    const bouncing = !settings || settings.bounce !== false;
    super(x, y, angle, ownerIndex, {
      speed: CONFIG.bullet.speed,
      life: CONFIG.bullet.life,
      radius: CONFIG.bullet.radius,
      trailLength: CONFIG.bullet.trailLength,
      maxBounces: bouncing ? CONFIG.bullet.maxBounces : 0,
    });
  }

  /** @private */
  onWall(hit, world) {
    this.bounces += 1;
    if (this.bounces > this.maxBounces) {
      this.dead = true;
      this.fizzle(world, hit);
      return;
    }

    this.reflect(hit.nx, hit.ny);
    const walls = world.arena.walls;
    if (!this.pushOutOfWall(hit.nx, hit.ny, walls)) {
      this.dead = true;
      return;
    }

    makeParticles(world.particles, this.x, this.y, {
      count: 4, kind: 'spark', color: '#fef3c7', speed: 150,
      life: 0.2, size: 1.8, angle: Math.atan2(hit.ny, hit.nx), spread: 2.0,
    });
    Audio.play('bounce', { pan: panAt(world, this.x), volume: 0.7, rate: rand(0.9, 1.15) });
  }

  /** Small puff when the shell runs out of bounces or lifetime. @private */
  fizzle(world, hit) {
    const angle = hit ? Math.atan2(hit.ny, hit.nx) : 0;
    makeParticles(world && world.particles, this.x, this.y, {
      count: 6, kind: 'spark', color: '#fde68a', speed: 120,
      life: 0.22, size: 1.8, angle, spread: hit ? 2.2 : TAU,
    });
  }

  /** @private */
  onTankHit(tank, world) {
    this.hitTankIndex = tank.index;
    this.dead = true;
    // Impact FX only; the hit itself (score, shield, death) is game.js' job.
    makeParticles(world && world.particles, this.x, this.y, {
      count: 8, kind: 'spark', color: tank.color ? tank.color.light : '#ffffff',
      speed: 190, life: 0.28, size: 2.2,
    });
  }

  /** @private */
  onExpire(world) {
    this.dead = true;
    this.fizzle(world, null);
  }
}

/**
 * Rocket, fired instead of a `Bullet` while the tank has rocket ammunition.
 * Slower, never bounces, and detonates on ANY impact — wall, tank or the end
 * of its lifetime. The blast itself is resolved by `game.js` calling
 * `explodeRocket(world, rocket.x, rocket.y, rocket.ownerIndex)` whenever it
 * removes a dead projectile with `explode === true`.
 *
 * A rocket NEVER sets `hitTankIndex`: even a direct hit is delivered by the
 * blast, so `game.js` must not score it twice.
 */
export class Rocket extends Projectile {
  /**
   * @param {number} x
   * @param {number} y
   * @param {number} angle radians
   * @param {number} ownerIndex
   * @param {object} [settings] accepted for signature compatibility with Bullet
   */
  constructor(x, y, angle, ownerIndex, settings) {
    super(x, y, angle, ownerIndex, {
      speed: CONFIG.rocket.speed,
      life: CONFIG.rocket.life,
      radius: CONFIG.bullet.radius * 1.5,
      trailLength: Math.round(CONFIG.bullet.trailLength * 1.6),
      maxBounces: 0,
    });
    this.isRocket = true;
    this.smokeTimer = 0;
  }

  /** Flags the rocket for detonation; `game.js` runs the actual blast. */
  detonate() {
    this.dead = true;
    this.explode = true;
  }

  /** @private */ onWall() { this.detonate(); }
  /** Direct hit — reported through the blast, not through `hitTankIndex`. @private */
  onTankHit() { this.detonate(); }
  /** @private */ onExpire() { this.detonate(); }

  /** Exhaust plume. @private */
  afterUpdate(dt, world) {
    if (this.dead) return;
    this.smokeTimer -= dt;
    if (this.smokeTimer > 0) return;
    this.smokeTimer = 0.028;

    makeParticles(world && world.particles, this.x, this.y, {
      count: 1, kind: 'smoke', color: '#9ca3af', speed: 34,
      life: 0.55, size: 5.5, angle: this.angle + Math.PI, spread: 0.9,
    });
  }
}

// =============================================================================
// Particles
// =============================================================================

/**
 * Per-kind defaults. Anything passed in `opts` overrides these.
 *   spark  — bright, short, fast; impacts and muzzle flashes
 *   smoke  — slow, large, drifts upwards; exhaust and dust
 *   debris — chunky, affected by gravity, spins; explosions
 *   ring   — a single expanding halo, does not travel
 */
const PARTICLE_DEFAULTS = {
  spark: { speed: 210, life: 0.42, size: 2.4, drag: 5.5, gravity: 0, spin: 0, grow: 0 },
  smoke: { speed: 55, life: 0.9, size: 9, drag: 2.2, gravity: -14, spin: 0.6, grow: 0 },
  debris: { speed: 165, life: 0.75, size: 3, drag: 2.6, gravity: 260, spin: 9, grow: 0 },
  ring: { speed: 0, life: 0.4, size: 8, drag: 0, gravity: 0, spin: 0, grow: 42 },
};

/**
 * Appends particles to `list`.
 *
 * Each particle is a plain object the renderer can read directly:
 * `{ x, y, vx, vy, life, maxLife, alpha, size, color, kind, rot }`.
 * `alpha` is kept up to date by `updateParticles()` so the renderer never has
 * to know the fade curve of a kind.
 *
 * @param {Array} list target list, usually `world.particles`
 * @param {number} x
 * @param {number} y
 * @param {{count?:number, color?:string, speed?:number, life?:number,
 *          size?:number, kind?:('spark'|'smoke'|'debris'|'ring'),
 *          angle?:number, spread?:number, grow?:number, drag?:number,
 *          gravity?:number, spin?:number, radius?:number}} [opts]
 */
export function makeParticles(list, x, y, opts) {
  if (!Array.isArray(list)) return;
  const o = opts || {};

  const kind = PARTICLE_DEFAULTS[o.kind] ? o.kind : 'spark';
  const def = PARTICLE_DEFAULTS[kind];
  const count = Math.max(0, Math.round(o.count != null ? o.count : (kind === 'ring' ? 1 : 8)));
  if (count === 0) return;

  const color = o.color || '#ffffff';
  const speed = o.speed != null ? o.speed : def.speed;
  const life = o.life != null ? o.life : def.life;
  const size = o.size != null ? o.size : def.size;
  const grow = o.grow != null ? o.grow : def.grow;
  const drag = o.drag != null ? o.drag : def.drag;
  const gravity = o.gravity != null ? o.gravity : def.gravity;
  const spin = o.spin != null ? o.spin : def.spin;
  const baseAngle = o.angle != null ? o.angle : 0;
  const spread = o.spread != null ? o.spread : TAU;
  const jitter = o.radius != null ? o.radius : 0;

  for (let i = 0; i < count; i++) {
    const dir = spread >= TAU
      ? rand(0, TAU)
      : baseAngle + rand(-spread * 0.5, spread * 0.5);
    const sp = kind === 'ring' ? 0 : speed * rand(0.45, 1);
    const ttl = life * rand(0.75, 1.15);
    const startOffset = jitter * Math.sqrt(Math.random());
    const particleSize = size * rand(0.75, 1.25);

    list.push({
      x: x + Math.cos(dir) * startOffset,
      y: y + Math.sin(dir) * startOffset,
      vx: Math.cos(dir) * sp,
      vy: Math.sin(dir) * sp,
      life: ttl,
      maxLife: ttl,
      alpha: 1,
      size: particleSize,
      baseSize: particleSize,
      grow,
      color,
      kind,
      rot: rand(0, TAU),
      spin: spin ? rand(-spin, spin) : 0,
      drag,
      gravity,
    });
  }

  // Keep the list bounded: drop the OLDEST particles when over the cap.
  if (list.length > MAX_PARTICLES) {
    list.splice(0, list.length - MAX_PARTICLES);
  }
}

/**
 * Advances every particle and removes the expired ones in place.
 * @param {Array} list
 * @param {number} dt seconds
 */
export function updateParticles(list, dt) {
  if (!Array.isArray(list)) return;

  for (let i = list.length - 1; i >= 0; i--) {
    const p = list[i];
    p.life -= dt;
    if (p.life <= 0) {
      list.splice(i, 1);
      continue;
    }

    const damping = Math.exp(-p.drag * dt);
    p.vx *= damping;
    p.vy *= damping;
    p.vy += p.gravity * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.rot += p.spin * dt;

    const remaining = p.life / p.maxLife;
    if (p.kind === 'ring') {
      // Ease-out expansion: fast at first, then settling.
      const progress = 1 - remaining;
      p.size = p.baseSize + p.grow * (1 - (1 - progress) * (1 - progress));
      p.alpha = remaining * remaining;
    } else if (p.kind === 'smoke') {
      p.alpha = remaining * 0.6;
      p.size = p.baseSize * (1 + (1 - remaining) * 0.9);
    } else {
      p.alpha = remaining;
    }
  }
}
