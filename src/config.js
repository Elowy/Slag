/**
 * Slag — central tuning table.
 *
 * Every gameplay-relevant number lives here so the game feel can be tuned
 * without touching logic. All units are SI-ish and framerate independent:
 *   - distances / radii : arena pixels (the logical playfield is 1600x900)
 *   - speeds            : pixels per second
 *   - accelerations     : pixels per second squared
 *   - times / durations : seconds
 *   - angular speeds    : radians per second
 *
 * NOTE: `CONFIG.tank.*` movement/shooting values are BASE values only.
 * Gameplay code must read them through `effective(tank, key)` from
 * `./powerups.js`, so active power-ups are always taken into account.
 */
export const CONFIG = {
  // ---------------------------------------------------------------------
  // Arena — fixed logical resolution. The canvas is letterboxed to 16:9,
  // so these numbers never change at runtime.
  // ---------------------------------------------------------------------
  arena: {
    width: 1600,          // logical playfield width in pixels
    height: 900,          // logical playfield height in pixels
    wallThickness: 24,    // thickness of the four outer border walls
  },

  // ---------------------------------------------------------------------
  // Tank — the single most important block for game feel.
  //  * higher `accel` + higher `friction` = snappier, more arcade-like
  //  * higher `turnSpeed`                 = the hull snaps to the stick faster
  //  * lower `reloadTime`                 = more bullets in the air
  // ---------------------------------------------------------------------
  tank: {
    radius: 21,           // collision radius of the hull (couch-readable on a TV)
    maxSpeed: 205,        // top speed at full right-stick deflection
    accel: 1100,          // how hard the tank pushes towards the desired velocity
    friction: 7.5,        // exponential velocity damping (higher = stops sooner)
    turnSpeed: 7.0,       // hull rotation speed towards the movement direction
    turretTurnSpeed: 9.0, // turret rotation speed (aiming feels crisper than the hull)
    barrelLength: 33,     // muzzle offset from the tank centre; bullets spawn here
    reloadTime: 0.42,     // seconds between two shots
    maxActiveBullets: 5,  // how many of this tank's bullets may live at once
    respawnDelay: 2.0,    // seconds spent dead before respawning
    spawnInvuln: 2.2,     // invulnerability (blinking) after respawn
    hitFlashTime: 0.18,   // duration of the white "I got hit" flash
  },

  // ---------------------------------------------------------------------
  // Bullet — `maxBounces` is FIXED at 2 by design. The lobby toggle only
  // switches bouncing on (2 bounces) or off (0 bounces); it never raises
  // this number.
  // ---------------------------------------------------------------------
  bullet: {
    radius: 4.5,          // collision radius of a projectile
    speed: 430,           // muzzle velocity
    life: 2.8,            // seconds before the bullet fizzles out on its own
                          // (kept short so bounced shells cannot loiter and
                          //  drift back into their own shooter)
    maxBounces: 2,        // FIXED: wall bounces before the bullet dies
    selfHitGrace: 0.18,   // a fresh, unbounced bullet cannot hit its owner for this long
    trailLength: 10,      // number of stored trail samples (visual only)
  },

  // ---------------------------------------------------------------------
  // Match flow.
  // ---------------------------------------------------------------------
  match: {
    pointsToWin: 15,      // default score limit (adjustable in the lobby)
    maxPlayers: 4,        // number of player slots
    countdown: 3.0,       // "3, 2, 1, GO!" length before a round starts
    endScreenDelay: 5.0,  // how long the winner screen stays before it can be skipped
  },

  // ---------------------------------------------------------------------
  // Input — analog stick / trigger shaping.
  // ---------------------------------------------------------------------
  input: {
    deadzone: 0.26,       // radial deadzone; the remainder is renormalised to 0..1
    triggerThreshold: 0.35, // R2 value counted as "pressed" (edge detection)
    turretIdleReturn: 3.0, // seconds of idle left stick before the turret returns to 'follow'
  },

  // ---------------------------------------------------------------------
  // Screen effects.
  // ---------------------------------------------------------------------
  fx: {
    shakeDecay: 6.0,      // exponential decay rate of the screen shake
    maxShake: 16,         // shake amplitude clamp in pixels
  },

  // ---------------------------------------------------------------------
  // Pickups (crates lying on the arena and air-dropped ones).
  // ---------------------------------------------------------------------
  pickup: {
    radius: 16,           // pickup radius; collected when tank centre is within radius + tank.radius
    respawnTime: 18,      // seconds until a fixed arena spot refills after being taken
    airdropInterval: 22,  // average seconds between air drops
    airdropJitter: 6,     // +/- random jitter applied to `airdropInterval`
    airdropFallTime: 1.4, // seconds the crate spends falling (not collectible meanwhile)
    maxOnField: 4,        // hard cap of simultaneously present pickups
  },

  // ---------------------------------------------------------------------
  // Rocket — fired instead of a normal bullet while `rocketAmmo > 0`.
  // Slower, does not bounce, explodes in an area on any impact.
  // ---------------------------------------------------------------------
  rocket: {
    speed: 267,           // muzzle velocity (~ bullet.speed * 0.62)
    blastRadius: 95,      // everything inside this radius is hit, walls do not block it
    life: 3.5,            // seconds before the rocket self-destructs
  },

  // ---------------------------------------------------------------------
  // Power-up durations and stack limits.
  // ---------------------------------------------------------------------
  powerup: {
    rapidTime: 12,        // 'rapid' (Gyorstűz) duration in seconds
    speedTime: 12,        // 'speed' (Nitró) duration in seconds
    rocketShots: 3,       // rockets granted by one 'rocket' (Rakéta) pickup
    maxShields: 2,        // maximum stacked shields from 'life' (Pajzs)
  },
};

/**
 * Player colours. Eight well separated hues with clearly different lightness,
 * so they stay distinguishable for colour-blind players too.
 * `name` is the Hungarian label shown in the lobby; `id` is the stable key
 * stored in `PlayerSlot.colorId`.
 *   main  — hull / primary colour
 *   dark  — treads, outlines, shadowed parts
 *   light — highlights, turret rim, HUD accents
 */
export const PALETTE = [
  { id: 'red',    name: 'Piros',   main: '#ef4444', dark: '#7f1d1d', light: '#fca5a5' },
  { id: 'blue',   name: 'Kék',     main: '#3b82f6', dark: '#1e3a8a', light: '#93c5fd' },
  { id: 'green',  name: 'Zöld',    main: '#22c55e', dark: '#14532d', light: '#86efac' },
  { id: 'yellow', name: 'Sárga',   main: '#eab308', dark: '#713f12', light: '#fde047' },
  { id: 'purple', name: 'Lila',    main: '#a855f7', dark: '#4c1d95', light: '#d8b4fe' },
  { id: 'cyan',   name: 'Türkiz',  main: '#06b6d4', dark: '#164e63', light: '#67e8f9' },
  { id: 'orange', name: 'Narancs', main: '#f97316', dark: '#7c2d12', light: '#fdba74' },
  { id: 'pink',   name: 'Rózsa',   main: '#ec4899', dark: '#831843', light: '#f9a8d4' },
];
