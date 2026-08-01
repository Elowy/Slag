/**
 * Slag — arena definitions, geometry helpers and circle/AABB collision.
 *
 * LEVEL DESIGN CONTRACT
 * ---------------------
 * Every arena is authored in the fixed 1600x900 logical playfield and is
 * **180 degree rotationally symmetric** around the arena centre, i.e. the
 * point mapping `(x, y) -> (W - x, H - y)` maps the layout onto itself.
 * That guarantees all four spawn points are strategically equivalent, which
 * matters a lot in a four player free-for-all.
 *
 * To make the symmetry impossible to get wrong by hand, each arena is written
 * as a *half definition*: only one of every mirrored pair is spelled out and
 * `defineArena()` generates the counterpart. Elements that sit exactly on the
 * arena centre are point symmetric on their own and are emitted only once.
 * The result is still fully deterministic and inspectable.
 *
 * Design rules enforced by `validateArena()`:
 *   - no spawn point has a clear line of sight to another spawn point
 *   - every corridor a tank has to use is at least `MIN_CORRIDOR` px wide
 *   - no unreachable pockets: all spawns and pickups are mutually reachable
 *   - 2..4 neutral pickup spots per arena, mirrored like everything else
 */

import { CONFIG } from './config.js';
import { clamp, dist, rand } from './util.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Authoring width/height. The whole level design assumes exactly these. */
const AW = CONFIG.arena.width;
const AH = CONFIG.arena.height;

const TAU = Math.PI * 2;
const QUARTER = Math.PI * 0.25;

/** Maximum push-out passes performed by `resolveCircle`. */
const MAX_RESOLVE_ITERATIONS = 4;

/** Narrowest passage a tank should ever be forced through (design rule). */
const MIN_CORRIDOR = 56;

/** Default number of random samples taken by `findFreePosition`. */
const FREE_POSITION_ATTEMPTS = 160;

/** A pickup closer than this to a spawn would not be a neutral objective. */
const NEUTRAL_PICKUP_DISTANCE = 220;

/**
 * Lowest Y a corner spawn may use.
 *
 * `render.js` parks a permanent player card in each of the four screen corners
 * (326x106 px, 14 px from the edge), so a spawn placed in the geometric corner
 * of the arena starts the round underneath its own HUD. Corner spawns are
 * therefore pushed down to this line — still in their corner tactically, but
 * clear of the card by a full tank width. The 180 degree mirror puts the
 * bottom pair at `AH - HUD_SAFE_Y`, which clears the bottom cards the same way.
 */
const HUD_SAFE_Y = 155;

// ---------------------------------------------------------------------------
// Types (JSDoc only — this project ships plain ES modules)
// ---------------------------------------------------------------------------

/**
 * @typedef {{ x:number, y:number, w:number, h:number }} Wall
 *   Axis aligned box, top-left corner plus size, in arena coordinates.
 * @typedef {{ x:number, y:number, angle:number }} Spawn
 * @typedef {{ x:number, y:number }} Point
 * @typedef {{ id:string, name:string, walls:Wall[], spawns:Spawn[], pickups:Point[] }} ArenaDef
 * @typedef {{ id:string, name:string, width:number, height:number,
 *             walls:Wall[], spawns:Spawn[], pickups:Point[] }} Arena
 */

// ---------------------------------------------------------------------------
// Authoring helpers
// ---------------------------------------------------------------------------

/** @returns {Wall} */
function rect(x, y, w, h) {
  return { x, y, w, h };
}

/** Square pillar given by its centre. @returns {Wall} */
function pillar(cx, cy, size = 64) {
  return { x: cx - size / 2, y: cy - size / 2, w: size, h: size };
}

/** @returns {Spawn} */
function spawn(x, y, angle) {
  return { x, y, angle };
}

/** @returns {Point} */
function pt(x, y) {
  return { x, y };
}

/** Wraps an angle into (-PI, PI]. */
function wrapAngle(a) {
  let r = a % TAU;
  if (r > Math.PI) r -= TAU;
  if (r <= -Math.PI) r += TAU;
  return r;
}

/** 180 degree rotation of a wall around the arena centre. */
function mirrorWall(w) {
  return { x: AW - w.x - w.w, y: AH - w.y - w.h, w: w.w, h: w.h };
}

/** 180 degree rotation of a spawn (position and facing). */
function mirrorSpawn(s) {
  return { x: AW - s.x, y: AH - s.y, angle: wrapAngle(s.angle + Math.PI) };
}

/** 180 degree rotation of a plain point. */
function mirrorPoint(p) {
  return { x: AW - p.x, y: AH - p.y };
}

const EPS = 0.001;

function sameWall(a, b) {
  return Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS
      && Math.abs(a.w - b.w) < EPS && Math.abs(a.h - b.h) < EPS;
}

function samePoint(a, b) {
  return Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS;
}

function sameSpawn(a, b) {
  return samePoint(a, b) && Math.abs(wrapAngle(a.angle - b.angle)) < EPS;
}

/**
 * Expands a half definition into the full, point symmetric list.
 * Self symmetric items (their own mirror image) are emitted once.
 */
function expand(items, mirror, same) {
  const out = [];
  for (const item of items) {
    out.push(item);
    const m = mirror(item);
    if (!same(item, m)) out.push(m);
  }
  return out;
}

/**
 * Builds a full `ArenaDef` from a half definition.
 * @param {{ id:string, name:string, walls:Wall[], spawns:Spawn[], pickups:Point[] }} half
 * @returns {ArenaDef}
 */
function defineArena(half) {
  return {
    id: half.id,
    name: half.name,
    walls: expand(half.walls, mirrorWall, sameWall),
    spawns: expand(half.spawns, mirrorSpawn, sameSpawn),
    pickups: expand(half.pickups, mirrorPoint, samePoint),
  };
}

// ---------------------------------------------------------------------------
// The arenas
// ---------------------------------------------------------------------------

/**
 * Hand designed arenas. Only the "first half" of every mirrored pair is
 * written down; `defineArena()` produces the 180 degree counterparts.
 *
 * @type {ArenaDef[]}
 */
export const ARENAS = [
  // -------------------------------------------------------------------------
  // 1. Kereszttűz — a big central cross plus four sight blockers. Very open,
  //    fast, lots of long bounce lines along the outer ring.
  // -------------------------------------------------------------------------
  defineArena({
    id: 'crossfire',
    name: 'Kereszttűz',
    walls: [
      rect(640, 438, 320, 24),  // cross: horizontal arm (self symmetric)
      rect(788, 300, 24, 138),  // cross: upper vertical arm (mirror = lower arm)
      rect(380, 0, 24, 230),    // hangs from the top edge, cuts the top sight line
      rect(0, 380, 250, 24),    // sticks out of the left edge, cuts the left sight line
      rect(540, 150, 24, 150),  // inner baffle, cover on the way to the centre
      rect(300, 620, 130, 24),  // outer baffle in the lower left quadrant
    ],
    spawns: [
      // The Y is kept below the HUD card band (see HUD_SAFE_Y): the four
      // corner cards of render.js would otherwise cover the tanks during the
      // whole countdown, and nobody could find their own machine.
      spawn(140, HUD_SAFE_Y, QUARTER),        // top-left, facing the centre
      spawn(1460, HUD_SAFE_Y, Math.PI - QUARTER), // top-right, facing the centre
    ],
    pickups: [
      pt(800, 190),  // north of the cross, in the open
      pt(330, 450),  // west pocket, equidistant from both left spawns
    ],
  }),

  // -------------------------------------------------------------------------
  // 2. Négy Sarok — four corner rooms with a diagonal doorway, an open middle
  //    with a fat central block. Camping is punished by the wide-open middle.
  // -------------------------------------------------------------------------
  defineArena({
    id: 'corners',
    name: 'Négy Sarok',
    walls: [
      rect(336, 0, 24, 240),    // top-left room: vertical side
      rect(0, 336, 240, 24),    // top-left room: horizontal side
      rect(1240, 0, 24, 240),   // top-right room: vertical side
      rect(1360, 336, 240, 24), // top-right room: horizontal side
      rect(700, 390, 200, 120), // central block (self symmetric)
      rect(776, 120, 48, 160),  // northern tusk above the central block
    ],
    spawns: [
      spawn(110, HUD_SAFE_Y, QUARTER),
      spawn(1490, HUD_SAFE_Y, Math.PI - QUARTER),
    ],
    pickups: [
      pt(800, 340),  // right above the central block — the hottest spot
      pt(450, 450),  // western no-man's land
    ],
  }),

  // -------------------------------------------------------------------------
  // 3. Labirintus — two long interlocking arms forming a pinwheel, with short
  //    spurs. Corridors are 76-150 px wide: tight, but always drivable.
  // -------------------------------------------------------------------------
  defineArena({
    id: 'labyrinth',
    name: 'Labirintus',
    walls: [
      rect(300, 250, 700, 24),  // pinwheel arm: long horizontal (mirror = lower arm)
      rect(1000, 250, 24, 300), // pinwheel arm: descending vertical
      rect(700, 0, 24, 250),    // north spur, runs down to the arm (no thin slot left)
      rect(0, 380, 150, 24),    // west spur, cuts the left sight line
      rect(230, 500, 24, 240),  // south-west divider
      rect(300, 400, 180, 24),  // west shelf
      rect(752, 402, 96, 96),   // heart of the maze (self symmetric)
    ],
    spawns: [
      // 180 rather than the bare HUD_SAFE_Y: at 155 the two top spawns see
      // each other straight down the northern corridor.
      spawn(90, 180, QUARTER),
      spawn(1510, 180, Math.PI - QUARTER),
    ],
    pickups: [
      pt(800, 150),  // exposed, on the northern highway
      pt(400, 550),  // sheltered, deep in the south-west
    ],
  }),

  // -------------------------------------------------------------------------
  // 4. Oszlopcsarnok — a 5x3 pillar hall. Every sight line is short, bullets
  //    ricochet between the columns. Spawns sit at the four edge midpoints.
  // -------------------------------------------------------------------------
  defineArena({
    id: 'pillars',
    name: 'Oszlopcsarnok',
    walls: [
      pillar(320, 225), pillar(560, 225), pillar(800, 225),
      pillar(1040, 225), pillar(1280, 225),
      pillar(320, 450), pillar(560, 450),
      rect(760, 390, 80, 120),  // taller keystone in the middle (self symmetric)
      rect(430, 90, 24, 140),   // northern baffle between two columns
      rect(90, 550, 140, 24),   // western baffle
    ],
    spawns: [
      spawn(100, 450, 0),               // west, facing east
      spawn(800, 90, Math.PI * 0.5),    // north, facing south
    ],
    pickups: [
      pt(680, 337),  // between the inner columns, north-west of the keystone
      pt(920, 337),  // its horizontal counterpart
    ],
  }),

  // -------------------------------------------------------------------------
  // 5. Gyűrű — a walled ring with four gates and an inner keep. The pickups
  //    all live inside the ring, so the middle is permanently contested.
  // -------------------------------------------------------------------------
  defineArena({
    id: 'ring',
    name: 'Gyűrű',
    walls: [
      rect(480, 230, 260, 24),  // ring: top-left segment (mirror = bottom-right)
      rect(860, 230, 260, 24),  // ring: top-right segment (mirror = bottom-left)
      rect(480, 254, 24, 156),  // ring: left-upper segment (mirror = right-lower)
      rect(480, 490, 24, 156),  // ring: left-lower segment (mirror = right-upper)
      rect(752, 402, 96, 96),   // inner keep (self symmetric)
      rect(788, 0, 24, 150),    // north spoke, cuts the top sight line
      rect(0, 438, 150, 24),    // west spoke, cuts the left sight line
      rect(300, 150, 24, 200),  // outer baffle, cuts the northern outer lane
    ],
    spawns: [
      // 250 rather than the bare HUD_SAFE_Y: at 155 the outer lane is a clean
      // sight line between the two top spawns. The outer baffle below breaks
      // what is left of that lane.
      spawn(110, 250, QUARTER),
      spawn(1490, 250, Math.PI - QUARTER),
    ],
    pickups: [
      pt(800, 320),  // inside the ring, north of the keep
      pt(620, 450),  // inside the ring, west of the keep
    ],
  }),
];

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

/**
 * The four outer border walls. They hang *outwards*, so the drivable
 * playfield stays exactly `AW x AH`.
 * @returns {Wall[]}
 */
function borderWalls() {
  const t = CONFIG.arena.wallThickness;
  return [
    rect(-t, -t, AW + t * 2, t), // top
    rect(-t, AH, AW + t * 2, t), // bottom
    rect(-t, 0, t, AH),          // left
    rect(AW, 0, t, AH),          // right
  ];
}

/** Resolves an index / id / definition object to an `ArenaDef`. */
function resolveDef(defOrIndex) {
  if (typeof defOrIndex === 'number') {
    return ARENAS[defOrIndex] || ARENAS[0];
  }
  if (typeof defOrIndex === 'string') {
    return ARENAS.find((a) => a.id === defOrIndex) || ARENAS[0];
  }
  if (defOrIndex && Array.isArray(defOrIndex.walls)) return defOrIndex;
  return ARENAS[0];
}

/**
 * Instantiates a playable arena.
 *
 * The returned `walls` array already contains the four outer border walls and
 * is a fresh copy, so gameplay code may keep or even mutate it without
 * corrupting the shared `ARENAS` definitions.
 *
 * @param {number|string|ArenaDef} defOrIndex index into `ARENAS`, an arena id, or a definition
 * @returns {Arena}
 */
export function buildArena(defOrIndex) {
  const def = resolveDef(defOrIndex);
  const walls = borderWalls();
  for (const w of def.walls) walls.push({ x: w.x, y: w.y, w: w.w, h: w.h });

  return {
    id: def.id,
    name: def.name,
    width: AW,
    height: AH,
    walls,
    spawns: (def.spawns || []).map((s) => ({ x: s.x, y: s.y, angle: s.angle })),
    pickups: (def.pickups || []).map((p) => ({ x: p.x, y: p.y })),
  };
}

// ---------------------------------------------------------------------------
// Collision
// ---------------------------------------------------------------------------

/**
 * Fast "does this circle touch any wall" test — no allocation, used by the
 * validator's grid sweep and by `findFreePosition`.
 * @returns {boolean}
 */
function overlapsAnyWall(x, y, r, walls) {
  const r2 = r * r;
  for (let i = 0; i < walls.length; i++) {
    const w = walls[i];
    const dx = x - clamp(x, w.x, w.x + w.w);
    const dy = y - clamp(y, w.y, w.y + w.h);
    if (dx * dx + dy * dy <= r2) return true;
  }
  return false;
}

/**
 * Pushes a circle out of every wall it overlaps.
 *
 * The circle is resolved against the *closest point* of each box, so a circle
 * clipping a convex corner is pushed out diagonally instead of being snapped
 * to an axis — that is what keeps tanks from sticking on corners and from
 * being squeezed through a wall. Only when the centre ends up strictly inside
 * a box (deep penetration, e.g. after a teleport) do we fall back to the
 * smallest-penetration axis. Up to `MAX_RESOLVE_ITERATIONS` passes handle
 * concave corners where two walls push against each other.
 *
 * @param {number} x circle centre x
 * @param {number} y circle centre y
 * @param {number} r circle radius
 * @param {Wall[]} walls
 * @returns {{ x:number, y:number, hit:boolean, nx:number, ny:number }}
 *   corrected centre, whether anything was hit, and the normalised sum of all
 *   push-out vectors (0,0 when nothing was hit)
 */
export function resolveCircle(x, y, r, walls) {
  let px = x;
  let py = y;
  let hit = false;
  let accX = 0;
  let accY = 0;
  const r2 = r * r;

  for (let iter = 0; iter < MAX_RESOLVE_ITERATIONS; iter++) {
    let moved = false;

    for (let i = 0; i < walls.length; i++) {
      const w = walls[i];
      const cx = clamp(px, w.x, w.x + w.w);
      const cy = clamp(py, w.y, w.y + w.h);
      const dx = px - cx;
      const dy = py - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;

      let nx;
      let ny;
      let push;

      if (d2 > 1e-12) {
        // Centre outside the box: push straight away from the closest point.
        const d = Math.sqrt(d2);
        nx = dx / d;
        ny = dy / d;
        push = r - d;
      } else {
        // Centre inside the box: leave through the nearest face.
        const left = px - w.x;
        const right = w.x + w.w - px;
        const top = py - w.y;
        const bottom = w.y + w.h - py;
        const m = Math.min(left, right, top, bottom);
        if (m === left) { nx = -1; ny = 0; push = left + r; }
        else if (m === right) { nx = 1; ny = 0; push = right + r; }
        else if (m === top) { nx = 0; ny = -1; push = top + r; }
        else { nx = 0; ny = 1; push = bottom + r; }
      }

      if (push <= 0) continue;

      px += nx * push;
      py += ny * push;
      accX += nx * push;
      accY += ny * push;
      hit = true;
      moved = true;
    }

    if (!moved) break;
  }

  let nx = 0;
  let ny = 0;
  const accLen = Math.hypot(accX, accY);
  if (accLen > 1e-9) {
    nx = accX / accLen;
    ny = accY / accLen;
  }

  return { x: px, y: py, hit, nx, ny };
}

/**
 * Wall test for projectiles.
 *
 * Returns the first overlapped wall together with the normal of its smallest
 * penetration axis, which is exactly what a bounce wants: axis aligned, so a
 * bullet grazing a corner still reflects predictably instead of spraying off
 * at a random diagonal.
 *
 * @param {number} bx bullet centre x
 * @param {number} by bullet centre y
 * @param {number} r bullet radius
 * @param {Wall[]} walls
 * @returns {null | { nx:number, ny:number, wall:Wall }}
 */
export function bulletCollide(bx, by, r, walls) {
  const r2 = r * r;

  for (let i = 0; i < walls.length; i++) {
    const w = walls[i];
    const dx = bx - clamp(bx, w.x, w.x + w.w);
    const dy = by - clamp(by, w.y, w.y + w.h);
    if (dx * dx + dy * dy > r2) continue;

    // Smallest penetration axis of the box inflated by the bullet radius.
    const halfW = w.w * 0.5;
    const halfH = w.h * 0.5;
    const wcx = w.x + halfW;
    const wcy = w.y + halfH;
    const overlapX = halfW + r - Math.abs(bx - wcx);
    const overlapY = halfH + r - Math.abs(by - wcy);

    if (overlapX < overlapY) {
      return { nx: bx < wcx ? -1 : 1, ny: 0, wall: w };
    }
    return { nx: 0, ny: by < wcy ? -1 : 1, wall: w };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

/**
 * Finds a random spot in the arena where a circle of radius `r` fits without
 * touching a wall and stays at least `minDist` away from every point in
 * `avoidList`. Used by the air drop and by respawn placement.
 *
 * Sampling stops at the first spot that satisfies both constraints; if none
 * does within `attempts` tries, the best candidate found so far (free spots
 * always beat blocked ones, then the largest clearance wins) is pushed out of
 * any wall and returned. The function therefore always returns a usable point.
 *
 * @param {Arena} arena built arena (its `walls` must include the borders)
 * @param {number} r radius that has to fit
 * @param {Array<{x:number,y:number}>} [avoidList] points to stay away from
 * @param {number} [minDist] desired minimum distance from `avoidList`
 * @param {number} [attempts] number of random samples
 * @returns {{ x:number, y:number }}
 */
export function findFreePosition(arena, r, avoidList = [], minDist = 0, attempts = FREE_POSITION_ATTEMPTS) {
  const margin = r + 6;
  const minX = margin;
  const maxX = arena.width - margin;
  const minY = margin;
  const maxY = arena.height - margin;

  let bestX = arena.width * 0.5;
  let bestY = arena.height * 0.5;
  let bestScore = -Infinity;

  for (let i = 0; i < attempts; i++) {
    const x = rand(minX, maxX);
    const y = rand(minY, maxY);
    const free = !overlapsAnyWall(x, y, r, arena.walls);

    let nearest = Infinity;
    for (let j = 0; j < avoidList.length; j++) {
      const p = avoidList[j];
      const d = dist(x, y, p.x, p.y);
      if (d < nearest) nearest = d;
    }
    if (nearest === Infinity) nearest = arena.width; // nothing to avoid

    // Free candidates always outrank blocked ones; within a class the one
    // with the biggest clearance wins.
    const score = (free ? 1e6 : 0) + nearest;
    if (score > bestScore) {
      bestScore = score;
      bestX = x;
      bestY = y;
    }

    if (free && nearest >= minDist) return { x, y };
  }

  const res = resolveCircle(bestX, bestY, r, arena.walls);
  return { x: res.x, y: res.y };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Segment / AABB intersection (Liang-Barsky clipping).
 * @returns {boolean} true when the segment touches the box
 */
function segmentHitsRect(x1, y1, x2, y2, w) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  let t0 = 0;
  let t1 = 1;

  const p = [-dx, dx, -dy, dy];
  const q = [x1 - w.x, (w.x + w.w) - x1, y1 - w.y, (w.y + w.h) - y1];

  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return false;      // parallel to this slab and outside it
    } else {
      const t = q[i] / p[i];
      if (p[i] < 0) {
        if (t > t1) return false;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return false;
        if (t < t1) t1 = t;
      }
    }
  }
  return true;
}

/**
 * True when a wall blocks the straight segment between two points.
 *
 * Exported for the bots: they need it both for "can I actually shoot this
 * player" and for probing whether a heading is drivable. Pure geometry, no
 * allocation — it runs a few dozen times per decision tick.
 *
 * @param {number} x1
 * @param {number} y1
 * @param {number} x2
 * @param {number} y2
 * @param {Array<{x:number,y:number,w:number,h:number}>} walls
 * @returns {boolean}
 */
export function pathBlocked(x1, y1, x2, y2, walls) {
  return segmentBlocked(x1, y1, x2, y2, walls || EMPTY_WALLS);
}

const EMPTY_WALLS = [];

/** True when at least one wall blocks the segment. */
function segmentBlocked(x1, y1, x2, y2, walls) {
  for (let i = 0; i < walls.length; i++) {
    if (segmentHitsRect(x1, y1, x2, y2, walls[i])) return true;
  }
  return false;
}

/**
 * Line of sight between two spawn points. Not just the centre ray: the ray is
 * also swept sideways by +/- the tank radius on both ends, so a spawning tank
 * cannot be shot by nudging half a hull to the side either.
 * @returns {boolean} true when *every* sampled ray is blocked
 */
function sightFullyBlocked(a, b, walls, r) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l = Math.hypot(dx, dy);
  if (l < 1e-6) return false;

  // Unit normal of the segment.
  const px = -dy / l;
  const py = dx / l;
  const offsets = [-r, 0, r];

  for (const oa of offsets) {
    for (const ob of offsets) {
      const blocked = segmentBlocked(
        a.x + px * oa, a.y + py * oa,
        b.x + px * ob, b.y + py * ob,
        walls,
      );
      if (!blocked) return false;
    }
  }
  return true;
}

/**
 * Coarse grid flood fill from a start point.
 *
 * A cell counts as drivable when a circle of radius `clearance` centred on it
 * touches no wall; connectivity is 4-neighbour, so the fill never cuts a
 * corner diagonally. Running it twice — once with the tank radius and once
 * with `MIN_CORRIDOR / 2` — tells us both "is it reachable at all" and "is it
 * reachable through corridors of the required width".
 *
 * @returns {{ cols:number, rows:number, cell:number, seen:Uint8Array, ok:boolean }}
 *   `ok` is false when the start cell itself is blocked
 */
function floodFill(walls, clearance, cell, start) {
  const cols = Math.ceil(AW / cell);
  const rows = Math.ceil(AH / cell);
  const free = new Uint8Array(cols * rows);
  const seen = new Uint8Array(cols * rows);

  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x = (i + 0.5) * cell;
      const y = (j + 0.5) * cell;
      free[j * cols + i] = overlapsAnyWall(x, y, clearance, walls) ? 0 : 1;
    }
  }

  const si = clamp(Math.floor(start.x / cell), 0, cols - 1);
  const sj = clamp(Math.floor(start.y / cell), 0, rows - 1);
  const startIdx = sj * cols + si;
  if (!free[startIdx]) return { cols, rows, cell, seen, ok: false };

  const stack = [startIdx];
  seen[startIdx] = 1;
  while (stack.length) {
    const idx = stack.pop();
    const i = idx % cols;
    const j = (idx - i) / cols;
    if (i > 0 && free[idx - 1] && !seen[idx - 1]) { seen[idx - 1] = 1; stack.push(idx - 1); }
    if (i < cols - 1 && free[idx + 1] && !seen[idx + 1]) { seen[idx + 1] = 1; stack.push(idx + 1); }
    if (j > 0 && free[idx - cols] && !seen[idx - cols]) { seen[idx - cols] = 1; stack.push(idx - cols); }
    if (j < rows - 1 && free[idx + cols] && !seen[idx + cols]) { seen[idx + cols] = 1; stack.push(idx + cols); }
  }

  return { cols, rows, cell, seen, ok: true };
}

/** True when the grid cell containing `p` was reached by the flood fill. */
function reached(fill, p) {
  if (!fill.ok) return false;
  const i = clamp(Math.floor(p.x / fill.cell), 0, fill.cols - 1);
  const j = clamp(Math.floor(p.y / fill.cell), 0, fill.rows - 1);
  return fill.seen[j * fill.cols + i] === 1;
}

/** Distance from a point to the closest wall surface (0 when inside). */
function clearanceAt(x, y, walls) {
  let best = Infinity;
  for (let i = 0; i < walls.length; i++) {
    const w = walls[i];
    const dx = x - clamp(x, w.x, w.x + w.w);
    const dy = y - clamp(y, w.y, w.y + w.h);
    const d = Math.hypot(dx, dy);
    if (d < best) best = d;
  }
  return best;
}

/** Walls of a definition plus the borders (unless they are already present). */
function allWalls(def) {
  const walls = (def.walls || []).map((w) => ({ x: w.x, y: w.y, w: w.w, h: w.h }));
  const hasBorders = walls.some((w) => w.x < 0 || w.y < 0 || w.x + w.w > AW || w.y + w.h > AH);
  return hasBorders ? walls : borderWalls().concat(walls);
}

/**
 * Design-time sanity check for a single arena.
 *
 * This is NOT a runtime test — nothing calls it during play. It exists so a
 * level can be verified while it is being authored (or from `tools/`), and it
 * encodes every rule the arenas in this file were designed against.
 *
 * Checked:
 *   1. required fields, 4+ spawns, 2..4 pickups
 *   2. exact 180 degree point symmetry of walls, spawns and pickups
 *   3. degenerate / overlapping walls
 *   4. spawns and pickups standing free, spawns far enough apart
 *   5. no spawn-to-spawn line of sight (swept by the tank radius)
 *   6. no narrow slot between two walls (`minCorridor`)
 *   7. everything reachable — first with the tank radius, then through
 *      corridors at least `minCorridor` wide, so there are no dead pockets
 *
 * @param {ArenaDef} def
 * @param {{ tankRadius?:number, minCorridor?:number, gridCell?:number,
 *           minSpawnDistance?:number }} [opts]
 * @returns {string[]} list of problems, empty when the arena is sound
 */
export function validateArena(def, opts = {}) {
  const errors = [];
  if (!def || typeof def !== 'object') {
    return ['Érvénytelen aréna-definíció.'];
  }

  const tankR = opts.tankRadius ?? CONFIG.tank.radius;
  const minCorridor = opts.minCorridor ?? MIN_CORRIDOR;
  const cell = opts.gridCell ?? 8;
  const minSpawnDistance = opts.minSpawnDistance ?? 380;
  const pickupR = (CONFIG.pickup && CONFIG.pickup.radius) || 16;

  const tag = def.id || def.name || '?';
  const err = (msg) => errors.push(`[${tag}] ${msg}`);

  // --- 1. structure ------------------------------------------------------
  if (!def.id) err('Hiányzik az "id" mező.');
  if (!def.name) err('Hiányzik a "name" mező.');

  const spawns = Array.isArray(def.spawns) ? def.spawns : [];
  const pickups = Array.isArray(def.pickups) ? def.pickups : [];
  if (!Array.isArray(def.walls)) err('Hiányzik a "walls" tömb.');
  if (spawns.length < 4) err(`Legalább 4 spawn pont kell (jelenleg ${spawns.length}).`);
  if (pickups.length < 2 || pickups.length > 4) {
    err(`2-4 pickup pont kell (jelenleg ${pickups.length}).`);
  }

  const walls = allWalls(def);
  if (!walls.length || spawns.length === 0) return errors;

  // --- 2. 180 degree symmetry -------------------------------------------
  for (const w of def.walls || []) {
    const m = mirrorWall(w);
    if (!(def.walls || []).some((o) => sameWall(o, m))) {
      err(`Nem szimmetrikus fal: (${w.x}, ${w.y}, ${w.w}x${w.h}) tükörképe hiányzik.`);
    }
  }
  for (const s of spawns) {
    const m = mirrorSpawn(s);
    if (!spawns.some((o) => sameSpawn(o, m))) {
      err(`Nem szimmetrikus spawn: (${s.x}, ${s.y}) tükörképe hiányzik.`);
    }
  }
  for (const p of pickups) {
    const m = mirrorPoint(p);
    if (!pickups.some((o) => samePoint(o, m))) {
      err(`Nem szimmetrikus pickup: (${p.x}, ${p.y}) tükörképe hiányzik.`);
    }
  }

  // --- 3. wall sanity ----------------------------------------------------
  for (let a = 0; a < walls.length; a++) {
    const A = walls[a];
    if (A.w <= 0 || A.h <= 0) {
      err(`Elfajult fal: (${A.x}, ${A.y}, ${A.w}x${A.h}).`);
      continue;
    }
    for (let b = a + 1; b < walls.length; b++) {
      const B = walls[b];
      if (sameWall(A, B)) {
        err(`Duplikált fal: (${A.x}, ${A.y}, ${A.w}x${A.h}).`);
        continue;
      }
      const ovX = Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x);
      const ovY = Math.min(A.y + A.h, B.y + B.h) - Math.max(A.y, B.y);

      if (ovX > EPS && ovY > EPS) {
        err(`Átfedő falak: (${A.x}, ${A.y}, ${A.w}x${A.h}) és (${B.x}, ${B.y}, ${B.w}x${B.h}).`);
        continue;
      }

      // --- 6. narrow slots. A gap only forms a corridor when the two walls
      // overlap on the *other* axis. Junction artefacts (a gap that a third
      // wall already fills) are filtered out by probing the gap centre.
      if (ovY > EPS) {
        const gap = A.x < B.x ? B.x - (A.x + A.w) : A.x - (B.x + B.w);
        if (gap > EPS && gap < minCorridor) {
          const gx = A.x < B.x ? A.x + A.w + gap * 0.5 : B.x + B.w + gap * 0.5;
          const gy = (Math.max(A.y, B.y) + Math.min(A.y + A.h, B.y + B.h)) * 0.5;
          if (!overlapsAnyWall(gx, gy, 0, walls)) {
            err(`Túl szűk (${gap.toFixed(0)} px) függőleges folyosó a (${gx.toFixed(0)}, ${gy.toFixed(0)}) pont körül.`);
          }
        }
      }
      if (ovX > EPS) {
        const gap = A.y < B.y ? B.y - (A.y + A.h) : A.y - (B.y + B.h);
        if (gap > EPS && gap < minCorridor) {
          const gy = A.y < B.y ? A.y + A.h + gap * 0.5 : B.y + B.h + gap * 0.5;
          const gx = (Math.max(A.x, B.x) + Math.min(A.x + A.w, B.x + B.w)) * 0.5;
          if (!overlapsAnyWall(gx, gy, 0, walls)) {
            err(`Túl szűk (${gap.toFixed(0)} px) vízszintes folyosó a (${gx.toFixed(0)}, ${gy.toFixed(0)}) pont körül.`);
          }
        }
      }
    }
  }

  // --- 4. spawn / pickup placement --------------------------------------
  spawns.forEach((s, i) => {
    const c = clearanceAt(s.x, s.y, walls);
    if (c <= tankR) err(`A(z) ${i + 1}. spawn falban áll vagy túl közel van hozzá (${c.toFixed(0)} px).`);
    if (!Number.isFinite(s.angle)) err(`A(z) ${i + 1}. spawn "angle" mezője hiányzik.`);
  });

  for (let i = 0; i < spawns.length; i++) {
    for (let j = i + 1; j < spawns.length; j++) {
      const d = dist(spawns[i].x, spawns[i].y, spawns[j].x, spawns[j].y);
      if (d < minSpawnDistance) {
        err(`A(z) ${i + 1}. és ${j + 1}. spawn túl közel van egymáshoz (${d.toFixed(0)} px).`);
      }
    }
  }

  // A pickup must fit visually (its own radius) and be drivable into (tank radius).
  const pickupClearance = Math.max(tankR, pickupR);
  pickups.forEach((p, i) => {
    const c = clearanceAt(p.x, p.y, walls);
    if (c <= pickupClearance) {
      err(`A(z) ${i + 1}. pickup falban áll vagy túl közel van hozzá (${c.toFixed(0)} px).`);
    }
    for (let k = 0; k < spawns.length; k++) {
      const d = dist(p.x, p.y, spawns[k].x, spawns[k].y);
      if (d < NEUTRAL_PICKUP_DISTANCE) {
        err(`A(z) ${i + 1}. pickup túl közel van a(z) ${k + 1}. spawnhoz (${d.toFixed(0)} px).`);
      }
    }
  });

  // --- 5. spawn sight lines ---------------------------------------------
  for (let i = 0; i < spawns.length; i++) {
    for (let j = i + 1; j < spawns.length; j++) {
      if (!sightFullyBlocked(spawns[i], spawns[j], walls, tankR)) {
        err(`A(z) ${i + 1}. és ${j + 1}. spawn között közvetlen rálátás van.`);
      }
    }
  }

  // --- 7. reachability ---------------------------------------------------
  const tankFill = floodFill(walls, tankR, cell, spawns[0]);
  if (!tankFill.ok) {
    err('Az 1. spawn körül nincs szabad hely a rácsos elérhetőség-teszthez.');
  } else {
    spawns.forEach((s, i) => {
      if (!reached(tankFill, s)) err(`A(z) ${i + 1}. spawn nem érhető el az 1. spawnból (elzárt zseb).`);
    });
    pickups.forEach((p, i) => {
      if (!reached(tankFill, p)) err(`A(z) ${i + 1}. pickup nem érhető el az 1. spawnból (elzárt zseb).`);
    });
  }

  const wideFill = floodFill(walls, minCorridor / 2, cell, spawns[0]);
  if (!wideFill.ok) {
    err(`Az 1. spawn körül nincs ${minCorridor} px széles szabad hely.`);
  } else {
    spawns.forEach((s, i) => {
      if (!reached(wideFill, s)) err(`A(z) ${i + 1}. spawn csak ${minCorridor} px-nél szűkebb folyosón érhető el.`);
    });
    pickups.forEach((p, i) => {
      if (!reached(wideFill, p)) err(`A(z) ${i + 1}. pickup csak ${minCorridor} px-nél szűkebb folyosón érhető el.`);
    });
  }

  return errors;
}

/**
 * Runs `validateArena` on every built-in arena.
 * @returns {Array<{ id:string, name:string, errors:string[] }>}
 */
export function validateAllArenas(opts) {
  return ARENAS.map((a) => ({ id: a.id, name: a.name, errors: validateArena(a, opts) }));
}
