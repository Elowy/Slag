/**
 * Slag — entry point: the frame loop and everything around the game itself.
 *
 * Responsibilities
 *  - boot the canvas, the renderer, the input and the audio module,
 *  - drive a FIXED TIMESTEP simulation (1/120 s) from `requestAnimationFrame`,
 *  - poll the input EXACTLY once per rendered frame, before the fixed steps,
 *  - switch scenes: lobby → game → (end screen) → lobby,
 *  - keep the page usable: fullscreen, mute, resize, idle cursor, and a very
 *    visible red overlay instead of a silent death when something throws.
 *
 * WHY THE INPUT IS POLLED — AND CONSUMED — ONCE PER FRAME
 * `Input.poll()` computes the button EDGES (`confirmPressed`, ...) and an edge
 * lives for exactly one poll. Polling inside the fixed-step loop would
 * duplicate edges (a frame that runs three steps), so it happens once per
 * frame.
 *
 * Producing an edge per frame is only half of the job though: it must also be
 * CONSUMED per frame. Above 120 Hz a frame regularly runs ZERO fixed steps
 * (at 144 Hz every sixth one), and anything that reads edges from inside the
 * step loop silently drops them — at 144 Hz ~17% of the lobby presses, at
 * 240 Hz ~50%. Menu style input is therefore consumed here, outside the loop:
 * `lobby.consumeInput()` / `game.consumeInput()` run exactly once per frame,
 * while `update(dt)` only advances the simulation.
 */

import { Input } from './input.js';
import { Audio } from './audio.js';
import { initRender, resize, drawGame, drawLobby } from './render.js';
import { Lobby } from './lobby.js';
import { Game } from './game.js';

/** Fixed simulation step: 120 Hz. */
const STEP = 1 / 120;
/** Never run more than this many steps for a single frame (spiral of death). */
const MAX_STEPS = 5;
/**
 * Longest frame delta accepted. A hidden tab, a breakpoint or a garbage
 * collection pause must not teleport the tanks across the arena.
 */
const MAX_FRAME_DT = 0.25;
/** Seconds of pointer inactivity before the mouse cursor disappears. */
const CURSOR_IDLE = 2.0;
/** How long the opening overlay fades out, in milliseconds. */
const OVERLAY_FADE_MS = 420;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** @type {HTMLCanvasElement|null} */
let canvas = null;
/** Whatever `initRender()` handed back — the renderer's own context wrapper. */
let ctx = null;

/** @type {Lobby|null} */
let lobby = null;
/** @type {Game|null} */
let game = null;
/** @type {'lobby'|'game'} */
let scene = 'lobby';

let running = false;
let lastFrameMs = -1;
let accumulator = 0;

let idleTime = 0;
let cursorHidden = false;

let audioUnlocked = false;
let errorShown = false;

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

/** Wires everything up and starts the frame loop. */
function boot() {
  canvas = document.getElementById('game');
  if (!canvas || !canvas.getContext) {
    reportError('Hiányzik a rajzvászon', new Error('A <canvas id="game"> elem nem található.'), true);
    return;
  }

  ctx = initRender(canvas);
  if (!ctx) {
    reportError('Nem sikerült 2D rajzolási környezetet nyitni',
      new Error('canvas.getContext("2d") nem adott vissza környezetet.'), true);
    return;
  }
  onResize();

  Input.init();
  Audio.init();

  lobby = new Lobby();
  scene = 'lobby';

  installWindowHandlers();
  installOverlay();

  running = true;
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// Frame loop
// ---------------------------------------------------------------------------

/**
 * One animation frame.
 * @param {number} nowMs timestamp handed over by `requestAnimationFrame`
 */
function frame(nowMs) {
  if (!running) return;
  requestAnimationFrame(frame);

  try {
    tick(nowMs);
  } catch (err) {
    // A throwing frame would repeat forever: stop and show what happened.
    reportError('Váratlan hiba a játékhurokban', err, true);
  }
}

/** @param {number} nowMs */
function tick(nowMs) {
  // --- delta time ---------------------------------------------------------
  if (lastFrameMs < 0) lastFrameMs = nowMs;
  let dt = (nowMs - lastFrameMs) / 1000;
  lastFrameMs = nowMs;
  if (!Number.isFinite(dt) || dt < 0) dt = 0;
  if (dt > MAX_FRAME_DT) dt = MAX_FRAME_DT;

  // --- input: exactly once per frame, BEFORE the simulation steps ----------
  Input.poll();
  consumeInput();

  // --- fixed timestep accumulator -----------------------------------------
  accumulator += dt;
  let steps = 0;
  while (accumulator >= STEP && steps < MAX_STEPS) {
    stepScene(STEP);
    accumulator -= STEP;
    steps += 1;
  }
  if (steps >= MAX_STEPS) {
    // We are behind: drop the backlog instead of trying to catch up forever.
    accumulator = 0;
  }

  // --- once-per-frame work -------------------------------------------------
  handleEndScreenInput();
  updateCursor(dt);
  draw(nowMs);
}

/**
 * Reads the button EDGES of this frame, exactly once, outside the fixed step
 * loop. A frame that runs zero steps (anything above 120 Hz) must never eat a
 * button press.
 */
function consumeInput() {
  if (scene === 'lobby' && lobby) {
    lobby.consumeInput();
    if (lobby.started) enterGame();
    return;
  }
  if (game) game.consumeInput();
}

/**
 * Advances the active scene by one fixed step. Edges were already taken by
 * `consumeInput()`; this only moves the simulation forward.
 * @param {number} dt seconds
 */
function stepScene(dt) {
  if (scene === 'lobby') {
    lobby.update(dt);
    return;
  }
  if (game) game.update(dt);
}

/** @param {number} nowMs */
function draw(nowMs) {
  const t = nowMs / 1000;
  if (scene === 'lobby') drawLobby(ctx, lobby, t);
  else if (game) drawGame(ctx, game, t);
}

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------

/** Lobby → game. */
function enterGame() {
  game = new Game(lobby.playersForGame(), lobby.settings);
  scene = 'game';
}

/** Game → lobby. Everybody stays joined, so a rematch is two button presses. */
function enterLobby() {
  game = null;
  scene = 'lobby';
  lobby.reset();
}

/**
 * End screen controls, checked once per frame so an edge cannot be consumed
 * twice:
 *   Options / Enter → back to the lobby (the scene flow of the spec). Nobody
 *                     loses their seat there, so the next match is one more
 *                     press away, with a chance to change colours or settings.
 *   Kör / Esc       → the same way back, for players who reach for cancel.
 *   Kereszt         → immediate rematch with the very same line-up.
 */
function handleEndScreenInput() {
  if (scene !== 'game' || !game || !game.canExit) return;

  const players = game.players;
  for (let i = 0; i < players.length; i++) {
    const state = Input.getState(players[i].deviceId);
    if (state.startPressed || state.cancelPressed) {
      enterLobby();
      return;
    }
    if (state.confirmPressed) {
      game.restart();
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Window level plumbing
// ---------------------------------------------------------------------------

function installWindowHandlers() {
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);

  // The spec's `window.onerror` hook, in listener form so nothing that another
  // module may have installed gets overwritten.
  window.addEventListener('error', (event) => {
    reportError('Hiba történt', (event && event.error) || (event && event.message), false);
  });
  window.addEventListener('unhandledrejection', (event) => {
    reportError('Kezeletlen hiba', event && event.reason, false);
  });

  // Coming back from a hidden tab: forget the elapsed wall clock time so the
  // simulation continues instead of jumping forward by minutes.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    lastFrameMs = -1;
    accumulator = 0;
  });

  window.addEventListener('keydown', onKeyDown, { passive: false });
  if (canvas) canvas.addEventListener('dblclick', toggleFullscreen);

  window.addEventListener('pointermove', wakeCursor, { passive: true });
  window.addEventListener('pointerdown', wakeCursor, { passive: true });
}

/** F = fullscreen, M = mute. Everything else belongs to `input.js`. */
function onKeyDown(event) {
  if (event.ctrlKey || event.altKey || event.metaKey) return;
  if (event.code === 'KeyF') {
    event.preventDefault();
    toggleFullscreen();
  } else if (event.code === 'KeyM') {
    event.preventDefault();
    Audio.setMuted(!Audio.isMuted());
  }
}

function onResize() {
  if (!canvas) return;
  try {
    resize(canvas);
  } catch (err) {
    reportError('A méretezés meghiúsult', err, false);
  }
}

function toggleFullscreen() {
  try {
    if (!document.fullscreenElement) {
      const element = document.documentElement;
      const request = element.requestFullscreen || element.webkitRequestFullscreen;
      if (typeof request !== 'function') return;
      const result = request.call(element);
      if (result && typeof result.catch === 'function') result.catch(() => {});
      return;
    }
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (typeof exit !== 'function') return;
    const result = exit.call(document);
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch (err) {
    // Fullscreen is a convenience; a rejected request must never break a frame.
  }
}

// ---------------------------------------------------------------------------
// Idle cursor
// ---------------------------------------------------------------------------

/** @param {number} dt seconds */
function updateCursor(dt) {
  if (cursorHidden) return;
  idleTime += dt;
  if (idleTime < CURSOR_IDLE) return;
  cursorHidden = true;
  document.body.classList.add('cursor-hidden');
}

function wakeCursor() {
  idleTime = 0;
  if (!cursorHidden) return;
  cursorHidden = false;
  document.body.classList.remove('cursor-hidden');
}

// ---------------------------------------------------------------------------
// Opening overlay — audio unlock + the gamepad gesture Chrome insists on
// ---------------------------------------------------------------------------

function installOverlay() {
  const overlay = document.getElementById('start-overlay');

  const dismiss = (event) => {
    if (audioUnlocked) return;
    audioUnlocked = true;

    Audio.unlock();

    // The overlay says "click", but any key dismisses it too (spec §12). That
    // key press belongs to the overlay ONLY: `Enter` / `Space` are also the
    // join buttons of `kb-0`, and without this the keyboard would grab a lobby
    // slot nobody asked for — pushing the fourth controller out of the match.
    if (event && event.type === 'keydown') Input.consumeEdges();

    window.removeEventListener('pointerdown', dismiss);
    window.removeEventListener('keydown', dismiss);

    if (!overlay) return;
    overlay.classList.add('is-gone');
    // Remove it from the layout once the fade is over.
    setTimeout(() => { overlay.hidden = true; }, OVERLAY_FADE_MS);
  };

  window.addEventListener('pointerdown', dismiss);
  window.addEventListener('keydown', dismiss);
}

// ---------------------------------------------------------------------------
// Error overlay
// ---------------------------------------------------------------------------

/**
 * Shows a bright red overlay instead of dying silently. Only the FIRST error
 * is displayed: a broken frame usually keeps breaking, and a wall of identical
 * messages helps nobody.
 *
 * @param {string} title Hungarian headline
 * @param {*} err the thrown value (Error, string, anything)
 * @param {boolean} stopLoop true when the frame loop must be stopped
 */
function reportError(title, err, stopLoop) {
  if (stopLoop) running = false;

  // Real failure: the console keeps the full stack for debugging.
  console.error('[Slag]', title, err);

  if (errorShown) return;
  errorShown = true;

  const overlay = document.getElementById('error-overlay');
  const detail = describeError(err);

  if (!overlay) return;
  const titleNode = document.getElementById('error-title');
  const detailNode = document.getElementById('error-detail');
  if (titleNode) titleNode.textContent = title;
  if (detailNode) detailNode.textContent = detail;
  overlay.hidden = false;
}

/**
 * @param {*} err
 * @returns {string} a short, human readable description
 */
function describeError(err) {
  if (!err) return 'Ismeretlen hiba.';
  if (typeof err === 'string') return err;
  const message = err.message ? String(err.message) : String(err);
  const stack = err.stack ? String(err.stack) : '';
  if (!stack) return message;
  // The first few stack frames are enough to locate the problem.
  return stack.split('\n').slice(0, 6).join('\n');
}

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------

try {
  boot();
} catch (err) {
  reportError('A játék indítása meghiúsult', err, true);
}
