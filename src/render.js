/**
 * Slag — the entire presentation layer.
 *
 * The game is authored against a FIXED logical resolution of 1600x900. Every
 * coordinate in this module (and in the simulation) is expressed in that
 * space; `resize()` computes a DPR-aware, aspect-preserving transform and the
 * canvas is letterboxed with black bars, so the picture is never distorted.
 *
 * Layer order (documented, because it deviates from the naive "walls on top"):
 *
 *   1. floor: base gradient + grid + vignette
 *   2. cast shadows of the walls
 *   3. ground shadows of pickups and tanks
 *   4. WALLS
 *   5. pickups
 *   6. bullet trails
 *   7. tanks
 *   8. bullets / rockets
 *   9. particles
 *  10. screen flash  — outside the shaken layer
 *  11. HUD / overlays — outside the shaken layer, so text never jitters
 *
 * Why the walls sit UNDER the tanks: gameplay beats realism. If the walls were
 * painted last they would occasionally swallow a tank hugging a corner, and a
 * player who cannot see their own tank cannot play. Instead the walls are kept
 * deliberately LOW: their height is suggested by a soft cast shadow underneath
 * (drawn before them) and a bright bevel on the top edge. Ground shadows are
 * painted before the walls so a shadow never bleeds over a wall face.
 *
 * Performance notes: nothing on the hot path allocates gradients, arrays or
 * paths per frame — gradients and the floor grid are cached at module level and
 * reused; every `ctx.save()` has a matching `ctx.restore()`.
 */

import { CONFIG, PALETTE } from './config.js';
import { clamp, damp, hexToRgba } from './util.js';
import { ARENAS } from './arena.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Fixed logical playfield size — the whole module draws in this space. */
const LOGICAL_W = CONFIG.arena.width;
const LOGICAL_H = CONFIG.arena.height;

/** System font stack: no web fonts, no network, looks native everywhere. */
const FONT_STACK = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

/** Floor grid pitch in logical pixels (minor lines) and the major multiple. */
const GRID_MINOR = 50;
const GRID_MAJOR = 200;

/** HUD corner card geometry. */
const CARD_W = 326;
const CARD_H = 106;
const CARD_M = 14;

/** Neutral colour used when a colour reference cannot be resolved. */
const FALLBACK_COLOR = { id: 'gray', name: 'Szürke', main: '#94a3b8', dark: '#334155', light: '#e2e8f0' };

/**
 * Visual identity of the four power-ups. Kept local on purpose: rendering is
 * the only consumer of these values, so the renderer never depends on the
 * internal shape of `POWERUPS` in `powerups.js`. The colours are the ones the
 * specification prescribes (rapid = yellow, rocket = orange, speed = cyan,
 * life = red).
 */
const POWERUP_STYLE = {
  rapid:  { color: '#facc15', name: 'Gyorstűz' },
  rocket: { color: '#f97316', name: 'Rakéta' },
  speed:  { color: '#22d3ee', name: 'Nitró' },
  life:   { color: '#ef4444', name: 'Pajzs' },
};
const POWERUP_FALLBACK = { color: '#e2e8f0', name: 'Bónusz' };

/** Height (in logical px) an air-dropped crate falls from. */
const AIRDROP_HEIGHT = 640;

// ---------------------------------------------------------------------------
// View / transform state
// ---------------------------------------------------------------------------

/**
 * Current mapping between the logical 1600x900 space and the backing store.
 * `scale`, `offsetX`, `offsetY` are in CSS pixels; the device transform also
 * multiplies by `dpr`.
 */
const view = {
  canvas: null,
  ctx: null,
  dpr: 1,
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  cssW: LOGICAL_W,
  cssH: LOGICAL_H,
};

/** Guards against installing the window resize listener more than once. */
let resizeHooked = false;

/**
 * Creates (or reuses) the 2D context for the game canvas and sets up the
 * letterboxed transform.
 *
 * The returned value is the plain `CanvasRenderingContext2D` — every draw
 * function in this module also accepts a wrapper object exposing `.ctx`, so
 * callers are free to pass either.
 *
 * @param {HTMLCanvasElement} canvas
 * @returns {CanvasRenderingContext2D|null}
 */
export function initRender(canvas) {
  if (!canvas || typeof canvas.getContext !== 'function') return null;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return null;

  view.canvas = canvas;
  view.ctx = ctx;
  resetGradientCache(ctx);
  resize(canvas);

  // Keeping the backing store in sync is cheap and idempotent; wiring it here
  // means the game still scales correctly even if the host forgets to do it.
  if (!resizeHooked && typeof window !== 'undefined' && window.addEventListener) {
    resizeHooked = true;
    const onResize = () => resize(view.canvas);
    window.addEventListener('resize', onResize, { passive: true });
    window.addEventListener('orientationchange', onResize, { passive: true });
  }
  return ctx;
}

/**
 * Resizes the backing store to the CSS size times the device pixel ratio and
 * recomputes the 16:9 letterbox transform.
 *
 * @param {HTMLCanvasElement} [canvas] defaults to the canvas passed to `initRender`
 * @returns {typeof view} the current view descriptor
 */
export function resize(canvas) {
  const cv = canvas || view.canvas;
  if (!cv || typeof cv.getContext !== 'function') return view;

  const ctx = (cv === view.canvas && view.ctx) ? view.ctx : cv.getContext('2d', { alpha: false });
  view.canvas = cv;
  view.ctx = ctx;

  // Cap the DPR: beyond 3x the extra pixels cost far more than they show.
  const dpr = clamp(globalThis.devicePixelRatio || 1, 1, 3);
  const rect = typeof cv.getBoundingClientRect === 'function' ? cv.getBoundingClientRect() : null;
  const cssW = Math.max(1, Math.round((rect && rect.width) || cv.clientWidth || LOGICAL_W));
  const cssH = Math.max(1, Math.round((rect && rect.height) || cv.clientHeight || LOGICAL_H));

  const bw = Math.max(1, Math.round(cssW * dpr));
  const bh = Math.max(1, Math.round(cssH * dpr));
  if (cv.width !== bw) cv.width = bw;
  if (cv.height !== bh) cv.height = bh;

  const scale = Math.min(cssW / LOGICAL_W, cssH / LOGICAL_H);
  view.dpr = dpr;
  view.scale = scale;
  view.cssW = cssW;
  view.cssH = cssH;
  view.offsetX = (cssW - LOGICAL_W * scale) / 2;
  view.offsetY = (cssH - LOGICAL_H * scale) / 2;

  if (ctx) {
    applyBaseTransform(ctx);
    ctx.imageSmoothingEnabled = true;
  }
  return view;
}

/** Installs the logical-space transform (uniform scale, so nothing distorts). */
function applyBaseTransform(ctx) {
  const s = view.scale * view.dpr;
  ctx.setTransform(s, 0, 0, s, Math.round(view.offsetX * view.dpr), Math.round(view.offsetY * view.dpr));
}

/**
 * Converts a viewport (client) coordinate into logical arena coordinates.
 * @param {number} clientX
 * @param {number} clientY
 * @returns {{x:number,y:number}}
 */
export function screenToArena(clientX, clientY) {
  let x = clientX;
  let y = clientY;
  const cv = view.canvas;
  if (cv && typeof cv.getBoundingClientRect === 'function') {
    const r = cv.getBoundingClientRect();
    x -= r.left;
    y -= r.top;
  }
  const s = view.scale || 1;
  return { x: (x - view.offsetX) / s, y: (y - view.offsetY) / s };
}

/**
 * Converts logical arena coordinates into viewport (client) coordinates.
 * @param {number} ax
 * @param {number} ay
 * @returns {{x:number,y:number}}
 */
export function arenaToScreen(ax, ay) {
  const s = view.scale || 1;
  let ox = view.offsetX;
  let oy = view.offsetY;
  const cv = view.canvas;
  if (cv && typeof cv.getBoundingClientRect === 'function') {
    const r = cv.getBoundingClientRect();
    ox += r.left;
    oy += r.top;
  }
  return { x: ax * s + ox, y: ay * s + oy };
}

/** Accepts either a raw 2D context or a `{ ctx }` wrapper. */
function unwrap(c) {
  if (!c) return null;
  if (typeof c.fillRect === 'function') return c;
  if (c.ctx && typeof c.ctx.fillRect === 'function') return c.ctx;
  return null;
}

/**
 * Clears the whole backing store to black (that paints the letterbox bars),
 * installs the logical transform and clips to the playfield. Must be paired
 * with `endFrame()`.
 */
function beginFrame(ctx) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  applyBaseTransform(ctx);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, LOGICAL_W, LOGICAL_H);
  ctx.clip();
}

/** Closes the clip opened by `beginFrame()`. */
function endFrame(ctx) {
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Cached resources (gradients, grid geometry)
// ---------------------------------------------------------------------------

/** key -> CanvasGradient, valid for `gradientOwner` only. */
const gradientCache = new Map();
let gradientOwner = null;

function resetGradientCache(ctx) {
  gradientCache.clear();
  gradientOwner = ctx;
}

/**
 * Returns a lazily built, cached gradient. Gradient coordinates are resolved
 * against the transform in effect when the gradient is USED, so a gradient
 * built around the origin can be reused at any position by translating first.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} key cache key
 * @param {(ctx:CanvasRenderingContext2D)=>CanvasGradient} factory
 * @returns {CanvasGradient}
 */
function cachedGradient(ctx, key, factory) {
  if (gradientOwner !== ctx) resetGradientCache(ctx);
  let g = gradientCache.get(key);
  if (!g) {
    g = factory(ctx);
    gradientCache.set(key, g);
  }
  return g;
}

/** Cached grid geometry: `false` means "Path2D unavailable, use the loop". */
let gridPaths = null;

function getGridPaths() {
  if (gridPaths !== null) return gridPaths;
  if (typeof Path2D === 'undefined') {
    gridPaths = false;
    return gridPaths;
  }
  const minor = new Path2D();
  const major = new Path2D();
  for (let x = GRID_MINOR; x < LOGICAL_W; x += GRID_MINOR) {
    const p = (x % GRID_MAJOR === 0) ? major : minor;
    p.moveTo(x, 0);
    p.lineTo(x, LOGICAL_H);
  }
  for (let y = GRID_MINOR; y < LOGICAL_H; y += GRID_MINOR) {
    const p = (y % GRID_MAJOR === 0) ? major : minor;
    p.moveTo(0, y);
    p.lineTo(LOGICAL_W, y);
  }
  gridPaths = { minor, major };
  return gridPaths;
}

// ---------------------------------------------------------------------------
// Small drawing helpers
// ---------------------------------------------------------------------------

/** Builds a rounded rectangle sub-path (own implementation: no `roundRect` dependency). */
function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

/** Filled rounded rectangle. */
function fillRoundRect(ctx, x, y, w, h, r, fill) {
  roundRectPath(ctx, x, y, w, h, r);
  ctx.fillStyle = fill;
  ctx.fill();
}

/** Stroked rounded rectangle. */
function strokeRoundRect(ctx, x, y, w, h, r, stroke, lineWidth) {
  roundRectPath(ctx, x, y, w, h, r);
  ctx.strokeStyle = stroke;
  ctx.lineWidth = lineWidth;
  ctx.stroke();
}

/** Regular hexagon sub-path around (cx, cy). */
function hexPath(ctx, cx, cy, radius, rotation) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = rotation + i * (Math.PI / 3);
    const px = cx + Math.cos(a) * radius;
    const py = cy + Math.sin(a) * radius;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

/** Font shorthand for the shared system stack. */
function font(size, weight) {
  return `${weight || 700} ${size}px ${FONT_STACK}`;
}

/**
 * Sets `ctx.font` to the largest size (up to `size`) at which `text` still fits
 * into `maxWidth`. Keyboard hints are much longer than the gamepad ones, and
 * the exact width depends on whichever font of the stack the system has.
 * @returns {number} the size actually used
 */
function fitFont(ctx, text, maxWidth, size, weight, minSize = 10) {
  let s = size;
  ctx.font = font(s, weight);
  while (s > minSize && ctx.measureText(text).width > maxWidth) {
    s -= 1;
    ctx.font = font(s, weight);
  }
  return s;
}

/** Text with a contrasting outline — readable on any background, from 2 m away. */
function outlinedText(ctx, text, x, y, fill, outline, lineWidth) {
  if (outline) {
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    ctx.lineWidth = lineWidth || 4;
    ctx.strokeStyle = outline;
    ctx.strokeText(text, x, y);
  }
  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
}

/**
 * Normalises anything colour-ish into a full palette entry.
 * Accepts a palette object, a palette id or a raw hex string.
 */
function resolveColor(c) {
  if (c && typeof c === 'object' && typeof c.main === 'string') return c;
  if (typeof c === 'string') {
    const byId = PALETTE.find((p) => p.id === c);
    if (byId) return byId;
    if (c.charAt(0) === '#') return { id: c, name: c, main: c, dark: '#111827', light: '#ffffff' };
  }
  return FALLBACK_COLOR;
}

/** Visual style of a power-up id, never throws for unknown ids. */
function powerupStyle(id) {
  return POWERUP_STYLE[id] || POWERUP_FALLBACK;
}

/** Hungarian player label derived from the index (fallback when no name is known). */
function playerLabel(index) {
  return `${(index | 0) + 1}. játékos`;
}

/** Human readable device label derived from the stable device id scheme. */
function deviceLabel(deviceId) {
  if (typeof deviceId !== 'string') return '';
  if (deviceId.startsWith('gp-')) {
    const n = parseInt(deviceId.slice(3), 10);
    return Number.isFinite(n) ? `Kontroller ${n + 1}` : 'Kontroller';
  }
  if (deviceId === 'kb-0') return 'Billentyűzet A';
  if (deviceId === 'kb-1') return 'Billentyűzet B';
  if (deviceId.startsWith('kb-')) return 'Billentyűzet';
  return '';
}

/**
 * "What do I press now" line of a joined-but-not-ready lobby slot, named for
 * the device that actually sits in it. A keyboard player has no Cross and no
 * Circle button, so the gamepad wording left them with nothing to press.
 */
function slotActionHint(deviceId) {
  if (deviceId === 'kb-0') return 'Enter — kész   ·   Esc — kilépés';
  if (deviceId === 'kb-1') return 'Num Enter — kész   ·   Num . — kilépés';
  return 'Kereszt — kész   ·   Kör — kilépés';
}

/** Colour-row label of a slot, naming the keys that actually cycle the colour. */
function slotColorHint(deviceId) {
  if (deviceId === 'kb-0') return 'Q  ‹  Szín  ›  E';
  if (deviceId === 'kb-1') return 'U  ‹  Szín  ›  O';
  return '‹  Szín  ›';
}

// ---------------------------------------------------------------------------
// Power-up icons (hand drawn vectors — crisper and more legible than emoji,
// and they do not depend on the installed emoji font)
// ---------------------------------------------------------------------------

/**
 * Draws a power-up icon centred at (x, y) inside a `size` x `size` box.
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} id 'rapid'|'rocket'|'speed'|'life'
 * @param {number} x
 * @param {number} y
 * @param {number} size
 * @param {string} [color] overrides the default power-up colour
 */
function drawPowerupIcon(ctx, id, x, y, size, color) {
  const tint = color || powerupStyle(id).color;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size, size);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.fillStyle = tint;
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.lineWidth = 0.08;

  if (id === 'rapid') {
    // Lightning bolt.
    ctx.beginPath();
    ctx.moveTo(0.14, -0.5);
    ctx.lineTo(-0.34, 0.06);
    ctx.lineTo(-0.04, 0.06);
    ctx.lineTo(-0.14, 0.5);
    ctx.lineTo(0.34, -0.08);
    ctx.lineTo(0.04, -0.08);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  } else if (id === 'rocket') {
    // Nose cone + body + fins, pointing up.
    ctx.beginPath();
    ctx.moveTo(0, -0.5);
    ctx.quadraticCurveTo(0.2, -0.24, 0.2, -0.02);
    ctx.lineTo(0.2, 0.2);
    ctx.lineTo(-0.2, 0.2);
    ctx.lineTo(-0.2, -0.02);
    ctx.quadraticCurveTo(-0.2, -0.24, 0, -0.5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-0.2, 0.04);
    ctx.lineTo(-0.4, 0.34);
    ctx.lineTo(-0.2, 0.28);
    ctx.closePath();
    ctx.moveTo(0.2, 0.04);
    ctx.lineTo(0.4, 0.34);
    ctx.lineTo(0.2, 0.28);
    ctx.closePath();
    ctx.fill();
    // Window.
    ctx.fillStyle = 'rgba(15,23,42,0.75)';
    ctx.beginPath();
    ctx.arc(0, -0.14, 0.09, 0, Math.PI * 2);
    ctx.fill();
  } else if (id === 'speed') {
    // Three speed streaks.
    ctx.strokeStyle = tint;
    ctx.lineWidth = 0.16;
    ctx.beginPath();
    ctx.moveTo(-0.44, -0.24); ctx.lineTo(0.34, -0.24);
    ctx.moveTo(-0.30, 0.02);  ctx.lineTo(0.44, 0.02);
    ctx.moveTo(-0.44, 0.28);  ctx.lineTo(0.18, 0.28);
    ctx.stroke();
  } else if (id === 'life') {
    // Heart.
    ctx.beginPath();
    ctx.moveTo(0, 0.36);
    ctx.bezierCurveTo(-0.64, -0.04, -0.38, -0.54, 0, -0.22);
    ctx.bezierCurveTo(0.38, -0.54, 0.64, -0.04, 0, 0.36);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  } else {
    // Unknown power-up: neutral diamond, never a crash.
    ctx.beginPath();
    ctx.moveTo(0, -0.4); ctx.lineTo(0.4, 0); ctx.lineTo(0, 0.4); ctx.lineTo(-0.4, 0);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Layer 1 — floor
// ---------------------------------------------------------------------------

function drawFloor(ctx) {
  // Base gradient.
  const base = cachedGradient(ctx, 'floor', (c) => {
    const g = c.createLinearGradient(0, 0, 0, LOGICAL_H);
    g.addColorStop(0, '#161d29');
    g.addColorStop(0.55, '#111722');
    g.addColorStop(1, '#0b0f17');
    return g;
  });
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);

  // Grid.
  const paths = getGridPaths();
  ctx.lineWidth = 1;
  if (paths) {
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.055)';
    ctx.stroke(paths.minor);
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.10)';
    ctx.stroke(paths.major);
  } else {
    // Fallback for exotic environments without Path2D.
    ctx.beginPath();
    for (let x = GRID_MINOR; x < LOGICAL_W; x += GRID_MINOR) { ctx.moveTo(x, 0); ctx.lineTo(x, LOGICAL_H); }
    for (let y = GRID_MINOR; y < LOGICAL_H; y += GRID_MINOR) { ctx.moveTo(0, y); ctx.lineTo(LOGICAL_W, y); }
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.06)';
    ctx.stroke();
  }

  // Vignette — pulls the eye towards the middle of the arena.
  const vig = cachedGradient(ctx, 'vignette', (c) => {
    const g = c.createRadialGradient(LOGICAL_W / 2, LOGICAL_H / 2, 260, LOGICAL_W / 2, LOGICAL_H / 2, 1040);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.62, 'rgba(0,0,0,0.16)');
    g.addColorStop(1, 'rgba(0,0,0,0.55)');
    return g;
  });
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);
}

// ---------------------------------------------------------------------------
// Layers 2 & 4 — walls
// ---------------------------------------------------------------------------

/** Soft cast shadow underneath every wall — this is what sells the height. */
function drawWallShadows(ctx, walls) {
  if (!walls || !walls.length) return;
  ctx.save();
  ctx.fillStyle = 'rgba(0, 0, 0, 0.40)';
  for (let i = 0; i < walls.length; i++) {
    const w = walls[i];
    if (!w) continue;
    roundRectPath(ctx, w.x + 7, w.y + 10, w.w, w.h, 5);
    ctx.fill();
  }
  ctx.fillStyle = 'rgba(0, 0, 0, 0.22)';
  for (let i = 0; i < walls.length; i++) {
    const w = walls[i];
    if (!w) continue;
    roundRectPath(ctx, w.x + 13, w.y + 18, w.w, w.h, 7);
    ctx.fill();
  }
  ctx.restore();
}

/**
 * The walls themselves: a dark slab, a lighter top band and a bright bevel on
 * the upper edge. Deliberately low so tanks are never hidden behind them.
 */
function drawWalls(ctx, walls) {
  if (!walls || !walls.length) return;
  ctx.save();
  for (let i = 0; i < walls.length; i++) {
    const w = walls[i];
    if (!w) continue;
    const band = Math.min(9, w.h * 0.42);

    // Body.
    roundRectPath(ctx, w.x, w.y, w.w, w.h, 4);
    ctx.fillStyle = '#2b323f';
    ctx.fill();

    // Lit top band.
    roundRectPath(ctx, w.x, w.y, w.w, band, 4);
    ctx.fillStyle = '#414b5c';
    ctx.fill();

    // Bright bevel on the very top edge.
    ctx.fillStyle = 'rgba(203, 213, 225, 0.55)';
    ctx.fillRect(w.x + 2, w.y, Math.max(0, w.w - 4), 2);

    // Dark base line so the slab reads as sitting on the floor.
    ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
    ctx.fillRect(w.x + 2, w.y + w.h - 2.5, Math.max(0, w.w - 4), 2.5);

    // Outline.
    roundRectPath(ctx, w.x + 0.5, w.y + 0.5, w.w - 1, w.h - 1, 4);
    ctx.strokeStyle = 'rgba(8, 11, 17, 0.85)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Layer 3 — ground shadows
// ---------------------------------------------------------------------------

function drawTankShadows(ctx, tanks) {
  ctx.save();
  ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
  for (let i = 0; i < tanks.length; i++) {
    const tk = tanks[i];
    if (!tk || tk.alive === false) continue;
    const r = CONFIG.tank.radius;
    ctx.beginPath();
    ctx.ellipse((tk.x ?? 0) + 4, (tk.y ?? 0) + 6, r * 1.22, r * 1.05, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawPickupShadows(ctx, pickups) {
  if (!pickups || !pickups.length) return;
  ctx.save();
  for (let i = 0; i < pickups.length; i++) {
    const p = pickups[i];
    if (!p || p.dead || p.state === 'taken') continue;
    const falling = p.state === 'falling';
    const prog = falling ? fallProgress(p) : 1;
    // While the crate is high up the shadow is small and faint; it grows as
    // the crate approaches the ground — a classic, instantly readable cue.
    const rad = 7 + 14 * prog;
    ctx.globalAlpha = 0.18 + 0.30 * prog;
    ctx.fillStyle = '#000000';
    ctx.beginPath();
    ctx.ellipse(p.x ?? 0, (p.y ?? 0) + 8, rad, rad * 0.55, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Layer 5 — pickups
// ---------------------------------------------------------------------------

/**
 * Fall progress of an air-dropped crate: 0 while it is high in the sky, 1 the
 * moment it lands.
 *
 * `Pickup.fallT` is ALREADY normalized to 0..1 by `powerups.js`
 * (`fallT = Math.min(1, fallT + dt / airdropFallTime)`). Dividing it by
 * `airdropFallTime` a second time capped the progress at 1/1.4 = 0.714, so the
 * crate stopped 183 logical pixels above the ground and then teleported down in
 * a single frame — one frame after the dust, the shake and the 'airdrop' sound
 * had already played.
 */
function fallProgress(p) {
  return clamp(p.fallT ?? 0, 0, 1);
}

function drawPickups(ctx, pickups, t) {
  if (!pickups || !pickups.length) return;
  for (let i = 0; i < pickups.length; i++) {
    const p = pickups[i];
    if (!p || p.dead || p.state === 'taken') continue;
    drawPickup(ctx, p, t);
  }
}

function drawPickup(ctx, p, t) {
  const style = powerupStyle(p.defId);
  const falling = p.state === 'falling';
  const prog = falling ? fallProgress(p) : 1;
  const x = p.x ?? 0;
  const bobPhase = Number.isFinite(p.bob) ? p.bob : t;
  const hover = falling ? 0 : Math.sin(bobPhase * 2.1) * 4.5;
  const y = (p.y ?? 0) + hover - (1 - prog) * AIRDROP_HEIGHT;
  const spin = Number.isFinite(p.spin) ? p.spin : t * 0.6;
  const size = 15;

  ctx.save();
  ctx.translate(x, y);

  // Glow halo in the power-up colour (cached radial gradient, reused by
  // translating instead of rebuilding it every frame).
  const glow = cachedGradient(ctx, `glow:${p.defId}`, (c) => {
    const g = c.createRadialGradient(0, 0, 2, 0, 0, 46);
    g.addColorStop(0, hexToRgba(style.color, 0.55));
    g.addColorStop(0.45, hexToRgba(style.color, 0.20));
    g.addColorStop(1, hexToRgba(style.color, 0));
    return g;
  });
  ctx.globalAlpha = 0.75 + 0.25 * Math.sin(bobPhase * 3.1);
  ctx.fillStyle = glow;
  ctx.fillRect(-46, -46, 92, 92);
  ctx.globalAlpha = 1;

  // Parachute while the crate is still in the air.
  if (falling && prog < 1) {
    ctx.save();
    // Fades out over the last 15% of the drop instead of blinking away.
    ctx.globalAlpha = clamp((1 - prog) / 0.15, 0, 1);
    ctx.beginPath();
    ctx.moveTo(-24, -22);
    ctx.quadraticCurveTo(0, -62, 24, -22);
    ctx.closePath();
    ctx.fillStyle = hexToRgba(style.color, 0.55);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-24, -22); ctx.lineTo(-9, -6);
    ctx.moveTo(24, -22); ctx.lineTo(9, -6);
    ctx.moveTo(0, -40); ctx.lineTo(0, -8);
    ctx.strokeStyle = 'rgba(226,232,240,0.45)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.restore();
  }

  // Crate.
  ctx.save();
  ctx.rotate(spin * 0.5);
  roundRectPath(ctx, -size, -size, size * 2, size * 2, 5);
  ctx.fillStyle = 'rgba(15, 20, 30, 0.92)';
  ctx.fill();
  ctx.strokeStyle = style.color;
  ctx.lineWidth = 3;
  ctx.stroke();
  // Corner ticks give the crate a "container" feel.
  ctx.strokeStyle = hexToRgba(style.color, 0.5);
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-size + 4, -size + 4); ctx.lineTo(-size + 4, -size + 10);
  ctx.moveTo(size - 4, size - 4); ctx.lineTo(size - 4, size - 10);
  ctx.stroke();
  ctx.restore();

  // Icon stays upright so it is always readable.
  drawPowerupIcon(ctx, p.defId, 0, 0, size * 1.5, style.color);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Layers 6 & 8 — bullets, rockets and their trails
// ---------------------------------------------------------------------------

/** Colour lookup by owner index, filled once per frame (no per-bullet search). */
const ownerColors = [];

function refreshOwnerColors(tanks) {
  ownerColors.length = 0;
  for (let i = 0; i < tanks.length; i++) {
    const tk = tanks[i];
    if (!tk) continue;
    ownerColors[tk.index ?? i] = resolveColor(tk.color);
  }
}

function ownerColor(index) {
  return ownerColors[index] || FALLBACK_COLOR;
}

/**
 * Trails are stored as `Array<{x,y}>` but the module contract does not fix
 * whether the newest sample sits at the head or the tail, so the end closest
 * to the projectile is treated as the newest one.
 */
function drawTrails(ctx, bullets) {
  if (!bullets || !bullets.length) return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let i = 0; i < bullets.length; i++) {
    const b = bullets[i];
    if (!b || b.dead) continue;
    const trail = b.trail;
    if (!trail || trail.length < 2) continue;

    const col = ownerColor(b.ownerIndex);
    const isRocket = b.isRocket === true;
    const n = trail.length;
    const head = trail[0];
    const tail = trail[n - 1];
    const bx = b.x ?? 0;
    const by = b.y ?? 0;
    const headIsNewest =
      Math.hypot((head?.x ?? 0) - bx, (head?.y ?? 0) - by) <=
      Math.hypot((tail?.x ?? 0) - bx, (tail?.y ?? 0) - by);

    for (let k = 0; k < n - 1; k++) {
      const a = trail[k];
      const c = trail[k + 1];
      if (!a || !c) continue;
      // `age01`: 0 = newest segment, 1 = oldest.
      const age01 = headIsNewest ? k / (n - 1) : 1 - k / (n - 1);
      const fade = 1 - age01;
      if (isRocket) {
        // Rocket: fat smoke puffs instead of a thin streak.
        ctx.globalAlpha = 0.30 * fade;
        ctx.fillStyle = '#94a3b8';
        ctx.beginPath();
        ctx.arc(a.x, a.y, 2 + 6 * age01, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.globalAlpha = 0.55 * fade;
        ctx.strokeStyle = col.light;
        ctx.lineWidth = (CONFIG.bullet.radius * 1.7) * fade + 0.6;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(c.x, c.y);
        ctx.stroke();
      }
    }
  }
  ctx.restore();
}

function drawProjectiles(ctx, bullets, t) {
  if (!bullets || !bullets.length) return;
  for (let i = 0; i < bullets.length; i++) {
    const b = bullets[i];
    if (!b || b.dead) continue;
    if (b.isRocket === true) drawRocket(ctx, b, t);
    else drawBullet(ctx, b);
  }
}

function drawBullet(ctx, b) {
  const col = ownerColor(b.ownerIndex);
  const r = b.radius ?? CONFIG.bullet.radius;
  ctx.save();
  ctx.translate(b.x ?? 0, b.y ?? 0);

  // Coloured halo (cached per palette colour).
  const halo = cachedGradient(ctx, `bhalo:${col.main}`, (c) => {
    const g = c.createRadialGradient(0, 0, 0, 0, 0, 14);
    g.addColorStop(0, hexToRgba(col.light, 0.55));
    g.addColorStop(1, hexToRgba(col.main, 0));
    return g;
  });
  ctx.fillStyle = halo;
  ctx.fillRect(-14, -14, 28, 28);

  // Body + hot white core.
  ctx.beginPath();
  ctx.arc(0, 0, r + 0.8, 0, Math.PI * 2);
  ctx.fillStyle = col.main;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(-r * 0.22, -r * 0.22, r * 0.55, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();

  // A bullet that already bounced is ringed, so players can judge the danger.
  if ((b.bounces ?? 0) > 0) {
    ctx.beginPath();
    ctx.arc(0, 0, r + 3.2, 0, Math.PI * 2);
    ctx.strokeStyle = hexToRgba(col.light, 0.75);
    ctx.lineWidth = 1.4;
    ctx.stroke();
  }
  ctx.restore();
}

function drawRocket(ctx, b, t) {
  const angle = Math.atan2(b.vy ?? 0, b.vx ?? 1);
  ctx.save();
  ctx.translate(b.x ?? 0, b.y ?? 0);

  // Engine glow.
  const glow = cachedGradient(ctx, 'rocketglow', (c) => {
    const g = c.createRadialGradient(0, 0, 0, 0, 0, 26);
    g.addColorStop(0, 'rgba(249, 115, 22, 0.55)');
    g.addColorStop(1, 'rgba(249, 115, 22, 0)');
    return g;
  });
  ctx.fillStyle = glow;
  ctx.fillRect(-26, -26, 52, 52);

  ctx.rotate(angle);

  // Exhaust flame, flickering.
  const flame = 10 + Math.sin(t * 40) * 3;
  ctx.beginPath();
  ctx.moveTo(-11, -3.4);
  ctx.lineTo(-11 - flame, 0);
  ctx.lineTo(-11, 3.4);
  ctx.closePath();
  ctx.fillStyle = 'rgba(253, 224, 71, 0.9)';
  ctx.fill();

  // Fins.
  ctx.fillStyle = '#7c2d12';
  ctx.beginPath();
  ctx.moveTo(-9, -3.5); ctx.lineTo(-13, -8); ctx.lineTo(-5, -3.5); ctx.closePath();
  ctx.moveTo(-9, 3.5); ctx.lineTo(-13, 8); ctx.lineTo(-5, 3.5); ctx.closePath();
  ctx.fill();

  // Body + nose cone.
  roundRectPath(ctx, -11, -4, 20, 8, 3.4);
  ctx.fillStyle = '#e2e8f0';
  ctx.fill();
  ctx.strokeStyle = '#475569';
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(9, -4);
  ctx.lineTo(16, 0);
  ctx.lineTo(9, 4);
  ctx.closePath();
  ctx.fillStyle = '#f97316';
  ctx.fill();

  ctx.restore();
}

// ---------------------------------------------------------------------------
// Layer 7 — tanks
// ---------------------------------------------------------------------------

/**
 * Draws one tank: treads, hull, turret, barrel, muzzle flash, the large
 * colour-blind friendly player number, plus status decorations (invulnerability
 * blink and ring, shield hexagons, floating power-up icons).
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} tank
 * @param {number} t seconds
 * @param {boolean} [decorations=true] set to false for static previews
 */
function drawTank(ctx, tank, t, decorations) {
  const col = resolveColor(tank.color);
  const r = CONFIG.tank.radius;
  const hullAngle = tank.angle ?? 0;
  const turretAngle = tank.turretAngle ?? hullAngle;
  const invuln = tank.invulnTimer ?? 0;
  const showDecor = decorations !== false;

  ctx.save();
  ctx.translate(tank.x ?? 0, tank.y ?? 0);

  // Invulnerability: a smooth sine fade instead of a harsh on/off blink.
  let bodyAlpha = 1;
  if (invuln > 0) bodyAlpha = 0.42 + 0.58 * (0.5 + 0.5 * Math.sin(t * 15));

  ctx.save();
  ctx.globalAlpha = bodyAlpha;

  // --- hull frame (rotates with the chassis) ---
  ctx.save();
  ctx.rotate(hullAngle);
  drawTreads(ctx, r, tank.trackPhase ?? 0);

  // Hull plate.
  roundRectPath(ctx, -r * 0.98, -r * 0.74, r * 1.96, r * 1.48, 5);
  ctx.fillStyle = col.main;
  ctx.fill();
  ctx.strokeStyle = col.dark;
  ctx.lineWidth = 2.6;
  ctx.stroke();

  // Top-light highlight and a front wedge that makes the facing obvious.
  ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
  ctx.fillRect(-r * 0.9, -r * 0.66, r * 1.8, r * 0.42);
  ctx.beginPath();
  ctx.moveTo(r * 0.98, 0);
  ctx.lineTo(r * 0.5, -r * 0.5);
  ctx.lineTo(r * 0.5, r * 0.5);
  ctx.closePath();
  ctx.fillStyle = hexToRgba(col.light, 0.55);
  ctx.fill();
  ctx.restore();

  // --- turret frame ---
  ctx.save();
  ctx.rotate(turretAngle);
  // Barrel.
  roundRectPath(ctx, r * 0.15, -3.4, CONFIG.tank.barrelLength, 6.8, 2.4);
  ctx.fillStyle = col.dark;
  ctx.fill();
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.lineWidth = 1.2;
  ctx.stroke();
  // Muzzle band.
  ctx.fillStyle = col.light;
  ctx.fillRect(r * 0.15 + CONFIG.tank.barrelLength - 5, -3.4, 3.2, 6.8);
  ctx.restore();

  // Turret dome (over the barrel root).
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.62, 0, Math.PI * 2);
  ctx.fillStyle = col.main;
  ctx.fill();
  ctx.strokeStyle = col.dark;
  ctx.lineWidth = 2.4;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(-r * 0.16, -r * 0.16, r * 0.24, 0, Math.PI * 2);
  ctx.fillStyle = hexToRgba(col.light, 0.45);
  ctx.fill();

  ctx.restore(); // end of the alpha-faded body

  // Hit flash — a bright wash over the whole tank.
  const hitFlash = tank.hitFlash ?? 0;
  if (hitFlash > 0) {
    ctx.save();
    ctx.globalAlpha = clamp(hitFlash / (CONFIG.tank.hitFlashTime || 0.18), 0, 1) * 0.8;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.25, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Muzzle flash, drawn in world space along the turret direction.
  const mf = tank.muzzleFlash ?? 0;
  if (mf > 0) {
    const k = clamp(mf * 10, 0, 1);
    ctx.save();
    ctx.rotate(turretAngle);
    ctx.translate(r * 0.15 + CONFIG.tank.barrelLength + 2, 0);
    const fg = cachedGradient(ctx, 'muzzle', (c) => {
      const g = c.createRadialGradient(0, 0, 0, 0, 0, 18);
      g.addColorStop(0, 'rgba(255, 255, 255, 0.95)');
      g.addColorStop(0.35, 'rgba(253, 224, 71, 0.7)');
      g.addColorStop(1, 'rgba(249, 115, 22, 0)');
      return g;
    });
    ctx.globalAlpha = k;
    ctx.scale(0.55 + k * 0.6, 0.55 + k * 0.6);
    ctx.fillStyle = fg;
    ctx.fillRect(-18, -18, 36, 36);
    // Star spikes.
    ctx.fillStyle = 'rgba(255, 247, 214, 0.9)';
    ctx.beginPath();
    ctx.moveTo(16, 0); ctx.lineTo(2, -6); ctx.lineTo(-4, 0); ctx.lineTo(2, 6);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  if (showDecor) {
    // Invulnerability ring.
    if (invuln > 0) {
      ctx.beginPath();
      ctx.arc(0, 0, r + 6, 0, Math.PI * 2);
      ctx.strokeStyle = hexToRgba(col.light, 0.35 + 0.35 * (0.5 + 0.5 * Math.sin(t * 9)));
      ctx.lineWidth = 1.8;
      ctx.stroke();
    }

    // Shield hexagons — one slowly rotating ring per stacked shield.
    const shields = clamp(tank.shields ?? 0, 0, 2);
    for (let i = 0; i < shields; i++) {
      const rad = r + 11 + i * 7;
      hexPath(ctx, 0, 0, rad, t * (0.45 + i * 0.18) + i * 0.52);
      ctx.strokeStyle = hexToRgba('#7dd3fc', 0.35 + 0.30 * (0.5 + 0.5 * Math.sin(t * 2.6 + i)));
      ctx.lineWidth = 2.4;
      ctx.stroke();
    }

    // Pick-up flash: a quick expanding ring.
    const pf = tank.pickupFlash ?? 0;
    if (pf > 0) {
      const k = clamp(pf / 0.45, 0, 1);
      ctx.beginPath();
      ctx.arc(0, 0, r + 8 + (1 - k) * 26, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255, 255, 255, ${0.6 * k})`;
      ctx.lineWidth = 3 * k + 0.5;
      ctx.stroke();
    }
  }

  // Player number: screen aligned, huge and outlined. This is THE colour-blind
  // friendly identification, so it is painted last and never faded.
  ctx.font = font(20, 900);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  outlinedText(ctx, String((tank.index ?? 0) + 1), 0, 0.5, '#ffffff', 'rgba(0, 0, 0, 0.92)', 4.5);

  // Active power-ups float above the tank so opponents can see them too.
  if (showDecor) drawTankPowerupBadges(ctx, tank, r);

  ctx.restore();
}

/** Animated treads: the segment lines scroll with `trackPhase`. */
function drawTreads(ctx, r, phase) {
  const L = r * 2.32;
  const W = r * 0.62;
  const off = r * 0.84;
  const spacing = 6.5;
  // Works whether `trackPhase` accumulates distance or radians — only the
  // remainder matters, so the pattern always scrolls smoothly.
  const scroll = ((phase % spacing) + spacing) % spacing;

  for (let s = -1; s <= 1; s += 2) {
    const cy = s * off;
    roundRectPath(ctx, -L / 2, cy - W / 2, L, W, 3);
    ctx.fillStyle = '#1b202a';
    ctx.fill();
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    ctx.beginPath();
    for (let px = -L / 2 + scroll; px < L / 2 - 0.5; px += spacing) {
      if (px <= -L / 2 + 0.5) continue;
      ctx.moveTo(px, cy - W / 2 + 1);
      ctx.lineTo(px, cy + W / 2 - 1);
    }
    ctx.strokeStyle = 'rgba(226, 232, 240, 0.20)';
    ctx.lineWidth = 1.8;
    ctx.stroke();
  }
}

/** Small icon row hovering above the tank (mirrors the HUD card). */
function drawTankPowerupBadges(ctx, tank, r) {
  const ups = tank.powerups || {};
  const ids = [];
  if ((ups.rapid ?? 0) > 0) ids.push('rapid');
  if ((ups.speed ?? 0) > 0) ids.push('speed');
  if ((tank.rocketAmmo ?? 0) > 0) ids.push('rocket');
  if ((tank.shields ?? 0) > 0) ids.push('life');
  if (!ids.length) return;

  const iconSize = 13;
  const pitch = 17;
  const totalW = ids.length * pitch + 8;
  const y = -r - 21;

  ctx.save();
  fillRoundRect(ctx, -totalW / 2, y - 10, totalW, 20, 10, 'rgba(8, 12, 20, 0.62)');
  for (let i = 0; i < ids.length; i++) {
    const x = -totalW / 2 + 4 + pitch * i + pitch / 2 - 0.5;
    drawPowerupIcon(ctx, ids[i], x, y, iconSize, powerupStyle(ids[i]).color);
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Layer 9 — particles
// ---------------------------------------------------------------------------

/**
 * Particle fields beyond `x`/`y` are not nailed down by the contract, so every
 * read is defensive and the remaining lifetime is normalised against whichever
 * "total life" field exists.
 */
function drawParticles(ctx, particles) {
  if (!particles || !particles.length) return;
  ctx.save();
  ctx.lineCap = 'round';
  for (let i = 0; i < particles.length; i++) {
    const p = particles[i];
    if (!p || p.dead) continue;
    const total = p.maxLife ?? p.lifeMax ?? p.life0 ?? p.totalLife ?? p.life ?? 1;
    const k = clamp((p.life ?? 0) / (total || 1), 0, 1);
    const alpha = clamp(p.alpha ?? k, 0, 1);
    if (alpha <= 0.01) continue;
    const color = p.color || '#e2e8f0';
    const size = p.size ?? 3;
    const x = p.x ?? 0;
    const y = p.y ?? 0;
    const kind = p.kind || 'spark';

    ctx.globalAlpha = alpha;
    if (kind === 'ring') {
      const rad = p.radius ?? p.r ?? (size * (1 + 2.6 * (1 - k)));
      ctx.beginPath();
      ctx.arc(x, y, Math.max(0.5, rad), 0, Math.PI * 2);
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(0.6, 4 * k);
      ctx.stroke();
    } else if (kind === 'smoke') {
      ctx.globalAlpha = alpha * 0.45;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(0.5, size * (1.6 - k * 0.6)), 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    } else if (kind === 'debris') {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(p.rot ?? (p.angle ?? 0));
      ctx.fillStyle = color;
      ctx.fillRect(-size * 0.5, -size * 0.35, size, size * 0.7);
      ctx.restore();
    } else {
      // 'spark': a short streak along the velocity vector, falling back to a dot.
      const vx = p.vx ?? 0;
      const vy = p.vy ?? 0;
      const sp = Math.hypot(vx, vy);
      if (sp > 30) {
        const len = clamp(sp * 0.018, 2, 14);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x - (vx / sp) * len, y - (vy / sp) * len);
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(1, size * 0.8);
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(x, y, Math.max(0.6, size * 0.6), 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
      }
    }
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Layer 10 — full screen flash
// ---------------------------------------------------------------------------

function drawScreenFlash(ctx, fx) {
  const f = clamp(fx.flash ?? 0, 0, 1);
  if (f <= 0.004) return;
  ctx.save();
  ctx.globalAlpha = f * 0.55;
  ctx.fillStyle = typeof fx.flashColor === 'string' ? fx.flashColor : '#ffffff';
  ctx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------

/** Corner anchors for the four player cards: TL, TR, BL, BR. */
const CARD_SLOTS = [
  { x: CARD_M, y: CARD_M, right: false },
  { x: LOGICAL_W - CARD_M - CARD_W, y: CARD_M, right: true },
  { x: CARD_M, y: LOGICAL_H - CARD_M - CARD_H, right: false },
  { x: LOGICAL_W - CARD_M - CARD_W, y: LOGICAL_H - CARD_M - CARD_H, right: true },
];

/** `game.scoreboard()` may be missing or throw — never let the HUD kill a frame. */
function safeScoreboard(game) {
  try {
    const rows = typeof game.scoreboard === 'function' ? game.scoreboard() : null;
    return Array.isArray(rows) ? rows : [];
  } catch (_err) {
    return [];
  }
}

function drawHud(ctx, game, tanks, time) {
  const board = safeScoreboard(game);
  const settings = (game.world && game.world.settings) || {};
  const target = settings.pointsToWin ?? CONFIG.match.pointsToWin;

  // Idő a simításhoz. Az első kép és egy visszaugró óra (jelenetváltás) is
  // 0 dt-t ad, ilyenkor a kártya azonnal a végállapotba ugrik.
  const now = Number.isFinite(time) ? time : 0;
  let dt = cardFadeTime < 0 ? 0 : now - cardFadeTime;
  if (!(dt > 0) || dt > 0.25) dt = 0;
  cardFadeTime = now;

  // Player cards.
  for (let i = 0; i < tanks.length; i++) {
    const tank = tanks[i];
    if (!tank) continue;
    const idx = clamp(tank.index ?? i, 0, 3) | 0;
    const slot = CARD_SLOTS[idx];
    const row = board.find((r) => r && r.index === tank.index);
    const name = (row && row.name) || playerLabel(idx);
    // A card sitting on top of a tank would hide the one thing the player is
    // actually looking at, so it gets out of the way while that lasts.
    const clear = cardFade(idx, cardCovered(slot, tanks), dt);
    drawPlayerCard(ctx, slot, tank, name, target,
      CARD_MIN_ALPHA + (1 - CARD_MIN_ALPHA) * clear,
      CARD_TEXT_MIN_ALPHA + (1 - CARD_TEXT_MIN_ALPHA) * clear);
  }

  // Target score + current leader, centred at the top.
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  fillRoundRect(ctx, LOGICAL_W / 2 - 92, 12, 184, 40, 20, 'rgba(8, 12, 20, 0.62)');
  strokeRoundRect(ctx, LOGICAL_W / 2 - 92, 12, 184, 40, 20, 'rgba(148, 163, 184, 0.28)', 1.5);
  ctx.font = font(23, 800);
  outlinedText(ctx, `Cél: ${target}`, LOGICAL_W / 2, 33, '#f1f5f9', 'rgba(0,0,0,0.7)', 3);

  const leader = board.length ? board[0] : null;
  if (leader) {
    const lc = resolveColor(leader.color);
    const second = board.length > 1 ? (board[1].score ?? 0) : 0;
    const lead = (leader.score ?? 0) - second;
    const text = (board.length > 1 && lead === 0)
      ? 'Állás: döntetlen'
      : `Vezet: ${leader.name || playerLabel(leader.index ?? 0)} — ${leader.score ?? 0}`;
    ctx.font = font(16, 700);
    outlinedText(ctx, text, LOGICAL_W / 2, 66, lc.light, 'rgba(0,0,0,0.75)', 3.5);
  }
  ctx.restore();
}

/**
 * Mennyire halványul el a kártya, amíg élő tank van alatta.
 *
 * A HÁTTÉR (panel, keret, színcsík, haladássáv) majdnem eltűnik: ez az, ami
 * ténylegesen kitakarja a tankot. A TARTALOM (név, pontszám, K/D) csak félig
 * halványul, mert olvashatónak kell maradnia: minden ilyen felirat sötét
 * kontúrral rajzolódik (`outlinedText`), ami a világos pályán is megtartja a
 * kontrasztot — de nullára vinni a pontszámot pont akkor tüntetné el, amikor
 * abban a sarokban folyik a harc.
 */
const CARD_MIN_ALPHA = 0.1;
const CARD_TEXT_MIN_ALPHA = 0.5;

/** Elhalványulás sebessége. ~0,15 mp alatt áll be, így nem villog. */
const CARD_FADE_LAMBDA = 16;

/** Kártyánként simított "szabad-e" érték (1 = szabad, 0 = tank van alatta). */
const cardClear = [1, 1, 1, 1];
/** Az előző kép ideje másodpercben, a simítás dt-jéhez. */
let cardFadeTime = -1;

/**
 * Van-e élő tank a kártya alatt.
 * @param {{x:number, y:number}} slot card position
 * @param {Array} tanks every tank of the match
 * @returns {boolean}
 */
function cardCovered(slot, tanks) {
  for (let i = 0; i < tanks.length; i++) {
    const tank = tanks[i];
    if (!tank || tank.alive === false) continue;
    const r = (tank.radius ?? CONFIG.tank.radius) + 10;
    if (tank.x > slot.x - r && tank.x < slot.x + CARD_W + r
      && tank.y > slot.y - r && tank.y < slot.y + CARD_H + r) {
      return true;
    }
  }
  return false;
}

/**
 * Frissíti és visszaadja a kártya simított "szabad" értékét (0..1).
 * @param {number} index kártya sorszáma (0..3)
 * @param {boolean} covered van-e alatta tank
 * @param {number} dt eltelt idő másodpercben
 * @returns {number}
 */
function cardFade(index, covered, dt) {
  const i = clamp(index, 0, cardClear.length - 1) | 0;
  const target = covered ? 0 : 1;
  cardClear[i] = dt > 0 ? damp(cardClear[i], target, CARD_FADE_LAMBDA, dt) : target;
  return cardClear[i];
}

/**
 * One corner card: colour strip, name, big score, K/D, power-up row, score
 * progress bar and — while dead — the respawn countdown.
 *
 * `alpha` only ever applies to the CHROME. Everything the player has to read
 * (name, K/D, score, respawn countdown) stays fully opaque — its black outline
 * keeps it legible on top of a tank, which is the whole point of dimming.
 *
 * @param {number} [alpha=1] chrome opacity, see `cardOpacity()`
 */
function drawPlayerCard(ctx, slot, tank, name, target, alpha, textAlpha) {
  const col = resolveColor(tank.color);
  const x = slot.x;
  const y = slot.y;
  const right = slot.right;
  const pad = 16;
  // Anchor + direction so the right hand cards mirror their content.
  const ax = right ? x + CARD_W - pad : x + pad;
  const align = right ? 'right' : 'left';
  const dir = right ? -1 : 1;
  const dim = Number.isFinite(alpha) ? clamp(alpha, 0, 1) : 1;
  const ink = Number.isFinite(textAlpha) ? clamp(textAlpha, 0, 1) : 1;

  ctx.save();
  ctx.globalAlpha = dim;

  // Background + border. The border glows briefly after a pick-up.
  fillRoundRect(ctx, x, y, CARD_W, CARD_H, 12, 'rgba(9, 13, 21, 0.68)');
  const flash = clamp((tank.pickupFlash ?? 0) / 0.45, 0, 1);
  strokeRoundRect(
    ctx, x + 1, y + 1, CARD_W - 2, CARD_H - 2, 11,
    flash > 0 ? `rgba(255,255,255,${0.35 + 0.5 * flash})` : hexToRgba(col.main, 0.55),
    flash > 0 ? 3 : 2,
  );

  // Colour strip on the outer edge.
  const stripX = right ? x + CARD_W - 9 : x + 3;
  fillRoundRect(ctx, stripX, y + 8, 6, CARD_H - 16, 3, col.main);

  // Innentől a tartalom jön. Ez is halványul, de csak félig: a sötét kontúr
  // miatt olvasható marad, viszont már átlátszik alatta a tank.
  ctx.globalAlpha = ink;

  ctx.textBaseline = 'middle';
  ctx.textAlign = align;

  // Name + device.
  ctx.font = font(17, 800);
  outlinedText(ctx, name, ax, y + 22, col.light, 'rgba(0,0,0,0.75)', 3);

  // Kills / deaths.
  ctx.font = font(13, 600);
  ctx.fillStyle = 'rgba(226, 232, 240, 0.62)';
  ctx.fillText(`Ölés ${tank.kills ?? 0} · Halál ${tank.deaths ?? 0}`, ax, y + 42);

  // Big score on the opposite side of the name.
  ctx.textAlign = right ? 'left' : 'right';
  const sx = right ? x + pad : x + CARD_W - pad;
  ctx.font = font(46, 900);
  outlinedText(ctx, String(tank.score ?? 0), sx, y + 36, '#ffffff', 'rgba(0,0,0,0.8)', 5);

  // Power-up row.
  ctx.textAlign = align;
  drawCardPowerups(ctx, ax, y + 72, dir, tank);

  // Score progress towards the target (decoration, so it dims with the chrome).
  const frac = clamp((tank.score ?? 0) / (target || 1), 0, 1);
  ctx.globalAlpha = dim;
  fillRoundRect(ctx, x + 10, y + CARD_H - 10, CARD_W - 20, 4, 2, 'rgba(255,255,255,0.10)');
  if (frac > 0) {
    fillRoundRect(ctx, x + 10, y + CARD_H - 10, (CARD_W - 20) * frac, 4, 2, col.main);
  }
  ctx.globalAlpha = 1;

  // Respawn countdown while dead. A takaró réteg majdnem átlátszatlan, hogy a
  // pontszám ne üssön át a számlálón — de ha épp EGY MÁSIK tank harcol a
  // kártya alatt, ez a réteg takarná ki a legjobban, ezért az is halványul.
  if (tank.alive === false) {
    ctx.globalAlpha = dim;
    fillRoundRect(ctx, x, y, CARD_W, CARD_H, 12, 'rgba(6, 9, 15, 0.94)');
    ctx.globalAlpha = ink;
    ctx.textAlign = 'center';
    ctx.font = font(14, 700);
    ctx.fillStyle = 'rgba(226, 232, 240, 0.75)';
    ctx.fillText('ÚJRAÉLEDÉS', x + CARD_W / 2, y + 34);
    const rt = Math.max(0, tank.respawnTimer ?? 0);
    ctx.font = font(40, 900);
    outlinedText(ctx, `${rt.toFixed(1)} s`, x + CARD_W / 2, y + 68, col.light, 'rgba(0,0,0,0.85)', 5);
    ctx.globalAlpha = 1;
  }

  ctx.restore();
}

/** Icon row of the card: timed bars, rocket ammo count and shield hearts. */
function drawCardPowerups(ctx, ax, y, dir, tank) {
  const ups = tank.powerups || {};
  const items = [];
  if ((ups.rapid ?? 0) > 0) {
    items.push({ id: 'rapid', frac: clamp(ups.rapid / (CONFIG.powerup.rapidTime || 12), 0, 1) });
  }
  if ((ups.speed ?? 0) > 0) {
    items.push({ id: 'speed', frac: clamp(ups.speed / (CONFIG.powerup.speedTime || 12), 0, 1) });
  }
  const ammo = tank.rocketAmmo ?? 0;
  if (ammo > 0) items.push({ id: 'rocket', label: `×${ammo}` });
  const shields = tank.shields ?? 0;
  if (shields > 0) items.push({ id: 'life', hearts: shields });

  if (!items.length) {
    ctx.font = font(12, 600);
    ctx.fillStyle = 'rgba(148, 163, 184, 0.35)';
    ctx.fillText('nincs bónusz', ax, y + 2);
    return;
  }

  const cell = 46;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const style = powerupStyle(it.id);
    // `dir` mirrors the layout for the right hand cards.
    const cx = ax + dir * (i * cell + 11);
    drawPowerupIcon(ctx, it.id, cx, y, 20, style.color);

    if (it.frac !== undefined) {
      const bw = 26;
      const bx = cx - bw / 2;
      fillRoundRect(ctx, bx, y + 14, bw, 4, 2, 'rgba(255,255,255,0.14)');
      fillRoundRect(ctx, bx, y + 14, bw * it.frac, 4, 2, style.color);
    } else if (it.label) {
      ctx.save();
      ctx.textAlign = 'center';
      ctx.font = font(13, 800);
      outlinedText(ctx, it.label, cx, y + 17, style.color, 'rgba(0,0,0,0.8)', 3);
      ctx.restore();
    } else if (it.hearts) {
      for (let h = 0; h < it.hearts; h++) {
        drawPowerupIcon(ctx, 'life', cx - 5 + h * 10, y + 16, 9, '#fca5a5');
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Countdown and match end overlays
// ---------------------------------------------------------------------------

/**
 * The `Game` contract does not expose a countdown field by name, so several
 * plausible names are probed. A probed value is only trusted while it keeps
 * moving — a field that stays constant is the countdown LENGTH, not the
 * remaining time. Whenever nothing usable is found the renderer falls back to
 * its own timer, anchored at the moment the state turned into 'countdown'.
 */
let cdAnchor = -1;
let prevState = null;
let goUntil = -1;
let cdProbeValue = NaN;
let cdProbeChangedAt = -1;

function countdownRemaining(game, t) {
  const w = game.world || {};
  const candidates = [
    game.countdown, game.countdownTimer, game.countdownLeft,
    game.stateTimer, w.countdown, w.countdownTimer,
  ];
  let probe = NaN;
  for (let i = 0; i < candidates.length; i++) {
    if (Number.isFinite(candidates[i])) {
      probe = candidates[i];
      break;
    }
  }
  if (Number.isFinite(probe)) {
    if (probe !== cdProbeValue) {
      cdProbeValue = probe;
      cdProbeChangedAt = t;
    }
    if (t - cdProbeChangedAt < 0.4) return probe;
  }
  if (cdAnchor < 0) return CONFIG.match.countdown;
  return CONFIG.match.countdown - (t - cdAnchor);
}

function drawCountdown(ctx, remaining, t) {
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  let text;
  let scale;
  let alpha;
  if (remaining > 0) {
    const frac = remaining - Math.floor(remaining); // 1 -> just switched, 0 -> about to switch
    text = String(Math.ceil(remaining));
    scale = 0.85 + 0.75 * frac * frac;
    alpha = clamp(frac * 3, 0, 1);
  } else {
    const k = clamp((goUntil - t) / 0.8, 0, 1);
    text = 'HAJRÁ!';
    scale = 1.05 + (1 - k) * 0.55;
    alpha = k;
  }
  if (alpha <= 0.01) {
    ctx.restore();
    return;
  }

  ctx.globalAlpha = alpha;
  ctx.translate(LOGICAL_W / 2, LOGICAL_H / 2 - 20);
  ctx.scale(scale, scale);
  ctx.font = font(remaining > 0 ? 170 : 120, 900);
  outlinedText(ctx, text, 0, 0, '#ffffff', 'rgba(3, 6, 12, 0.85)', 12);
  ctx.globalAlpha = alpha * 0.8;
  ctx.font = font(24, 700);
  ctx.fillStyle = 'rgba(226, 232, 240, 0.8)';
  if (remaining > 0) ctx.fillText('Felkészülés…', 0, 120);
  ctx.restore();
}

function drawMatchEnd(ctx, game, t) {
  const board = safeScoreboard(game);
  const winner = game.winner || null;
  const winColor = winner ? resolveColor(winner.colorId || winner.color) : FALLBACK_COLOR;

  ctx.save();
  ctx.fillStyle = 'rgba(5, 8, 14, 0.80)';
  ctx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  ctx.font = font(24, 700);
  ctx.fillStyle = 'rgba(148, 163, 184, 0.85)';
  ctx.fillText('MECCS VÉGE', LOGICAL_W / 2, 150);

  // Winner headline with a gentle pulse.
  const pulse = 1 + Math.sin(t * 3) * 0.02;
  ctx.save();
  ctx.translate(LOGICAL_W / 2, 226);
  ctx.scale(pulse, pulse);
  ctx.font = font(70, 900);
  const title = winner
    ? `GYŐZTES: ${winner.name || playerLabel(winner.index ?? 0)}`
    : 'DÖNTETLEN';
  outlinedText(ctx, title, 0, 0, winColor.main, 'rgba(0, 0, 0, 0.85)', 9);
  ctx.restore();

  // Result table.
  const tableW = 920;
  const x0 = (LOGICAL_W - tableW) / 2;
  const headY = 320;
  const cols = [x0 + 40, x0 + 90, x0 + 520, x0 + 650, x0 + 780, x0 + 900];

  ctx.font = font(16, 700);
  ctx.fillStyle = 'rgba(148, 163, 184, 0.8)';
  ctx.textAlign = 'left';
  ctx.fillText('#', cols[0] - 12, headY);
  ctx.fillText('Játékos', cols[1], headY);
  ctx.textAlign = 'right';
  ctx.fillText('Pont', cols[2], headY);
  ctx.fillText('Ölés', cols[3], headY);
  ctx.fillText('Halál', cols[4], headY);
  ctx.fillText('Öngól', cols[5], headY);

  ctx.strokeStyle = 'rgba(148, 163, 184, 0.25)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x0, headY + 18);
  ctx.lineTo(x0 + tableW, headY + 18);
  ctx.stroke();

  for (let i = 0; i < board.length; i++) {
    const row = board[i];
    if (!row) continue;
    const rc = resolveColor(row.color);
    const ry = headY + 62 + i * 62;

    if (i === 0) {
      fillRoundRect(ctx, x0 - 6, ry - 26, tableW + 12, 52, 10, hexToRgba(rc.main, 0.12));
    }

    ctx.textAlign = 'left';
    ctx.font = font(22, 800);
    ctx.fillStyle = 'rgba(226, 232, 240, 0.55)';
    ctx.fillText(`${i + 1}.`, cols[0] - 12, ry);

    // Colour chip.
    fillRoundRect(ctx, cols[1] - 34, ry - 11, 22, 22, 6, rc.main);
    strokeRoundRect(ctx, cols[1] - 34, ry - 11, 22, 22, 6, rc.dark, 2);

    ctx.font = font(26, 800);
    ctx.fillStyle = rc.light;
    ctx.fillText(row.name || playerLabel(row.index ?? i), cols[1], ry);

    ctx.textAlign = 'right';
    ctx.font = font(30, 900);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(String(row.score ?? 0), cols[2], ry);
    ctx.font = font(22, 700);
    ctx.fillStyle = 'rgba(226, 232, 240, 0.75)';
    ctx.fillText(String(row.kills ?? 0), cols[3], ry);
    ctx.fillStyle = 'rgba(226, 232, 240, 0.55)';
    ctx.fillText(String(row.deaths ?? 0), cols[4], ry);
    ctx.fillText(String(row.ownGoals ?? 0), cols[5], ry);
  }

  // Footer hints.
  ctx.textAlign = 'center';
  ctx.font = font(22, 800);
  const blink = 0.65 + 0.35 * (0.5 + 0.5 * Math.sin(t * 4));
  ctx.fillStyle = `rgba(255, 255, 255, ${blink})`;
  // These must match `handleEndScreenInput()` in main.js: Cross restarts on the
  // spot, Options/Enter and Circle/Esc both go back to the lobby (spec 11).
  ctx.fillText('Kereszt — azonnali visszavágó', LOGICAL_W / 2, 800);
  ctx.font = font(19, 700);
  ctx.fillStyle = 'rgba(148, 163, 184, 0.85)';
  ctx.fillText('Options / Enter vagy Kör / Esc — vissza a lobbiba', LOGICAL_W / 2, 838);

  ctx.restore();
}

// ---------------------------------------------------------------------------
// Public: the in-game frame
// ---------------------------------------------------------------------------

/**
 * Renders one full game frame: arena, entities, effects and HUD.
 *
 * @param {CanvasRenderingContext2D|{ctx:CanvasRenderingContext2D}} ctxOrWrapper
 * @param {object} game the `Game` instance
 * @param {number} t elapsed time in seconds (used for animation phases)
 */
export function drawGame(ctxOrWrapper, game, t) {
  const ctx = unwrap(ctxOrWrapper);
  if (!ctx || !game) return;

  const time = Number.isFinite(t) ? t : 0;
  const world = game.world || {};
  const arena = world.arena || null;
  const tanks = Array.isArray(world.tanks) ? world.tanks : [];
  const bullets = Array.isArray(world.bullets) ? world.bullets : [];
  const particles = Array.isArray(world.particles) ? world.particles : [];
  const pickups = Array.isArray(world.pickups) ? world.pickups : [];
  const fx = world.fx || {};
  const walls = (arena && arena.walls) || [];

  // Track the state transitions the countdown overlay needs.
  const state = game.state || 'playing';
  if (state !== prevState) {
    if (state === 'countdown') cdAnchor = time;
    if (prevState === 'countdown' && state === 'playing') goUntil = time + 0.8;
    prevState = state;
  }

  refreshOwnerColors(tanks);
  beginFrame(ctx);

  // ---- world layers (screen shake applies here, never to the HUD) ----
  ctx.save();
  const shake = clamp(fx.shake ?? 0, 0, CONFIG.fx.maxShake);
  if (shake > 0.15) {
    ctx.translate((Math.random() * 2 - 1) * shake, (Math.random() * 2 - 1) * shake);
  }

  drawFloor(ctx);
  drawWallShadows(ctx, walls);
  drawPickupShadows(ctx, pickups);
  drawTankShadows(ctx, tanks);
  drawWalls(ctx, walls);
  drawPickups(ctx, pickups, time);
  drawTrails(ctx, bullets);

  for (let i = 0; i < tanks.length; i++) {
    const tk = tanks[i];
    if (!tk || tk.alive === false) continue;
    drawTank(ctx, tk, time, true);
  }

  drawProjectiles(ctx, bullets, time);
  drawParticles(ctx, particles);
  ctx.restore();

  // ---- unshaken overlays ----
  drawScreenFlash(ctx, fx);
  drawHud(ctx, game, tanks, time);

  if (state === 'countdown') {
    drawCountdown(ctx, Math.max(0.001, countdownRemaining(game, time)), time);
  } else if (state === 'playing' && time < goUntil) {
    drawCountdown(ctx, 0, time);
  } else if (state === 'matchEnd') {
    drawMatchEnd(ctx, game, time);
  }

  // A szünet mindent takar: ha nem látszik egyértelműen, hogy a játék áll,
  // a játékos azt hiszi, lefagyott.
  if (game.pause && game.pause.active) drawPauseOverlay(ctx, game.pause, time);

  endFrame(ctx);
}

/**
 * Teljes képernyős szünet-fátyol.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {{reason:string, title:string, detail:string, hint:string}} info
 * @param {number} t
 */
function drawPauseOverlay(ctx, info, t) {
  ctx.save();
  ctx.fillStyle = 'rgba(2, 6, 14, 0.82)';
  ctx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const cy = LOGICAL_H / 2;
  const warn = info.reason === 'device';
  const accent = warn ? '#fca5a5' : '#e2e8f0';

  const boxW = 940;
  const boxH = 260;
  fillRoundRect(ctx, (LOGICAL_W - boxW) / 2, cy - boxH / 2, boxW, boxH, 22, 'rgba(11, 16, 25, 0.92)');
  strokeRoundRect(ctx, (LOGICAL_W - boxW) / 2, cy - boxH / 2, boxW, boxH, 22,
    warn ? 'rgba(248, 113, 113, 0.75)' : 'rgba(148, 163, 184, 0.45)', 2.5);

  ctx.font = font(58, 900);
  ctx.fillStyle = accent;
  fitFont(ctx, info.title, boxW - 90, 58, 900);
  ctx.fillText(info.title, LOGICAL_W / 2, cy - 62);

  if (info.detail) {
    ctx.font = font(24, 700);
    ctx.fillStyle = 'rgba(226, 232, 240, 0.85)';
    fitFont(ctx, info.detail, boxW - 90, 24, 700);
    ctx.fillText(info.detail, LOGICAL_W / 2, cy - 4);
  }

  if (info.hint) {
    const pulse = 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(t * 3.2));
    ctx.font = font(21, 700);
    ctx.fillStyle = `rgba(148, 163, 184, ${pulse})`;
    fitFont(ctx, info.hint, boxW - 90, 21, 700);
    ctx.fillText(info.hint, LOGICAL_W / 2, cy + 58);
  }

  ctx.restore();
}

// ---------------------------------------------------------------------------
// Lobby
// ---------------------------------------------------------------------------

/** Lobby slot card geometry. */
const SLOT_W = 356;
// A kártya magasságát a beállítás-sáv szabja meg: a gépi ellenfelek két új
// sorral bővítették, és a lobbi egyetlen képernyőre fér ki görgetés nélkül.
const SLOT_H = 336;
const SLOT_GAP = 16;
const SLOT_Y = 158;
const SLOT_X0 = (LOGICAL_W - (SLOT_W * 4 + SLOT_GAP * 3)) / 2;

/**
 * A kártya belső mértékei. MINDEN kártyabeli koordináta a kártya bal felső
 * sarkához képest értendő: a rajzoló `translate(x, y)`-t hív, így egy méret
 * megváltoztatása nem szór szét húsz abszolút konstanst.
 *
 * Függőleges költségvetés (kártya-lokálisan, SLOT_H = 336):
 *   0..5     szín-akcentus csík
 *   21..43   fejléc (név + eszközcímke), a szám-korong 19..45
 *   54       elválasztó vonal
 *   64..180  hatszög-talp, benne a tank előnézet (66..176)
 *   187..203 szín-súgó szövege
 *   208..242 paletta-sáv (a kiválasztott kerete 209..242)
 *   256..274 szín neve
 *   290..324 állapot-jelvény
 */
const SLOT_R = 18;
const SLOT_PAD = 18;
const SLOT_HEAD_Y = 32;
const SLOT_TANK_Y = 122;
const SLOT_BAR_Y = 212;

/** A közös beállítás-panel mértékei. */
const SET_W = 760;
const SET_X = (LOGICAL_W - SET_W) / 2;
const SET_Y = 506;
const SET_ROW_H = 38;
/**
 * A sor eleji sáv, ahova a fókusz-pöttyök kerülnek. Négy játékos pöttyei
 * `SET_X + 22 + 3*13 + 5,5 = SET_X + 66,5`-ig érnek, a címke `SET_X + 86`-nál
 * kezdődik — így négy emberrel sem takarja el senki a "Gépi ellenfelek" elejét.
 */
const SET_LABEL_INDENT = 86;
const SET_DOT_X = 22;
const SET_DOT_PITCH = 13;
const SET_DOT_R = 5.5;

/** A lábléc fix sávjai — ezeket mértük ki, nem szabad elcsúsztatni. */
const FOOT_PROMPT_Y = 738;
const FOOT_PROMPT_H = 54;
const FOOT_BAND_Y = 816;
const FOOT_BAND_H = 40;
const FOOT_LEGEND_Y = 852;

/**
 * A vezérlés-legenda gomb/jelentés párokra bontva: így a gomb neve külön
 * "billentyű-kupakot" kaphat, és két méterről is meg lehet találni a szemmel.
 * Ugyanaz az öt információ, mint korábban — az "F / M" sor csak ketté van bontva.
 */
const LOBBY_HINTS = [
  ['Jobb stick', 'mozgás'],
  ['R2', 'lövés'],
  ['Bal stick', 'külön célzás (opcionális)'],
  ['Options', 'indítás'],
  ['F', 'teljes képernyő'],
  ['M', 'némítás'],
];

/**
 * Lassan sodródó porszemek a háttérben. Modulszinten, egyszer generálva:
 * a lobbi minden képkockán újrarajzol, itt nem keletkezhet szemét.
 */
const LOBBY_MOTES = (() => {
  const out = [];
  let seed = 20240607;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < 44; i++) {
    out.push({
      x: rnd() * LOGICAL_W,
      y: rnd() * LOGICAL_H,
      r: 0.7 + rnd() * 2.1,
      sp: 5 + rnd() * 15,
      a: 0.05 + rnd() * 0.11,
    });
  }
  return out;
})();

/** Cached diagonal stripe geometry of the lobby background (`false` = no Path2D). */
let lobbyStripes = null;

function getLobbyStripes() {
  if (lobbyStripes !== null) return lobbyStripes;
  if (typeof Path2D === 'undefined') {
    lobbyStripes = false;
    return lobbyStripes;
  }
  const p = new Path2D();
  for (let x = -LOGICAL_H - 300; x < LOGICAL_W + LOGICAL_H + 300; x += 150) {
    p.moveTo(x, LOGICAL_H);
    p.lineTo(x + LOGICAL_H, 0);
  }
  lobbyStripes = p;
  return lobbyStripes;
}

/** Human readable arena name for a settings value. */
function arenaLabel(arenaId) {
  if (!arenaId || arenaId === 'random') return 'Véletlen';
  const def = ARENAS.find((a) => a && a.id === arenaId);
  return (def && def.name) || String(arenaId);
}

/**
 * Which shared settings row (if any) a slot currently has the focus on.
 * 0 (or missing) means the player's own colour row.
 */
function slotFocus(slot) {
  const f = slot.focusRow ?? slot.focus ?? slot.row ?? 0;
  return Number.isFinite(f) ? f : 0;
}

/**
 * Centred text with manual letter spacing. `ctx.letterSpacing` is not available
 * everywhere, and a tracked-out caption is what separates a title from a label
 * at two metres. Returns the total drawn width.
 */
function trackedText(ctx, text, cx, y, tracking) {
  // A gyors út: a böngésző saját betűközét használjuk, egyetlen rajzolással.
  if ('letterSpacing' in ctx) {
    const prev = ctx.letterSpacing;
    ctx.letterSpacing = `${tracking}px`;
    const prevAlign = ctx.textAlign;
    ctx.textAlign = 'center';
    // A betűköz az UTOLSÓ betű után is hozzáadódik, ezért a fele szélességgel
    // balra toljuk a középpontot — így a szöveg optikailag valóban középen áll.
    ctx.fillText(String(text), cx - tracking / 2, y);
    const w = ctx.measureText(String(text)).width - tracking;
    ctx.textAlign = prevAlign;
    ctx.letterSpacing = prev;
    return w;
  }
  const chars = Array.from(String(text));
  let total = -tracking;
  const adv = [];
  for (let i = 0; i < chars.length; i++) {
    const w = ctx.measureText(chars[i]).width;
    adv.push(w);
    total += w + tracking;
  }
  const prevAlign = ctx.textAlign;
  ctx.textAlign = 'left';
  let x = cx - total / 2;
  for (let i = 0; i < chars.length; i++) {
    ctx.fillText(chars[i], x, y);
    x += adv[i] + tracking;
  }
  ctx.textAlign = prevAlign;
  return total;
}

/**
 * A single `‹` / `›` chevron drawn as a vector — crisper than the glyph.
 * `dir` is -1 for the left arrow (apex on the left) and +1 for the right one.
 */
function chevron(ctx, x, y, dir, size, color, lineWidth) {
  ctx.beginPath();
  ctx.moveTo(x - dir * size * 0.5, y - size);
  ctx.lineTo(x + dir * size * 0.5, y);
  ctx.lineTo(x - dir * size * 0.5, y + size);
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();
}

/** Warning triangle with an exclamation mark, centred on (cx, cy). */
function warningGlyph(ctx, cx, cy, size, color) {
  const h = size;
  const w = size * 1.12;
  ctx.beginPath();
  ctx.moveTo(cx, cy - h / 2);
  ctx.lineTo(cx + w / 2, cy + h / 2);
  ctx.lineTo(cx - w / 2, cy + h / 2);
  ctx.closePath();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.4;
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx, cy - h * 0.14);
  ctx.lineTo(cx, cy + h * 0.16);
  ctx.lineWidth = 2.4;
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy + h * 0.33, 1.3, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

/**
 * A layered panel: drop shadow, gradient body, hairline border and an inner
 * top highlight. This is what gives the lobby depth instead of flat rectangles.
 * Draws in the CURRENT user space, so callers may translate first.
 */
function lobbyPanel(ctx, x, y, w, h, r, key, top, bottom, border) {
  // Egyetlen, eltolt árnyék: a lobbi minden képkockán újrarajzol, és egy
  // teljes panelnyi extra alfás kitöltés a legdrágább dolog a képernyőn.
  ctx.fillStyle = 'rgba(0, 0, 0, 0.42)';
  roundRectPath(ctx, x + 3, y + 6, w - 6, h - 4, r);
  ctx.fill();

  const g = cachedGradient(ctx, key, (c) => {
    const grad = c.createLinearGradient(0, y, 0, y + h);
    grad.addColorStop(0, top);
    grad.addColorStop(1, bottom);
    return grad;
  });
  roundRectPath(ctx, x, y, w, h, r);
  ctx.fillStyle = g;
  ctx.fill();

  // Inner bevel: a bright hairline on the top edge reads as "lit from above".
  // Vágás nélkül: a vonal a lekerekítés sugarának 0,8-szeresétől indul, tehát
  // biztosan a panel testén belül marad.
  ctx.beginPath();
  ctx.moveTo(x + r * 0.8, y + 1);
  ctx.lineTo(x + w - r * 0.8, y + 1);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.10)';
  ctx.lineWidth = 2;
  ctx.stroke();

  if (border) strokeRoundRect(ctx, x + 0.75, y + 0.75, w - 1.5, h - 1.5, r - 0.75, border, 1.5);
}

/**
 * Draws the whole lobby screen onto the canvas (no DOM involved).
 *
 * @param {CanvasRenderingContext2D|{ctx:CanvasRenderingContext2D}} ctxOrWrapper
 * @param {object} lobby the `Lobby` instance
 * @param {number} t elapsed time in seconds
 */
export function drawLobby(ctxOrWrapper, lobby, t) {
  const ctx = unwrap(ctxOrWrapper);
  if (!ctx || !lobby) return;
  const time = Number.isFinite(t) ? t : 0;

  const slots = Array.isArray(lobby.slots) ? lobby.slots : [null, null, null, null];
  const settings = lobby.settings || {};
  const canStart = lobby.canStart === true;

  beginFrame(ctx);
  drawLobbyBackground(ctx, time);
  drawLobbyTitle(ctx, time);

  // ---- taken colours (a colour may only be used once) ----
  const taken = new Map();
  for (let i = 0; i < 4; i++) {
    const s = slots[i];
    if (s && s.colorId) taken.set(s.colorId, i);
  }

  // ---- slot cards ----
  for (let i = 0; i < 4; i++) {
    const x = SLOT_X0 + i * (SLOT_W + SLOT_GAP);
    drawLobbySlot(ctx, x, SLOT_Y, slots[i], i, taken, time);
  }

  // ---- shared settings ----
  drawLobbySettings(ctx, settings, slots, lobby.settingRows);

  // ---- controller hint / start prompt / help ----
  drawLobbyFooter(ctx, lobby, canStart, time);

  endFrame(ctx);
}

/**
 * Title block: 22..92 the wordmark, 100..105 the palette rule, 111..129 the
 * subtitle. The cards start at 158, so the whole block stays clear of them.
 */
function drawLobbyTitle(ctx, t) {
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Wordmark. A soft coloured under-glow lifts it off the background without
  // touching the letterforms' own contrast (pure white on near-black).
  ctx.font = font(84, 900);
  ctx.fillStyle = 'rgba(56, 189, 248, 0.20)';
  ctx.fillText('SLAG', LOGICAL_W / 2, 62);
  const titleFill = cachedGradient(ctx, 'lob-title', (c) => {
    const g = c.createLinearGradient(0, 24, 0, 94);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.55, '#e8eef7');
    g.addColorStop(1, '#9fb3cd');
    return g;
  });
  outlinedText(ctx, 'SLAG', LOGICAL_W / 2, 58, titleFill, 'rgba(2, 6, 12, 0.9)', 9);

  // Palette rule: the eight player colours, with a light running across them.
  // This is the game's own colour identity used as the header's ornament.
  const segW = 62;
  const segGap = 4;
  const ruleW = PALETTE.length * segW + (PALETTE.length - 1) * segGap;
  const ruleX = (LOGICAL_W - ruleW) / 2;
  const phase = (t * 2) % PALETTE.length;
  for (let i = 0; i < PALETTE.length; i++) {
    let d = Math.abs(i - phase);
    d = Math.min(d, PALETTE.length - d);
    ctx.globalAlpha = 0.38 + 0.62 * Math.max(0, 1 - d / 1.7);
    fillRoundRect(ctx, ruleX + i * (segW + segGap), 100, segW, 5, 2.5, PALETTE[i].main);
  }
  ctx.globalAlpha = 1;

  const sub = '4 fős helyi tankcsata — egy képernyő, egy kanapé';
  const tracking = 2.4;
  fitFont(ctx, sub, LOGICAL_W - 200 - tracking * sub.length, 18, 700);
  ctx.fillStyle = 'rgba(148, 163, 184, 0.92)';
  trackedText(ctx, sub, LOGICAL_W / 2, 120, tracking);
  ctx.restore();
}

/**
 * Paints the STATIC part of the lobby background — base gradient, the cold
 * spotlight behind the title and the vignette — into `target`.
 */
function paintLobbyBackdrop(c2d) {
  const base = c2d.createLinearGradient(0, 0, 0, LOGICAL_H);
  base.addColorStop(0, '#141d2f');
  base.addColorStop(0.45, '#0c1320');
  base.addColorStop(1, '#05070d');
  c2d.fillStyle = base;
  c2d.fillRect(0, 0, LOGICAL_W, LOGICAL_H);

  // Cold spotlight behind the title — the eye lands on the wordmark first.
  const spot = c2d.createRadialGradient(LOGICAL_W / 2, 20, 30, LOGICAL_W / 2, 20, 660);
  spot.addColorStop(0, 'rgba(56, 189, 248, 0.17)');
  spot.addColorStop(0.55, 'rgba(56, 189, 248, 0.05)');
  spot.addColorStop(1, 'rgba(56, 189, 248, 0)');
  c2d.fillStyle = spot;
  c2d.fillRect(0, 0, LOGICAL_W, 700);

  // Vignette: pushes the corners back so the panels float above the screen.
  const vig = c2d.createRadialGradient(LOGICAL_W / 2, 430, 340, LOGICAL_W / 2, 430, 980);
  vig.addColorStop(0, 'rgba(0, 0, 0, 0)');
  vig.addColorStop(1, 'rgba(0, 0, 0, 0.62)');
  c2d.fillStyle = vig;
  c2d.fillRect(0, 0, LOGICAL_W, LOGICAL_H);
}

/**
 * The baked backdrop bitmap (`false` = no offscreen canvas available, paint it
 * live). Three full-screen gradient fills per frame cost more than the whole
 * rest of the lobby on a software rasteriser, and none of them ever change —
 * so they are rendered ONCE and blitted afterwards.
 */
let lobbyBackdrop = null;

function getLobbyBackdrop() {
  if (lobbyBackdrop !== null) return lobbyBackdrop;
  let cv = null;
  if (typeof OffscreenCanvas !== 'undefined') cv = new OffscreenCanvas(LOGICAL_W, LOGICAL_H);
  else if (typeof document !== 'undefined' && document.createElement) cv = document.createElement('canvas');
  if (!cv) {
    lobbyBackdrop = false;
    return lobbyBackdrop;
  }
  cv.width = LOGICAL_W;
  cv.height = LOGICAL_H;
  const c2d = cv.getContext('2d');
  if (!c2d) {
    lobbyBackdrop = false;
    return lobbyBackdrop;
  }
  paintLobbyBackdrop(c2d);
  lobbyBackdrop = cv;
  return lobbyBackdrop;
}

function drawLobbyBackground(ctx, t) {
  const backdrop = getLobbyBackdrop();
  if (backdrop) ctx.drawImage(backdrop, 0, 0, LOGICAL_W, LOGICAL_H);
  else paintLobbyBackdrop(ctx);

  // Slowly drifting diagonal stripes — quiet motion, no distraction.
  ctx.save();
  ctx.globalAlpha = 0.05;
  ctx.strokeStyle = '#94a3b8';
  ctx.lineWidth = 30;
  const drift = (t * 12) % 150;
  const stripes = getLobbyStripes();
  if (stripes) {
    ctx.translate(drift, 0);
    ctx.stroke(stripes);
  } else {
    ctx.beginPath();
    for (let x = -LOGICAL_H; x < LOGICAL_W + LOGICAL_H; x += 150) {
      ctx.moveTo(x + drift, LOGICAL_H);
      ctx.lineTo(x + drift + LOGICAL_H, 0);
    }
    ctx.stroke();
  }
  ctx.restore();

  // Drifting dust — barely visible, but it stops the screen from looking dead.
  ctx.save();
  ctx.fillStyle = '#cbd5e1';
  for (let i = 0; i < LOBBY_MOTES.length; i++) {
    const m = LOBBY_MOTES[i];
    const my = (m.y - t * m.sp) % LOGICAL_H;
    ctx.globalAlpha = m.a;
    ctx.beginPath();
    ctx.arc(m.x, my < 0 ? my + LOGICAL_H : my, m.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** The rocking tank preview + its hexagonal pad, in card-local coordinates. */
function drawSlotPreview(ctx, col, index, t, alpha) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(SLOT_W / 2, SLOT_TANK_Y);

  // Dobogó a tank alatt, a játékos saját színében: a tank rajta ÁLL, tehát
  // nincs az a kétértelműség, amit egy körberajzolt keret okozna (az ágyúcső
  // 2,2-szeres méretben 76 px-re nyúlik a középpont fölé, egy zárt talp
  // felső élét mindig átvágná). Alsó éle 150 + 26 = 176, azaz abszolút 334;
  // a szín-súgó betűteteje 345 — a kettő nem ér össze.
  ctx.beginPath();
  ctx.ellipse(0, 28, 96, 26, 0, 0, Math.PI * 2);
  ctx.fillStyle = hexToRgba(col.dark, 0.6);
  ctx.fill();
  ctx.strokeStyle = hexToRgba(col.main, 0.5);
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(0, 28, 80, 20, 0, 0, Math.PI * 2);
  ctx.strokeStyle = hexToRgba(col.light, 0.18);
  ctx.lineWidth = 1.2;
  ctx.stroke();

  // Az előnézet 2,5-szeres méretben és y+128 középponttal a billegés szélén
  // 357-ig ért le, a szín-súgó betűtetői viszont 345-nél kezdődnek: a sötét
  // lánctalp-sarok átfutott a szövegen. 2,2-szeres méret és y+122 középpont
  // mellett a kettő elválik.
  ctx.scale(2.2, 2.2);
  const preview = {
    index,
    color: col,
    x: 0,
    y: 0,
    angle: -Math.PI / 2 + Math.sin(t * 0.9 + index) * 0.18,
    turretAngle: -Math.PI / 2 + Math.sin(t * 0.6 + index * 1.7) * 0.35,
    trackPhase: t * 26,
    alive: true,
  };
  // Ground shadow for the preview.
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath();
  ctx.ellipse(2, 4, CONFIG.tank.radius * 1.2, CONFIG.tank.radius * 1.05, 0, 0, Math.PI * 2);
  ctx.fill();
  drawTank(ctx, preview, t, false);
  ctx.restore();
}

function drawLobbySlot(ctx, x, y, slot, index, taken, t) {
  ctx.save();
  ctx.translate(x, y);
  ctx.textBaseline = 'middle';

  const joined = !!slot;
  const col = joined ? resolveColor(slot.colorId || slot.color) : FALLBACK_COLOR;
  const ready = joined && slot.ready === true;
  const lost = joined && slot.deviceLost === true;
  const isBot = joined && slot.isBot === true;

  // Card body. A slot whose controller vanished gets a red frame — otherwise
  // nothing on screen tells the players which seat is holding up the lobby.
  // A gép kerete indigó, nem zöld: a zöld azt jelenti, hogy egy EMBER
  // nyomta meg a készt, és ezt egy pillantással meg kell tudni különböztetni.
  let accent = hexToRgba(col.main, 0.85);
  if (ready) accent = '#22c55e';
  if (isBot) accent = 'rgba(129, 140, 248, 0.95)';
  if (lost) accent = '#ef4444';

  if (joined) {
    lobbyPanel(ctx, 0, 0, SLOT_W, SLOT_H, SLOT_R, 'lob-card',
      'rgba(24, 33, 50, 0.95)', 'rgba(8, 12, 20, 0.95)', null);
  } else {
    lobbyPanel(ctx, 0, 0, SLOT_W, SLOT_H, SLOT_R, 'lob-card-empty',
      'rgba(15, 21, 33, 0.55)', 'rgba(7, 10, 17, 0.6)', null);
  }

  if (joined) {
    // Header wash + spotlight behind the tank, cached PER COLOUR (max eight
    // gradients ever) — nothing is allocated per frame. Egyik sem vág (clip):
    // a mosás lekerekített úton megy, a fény pedig egy olyan téglalapon,
    // ami maradéktalanul a kártyán belül van — így a vágómaszk ára megspórolva.
    const wash = cachedGradient(ctx, `lob-wash-${col.id}`, (c) => {
      const g = c.createLinearGradient(0, 0, 0, 96);
      g.addColorStop(0, hexToRgba(col.main, 0.30));
      g.addColorStop(1, hexToRgba(col.main, 0));
      return g;
    });
    roundRectPath(ctx, 0, 0, SLOT_W, 100, SLOT_R);
    ctx.fillStyle = wash;
    ctx.fill();

    const glow = cachedGradient(ctx, `lob-glow-${col.id}`, (c) => {
      const g = c.createRadialGradient(SLOT_W / 2, SLOT_TANK_Y, 10, SLOT_W / 2, SLOT_TANK_Y, 118);
      g.addColorStop(0, hexToRgba(col.main, 0.20));
      g.addColorStop(1, hexToRgba(col.main, 0));
      return g;
    });
    ctx.fillStyle = glow;
    ctx.fillRect(SLOT_W / 2 - 118, SLOT_TANK_Y - 118, 236, 236);

    // Az akcentus-csík MINDIG a játékos színe: az állapotot a keret és a
    // jelvény mondja el, a szín pedig végig ugyanazt a széket jelenti.
    // Vastag vonalként húzva a lekerekített sarkokon belül marad.
    ctx.beginPath();
    ctx.moveTo(SLOT_R, 4);
    ctx.lineTo(SLOT_W - SLOT_R, 4);
    ctx.strokeStyle = hexToRgba(col.main, 0.95);
    ctx.lineWidth = 7;
    ctx.stroke();

    strokeRoundRect(ctx, 1.5, 1.5, SLOT_W - 3, SLOT_H - 3, SLOT_R - 1.5,
      accent, ready || lost ? 3.5 : 2.5);
    if (ready || isBot || lost) {
      // Halo: a második, halvány keret messziről is elárulja az állapotot.
      strokeRoundRect(ctx, -2.5, -2.5, SLOT_W + 5, SLOT_H + 5, SLOT_R + 2.5,
        lost ? 'rgba(239, 68, 68, 0.28)'
          : ready ? 'rgba(34, 197, 94, 0.28)' : 'rgba(129, 140, 248, 0.26)', 3);
    }
  } else {
    ctx.save();
    ctx.setLineDash([10, 8]);
    strokeRoundRect(ctx, 1.5, 1.5, SLOT_W - 3, SLOT_H - 3, SLOT_R - 1.5, 'rgba(148, 163, 184, 0.35)', 2);
    ctx.restore();
  }

  // ---- header: number chip + name (left), device label (right) ----
  const name = joined && isBot ? (slot.name || playerLabel(index)) : playerLabel(index);
  const device = !joined ? ''
    : isBot ? `GÉP · ${slot.deviceLabel || ''}` : deviceLabel(slot.deviceId);

  ctx.textAlign = 'right';
  fitFont(ctx, device, 120, 14, 700);
  const devW = device ? ctx.measureText(device).width : 0;
  if (device) {
    ctx.fillStyle = isBot ? 'rgba(165, 180, 252, 0.95)' : 'rgba(148, 163, 184, 0.8)';
    ctx.fillText(device, SLOT_W - SLOT_PAD, SLOT_HEAD_Y);
  }

  // Number chip — the player's colour repeated as a solid block, so the seat
  // and its tank are tied together even before anyone reads a word.
  const chip = 26;
  const chipY = SLOT_HEAD_Y - chip / 2;
  fillRoundRect(ctx, SLOT_PAD, chipY, chip, chip, 8,
    joined ? hexToRgba(col.main, 0.9) : 'rgba(148, 163, 184, 0.18)');
  if (joined) strokeRoundRect(ctx, SLOT_PAD + 0.75, chipY + 0.75, chip - 1.5, chip - 1.5, 7.5, hexToRgba(col.light, 0.55), 1.5);
  ctx.textAlign = 'center';
  ctx.font = font(16, 900);
  ctx.fillStyle = joined ? 'rgba(6, 10, 18, 0.92)' : 'rgba(148, 163, 184, 0.55)';
  ctx.fillText(String(index + 1), SLOT_PAD + chip / 2, SLOT_HEAD_Y + 1);

  ctx.textAlign = 'left';
  const nameX = SLOT_PAD + chip + 10;
  fitFont(ctx, name, SLOT_W - nameX - SLOT_PAD - devW - 12, 22, 800);
  ctx.fillStyle = joined ? col.light : 'rgba(148, 163, 184, 0.6)';
  ctx.fillText(name, nameX, SLOT_HEAD_Y);

  // Hairline under the header groups it away from the preview. Középen KIHAGY
  // egy 128 px-es rést: a tank ágyúcsöve 2,2-szeres méretben 75 px-re nyúlik a
  // középpont fölé (lokális 47-ig), és nem szabad átvágnia egy vonalat.
  ctx.beginPath();
  ctx.moveTo(SLOT_PAD, 50);
  ctx.lineTo(SLOT_W / 2 - 64, 50);
  ctx.moveTo(SLOT_W / 2 + 64, 50);
  ctx.lineTo(SLOT_W - SLOT_PAD, 50);
  ctx.strokeStyle = joined ? hexToRgba(col.main, 0.32) : 'rgba(148, 163, 184, 0.14)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  if (!joined) {
    // Empty slot: a ghost tank (this is what could sit here) + the join prompt.
    drawSlotPreview(ctx, FALLBACK_COLOR, index, t, 0.07);

    ctx.textAlign = 'center';
    const pulse = 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(t * 3 + index));
    fitFont(ctx, 'Nyomj R2-t', SLOT_W - 40, 24, 800);
    ctx.fillStyle = `rgba(226, 232, 240, ${pulse})`;
    ctx.fillText('Nyomj R2-t', SLOT_W / 2, 200);
    fitFont(ctx, 'a csatlakozáshoz', SLOT_W - 40, 24, 800);
    ctx.fillText('a csatlakozáshoz', SLOT_W / 2, 230);

    const kb = 'billentyűzeten: Space vagy Numpad 0';
    fitFont(ctx, kb, SLOT_W - 32, 15, 600);
    ctx.fillStyle = 'rgba(148, 163, 184, 0.65)';
    ctx.fillText(kb, SLOT_W / 2, 264);
    // Ez a szabad hely gépi ellenféllel is feltölthető — enélkül egy
    // kontrollerrel játszó ember azt hiheti, hogy nincs kivel játszania.
    const botLine = 'vagy állíts be gépi ellenfelet lent';
    fitFont(ctx, botLine, SLOT_W - 40, 14, 700);
    fillRoundRect(ctx, SLOT_W / 2 - ctx.measureText(botLine).width / 2 - 12, 292 - 12,
      ctx.measureText(botLine).width + 24, 24, 12, 'rgba(99, 102, 241, 0.16)');
    ctx.fillStyle = 'rgba(165, 180, 252, 0.95)';
    ctx.fillText(botLine, SLOT_W / 2, 292);
    ctx.restore();
    return;
  }

  // Tank preview, gently rocking.
  drawSlotPreview(ctx, col, index, t, 1);

  // Colour picker strip: all eight palette colours, taken ones struck through.
  // A botnak nincs fókusza: a fehér kiemelő keret azt sugallná, hogy valaki
  // épp a színét szerkeszti — miközben fölötte az áll, hogy automatikus.
  const focus = isBot ? -1 : slotFocus(slot);
  const barY = SLOT_BAR_Y;
  const hint = isBot ? 'A gép színe automatikus' : slotColorHint(slot.deviceId);
  ctx.textAlign = 'center';
  fitFont(ctx, hint, SLOT_W - 40, 14, 700);
  ctx.fillStyle = focus === 0 ? 'rgba(226,232,240,0.95)' : 'rgba(148,163,184,0.6)';
  ctx.fillText(hint, SLOT_W / 2, barY - 17);

  const sw = 32;
  const pitch = 38;
  const startX = SLOT_W / 2 - (pitch * PALETTE.length - (pitch - sw)) / 2;
  // Recessed tray behind the swatches: the strip reads as one control.
  fillRoundRect(ctx, startX - 9, barY - 4, pitch * PALETTE.length - (pitch - sw) + 18, 34, 10,
    'rgba(2, 5, 11, 0.5)');
  strokeRoundRect(ctx, startX - 8.5, barY - 3.5, pitch * PALETTE.length - (pitch - sw) + 17, 33, 9.5,
    focus === 0 ? 'rgba(226, 232, 240, 0.28)' : 'rgba(148, 163, 184, 0.12)', 1);

  for (let i = 0; i < PALETTE.length; i++) {
    const p = PALETTE[i];
    const sx = startX + i * pitch;
    const mine = p.id === slot.colorId;
    const owner = taken.get(p.id);
    const blocked = owner !== undefined && owner !== index;

    ctx.globalAlpha = blocked ? 0.24 : 1;
    fillRoundRect(ctx, sx, barY, sw, 26, 6, p.main);
    // Glossy top edge: makes the swatch look like a physical key.
    fillRoundRect(ctx, sx + 2, barY + 2, sw - 4, 8, 4, 'rgba(255, 255, 255, 0.18)');
    strokeRoundRect(ctx, sx + 0.5, barY + 0.5, sw - 1, 25, 5.5, 'rgba(2, 6, 12, 0.55)', 1);
    ctx.globalAlpha = 1;

    if (mine) {
      strokeRoundRect(ctx, sx - 2.5, barY - 2.5, sw + 5, 31, 8,
        focus === 0 ? '#ffffff' : 'rgba(255,255,255,0.55)', 3);
    }
    if (blocked) {
      // Diagonal strike-through marks a colour someone else already owns.
      ctx.beginPath();
      ctx.moveTo(sx + 3, barY + 22);
      ctx.lineTo(sx + sw - 3, barY + 4);
      ctx.strokeStyle = 'rgba(248, 250, 252, 0.8)';
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }
  }

  // Colour name.
  const colName = col.name || '';
  fitFont(ctx, colName, SLOT_W - 60, 18, 800);
  ctx.fillStyle = col.light;
  ctx.fillText(colName, SLOT_W / 2, barY + 53);

  // ---- status badge ----
  const badgeY = SLOT_H - 46;
  const bx = SLOT_PAD + 2;
  const bw = SLOT_W - (SLOT_PAD + 2) * 2;
  if (lost) {
    lobbyBadge(ctx, bx, badgeY, bw, 'lob-badge-lost', 'rgba(239, 68, 68, 0.30)', 'rgba(127, 29, 29, 0.30)', 'rgba(239, 68, 68, 0.85)');
    fitFont(ctx, 'Kontroller lecsatlakozott', bw - 24, 15, 800);
    ctx.fillStyle = '#fecaca';
    ctx.fillText('Kontroller lecsatlakozott', SLOT_W / 2, badgeY + 11);
    fitFont(ctx, 'a hely hamarosan felszabadul', bw - 24, 13, 600);
    ctx.fillStyle = 'rgba(254, 202, 202, 0.85)';
    ctx.fillText('a hely hamarosan felszabadul', SLOT_W / 2, badgeY + 25);
  } else if (isBot) {
    // A gép mindig kész — de más színnel, hogy egy pillantásra elváljon
    // attól a széktől, ahol tényleg ül valaki.
    lobbyBadge(ctx, bx, badgeY, bw, 'lob-badge-bot', 'rgba(99, 102, 241, 0.34)', 'rgba(49, 46, 129, 0.28)', 'rgba(129, 140, 248, 0.95)');
    drawBotGlyph(ctx, bx + 26, badgeY + 17, '#c7d2fe');
    fitFont(ctx, 'GÉPI ELLENFÉL', bw - 76, 17, 900);
    ctx.fillStyle = '#c7d2fe';
    ctx.fillText('GÉPI ELLENFÉL', SLOT_W / 2 + 12, badgeY + 18);
  } else if (ready) {
    lobbyBadge(ctx, bx, badgeY, bw, 'lob-badge-ready', 'rgba(34, 197, 94, 0.34)', 'rgba(20, 83, 45, 0.30)', '#22c55e');
    // Check mark.
    ctx.beginPath();
    ctx.moveTo(bx + 20, badgeY + 17);
    ctx.lineTo(bx + 28, badgeY + 25);
    ctx.lineTo(bx + 44, badgeY + 9);
    ctx.strokeStyle = '#4ade80';
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
    fitFont(ctx, 'KÉSZ', bw - 90, 20, 900);
    ctx.fillStyle = '#bbf7d0';
    ctx.fillText('KÉSZ', SLOT_W / 2 + 16, badgeY + 18);
  } else {
    lobbyBadge(ctx, bx, badgeY, bw, 'lob-badge-idle', 'rgba(148, 163, 184, 0.20)', 'rgba(30, 41, 59, 0.28)', 'rgba(148, 163, 184, 0.35)');
    const actionHint = slotActionHint(slot.deviceId);
    fitFont(ctx, actionHint, bw - 28, 16, 700);
    ctx.fillStyle = 'rgba(226, 232, 240, 0.92)';
    ctx.fillText(actionHint, SLOT_W / 2, badgeY + 18);
  }

  ctx.restore();
}

/** The pill behind a slot's status line: gradient body + coloured ring. */
function lobbyBadge(ctx, x, y, w, key, top, bottom, ring) {
  const g = cachedGradient(ctx, key, (c) => {
    const grad = c.createLinearGradient(0, y, 0, y + 34);
    grad.addColorStop(0, top);
    grad.addColorStop(1, bottom);
    return grad;
  });
  roundRectPath(ctx, x, y, w, 34, 17);
  ctx.fillStyle = g;
  ctx.fill();
  strokeRoundRect(ctx, x + 1, y + 1, w - 2, 32, 16, ring, 2);
}

/** Tiny robot head — marks the bot badge without relying on an emoji font. */
function drawBotGlyph(ctx, cx, cy, color) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 2;
  roundRectPath(ctx, cx - 8, cy - 6, 16, 13, 4);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx - 3.5, cy, 1.7, 0, Math.PI * 2);
  ctx.arc(cx + 3.5, cy, 1.7, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx, cy - 6);
  ctx.lineTo(cx, cy - 10);
  ctx.lineWidth = 1.8;
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy - 11, 1.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawLobbySettings(ctx, settings, slots, lobbyRows) {
  // A sorok a lobbitól jönnek, ha van honnan: így egy új beállítás sosem
  // maradhat le a képernyőről csak azért, mert itt kézzel is fel volt sorolva.
  const rows = Array.isArray(lobbyRows) && lobbyRows.length
    ? lobbyRows.map((r) => ({ label: r.label, value: r.value }))
    : [
      { label: 'Pattogó lövedék', value: settings.bounce === false ? 'KI' : 'BE' },
      { label: 'Pálya', value: arenaLabel(settings.arenaId) },
      { label: 'Cél', value: `${settings.pointsToWin ?? CONFIG.match.pointsToWin} pont` },
    ];

  const boxX = SET_X;
  const boxY = SET_Y;
  const boxW = SET_W;
  const rowH = SET_ROW_H;
  const boxH = rows.length * rowH + 18;

  ctx.save();
  ctx.textBaseline = 'middle';
  lobbyPanel(ctx, boxX, boxY, boxW, boxH, 16, 'lob-settings',
    'rgba(22, 30, 46, 0.92)', 'rgba(8, 12, 20, 0.94)', 'rgba(148, 163, 184, 0.30)');

  for (let i = 0; i < rows.length; i++) {
    const ry = boxY + 9 + i * rowH;
    const cy = ry + rowH / 2 - 2;
    // Settings rows are focus index 1..n; collect the players sitting on them.
    const focusedBy = [];
    for (let s = 0; s < slots.length; s++) {
      const slot = slots[s];
      if (slot && slotFocus(slot) === i + 1) focusedBy.push(resolveColor(slot.colorId || slot.color));
    }
    const hot = focusedBy.length > 0;

    if (hot) {
      fillRoundRect(ctx, boxX + 8, ry + 2, boxW - 16, rowH - 6, 10, 'rgba(255, 255, 255, 0.09)');
      strokeRoundRect(ctx, boxX + 8.5, ry + 2.5, boxW - 17, rowH - 7, 9.5,
        hexToRgba(focusedBy[0].main, 0.55), 1.5);
      // Left accent bar in the colour of the first player editing this row.
      fillRoundRect(ctx, boxX + 8, ry + 6, 4, rowH - 14, 2, focusedBy[0].main);
    } else if (i % 2 === 1) {
      fillRoundRect(ctx, boxX + 8, ry + 2, boxW - 16, rowH - 6, 10, 'rgba(255, 255, 255, 0.025)');
    }

    // ---- value stepper on the right: ‹ value › inside its own chip ----
    ctx.textAlign = 'center';
    const value = String(rows[i].value);
    fitFont(ctx, value, 240, 21, 800);
    const valW = ctx.measureText(value).width;
    const chipW = valW + 74;
    const chipX = boxX + boxW - 16 - chipW;
    fillRoundRect(ctx, chipX, ry + 4, chipW, rowH - 10, 9,
      hot ? 'rgba(2, 6, 12, 0.5)' : 'rgba(2, 6, 12, 0.32)');
    strokeRoundRect(ctx, chipX + 0.5, ry + 4.5, chipW - 1, rowH - 11, 8.5,
      hot ? 'rgba(226, 232, 240, 0.30)' : 'rgba(148, 163, 184, 0.16)', 1);
    ctx.fillStyle = hot ? '#f8fafc' : 'rgba(226, 232, 240, 0.9)';
    ctx.fillText(value, chipX + chipW / 2, cy);
    const arrow = hot ? 'rgba(248, 250, 252, 0.95)' : 'rgba(148, 163, 184, 0.6)';
    chevron(ctx, chipX + 18, cy, -1, 6, arrow, 2.6);
    chevron(ctx, chipX + chipW - 18, cy, 1, 6, arrow, 2.6);

    // ---- label on the left ----
    ctx.textAlign = 'left';
    // A címke a pöttyöknek fenntartott sáv UTÁN kezdődik. Négy játékos
    // pöttyei a boxX + 70 pixelig érnek; a régi `boxX + 28` kezdet miatt
    // három-négy embernél a "Gépi ellenfelek" első betűit takarták el.
    fitFont(ctx, rows[i].label, chipX - (boxX + SET_LABEL_INDENT) - 16, 20, 700);
    ctx.fillStyle = hot ? '#f1f5f9' : 'rgba(203, 213, 225, 0.75)';
    ctx.fillText(rows[i].label, boxX + SET_LABEL_INDENT, cy);

    // Colour dots of the players currently editing this row — a saját sávjukban.
    for (let k = 0; k < focusedBy.length; k++) {
      const dx = boxX + SET_DOT_X + k * SET_DOT_PITCH;
      ctx.beginPath();
      ctx.arc(dx, cy, SET_DOT_R, 0, Math.PI * 2);
      ctx.fillStyle = focusedBy[k].main;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(dx, cy, SET_DOT_R, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(2, 6, 12, 0.55)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  ctx.textAlign = 'center';
  const help = 'D-pad fel/le — sorváltás (saját szín ↔ közös beállítások), bal/jobb — érték';
  fitFont(ctx, help, boxW + 120, 13, 600);
  ctx.fillStyle = 'rgba(148, 163, 184, 0.7)';
  ctx.fillText(help, LOGICAL_W / 2, boxY + boxH + 13);
  ctx.restore();
}

/** "1. játékos" / "1. és 3. játékos" — the seats that are not ready yet. */
function pendingNames(slots) {
  const names = slots.map((s) => (s && s.name) || playerLabel((s && s.index) || 0));
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} és ${names[names.length - 1]}`;
}

/**
 * Footer. Fixed bands, measured so nothing can collide:
 *   738..792  start prompt plate (one or two lines INSIDE it)
 *   796..836  gamepad warning band
 *   841..863  control legend key caps
 *   869..883  keyboard scheme A
 *   885..899  keyboard scheme B
 */
function drawLobbyFooter(ctx, lobby, canStart, t) {
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const readyCount = Number.isFinite(lobby.readyCount) ? lobby.readyCount : 0;

  // "Press a button" hint when no gamepad has been seen yet. Chrome only
  // reports pads after a user gesture, hence the explicit nudge. Computed
  // first: when it is up it owns the band right below the start prompt.
  const noPads = lobby.hasGamepads === false
    || lobby.showControllerHint === true
    || lobby.gamepadHint === true;

  const pending = noPads || !Array.isArray(lobby.pendingSlots) ? [] : lobby.pendingSlots;

  // Start prompt. The message must say what is actually missing: a flat
  // "at least 2 ready players" while three players stand ready tells a lie and
  // hides the seat that is really holding up the match.
  let main;
  let sub = '';
  if (canStart) {
    main = 'Options / Enter — indítás';
    if (pending.length) {
      const verb = pending.length > 1 ? 'kimaradnak' : 'kimarad';
      sub = `${pendingNames(pending)} még nem kész — így ${verb} a meccsből`;
    }
  } else {
    // A hiányzó feltételt mondjuk ki, nem egy általánosat: egy kontrollerrel
    // ülő játékosnak az a használható infó, hogy gépi ellenfelet is kaphat.
    const humans = Number.isFinite(lobby.readyHumans) ? lobby.readyHumans : readyCount;
    // Csak olyan megoldást ajánlhatunk, ami tényleg járható. Ha már ül a
    // gépnél valaki, aki nem nyomott készre, ŐT kell megnevezni: gépi
    // ellenfelet hiába javasolnánk, ha nincs is szabad szék neki.
    const joined = Number.isFinite(lobby.humanCount) ? lobby.humanCount : humans;
    const notReady = Math.max(0, joined - humans);
    if (humans < 1) {
      main = 'Legalább egy embernek készen kell állnia';
    } else if (notReady > 0) {
      main = notReady === 1
        ? 'Még egy játékosnak meg kell nyomnia a Keresztet'
        : `Még ${notReady} játékosnak meg kell nyomnia a Keresztet`;
    } else {
      main = 'Állíts be gépi ellenfelet, vagy várj még egy játékosra';
    }
    // Naming names is only useful once somebody IS ready — with an empty lobby
    // it would just repeat all four slots back at the players.
    if (pending.length && readyCount > 0) sub = `${pendingNames(pending)} — Kereszt / Enter: kész`;
  }

  // A két sor MINDIG a prompt tábláján belülre kerül (738..792). Korábban az
  // alsó sor 800-nál állt, vagyis belelógott a kontroller-figyelmeztetés
  // sávjába (796..836) — együtt is előfordulhatnak, ha billentyűzettel indul
  // a meccs egy nem HTTPS-en kiszolgált oldalon.
  const mainSize = canStart ? 24 : 20;
  fitFont(ctx, main, 1080, mainSize, canStart ? 900 : 800);
  const mainW = ctx.measureText(main).width;
  let subW = 0;
  if (sub) {
    fitFont(ctx, sub, 1080, 15, 600);
    subW = ctx.measureText(sub).width;
  }
  const plateW = clamp(Math.max(mainW, subW) + 76, 400, 1180);
  const plateX = (LOGICAL_W - plateW) / 2;

  const pulse = 0.65 + 0.35 * (0.5 + 0.5 * Math.sin(t * 4));
  if (canStart) {
    const g = cachedGradient(ctx, 'lob-start', (c) => {
      const grad = c.createLinearGradient(0, FOOT_PROMPT_Y, 0, FOOT_PROMPT_Y + FOOT_PROMPT_H);
      grad.addColorStop(0, 'rgba(34, 197, 94, 0.34)');
      grad.addColorStop(1, 'rgba(21, 128, 61, 0.20)');
      return grad;
    });
    ctx.fillStyle = 'rgba(34, 197, 94, 0.10)';
    roundRectPath(ctx, plateX - 6, FOOT_PROMPT_Y - 6, plateW + 12, FOOT_PROMPT_H + 12, (FOOT_PROMPT_H + 12) / 2);
    ctx.fill();
    roundRectPath(ctx, plateX, FOOT_PROMPT_Y, plateW, FOOT_PROMPT_H, FOOT_PROMPT_H / 2);
    ctx.fillStyle = g;
    ctx.fill();
    strokeRoundRect(ctx, plateX + 1.25, FOOT_PROMPT_Y + 1.25, plateW - 2.5, FOOT_PROMPT_H - 2.5,
      FOOT_PROMPT_H / 2 - 1.25, `rgba(74, 222, 128, ${pulse})`, 2.5);
  } else {
    roundRectPath(ctx, plateX, FOOT_PROMPT_Y, plateW, FOOT_PROMPT_H, FOOT_PROMPT_H / 2);
    ctx.fillStyle = 'rgba(15, 23, 42, 0.55)';
    ctx.fill();
    strokeRoundRect(ctx, plateX + 1, FOOT_PROMPT_Y + 1, plateW - 2, FOOT_PROMPT_H - 2,
      FOOT_PROMPT_H / 2 - 1, 'rgba(148, 163, 184, 0.22)', 1.5);
  }

  const mainY = sub ? 755 : 765;
  fitFont(ctx, main, plateW - 48, mainSize, canStart ? 900 : 800);
  ctx.fillStyle = canStart ? `rgba(240, 253, 244, ${0.75 + 0.25 * pulse})` : 'rgba(203, 213, 225, 0.9)';
  ctx.fillText(main, LOGICAL_W / 2, mainY);
  if (sub) {
    fitFont(ctx, sub, plateW - 48, 15, 600);
    ctx.fillStyle = canStart ? 'rgba(253, 224, 71, 0.9)' : 'rgba(148, 163, 184, 0.75)';
    ctx.fillText(sub, LOGICAL_W / 2, 781);
  }

  // A blocked Gamepad API outranks the "press a button" nudge: no amount of
  // button pressing will help, and the message has to name the actual fix.
  // A sávok magassága és helye szűk: fölöttük az indítás-tábla alja 792-nél,
  // alattuk a vezérlés-legenda kupakjainak teteje 841-nél van. 796..836 az a
  // doboz, ami mindkettőt elkerüli — ezért y=816, magasság 40, MINDKÉT sávnál.
  const support = lobby.gamepadSupport;
  if (support === 'insecure' || support === 'unsupported') {
    const insecure = support === 'insecure';
    const msg = insecure
      ? 'A böngésző letiltotta a kontrollereket, mert az oldal nem HTTPS-en fut — addig billentyűzettel játszhattok.'
      : 'Ez a böngésző nem támogatja a kontrollereket — billentyűzettel viszont játszhattok.';
    lobbyBand(ctx, 980, 'rgba(239, 68, 68, 0.22)', 'rgba(127, 29, 29, 0.22)',
      'rgba(248, 113, 113, 0.85)', '#fecaca', msg, 19, 800, t);
  } else if (noPads) {
    // Ez a lobbi ALAPÁLLAPOTA betöltéskor, tehát a legtöbbet látott képernyő:
    // a `fitFont` garantálja, hogy a szöveg soha ne lógjon ki a keretéből.
    const msg = 'Nyomj meg egy gombot a kontrolleren… (vagy játssz billentyűzettel)';
    lobbyBand(ctx, 860, 'rgba(234, 179, 8, 0.20)', 'rgba(113, 63, 18, 0.20)',
      'rgba(250, 204, 21, 0.7)', '#fde047', msg, 19, 700, t);
  }

  drawLobbyLegend(ctx);

  // Keyboard legend: movement AND the menu keys, because a keyboard player has
  // no Cross / Circle / Options to press.
  ctx.textAlign = 'center';
  const kbA = 'Billentyűzet A: WASD + nyilak + Space   ·   kész/indítás: Enter, kilépés: Esc, szín: Q / E';
  const kbB = 'Billentyűzet B: IJKL + Numpad 8/4/5/6 + Numpad 0   ·   kész/indítás: Numpad Enter, kilépés: Numpad ., szín: U / O';
  ctx.fillStyle = 'rgba(148, 163, 184, 0.6)';
  fitFont(ctx, kbA, LOGICAL_W - 60, 14, 600);
  ctx.fillText(kbA, LOGICAL_W / 2, 876);
  fitFont(ctx, kbB, LOGICAL_W - 60, 14, 600);
  ctx.fillText(kbB, LOGICAL_W / 2, 892);
  ctx.restore();
}

/** One full-width warning band at the fixed 796..836 slot, with an icon. */
function lobbyBand(ctx, w, top, bottom, ring, textColor, msg, size, weight, t) {
  const x = (LOGICAL_W - w) / 2;
  const y = FOOT_BAND_Y - FOOT_BAND_H / 2;
  const g = cachedGradient(ctx, `lob-band-${ring}`, (c) => {
    const grad = c.createLinearGradient(0, y, 0, y + FOOT_BAND_H);
    grad.addColorStop(0, top);
    grad.addColorStop(1, bottom);
    return grad;
  });
  roundRectPath(ctx, x, y, w, FOOT_BAND_H, FOOT_BAND_H / 2);
  ctx.fillStyle = g;
  ctx.fill();
  const blink = 0.7 + 0.3 * (0.5 + 0.5 * Math.sin(t * 3));
  ctx.globalAlpha = blink;
  strokeRoundRect(ctx, x + 1, y + 1, w - 2, FOOT_BAND_H - 2, FOOT_BAND_H / 2 - 1, ring, 2);
  ctx.globalAlpha = 1;

  warningGlyph(ctx, x + 34, FOOT_BAND_Y, 20, textColor);
  // A szöveg a jel utáni sávban van középre zárva, hogy sose érjen a jelhez.
  const textL = x + 58;
  const textR = x + w - 24;
  ctx.textAlign = 'center';
  fitFont(ctx, msg, textR - textL, size, weight);
  ctx.fillStyle = textColor;
  ctx.fillText(msg, (textL + textR) / 2, FOOT_BAND_Y);
}

/**
 * Control legend as key caps: the button name sits in a chip, the meaning next
 * to it. Ink box is 841..863 — the keyboard lines start at 869.
 */
function drawLobbyLegend(ctx) {
  const maxW = LOGICAL_W - 60;
  let size = 16;
  let items = null;
  let total = 0;
  let sep = 0;
  for (;;) {
    const padX = Math.round(size * 0.55);
    const gap = Math.round(size * 0.5);
    sep = Math.round(size * 1.5);
    items = [];
    total = 0;
    for (let i = 0; i < LOBBY_HINTS.length; i++) {
      const [k, l] = LOBBY_HINTS[i];
      ctx.font = font(size, 800);
      const kw = ctx.measureText(k).width;
      ctx.font = font(size, 600);
      const lw = ctx.measureText(l).width;
      const w = kw + padX * 2 + gap + lw;
      items.push({ k, l, kw, lw, w, padX, gap });
      total += w;
    }
    total += sep * (LOBBY_HINTS.length - 1);
    if (total <= maxW || size <= 11) break;
    size -= 1;
  }

  const chipH = size + 6;
  const cy = FOOT_LEGEND_Y;
  let x = (LOGICAL_W - total) / 2;
  ctx.textBaseline = 'middle';
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    fillRoundRect(ctx, x, cy - chipH / 2, it.kw + it.padX * 2, chipH, 6, 'rgba(148, 163, 184, 0.18)');
    strokeRoundRect(ctx, x + 0.5, cy - chipH / 2 + 0.5, it.kw + it.padX * 2 - 1, chipH - 1, 5.5,
      'rgba(226, 232, 240, 0.24)', 1);
    ctx.textAlign = 'left';
    ctx.font = font(size, 800);
    ctx.fillStyle = '#f1f5f9';
    ctx.fillText(it.k, x + it.padX, cy + 0.5);
    x += it.kw + it.padX * 2 + it.gap;
    ctx.font = font(size, 600);
    ctx.fillStyle = 'rgba(203, 213, 225, 0.85)';
    ctx.fillText(it.l, x, cy + 0.5);
    x += it.lw;
    if (i < items.length - 1) x += sep;
  }
}
