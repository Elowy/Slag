/**
 * Slag — small, dependency-free math and helper utilities.
 *
 * Everything here is a pure function (no shared state, no side effects),
 * safe to call from any module and from tools running under plain Node.
 */

/** Two pi — used by the angle helpers below. */
const TAU = Math.PI * 2;

/**
 * Clamps `v` into the inclusive `[min, max]` range.
 * @param {number} v
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clamp(v, min, max) {
  return v < min ? min : (v > max ? max : v);
}

/**
 * Linear interpolation between `a` and `b`. `t` is NOT clamped, so it can be
 * used for extrapolation as well.
 * @param {number} a
 * @param {number} b
 * @param {number} t 0 -> a, 1 -> b
 * @returns {number}
 */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Framerate independent exponential approach ("smart lerp").
 * Moves `a` towards `b` with a half-life controlled by `lambda`: larger
 * `lambda` means a faster approach. Because the step is computed from the
 * elapsed time, the result is identical at 30, 60 or 144 FPS.
 * @param {number} a current value
 * @param {number} b target value
 * @param {number} lambda approach rate (1/seconds)
 * @param {number} dt elapsed time in seconds
 * @returns {number}
 */
export function damp(a, b, lambda, dt) {
  return b + (a - b) * Math.exp(-lambda * dt);
}

/**
 * Shortest signed difference between two angles, normalised to (-PI, PI].
 * Positive result means `a` is counter-clockwise ahead of `b`.
 * @param {number} a radians
 * @param {number} b radians
 * @returns {number} radians in (-PI, PI]
 */
export function angleDiff(a, b) {
  let d = (a - b) % TAU;
  if (d > Math.PI) d -= TAU;
  else if (d <= -Math.PI) d += TAU;
  return d;
}

/**
 * Interpolates between two angles along the shortest arc, so turrets and
 * hulls never take the "long way around" when crossing +/-PI.
 * @param {number} a radians
 * @param {number} b radians
 * @param {number} t 0 -> a, 1 -> b
 * @returns {number} radians
 */
export function angleLerp(a, b, t) {
  return a + angleDiff(b, a) * t;
}

/**
 * Length of the 2D vector (x, y).
 * @param {number} x
 * @param {number} y
 * @returns {number}
 */
export function len(x, y) {
  return Math.hypot(x, y);
}

/**
 * Distance between the points (ax, ay) and (bx, by).
 * @param {number} ax
 * @param {number} ay
 * @param {number} bx
 * @param {number} by
 * @returns {number}
 */
export function dist(ax, ay, bx, by) {
  return Math.hypot(bx - ax, by - ay);
}

/**
 * Uniform random float in `[min, max)`.
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function rand(min, max) {
  return min + Math.random() * (max - min);
}

/**
 * Uniform random integer in the INCLUSIVE range `[min, max]`.
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function randInt(min, max) {
  const lo = Math.ceil(min);
  const hi = Math.floor(max);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

/**
 * Returns a random element of the array (or `undefined` for an empty array).
 * @template T
 * @param {ArrayLike<T>} arr
 * @returns {T|undefined}
 */
export function pick(arr) {
  if (!arr || arr.length === 0) return undefined;
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Fisher-Yates shuffle. The input array is left untouched: a NEW shuffled
 * array is returned.
 * @template T
 * @param {ArrayLike<T>} arr
 * @returns {T[]} a new, shuffled array
 */
export function shuffle(arr) {
  const out = Array.prototype.slice.call(arr || []);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

/**
 * Converts a `#rgb` or `#rrggbb` hex colour into a CSS `rgba(...)` string.
 * Unparseable input falls back to opaque white, so a typo never kills a frame.
 * @param {string} hex e.g. '#ef4444' or '#e44'
 * @param {number} [a=1] alpha in 0..1
 * @returns {string} e.g. 'rgba(239, 68, 68, 0.5)'
 */
export function hexToRgba(hex, a = 1) {
  const alpha = clamp(Number.isFinite(a) ? a : 1, 0, 1);
  let h = typeof hex === 'string' ? hex.trim().replace('#', '') : '';
  if (h.length === 3) {
    // Expand the shorthand form: 'abc' -> 'aabbcc'
    h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  }
  if (h.length !== 6) return `rgba(255, 255, 255, ${alpha})`;
  const n = parseInt(h, 16);
  if (!Number.isFinite(n)) return `rgba(255, 255, 255, ${alpha})`;
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * High resolution timestamp in milliseconds. Uses `performance.now()` when
 * available (browser and modern Node), otherwise falls back to `Date.now()`.
 * @returns {number} milliseconds
 */
export function now() {
  const perf = globalThis.performance;
  return perf && typeof perf.now === 'function' ? perf.now() : Date.now();
}
