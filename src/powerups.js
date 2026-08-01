/**
 * Slag — power-ups, the crates that carry them, and the rocket blast.
 *
 * Four power-ups exist and their numbers live in the `POWERUPS` table below,
 * which is the single source of truth for both the gameplay modifiers and the
 * HUD (name, icon, colour).
 *
 * Crates reach the arena from two independent sources, both capped together by
 * `CONFIG.pickup.maxOnField`:
 *   1. fixed spots declared by the arena (`arena.pickups`), refilling
 *      `CONFIG.pickup.respawnTime` seconds after they are taken,
 *   2. air drops falling from the sky every `airdropInterval ± airdropJitter`
 *      seconds onto a random free patch of floor.
 *
 * INTEGRATION NOTES for game.js
 *   - `world.pickups` (Array) must exist, or it is created on first use.
 *   - `updatePickups(world, dt)` keeps its own bookkeeping on `world.pickupState`;
 *     replacing `world.arena` automatically restarts it for the new round.
 *   - `explodeRocket()` reports victims through the OPTIONAL callback
 *     `world.onHit(victimIndex, ownerIndex, x, y)`; see its documentation.
 *   - `updateTankPowerups()` is already called by `Tank.update()`. Do not call
 *     it a second time for tanks that are being updated normally.
 */

import { CONFIG } from './config.js';
import { clamp, dist, rand, pick } from './util.js';
import { resolveCircle } from './arena.js';
import { Audio } from './audio.js';
import { Input } from './input.js';
import { makeParticles } from './entities.js';

const TAU = Math.PI * 2;

/** How long the HUD icon flashes after a pickup, in seconds. */
const PICKUP_FLASH_TIME = 0.7;
/** Short mercy invulnerability granted when a shield absorbs a hit. */
const SHIELD_INVULN = 0.9;
/** Knock-back applied by an absorbed hit / a rocket blast (px/s). */
const SHIELD_KNOCKBACK = 210;
const BLAST_KNOCKBACK = 320;
/** Minimum clearance from walls, tanks and other crates when placing a drop. */
const DROP_WALL_CLEARANCE = 10;
const DROP_TANK_CLEARANCE = 90;
const DROP_PICKUP_CLEARANCE = 120;

// =============================================================================
// The four power-ups
// =============================================================================

/**
 * `mods` maps a `CONFIG.tank` key to a modifier resolved by `effective()`:
 * `{ mul }` scales the base value, `{ add }` offsets it. Only power-ups with a
 * `timerKey` whose timer is running contribute.
 *
 * `kind` tells the HUD how to render the remaining charge:
 *   'timed'  — shrinking bar driven by `tank.powerups[timerKey]`
 *   'ammo'   — remaining shot count (`tank.rocketAmmo`)
 *   'shield' — number of hearts (`tank.shields`)
 */
export const POWERUPS = [
  {
    id: 'rapid',
    name: 'Gyorstűz',
    icon: '⚡',
    color: '#eab308',
    light: '#fde047',
    kind: 'timed',
    timerKey: 'rapid',
    duration: CONFIG.powerup.rapidTime,
    desc: 'Villámgyors újratöltés és több lövedék a levegőben.',
    mods: {
      reloadTime: { mul: 0.32 },
      maxActiveBullets: { add: 3 },
    },
  },
  {
    id: 'rocket',
    name: 'Rakéta',
    icon: '🚀',
    color: '#f97316',
    light: '#fdba74',
    kind: 'ammo',
    timerKey: null,
    duration: 0,
    desc: 'A következő három lövés robbanó rakéta.',
    mods: null,
  },
  {
    id: 'speed',
    name: 'Nitró',
    icon: '💨',
    color: '#06b6d4',
    light: '#67e8f9',
    kind: 'timed',
    timerKey: 'speed',
    duration: CONFIG.powerup.speedTime,
    desc: 'Nagyobb végsebesség, gyorsulás és fordulékonyság.',
    mods: {
      maxSpeed: { mul: 1.45 },
      accel: { mul: 1.5 },
      turnSpeed: { mul: 1.25 },
    },
  },
  {
    id: 'life',
    name: 'Pajzs',
    icon: '❤',
    color: '#ef4444',
    light: '#fca5a5',
    kind: 'shield',
    timerKey: null,
    duration: 0,
    desc: 'Elnyeli a következő halálos találatot.',
    mods: null,
  },
];

/**
 * Looks up a power-up definition by id.
 * @param {string} id
 * @returns {object|null}
 */
export function getPowerup(id) {
  for (let i = 0; i < POWERUPS.length; i++) {
    if (POWERUPS[i].id === id) return POWERUPS[i];
  }
  return null;
}

// =============================================================================
// Tank side: modifiers and timers
// =============================================================================

/** Makes sure a tank carries the power-up fields, even if built elsewhere. */
function ensureTankFields(tank) {
  if (!tank.powerups || typeof tank.powerups !== 'object') {
    tank.powerups = { rapid: 0, speed: 0 };
  }
  if (!Number.isFinite(tank.powerups.rapid)) tank.powerups.rapid = 0;
  if (!Number.isFinite(tank.powerups.speed)) tank.powerups.speed = 0;
  if (!Number.isFinite(tank.rocketAmmo)) tank.rocketAmmo = 0;
  if (!Number.isFinite(tank.shields)) tank.shields = 0;
  if (!Number.isFinite(tank.pickupFlash)) tank.pickupFlash = 0;
}

/**
 * THE central modifier resolver. Every piece of gameplay code reads tank
 * movement and shooting numbers through this function instead of touching
 * `CONFIG.tank.*` directly, so active power-ups are never forgotten.
 *
 * Supported keys: 'maxSpeed', 'accel', 'turnSpeed', 'reloadTime',
 * 'maxActiveBullets'. Any other `CONFIG.tank` key is returned unmodified.
 *
 * @param {object} tank
 * @param {string} key
 * @returns {number} the modified value
 */
export function effective(tank, key) {
  const base = CONFIG.tank[key];
  if (!Number.isFinite(base)) return base;
  if (!tank || !tank.powerups) return base;

  let value = base;
  for (let i = 0; i < POWERUPS.length; i++) {
    const def = POWERUPS[i];
    if (!def.mods || !def.timerKey) continue;
    const mod = def.mods[key];
    if (!mod) continue;
    if (!(tank.powerups[def.timerKey] > 0)) continue;
    if (mod.mul != null) value *= mod.mul;
    if (mod.add != null) value += mod.add;
  }
  return value;
}

/**
 * Ticks the timed power-ups and the HUD flash of a single tank.
 *
 * `Tank.update()` calls this already — `game.js` only needs it for tanks it
 * updates by hand (there should be none).
 *
 * @param {object} tank
 * @param {number} dt seconds
 */
export function updateTankPowerups(tank, dt) {
  if (!tank) return;
  ensureTankFields(tank);

  const timers = tank.powerups;
  if (timers.rapid > 0) timers.rapid = Math.max(0, timers.rapid - dt);
  if (timers.speed > 0) timers.speed = Math.max(0, timers.speed - dt);
  if (tank.pickupFlash > 0) tank.pickupFlash = Math.max(0, tank.pickupFlash - dt);
}

/**
 * Grants a power-up to a tank.
 *
 * Timed power-ups RESTART their timer instead of accumulating, the rocket
 * pickup SETS the ammunition to `rocketShots` (so it never exceeds 3) and
 * shields stack up to `CONFIG.powerup.maxShields`.
 *
 * @param {object} tank
 * @param {string} defId one of 'rapid' | 'rocket' | 'speed' | 'life'
 * @param {object} [world] unused today, kept for the module contract
 * @returns {object|null} the applied definition
 */
export function applyPowerup(tank, defId, world) {
  if (!tank) return null;
  const def = getPowerup(defId);
  if (!def) return null;

  ensureTankFields(tank);

  switch (def.id) {
    case 'rapid':
      tank.powerups.rapid = CONFIG.powerup.rapidTime;
      break;
    case 'speed':
      tank.powerups.speed = CONFIG.powerup.speedTime;
      break;
    case 'rocket':
      tank.rocketAmmo = CONFIG.powerup.rocketShots;
      break;
    case 'life':
      tank.shields = Math.min(tank.shields + 1, CONFIG.powerup.maxShields);
      break;
    default:
      break;
  }

  tank.pickupFlash = PICKUP_FLASH_TIME;
  tank.lastPickupId = def.id;
  return def;
}

/**
 * Spends one shield to absorb an otherwise lethal hit: the tank survives, is
 * knocked away from the impact and gets a short mercy invulnerability.
 *
 * `game.js` should call this for bullet hits before killing a tank; the rocket
 * blast below already uses it internally.
 *
 * @param {object} tank
 * @param {object} world
 * @param {number} srcX impact position (for the knock-back direction)
 * @param {number} srcY
 * @returns {boolean} true when a shield absorbed the hit
 */
export function consumeShield(tank, world, srcX, srcY) {
  if (!tank || !tank.alive) return false;
  ensureTankFields(tank);
  if (tank.shields <= 0) return false;

  tank.shields -= 1;
  tank.invulnTimer = Math.max(tank.invulnTimer || 0, SHIELD_INVULN);
  tank.hitFlash = CONFIG.tank.hitFlashTime;
  applyKnockback(tank, srcX, srcY, SHIELD_KNOCKBACK);

  const shieldDef = getPowerup('life');
  makeParticles(world && world.particles, tank.x, tank.y, {
    count: 1, kind: 'ring', color: shieldDef.light, life: 0.42, size: tank.radius, grow: 34,
  });
  makeParticles(world && world.particles, tank.x, tank.y, {
    count: 12, kind: 'spark', color: shieldDef.color, speed: 200, life: 0.35, size: 2.4,
  });
  Audio.play('shieldBreak', { pan: panAt(world, tank.x) });
  Input.rumble(tank.deviceId, 0.8, 0.5, 220);
  return true;
}

// =============================================================================
// Pickups on the arena floor
// =============================================================================

/**
 * A crate lying on (or falling towards) the arena floor.
 *
 * `state`:
 *   'falling' — air drop still in the air, NOT collectible; `fallT` runs 0 → 1
 *   'idle'    — on the ground, bobbing, collectible
 *   'taken'   — collected this frame, removed by `updatePickups()`
 */
export class Pickup {
  /**
   * @param {number} x
   * @param {number} y
   * @param {string} defId power-up id carried by the crate
   * @param {{falling?:boolean, spotIndex?:number}} [opts]
   */
  constructor(x, y, defId, opts) {
    const o = opts || {};
    this.x = x;
    this.y = y;
    this.defId = defId;
    this.state = o.falling ? 'falling' : 'idle';
    /** 0 while high in the sky, 1 once landed. */
    this.fallT = o.falling ? 0 : 1;
    /** Phase of the hovering animation. */
    this.bob = rand(0, TAU);
    /** Rotation of the crate, radians. */
    this.spin = rand(0, TAU);
    this.dead = false;
    this.age = 0;
    /** Index into the arena's fixed spot list, or -1 for an air drop. */
    this.spotIndex = Number.isFinite(o.spotIndex) ? o.spotIndex : -1;
  }

  /** The power-up definition this crate carries. */
  get def() {
    return getPowerup(this.defId);
  }
}

/** Ensures `world.pickups` exists and returns it. */
function ensureList(world) {
  if (!Array.isArray(world.pickups)) world.pickups = [];
  return world.pickups;
}

/** Random delay until the next air drop. */
function nextAirdropDelay() {
  const jitter = CONFIG.pickup.airdropJitter;
  return Math.max(4, CONFIG.pickup.airdropInterval + rand(-jitter, jitter));
}

/**
 * Bookkeeping attached to `world.pickupState`. It is rebuilt automatically
 * whenever `world.arena` is replaced (new round / new arena), which also
 * clears the crates left over from the previous arena.
 */
function getStore(world) {
  const store = world.pickupState;
  if (store && store.arena === world.arena) return store;

  const arena = world.arena;
  const source = arena && Array.isArray(arena.pickups) ? arena.pickups : [];
  const spots = [];
  for (let i = 0; i < source.length; i++) {
    spots.push({ x: source[i].x, y: source[i].y, timer: 0, occupied: false });
  }

  ensureList(world).length = 0;
  world.pickupState = {
    arena,
    spots,
    // The first drop comes a bit earlier than the steady-state interval so a
    // short round still sees one.
    airdropTimer: nextAirdropDelay() * 0.6,
    seeded: false,
  };
  return world.pickupState;
}

/** Number of crates that currently occupy a slot (falling ones included). */
function countOnField(world) {
  const list = ensureList(world);
  let n = 0;
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (!p.dead && p.state !== 'taken') n += 1;
  }
  return n;
}

/** True while another crate may be added without breaking `maxOnField`. */
function canSpawnMore(world) {
  return countOnField(world) < CONFIG.pickup.maxOnField;
}

/** Picks a random power-up id. */
function randomPowerupId() {
  const def = pick(POWERUPS);
  return def ? def.id : POWERUPS[0].id;
}

/** Stereo pan (-1..1) from a world X coordinate. */
function panAt(world, x) {
  const width = (world && world.arena && world.arena.width) || CONFIG.arena.width;
  return clamp((x / width) * 2 - 1, -1, 1) * 0.8;
}

/** Adds screen shake, clamped to `CONFIG.fx.maxShake`. */
function addShake(world, amount) {
  if (!world || !world.fx) return;
  const current = Number.isFinite(world.fx.shake) ? world.fx.shake : 0;
  world.fx.shake = Math.min(current + amount, CONFIG.fx.maxShake);
}

/** Pushes a tank away from an impact point. */
function applyKnockback(tank, srcX, srcY, strength) {
  let dx = tank.x - srcX;
  let dy = tank.y - srcY;
  const d = Math.hypot(dx, dy);
  if (d < 0.0001) {
    // Dead centre: shove it in a random direction rather than not at all.
    const a = rand(0, TAU);
    dx = Math.cos(a);
    dy = Math.sin(a);
  } else {
    dx /= d;
    dy /= d;
  }
  tank.vx += dx * strength;
  tank.vy += dy * strength;
}

/**
 * Finds a random spot on the floor that is clear of walls, tanks and other
 * crates. Returns `null` when no candidate was found.
 */
function findFreeSpot(world, tries) {
  const arena = world.arena;
  if (!arena || !arena.walls) return null;

  const width = arena.width || CONFIG.arena.width;
  const height = arena.height || CONFIG.arena.height;
  const radius = CONFIG.pickup.radius;
  const margin = CONFIG.arena.wallThickness + radius + DROP_WALL_CLEARANCE;
  const attempts = tries || 60;
  const list = ensureList(world);
  const tanks = world.tanks || [];

  for (let i = 0; i < attempts; i++) {
    const x = rand(margin, width - margin);
    const y = rand(margin, height - margin);

    // Clear of geometry, with a little breathing room around the crate.
    const res = resolveCircle(x, y, radius + DROP_WALL_CLEARANCE, arena.walls);
    if (res && res.hit) continue;

    let blocked = false;
    for (let t = 0; t < tanks.length && !blocked; t++) {
      const tank = tanks[t];
      if (tank && tank.alive && dist(x, y, tank.x, tank.y) < DROP_TANK_CLEARANCE) blocked = true;
    }
    for (let p = 0; p < list.length && !blocked; p++) {
      const other = list[p];
      if (!other.dead && dist(x, y, other.x, other.y) < DROP_PICKUP_CLEARANCE) blocked = true;
    }
    if (blocked) continue;

    return { x, y };
  }
  return null;
}

/**
 * Creates a crate and adds it to `world.pickups`.
 *
 * @param {object} world
 * @param {{x?:number, y?:number, defId?:string, falling?:boolean,
 *          spotIndex?:number, force?:boolean}} [opts]
 *        Without `x`/`y` a random free position is searched. `falling: true`
 *        starts the air-drop animation. `force: true` bypasses `maxOnField`.
 * @returns {Pickup|null} the new crate, or null when it could not be placed
 */
export function spawnPickup(world, opts) {
  if (!world) return null;
  const o = opts || {};
  const list = ensureList(world);

  if (!o.force && !canSpawnMore(world)) return null;

  const def = getPowerup(o.defId);
  const defId = def ? def.id : randomPowerupId();

  let x = o.x;
  let y = o.y;
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    const spot = findFreeSpot(world);
    if (!spot) return null;
    x = spot.x;
    y = spot.y;
  }

  const pickup = new Pickup(x, y, defId, {
    falling: !!o.falling,
    spotIndex: o.spotIndex,
  });
  list.push(pickup);
  return pickup;
}

/** Fills a fixed arena spot with a randomly chosen power-up. */
function spawnAtSpot(world, spot, index) {
  const pickup = spawnPickup(world, { x: spot.x, y: spot.y, spotIndex: index });
  if (!pickup) return false;
  spot.occupied = true;
  spot.timer = 0;
  return true;
}

/** Fills every fixed spot at the start of a round, honouring `maxOnField`. */
function seedSpots(world, store) {
  for (let i = 0; i < store.spots.length; i++) {
    if (!canSpawnMore(world)) break;
    spawnAtSpot(world, store.spots[i], i);
  }
}

/** Drops a crate from the sky onto a random free patch of floor. */
function tryAirdrop(world) {
  return spawnPickup(world, { falling: true });
}

/** Air drop touchdown: dust, shake and the landing cue. */
function landAirdrop(pickup, world) {
  pickup.state = 'idle';
  pickup.fallT = 1;

  const def = pickup.def;
  makeParticles(world.particles, pickup.x, pickup.y, {
    count: 16, kind: 'smoke', color: '#a8a29e', speed: 150,
    life: 0.75, size: 8, radius: CONFIG.pickup.radius,
  });
  makeParticles(world.particles, pickup.x, pickup.y, {
    count: 8, kind: 'debris', color: '#78716c', speed: 180, life: 0.6, size: 2.6,
  });
  makeParticles(world.particles, pickup.x, pickup.y, {
    count: 1, kind: 'ring', color: def ? def.light : '#ffffff',
    life: 0.5, size: CONFIG.pickup.radius, grow: 52,
  });
  addShake(world, 7);
  Audio.play('airdrop', { pan: panAt(world, pickup.x) });
}

/** Hands the crate's power-up to a tank and marks it for removal. */
function collect(pickup, tank, world) {
  const def = applyPowerup(tank, pickup.defId, world);
  pickup.state = 'taken';
  pickup.dead = true;

  const color = def ? def.color : '#ffffff';
  const light = def ? def.light : '#ffffff';
  makeParticles(world.particles, pickup.x, pickup.y, {
    count: 1, kind: 'ring', color: light, life: 0.45, size: CONFIG.pickup.radius, grow: 46,
  });
  makeParticles(world.particles, pickup.x, pickup.y, {
    count: 18, kind: 'spark', color, speed: 210, life: 0.45, size: 2.6,
  });
  Audio.play('pickup', { pan: panAt(world, pickup.x) });
  Input.rumble(tank.deviceId, 0.35, 0.6, 160);
}

/** Advances one crate: falling animation, idle bobbing, collection test. */
function updateOne(pickup, world, dt) {
  pickup.age += dt;
  pickup.bob += dt * 2.4;
  pickup.spin += dt * 1.6;
  if (pickup.bob > TAU) pickup.bob -= TAU;
  if (pickup.spin > TAU) pickup.spin -= TAU;

  if (pickup.state === 'falling') {
    pickup.fallT = Math.min(1, pickup.fallT + dt / CONFIG.pickup.airdropFallTime);
    // A crate in the air cannot be collected.
    if (pickup.fallT >= 1) landAirdrop(pickup, world);
    return;
  }

  if (pickup.state !== 'idle' || pickup.dead) return;

  const tanks = world.tanks || [];
  for (let i = 0; i < tanks.length; i++) {
    const tank = tanks[i];
    if (!tank || !tank.alive) continue;
    const reach = CONFIG.pickup.radius + (tank.radius || CONFIG.tank.radius);
    if (dist(pickup.x, pickup.y, tank.x, tank.y) > reach) continue;
    collect(pickup, tank, world);
    return;
  }
}

/**
 * Drives the whole pickup system for one step: fixed-spot respawn timers, the
 * air-drop schedule, per-crate animation and collection.
 *
 * @param {object} world `{ arena, tanks, particles, fx, pickups }`
 * @param {number} dt seconds
 */
export function updatePickups(world, dt) {
  if (!world || !world.arena) return;

  const list = ensureList(world);
  const store = getStore(world);

  if (!store.seeded) {
    store.seeded = true;
    seedSpots(world, store);
  }

  // Fixed spots refill `respawnTime` seconds after being emptied.
  for (let i = 0; i < store.spots.length; i++) {
    const spot = store.spots[i];
    if (spot.occupied) continue;
    spot.timer -= dt;
    if (spot.timer > 0) continue;
    if (!canSpawnMore(world)) continue;
    spawnAtSpot(world, spot, i);
  }

  // Air drops.
  store.airdropTimer -= dt;
  if (store.airdropTimer <= 0) {
    store.airdropTimer = nextAirdropDelay();
    if (canSpawnMore(world)) tryAirdrop(world);
  }

  // Animate, collect, and sweep the collected ones.
  for (let i = list.length - 1; i >= 0; i--) {
    const pickup = list[i];
    updateOne(pickup, world, dt);
    if (!pickup.dead) continue;

    const spot = pickup.spotIndex >= 0 ? store.spots[pickup.spotIndex] : null;
    if (spot) {
      spot.occupied = false;
      spot.timer = CONFIG.pickup.respawnTime;
    }
    list.splice(i, 1);
  }
}

// =============================================================================
// Rocket blast
// =============================================================================

/**
 * Detonates a rocket at `x, y`.
 *
 * Called by `game.js` for every dead projectile whose `explode` flag is set.
 * The blast ignores walls (deliberate simplification — no line of sight test).
 *
 * Victim handling, in order, for every living tank within
 * `CONFIG.rocket.blastRadius`:
 *   - invulnerable tanks are skipped entirely,
 *   - everybody else is knocked away from the centre,
 *   - a tank holding a shield spends it, survives, and is NOT reported,
 *   - anyone else is reported as a hit.
 *
 * A hit is reported BOTH ways, and `game.js` must consume exactly one of them:
 *   - `world.onHit(victimIndex, ownerIndex, x, y)` is invoked when present,
 *   - and the same victim indices are returned as an array.
 * The owner appears among the victims like anyone else, so `game.js` can score
 * it as an own goal by comparing `victimIndex === ownerIndex`.
 *
 * @param {object} world
 * @param {number} x blast centre
 * @param {number} y blast centre
 * @param {number} ownerIndex index of the tank that fired the rocket
 * @returns {number[]} indices of the tanks that took the hit
 */
export function explodeRocket(world, x, y, ownerIndex) {
  const victims = [];
  if (!world) return victims;

  const particles = world.particles;
  const blast = CONFIG.rocket.blastRadius;

  // --- visuals and audio ---
  makeParticles(particles, x, y, {
    count: 1, kind: 'ring', color: '#fed7aa', life: 0.5, size: 14, grow: blast,
  });
  makeParticles(particles, x, y, {
    count: 30, kind: 'spark', color: '#fbbf24', speed: 430, life: 0.5, size: 3.2,
  });
  makeParticles(particles, x, y, {
    count: 16, kind: 'debris', color: '#f97316', speed: 260, life: 0.8, size: 3.2,
  });
  makeParticles(particles, x, y, {
    count: 14, kind: 'smoke', color: '#57534e', speed: 95, life: 1.2, size: 13,
    radius: blast * 0.35,
  });
  addShake(world, 14);
  Audio.play('explode', { pan: panAt(world, x) });

  // --- area damage ---
  const tanks = world.tanks || [];
  for (let i = 0; i < tanks.length; i++) {
    const tank = tanks[i];
    if (!tank || !tank.alive) continue;
    if (tank.invulnTimer > 0) continue;
    if (dist(x, y, tank.x, tank.y) > blast) continue;

    applyKnockback(tank, x, y, BLAST_KNOCKBACK);

    // A shield eats the blast: the tank survives and nobody scores.
    if (consumeShield(tank, world, x, y)) continue;

    victims.push(tank.index);
    if (typeof world.onHit === 'function') {
      world.onHit(tank.index, ownerIndex, x, y);
    }
  }

  return victims;
}
