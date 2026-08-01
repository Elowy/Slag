#!/usr/bin/env node
/**
 * Slag — headless smoke test.
 *
 * Starts `tools/serve.mjs` on a free port, opens the game in headless Chromium,
 * fakes four DualSense controllers through `navigator.getGamepads`, plays a
 * whole lobby -> countdown -> match round and checks that the game is actually
 * alive (no console errors, a canvas exists, the match really starts and the
 * screen is not black).
 *
 * Usage:
 *   node tools/smoke-test.mjs
 *   node tools/smoke-test.mjs --seconds 20 --headed
 *   node tools/smoke-test.mjs --url http://localhost:8080/   # use a running server
 *
 * Exit codes: 0 = PASS (or skipped because Playwright is missing), 1 = FAIL.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const SERVER_SCRIPT = path.join(HERE, 'serve.mjs');
const ARTIFACTS_DIR = path.join(REPO_ROOT, '.artifacts');

/** Where the Playwright browsers were pre-installed in this environment. */
const BROWSERS_PATH = '/opt/pw-browsers';
/** Global Playwright installation, used when a local resolution fails. */
const GLOBAL_PLAYWRIGHT = '/opt/node22/lib/node_modules/playwright/index.js';

// Standard gamepad mapping button indices.
const BTN = {
  CROSS: 0,
  CIRCLE: 1,
  L1: 4,
  R1: 5,
  R2: 7,
  OPTIONS: 9,
  DPAD_UP: 12,
  DPAD_DOWN: 13,
  DPAD_LEFT: 14,
  DPAD_RIGHT: 15,
};

const PAD_COUNT = 4;

// ---------------------------------------------------------------------------
// Output helpers (this is a CLI tool: it prints, it does not `console.log`)
// ---------------------------------------------------------------------------

const out = (line = '') => process.stdout.write(`${line}\n`);
const errOut = (line = '') => process.stderr.write(`${line}\n`);
const RULE = '─'.repeat(62);

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Collected verdicts, printed at the end.
 * @type {Array<{ ok: boolean, label: string, detail: string }>}
 */
const checks = [];

/** @type {string[]} */
const consoleErrors = [];
/** @type {string[]} */
const pageErrors = [];

/**
 * @param {boolean} ok
 * @param {string} label Hungarian, user visible
 * @param {string} [detail]
 */
function check(ok, label, detail = '') {
  checks.push({ ok, label, detail });
}

/** Prints the collected verdicts. Used by both the normal and the crash path. */
function printReport() {
  out('');
  for (const item of checks) {
    const mark = item.ok ? '✓' : '✗';
    out(`  ${mark} ${item.label}${item.detail ? `  —  ${item.detail}` : ''}`);
  }

  const dump = (title, list) => {
    if (list.length === 0) return;
    out('');
    out(`  ${title}`);
    for (const message of list.slice(0, 10)) out(`    · ${message}`);
    if (list.length > 10) out(`    · … és még ${list.length - 10} db`);
  };
  dump('console.error üzenetek:', consoleErrors);
  dump('Oldal-kivételek:', pageErrors);

  out('');
  out(`  Képernyőképek: ${ARTIFACTS_DIR}`);
  out(`  ${RULE}`);
}

// ---------------------------------------------------------------------------
// CLI arguments
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { seconds: 15, headed: false, url: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const value = eq === -1 ? argv[i + 1] : arg.slice(eq + 1);

    switch (name) {
      case 'seconds':
        opts.seconds = Math.max(3, Number.parseInt(value ?? '', 10) || 15);
        if (eq === -1) i++;
        break;
      case 'url':
        opts.url = value ?? null;
        if (eq === -1) i++;
        break;
      case 'headed':
        opts.headed = true;
        break;
      case 'help':
        out('Használat: node tools/smoke-test.mjs [--seconds N] [--url <cím>] [--headed]');
        process.exit(0);
        break;
      default:
        errOut(`Ismeretlen kapcsoló: ${arg}`);
        process.exit(1);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Playwright loading (must happen after PLAYWRIGHT_BROWSERS_PATH is set)
// ---------------------------------------------------------------------------

if (!process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync(BROWSERS_PATH)) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = BROWSERS_PATH;
}

/**
 * Tries hard to find a usable Playwright installation.
 * @returns {Promise<{ chromium: any }|null>}
 */
async function loadPlaywright() {
  const candidates = ['playwright'];
  if (fs.existsSync(GLOBAL_PLAYWRIGHT)) {
    candidates.push(pathToFileURL(GLOBAL_PLAYWRIGHT).href, GLOBAL_PLAYWRIGHT);
  }

  for (const candidate of candidates) {
    try {
      const mod = await import(candidate);
      // The global install is CommonJS, so the exports may sit under `default`.
      const resolved = mod && mod.chromium ? mod : mod && mod.default;
      if (resolved && resolved.chromium) return resolved;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Dev server child process
// ---------------------------------------------------------------------------

/**
 * Spawns `serve.mjs` on an OS-assigned free port and reads the real URL back
 * from its startup banner (no port-guessing race).
 *
 * @returns {Promise<{ url: string, child: import('node:child_process').ChildProcess }>}
 */
function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER_SCRIPT, '--port', '0'], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let buffer = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error('A fejlesztői szerver nem indult el 10 másodperc alatt.'));
    }, 10_000);

    child.stdout.on('data', (chunk) => {
      buffer += String(chunk);
      const match = /(https?:\/\/[^\s]+)/.exec(buffer);
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ url: match[1], child });
      }
    });

    child.stderr.on('data', (chunk) => {
      buffer += String(chunk);
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`A fejlesztői szerver kilépett (kód: ${code}).\n${buffer}`));
    });
  });
}

/** @param {import('node:child_process').ChildProcess|null} child */
async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  for (let i = 0; i < 20 && child.exitCode === null; i++) await sleep(50);
  if (child.exitCode === null) child.kill('SIGKILL');
}

// ---------------------------------------------------------------------------
// Page-side instrumentation (runs before any page script)
// ---------------------------------------------------------------------------

/**
 * Installed with `page.addInitScript`. Replaces `navigator.getGamepads` with
 * four fake DualSense pads and exposes `window.__setPad` / `window.__connectPads`
 * so the test can drive them.
 *
 * NOTE: this function is serialised and executed in the browser — it may not
 * capture anything from the Node scope.
 */
function installFakeGamepads() {
  const PAD_ID = 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)';
  const BUTTON_COUNT = 17;
  const AXIS_COUNT = 6;
  const COUNT = 4;

  // Remember which globals existed before the game ran, so the test can find
  // whatever the game exposes without walking the whole `window` object.
  try {
    window.__slagBaselineKeys = Object.getOwnPropertyNames(window).slice();
  } catch {
    window.__slagBaselineKeys = [];
  }

  /** @param {number} value */
  function makeButton(value) {
    return { pressed: value >= 0.5, touched: value > 0.02, value };
  }

  const pads = [];
  for (let i = 0; i < COUNT; i++) {
    const axes = new Array(AXIS_COUNT).fill(0);
    // Some drivers expose the analog triggers on axes 4/5 where -1 == released.
    axes[4] = -1;
    axes[5] = -1;
    pads.push({
      index: i,
      id: PAD_ID,
      connected: true,
      mapping: 'standard',
      timestamp: 0,
      axes,
      buttons: new Array(BUTTON_COUNT).fill(0).map(() => makeButton(0)),
      vibrationActuator: {
        type: 'dual-rumble',
        playEffect: () => Promise.resolve('complete'),
        reset: () => Promise.resolve('complete'),
      },
      hapticActuators: [],
    });
  }

  function snapshot() {
    const t = performance.now();
    for (const pad of pads) pad.timestamp = t;
    return pads.slice();
  }

  const descriptor = { configurable: true, writable: true, value: snapshot };
  try {
    Object.defineProperty(navigator, 'getGamepads', descriptor);
    Object.defineProperty(navigator, 'webkitGetGamepads', descriptor);
  } catch {
    /* nothing else we can do */
  }

  /**
   * @param {number} index
   * @param {{ axes?: any, buttons?: any }} state
   */
  window.__setPad = function setPad(index, state) {
    const pad = pads[index];
    if (!pad || !state) return;

    if (state.axes) {
      const entries = Array.isArray(state.axes)
        ? state.axes.map((v, i) => [i, v])
        : Object.entries(state.axes);
      for (const [key, value] of entries) {
        const i = Number(key);
        if (Number.isInteger(i) && i >= 0 && i < pad.axes.length && typeof value === 'number') {
          pad.axes[i] = Math.max(-1, Math.min(1, value));
        }
      }
    }

    if (state.buttons) {
      const entries = Array.isArray(state.buttons)
        ? state.buttons.map((v, i) => [i, v])
        : Object.entries(state.buttons);
      for (const [key, raw] of entries) {
        const i = Number(key);
        if (!Number.isInteger(i) || i < 0 || i >= pad.buttons.length || raw == null) continue;
        const value = typeof raw === 'number' ? raw : Number(raw.value ?? (raw.pressed ? 1 : 0));
        pad.buttons[i] = makeButton(Math.max(0, Math.min(1, value)));
      }
    }

    pad.timestamp = performance.now();
  };

  /** Releases every button and centres every axis on every pad. */
  window.__resetPads = function resetPads() {
    for (const pad of pads) {
      pad.axes = pad.axes.map((_, i) => (i === 4 || i === 5 ? -1 : 0));
      pad.buttons = pad.buttons.map(() => makeButton(0));
      pad.timestamp = performance.now();
    }
  };

  /**
   * Chrome only fires `gamepadconnected` after a user gesture; the fake pads
   * need the event fired explicitly. `GamepadEvent` would reject our plain
   * objects, so a plain `Event` with a `gamepad` property is used instead.
   * @param {string} type
   */
  function emit(type) {
    for (const pad of pads) {
      const event = new Event(type);
      try {
        event.gamepad = pad;
      } catch {
        Object.defineProperty(event, 'gamepad', { value: pad, configurable: true });
      }
      window.dispatchEvent(event);
    }
  }

  window.__connectPads = () => emit('gamepadconnected');
  window.__disconnectPads = () => emit('gamepaddisconnected');
}

// ---------------------------------------------------------------------------
// Page-side probes
// ---------------------------------------------------------------------------

/**
 * Looks for a game-like object among the globals the page created. Returns
 * `null` when the game does not expose anything (which is allowed).
 */
function probeSceneInPage() {
  const baseline = new Set(window.__slagBaselineKeys || []);
  const ours = new Set(['__setPad', '__resetPads', '__connectPads', '__disconnectPads', '__slagBaselineKeys']);

  /** @param {any} value */
  function classify(value) {
    if (!value || typeof value !== 'object') return null;
    const world = value.world;
    if (world && Array.isArray(world.tanks)) {
      return {
        state: typeof value.state === 'string' ? value.state : null,
        tanks: world.tanks.length,
        bullets: Array.isArray(world.bullets) ? world.bullets.length : -1,
      };
    }
    return null;
  }

  for (const key of Object.getOwnPropertyNames(window)) {
    if (baseline.has(key) || ours.has(key)) continue;
    let value;
    try {
      value = window[key];
    } catch {
      continue;
    }

    const direct = classify(value);
    if (direct) return { via: key, ...direct };

    // One level deeper, e.g. `window.__slag = { game, lobby }`.
    if (value && typeof value === 'object') {
      for (const inner of Object.keys(value)) {
        let child;
        try {
          child = value[inner];
        } catch {
          continue;
        }
        const nested = classify(child);
        if (nested) return { via: `${key}.${inner}`, ...nested };
      }
    }
  }

  return null;
}

/**
 * Finds the game canvas (prefers `#game`, otherwise the largest one).
 * Returns a coarse colour fingerprint plus the ratio of non-black pixels.
 */
function sampleCanvasInPage() {
  const canvases = Array.from(document.querySelectorAll('canvas'));
  if (canvases.length === 0) return null;

  const canvas =
    canvases.find((c) => c.id === 'game') ??
    canvases.slice().sort((a, b) => b.width * b.height - a.width * a.height)[0];

  const ctx = canvas.getContext('2d');
  if (!ctx || !canvas.width || !canvas.height) return null;

  let data;
  try {
    data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  } catch {
    return null;
  }

  const width = canvas.width;
  const height = canvas.height;

  // Ratio of pixels that are not (nearly) black — a black screen means the
  // render loop never drew anything.
  const stride = Math.max(1, Math.floor(Math.min(width, height) / 240));
  let nonBlack = 0;
  let total = 0;
  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const o = (y * width + x) * 4;
      total++;
      if (data[o] + data[o + 1] + data[o + 2] > 24) nonBlack++;
    }
  }

  // 32x18 average-colour fingerprint, used to tell scenes apart.
  const COLS = 32;
  const ROWS = 18;
  const signature = new Array(COLS * ROWS * 3).fill(0);
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const x0 = Math.floor((col * width) / COLS);
      const x1 = Math.max(x0 + 1, Math.floor(((col + 1) * width) / COLS));
      const y0 = Math.floor((row * height) / ROWS);
      const y1 = Math.max(y0 + 1, Math.floor(((row + 1) * height) / ROWS));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let y = y0; y < y1; y += 2) {
        for (let x = x0; x < x1; x += 2) {
          const o = (y * width + x) * 4;
          r += data[o];
          g += data[o + 1];
          b += data[o + 2];
          n++;
        }
      }
      const base = (row * COLS + col) * 3;
      signature[base] = n ? r / n : 0;
      signature[base + 1] = n ? g / n : 0;
      signature[base + 2] = n ? b / n : 0;
    }
  }

  return {
    id: canvas.id || '(névtelen)',
    width,
    height,
    nonBlackRatio: total ? nonBlack / total : 0,
    signature,
  };
}

/**
 * Fraction of fingerprint cells whose colour changed noticeably.
 *
 * A high `minDelta` answers "is this a different screen?" (used to tell the
 * lobby from the arena), a low one answers "did anything move at all?" (used to
 * detect a frozen render loop).
 *
 * @param {number[]|null|undefined} a
 * @param {number[]|null|undefined} b
 * @param {number} minDelta per-channel difference that counts as a change
 * @returns {number} 0..1
 */
function signatureDiff(a, b, minDelta) {
  if (!a || !b || a.length !== b.length) return 1;
  const cells = a.length / 3;
  let changed = 0;
  for (let i = 0; i < cells; i++) {
    const o = i * 3;
    const delta = Math.max(
      Math.abs(a[o] - b[o]),
      Math.abs(a[o + 1] - b[o + 1]),
      Math.abs(a[o + 2] - b[o + 2]),
    );
    if (delta > minDelta) changed++;
  }
  return changed / cells;
}

/** Per-cell delta that means "this is a completely different screen". */
const SCENE_DELTA = 18;
/** Per-cell delta that means "something on screen moved". */
const MOTION_DELTA = 3;

// ---------------------------------------------------------------------------
// Pad driving helpers (Node side)
// ---------------------------------------------------------------------------

/**
 * @param {any} page
 * @param {number} index
 * @param {object} state
 */
const setPad = (page, index, state) =>
  page.evaluate(([i, s]) => window.__setPad(i, s), [index, state]);

/**
 * Presses and releases a button, holding it long enough for the game's edge
 * detection to see a clean 0 -> 1 -> 0 transition across several frames.
 *
 * @param {any} page
 * @param {number} index
 * @param {number} button
 * @param {number} [holdMs]
 */
async function tap(page, index, button, holdMs = 200) {
  await setPad(page, index, { buttons: { [button]: 1 } });
  await sleep(holdMs);
  await setPad(page, index, { buttons: { [button]: 0 } });
  await sleep(110);
}

// ---------------------------------------------------------------------------
// Main scenario
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();

  out('');
  out('  SLAG — füstteszt (headless Chromium + 4 hamis DualSense)');
  out(`  ${RULE}`);

  const playwright = await loadPlaywright();
  if (!playwright) {
    out('  KIHAGYVA — a Playwright nem érhető el ebben a környezetben.');
    out('  Telepítés után futtasd újra: npm run smoke');
    out('');
    process.exit(0);
  }

  await fsp.mkdir(ARTIFACTS_DIR, { recursive: true });
  for (const file of await fsp.readdir(ARTIFACTS_DIR)) {
    if (file.endsWith('.png')) await fsp.rm(path.join(ARTIFACTS_DIR, file), { force: true });
  }

  /** @type {import('node:child_process').ChildProcess|null} */
  let server = null;
  let browser = null;
  let url = opts.url;

  try {
    if (!url) {
      const started = await startServer();
      server = started.child;
      url = started.url;
    }
    out(`  Szerver:   ${url}`);

    browser = await playwright.chromium.launch({
      headless: !opts.headed,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--mute-audio',
        '--autoplay-policy=no-user-gesture-required',
      ],
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();

    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const text = message.text();
      // A missing favicon is not a game bug.
      if (/favicon\.ico/i.test(text)) return;
      consoleErrors.push(text);
    });
    page.on('pageerror', (error) => {
      pageErrors.push(error && error.stack ? error.stack.split('\n')[0] : String(error));
    });

    await page.addInitScript(installFakeGamepads);
    await page.goto(url, { waitUntil: 'load', timeout: 20_000 });

    // --- 1. canvas ---------------------------------------------------------
    let canvasInfo = null;
    try {
      await page.waitForSelector('canvas', { timeout: 10_000 });
      canvasInfo = await page.evaluate(sampleCanvasInPage);
    } catch {
      canvasInfo = null;
    }
    check(
      Boolean(canvasInfo),
      'A <canvas> létezik és rajzolható',
      canvasInfo ? `#${canvasInfo.id}, ${canvasInfo.width}×${canvasInfo.height}` : 'nem található canvas',
    );
    if (!canvasInfo) throw new Error('Nincs canvas — a további lépéseknek nincs értelme.');

    // --- 2. start overlay + controller connection --------------------------
    // The opening overlay unlocks the audio context and (in a real browser)
    // makes Chrome hand out gamepads.
    await page.mouse.click(640, 360);
    await sleep(300);
    await page.mouse.click(640, 360);
    await sleep(300);

    await page.evaluate(() => window.__connectPads());
    await sleep(500);

    // --- 3. every pad joins with R2 ---------------------------------------
    for (let i = 0; i < PAD_COUNT; i++) {
      await tap(page, i, BTN.R2, 240);
      await sleep(160);
    }
    await sleep(500);
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, 'lobby.png') });

    // --- 4. colour selection (D-pad right, staggered per player) -----------
    for (let i = 1; i < PAD_COUNT; i++) {
      for (let step = 0; step < i; step++) {
        await tap(page, i, BTN.DPAD_RIGHT, 150);
      }
    }
    await sleep(400);

    // --- 5. everybody readies up (Cross) ----------------------------------
    for (let i = 0; i < PAD_COUNT; i++) {
      await tap(page, i, BTN.CROSS, 220);
      await sleep(120);
    }
    await sleep(600);

    // Two lobby fingerprints one second apart give us the lobby's own
    // animation "noise floor" to compare the in-match difference against.
    const lobbyA = await page.evaluate(sampleCanvasInPage);
    await sleep(1000);
    const lobbyB = await page.evaluate(sampleCanvasInPage);
    const lobbyNoise = signatureDiff(lobbyA?.signature, lobbyB?.signature, SCENE_DELTA);

    // --- 6. start the match (Options) -------------------------------------
    await tap(page, 0, BTN.OPTIONS, 240);
    await sleep(700);
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, 'countdown.png') });

    // --- 7. play with random input ----------------------------------------
    const playMs = opts.seconds * 1000;
    const shotTimes = [
      Math.round(playMs * 0.25),
      Math.round(playMs * 0.6),
      Math.round(playMs * 0.92),
    ];
    let shotIndex = 0;
    /** @type {any} */
    let midPlaySample = null;

    // Per-pad heading, nudged every tick so the tanks wander instead of jitter.
    const heading = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
    const firing = [false, false, false, false];

    const playStart = Date.now();
    while (Date.now() - playStart < playMs) {
      const elapsed = Date.now() - playStart;

      /** @type {Array<[number, object]>} */
      const batch = [];
      for (let i = 0; i < PAD_COUNT; i++) {
        heading[i] += (Math.random() - 0.5) * 1.4;
        const magnitude = 0.55 + Math.random() * 0.45;
        // Occasionally toggle the trigger so `firePressed` edges keep coming.
        if (Math.random() < 0.28) firing[i] = !firing[i];
        batch.push([
          i,
          {
            axes: { 2: Math.cos(heading[i]) * magnitude, 3: Math.sin(heading[i]) * magnitude },
            buttons: { [BTN.R2]: firing[i] ? 1 : 0 },
          },
        ]);
      }
      await page.evaluate((entries) => {
        for (const [i, state] of entries) window.__setPad(i, state);
      }, batch);

      if (shotIndex < shotTimes.length && elapsed >= shotTimes[shotIndex]) {
        shotIndex++;
        await page.screenshot({ path: path.join(ARTIFACTS_DIR, `play-${shotIndex}.png`) });
        if (shotIndex === 2) midPlaySample = await page.evaluate(sampleCanvasInPage);
      }

      await sleep(110);
    }

    // Two frames a fraction of a second apart, taken while the pads are still
    // being driven: this is what tells a running render loop from a frozen one.
    const motionA = await page.evaluate(sampleCanvasInPage);
    await sleep(180);
    const motionB = await page.evaluate(sampleCanvasInPage);

    await page.evaluate(() => window.__resetPads());
    const finalSample = motionB ?? (await page.evaluate(sampleCanvasInPage));

    // --- 8. verdicts -------------------------------------------------------
    const scene = await page.evaluate(probeSceneInPage);

    // 8a. Did we actually leave the lobby?
    const playDiff = signatureDiff(
      lobbyB?.signature,
      (midPlaySample ?? finalSample)?.signature,
      SCENE_DELTA,
    );
    if (scene) {
      const inMatch = scene.state === 'countdown' || scene.state === 'playing' || scene.state === 'matchEnd';
      check(
        inMatch && scene.tanks > 0,
        'A meccs elindult (nem ragadt a lobbiban)',
        `jelenet: ${scene.via} → state="${scene.state ?? 'n/a'}", ${scene.tanks} tank`,
      );
    } else {
      const left = playDiff >= 0.15 && playDiff > lobbyNoise * 2;
      check(
        left,
        'A meccs elindult (nem ragadt a lobbiban)',
        `képernyő-eltérés: ${(playDiff * 100).toFixed(1)}% (lobbi zaj: ${(lobbyNoise * 100).toFixed(1)}%)`,
      );
    }

    // 8b. Is anything drawn at all?
    const ratio = (finalSample ?? canvasInfo).nonBlackRatio;
    check(
      ratio > 0.02,
      'A képernyő nem üres (nem-fekete pixelek > 2%)',
      `${(ratio * 100).toFixed(1)}%`,
    );

    // 8c. Is the render loop still running?
    const motionDiff = signatureDiff(motionA?.signature, motionB?.signature, MOTION_DELTA);
    check(
      motionDiff > 0.005,
      'A kép él (a render ciklus fut)',
      `0,18 mp-nyi mozgás: ${(motionDiff * 100).toFixed(1)}%`,
    );

    // 8d. Errors.
    check(
      consoleErrors.length === 0,
      'Nincs console.error',
      consoleErrors.length ? `${consoleErrors.length} db` : '',
    );
    check(
      pageErrors.length === 0,
      'Nincs elkapatlan oldalhiba (pageerror)',
      pageErrors.length ? `${pageErrors.length} db` : '',
    );

    await context.close();
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stopServer(server);
  }

  // --- report --------------------------------------------------------------
  printReport();

  const failed = checks.filter((c) => !c.ok);
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);

  if (failed.length === 0) {
    out(`  PASS — mind a ${checks.length} ellenőrzés rendben (${seconds} mp)`);
    out('');
    process.exit(0);
  } else {
    out(`  FAIL — ${failed.length}/${checks.length} ellenőrzés bukott (${seconds} mp)`);
    out('');
    process.exit(1);
  }
}

main().catch((err) => {
  // Show whatever we already know before reporting the crash itself.
  if (checks.length > 0 || consoleErrors.length > 0 || pageErrors.length > 0) printReport();
  errOut('');
  errOut(`  FAIL — a füstteszt hibára futott: ${err && err.message ? err.message : String(err)}`);
  if (err && err.stack) errOut(err.stack.split('\n').slice(1, 4).join('\n'));
  errOut('');
  process.exit(1);
});
