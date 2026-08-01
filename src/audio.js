/**
 * Slag - procedural sound effects (see SPEC sections 5 and 14b).
 *
 * Everything is synthesized with WebAudio at runtime: oscillators, a shared
 * white-noise buffer, biquad filters and gain envelopes. There is not a single
 * external asset, so the game stays a pure "drop it on a static host" build.
 *
 * Design notes:
 *  - The AudioContext is created lazily (never in `init()`), because browsers
 *    block audio until a real user gesture.
 *  - Every sound instance is a "voice" with its own gain node. At most
 *    MAX_VOICES voices are alive; when a new one does not fit, the quietest
 *    running voice is faded out and replaced, so four players shooting at once
 *    cannot turn the mix into distortion.
 *  - Any failure (no WebAudio, blocked context, unknown sound name) is a
 *    silent no-op - audio must never break the game loop.
 */

/** Maximum number of simultaneously playing sound instances. */
const MAX_VOICES = 12;

/** Master output level, before the safety compressor. */
const MASTER_VOLUME = 0.85;

/** Length of the shared white-noise buffer, in seconds. */
const NOISE_SECONDS = 2;

let ctx = null;
let masterGain = null;
let noiseBuffer = null;
let muted = false;
let unavailable = false;      // WebAudio missing / construction failed
let gestureHooked = false;

/** @type {Array<Voice>} currently audible voices. */
const voices = [];

/* ------------------------------------------------------------------------ *
 * Context lifecycle
 * ------------------------------------------------------------------------ */

function createNoiseBuffer(context) {
  const length = Math.max(1, Math.floor(context.sampleRate * NOISE_SECONDS));
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

/**
 * Create the AudioContext on first use. Returns null when WebAudio is not
 * available - in that case the whole module degrades to silence.
 */
function ensureContext() {
  if (unavailable) return null;
  if (ctx) return ctx;
  try {
    const Ctor = (typeof window !== 'undefined')
      ? (window.AudioContext || window.webkitAudioContext)
      : null;
    if (!Ctor) {
      unavailable = true;
      return null;
    }
    const context = new Ctor();

    const gain = context.createGain();
    gain.gain.value = muted ? 0 : MASTER_VOLUME;

    // A gentle limiter keeps four simultaneous explosions from clipping.
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -14;
    compressor.knee.value = 24;
    compressor.ratio.value = 8;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.22;

    gain.connect(compressor);
    compressor.connect(context.destination);

    ctx = context;
    masterGain = gain;
    noiseBuffer = createNoiseBuffer(context);
  } catch (err) {
    unavailable = true;
    ctx = null;
    masterGain = null;
    noiseBuffer = null;
    return null;
  }
  return ctx;
}

function resumeContext() {
  if (!ctx) return;
  if (ctx.state === 'running') return;
  try {
    const result = ctx.resume();
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch (err) {
    // Nothing to do: playback simply stays silent until the next gesture.
  }
}

function onUserGesture() {
  Audio.unlock();
  if (ctx && ctx.state === 'running') removeGestureHooks();
}

function removeGestureHooks() {
  if (!gestureHooked || typeof window === 'undefined') return;
  gestureHooked = false;
  window.removeEventListener('pointerdown', onUserGesture);
  window.removeEventListener('touchend', onUserGesture);
  window.removeEventListener('mousedown', onUserGesture);
  window.removeEventListener('keydown', onUserGesture);
}

/* ------------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------------ */

function clamp(v, min, max) {
  if (!Number.isFinite(v)) return min;
  return v < min ? min : (v > max ? max : v);
}

/** Keep every scheduled frequency inside a safe, audible range. */
function clampFreq(f, context) {
  const nyquist = context.sampleRate ? context.sampleRate * 0.5 - 100 : 20000;
  const max = Math.min(20000, nyquist > 200 ? nyquist : 20000);
  return clamp(f, 10, max);
}

/**
 * Stereo placement. Returns null when no panning is needed or possible; the
 * caller then connects straight to the master bus.
 */
function createPanner(context, pan) {
  const p = clamp(pan, -1, 1);
  if (p === 0) return null;
  try {
    if (typeof context.createStereoPanner === 'function') {
      const node = context.createStereoPanner();
      node.pan.value = p;
      return node;
    }
    // Safari fallback: an equal-power 3D panner placed on the X axis.
    if (typeof context.createPanner === 'function') {
      const node = context.createPanner();
      node.panningModel = 'equalpower';
      const z = 1 - Math.abs(p);
      if (node.positionX) {
        node.positionX.value = p;
        node.positionY.value = 0;
        node.positionZ.value = z;
      } else if (typeof node.setPosition === 'function') {
        node.setPosition(p, 0, z);
      }
      return node;
    }
  } catch (err) {
    return null;
  }
  return null;
}

/* ------------------------------------------------------------------------ *
 * Voice
 * ------------------------------------------------------------------------ */

class Voice {
  /**
   * @param {AudioContext} context
   * @param {AudioNode} destination master bus
   * @param {number} volume final level, also used by the voice limiter
   * @param {number} pan -1..1
   */
  constructor(context, destination, volume, pan) {
    this.ctx = context;
    this.volume = volume;
    this.startTime = context.currentTime;
    this.endTime = this.startTime;
    this.sources = [];
    this.timer = 0;
    this.disposed = false;

    this.out = context.createGain();
    this.out.gain.value = volume;

    this.panner = createPanner(context, pan);
    if (this.panner) {
      this.out.connect(this.panner);
      this.panner.connect(destination);
    } else {
      this.out.connect(destination);
    }
  }

  /** Track a source node so the voice can be cut short and cleaned up. */
  register(source, endTime) {
    this.sources.push(source);
    if (endTime > this.endTime) this.endTime = endTime;
  }

  /** Arm the cleanup timer once every source has been scheduled. */
  arm() {
    const ms = Math.max(60, (this.endTime - this.ctx.currentTime + 0.2) * 1000);
    this.timer = setTimeout(() => this.dispose(), ms);
  }

  /** Fade out fast (no click) and free the slot immediately. */
  cut() {
    const t = this.ctx.currentTime;
    try {
      const g = this.out.gain;
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(0, t + 0.02);
    } catch (err) {
      // Ignore: the voice is being discarded anyway.
    }
    for (let i = 0; i < this.sources.length; i++) {
      try {
        this.sources[i].stop(t + 0.03);
      } catch (err) {
        // Already stopped.
      }
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.dispose(), 120);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = 0;
    }
    try {
      this.out.disconnect();
      if (this.panner) this.panner.disconnect();
    } catch (err) {
      // Node graph already torn down.
    }
    this.sources.length = 0;
    removeVoice(this);
  }
}

function removeVoice(voice) {
  const i = voices.indexOf(voice);
  if (i >= 0) voices.splice(i, 1);
}

/**
 * Drop finished voices, then make room for one more if the pool is full.
 * The quietest voice loses: if the incoming sound is the quietest of all, it
 * is the one that gets dropped (a click must never silence an explosion).
 * @returns {boolean} true if the new voice may be started.
 */
function makeRoom(context, newVolume) {
  const t = context.currentTime;
  for (let i = voices.length - 1; i >= 0; i--) {
    if (voices[i].endTime <= t) voices[i].dispose();
  }
  while (voices.length >= MAX_VOICES) {
    let quietest = 0;
    for (let i = 1; i < voices.length; i++) {
      if (voices[i].volume < voices[quietest].volume) quietest = i;
    }
    if (newVolume < voices[quietest].volume) return false;
    const victim = voices[quietest];
    voices.splice(quietest, 1);   // free the slot right away
    victim.cut();
  }
  return true;
}

/* ------------------------------------------------------------------------ *
 * Synth primitives
 * ------------------------------------------------------------------------ */

/**
 * One oscillator with an optional pitch sweep, optional filter and a
 * linear-attack / exponential-decay envelope.
 * @param {Voice} voice
 * @param {object} o { type, freq, freqEnd, dur, peak, attack, delay, detune, filter }
 * @param {number} rate pitch + tempo multiplier
 */
function addTone(voice, o, rate) {
  const c = voice.ctx;
  const start = voice.startTime + (o.delay || 0) / rate;
  const dur = Math.max(0.02, (o.dur || 0.1) / rate);
  const peak = Math.max(0.0008, o.peak != null ? o.peak : 0.3);
  const attack = clamp(o.attack != null ? o.attack : 0.004, 0.0005, dur * 0.5);

  const osc = c.createOscillator();
  osc.type = o.type || 'sine';
  osc.frequency.setValueAtTime(clampFreq(o.freq * rate, c), start);
  if (Number.isFinite(o.freqEnd)) {
    osc.frequency.exponentialRampToValueAtTime(clampFreq(o.freqEnd * rate, c), start + dur);
  }
  if (o.detune) osc.detune.value = o.detune;

  const env = c.createGain();
  env.gain.setValueAtTime(0, start);
  env.gain.linearRampToValueAtTime(peak, start + attack);
  env.gain.exponentialRampToValueAtTime(0.0005, start + dur);
  env.gain.setValueAtTime(0, start + dur + 0.001);

  let tail = osc;
  if (o.filter) {
    const bq = c.createBiquadFilter();
    bq.type = o.filter.type || 'lowpass';
    bq.frequency.setValueAtTime(clampFreq(o.filter.freq * rate, c), start);
    if (Number.isFinite(o.filter.freqEnd)) {
      bq.frequency.exponentialRampToValueAtTime(clampFreq(o.filter.freqEnd * rate, c), start + dur);
    }
    if (Number.isFinite(o.filter.Q)) bq.Q.value = o.filter.Q;
    tail.connect(bq);
    tail = bq;
  }
  tail.connect(env);
  env.connect(voice.out);

  const stopAt = start + dur + 0.03;
  osc.start(start);
  osc.stop(stopAt);
  voice.register(osc, stopAt);
}

/**
 * Filtered white noise with the same envelope shape.
 * @param {Voice} voice
 * @param {object} o { type, freq, freqEnd, Q, dur, peak, attack, delay, playbackRate }
 * @param {number} rate
 */
function addNoise(voice, o, rate) {
  const c = voice.ctx;
  if (!noiseBuffer) return;
  const start = voice.startTime + (o.delay || 0) / rate;
  const dur = Math.max(0.02, (o.dur || 0.1) / rate);
  const peak = Math.max(0.0008, o.peak != null ? o.peak : 0.3);
  const attack = clamp(o.attack != null ? o.attack : 0.003, 0.0005, dur * 0.5);

  const src = c.createBufferSource();
  src.buffer = noiseBuffer;
  src.loop = true;
  if (Number.isFinite(o.playbackRate)) src.playbackRate.value = clamp(o.playbackRate, 0.25, 4);

  const bq = c.createBiquadFilter();
  bq.type = o.type || 'bandpass';
  bq.frequency.setValueAtTime(clampFreq((o.freq != null ? o.freq : 1000) * rate, c), start);
  if (Number.isFinite(o.freqEnd)) {
    bq.frequency.exponentialRampToValueAtTime(clampFreq(o.freqEnd * rate, c), start + dur);
  }
  if (Number.isFinite(o.Q)) bq.Q.value = clamp(o.Q, 0.0001, 30);

  const env = c.createGain();
  env.gain.setValueAtTime(0, start);
  env.gain.linearRampToValueAtTime(peak, start + attack);
  env.gain.exponentialRampToValueAtTime(0.0005, start + dur);
  env.gain.setValueAtTime(0, start + dur + 0.001);

  src.connect(bq);
  bq.connect(env);
  env.connect(voice.out);

  // Random offset so repeated shots never sound like the exact same sample.
  const offset = Math.random() * Math.max(0, noiseBuffer.duration - 0.05);
  const stopAt = start + dur + 0.03;
  src.start(start, offset);
  src.stop(stopAt);
  voice.register(src, stopAt);
}

/* ------------------------------------------------------------------------ *
 * Sound definitions
 * ------------------------------------------------------------------------ */

const SOUNDS = {
  // Dry percussive crack: noise burst plus a fast downward pitch sweep.
  shoot: {
    volume: 0.55,
    build(k) {
      k.noise({ type: 'bandpass', freq: 1900, freqEnd: 420, Q: 1.1, dur: 0.09, peak: 0.7, attack: 0.001 });
      k.tone({ type: 'square', freq: 400, freqEnd: 70, dur: 0.11, peak: 0.26, attack: 0.001 });
      k.tone({ type: 'sine', freq: 150, freqEnd: 50, dur: 0.18, peak: 0.4, attack: 0.002 });
    },
  },

  // Tiny high click when a bullet kisses a wall.
  bounce: {
    volume: 0.32,
    build(k) {
      k.tone({ type: 'triangle', freq: 1560, freqEnd: 880, dur: 0.055, peak: 0.5, attack: 0.001 });
      k.noise({ type: 'highpass', freq: 2600, dur: 0.03, peak: 0.28, attack: 0.001 });
    },
  },

  // Body hit: a short thud with a metallic edge.
  hit: {
    volume: 0.62,
    build(k) {
      k.noise({ type: 'lowpass', freq: 1500, freqEnd: 320, Q: 0.8, dur: 0.2, peak: 0.55, attack: 0.001 });
      k.tone({ type: 'square', freq: 280, freqEnd: 80, dur: 0.16, peak: 0.28, attack: 0.001 });
      k.tone({ type: 'sine', freq: 95, freqEnd: 42, dur: 0.3, peak: 0.42, attack: 0.003 });
    },
  },

  // Big noise blast with a lowpass sweep, plus a sub drop for the punch.
  explode: {
    volume: 0.95,
    build(k) {
      k.noise({ type: 'lowpass', freq: 2800, freqEnd: 110, Q: 1.2, dur: 0.7, peak: 0.85, attack: 0.004 });
      k.noise({ type: 'highpass', freq: 3200, dur: 0.07, peak: 0.4, attack: 0.001 });
      k.tone({ type: 'sine', freq: 135, freqEnd: 30, dur: 0.55, peak: 0.6, attack: 0.005 });
      k.tone({
        type: 'sawtooth', freq: 90, freqEnd: 28, dur: 0.4, peak: 0.18, attack: 0.004,
        filter: { type: 'lowpass', freq: 600 },
      });
    },
  },

  // Friendly two-note confirmation when a player takes a slot.
  join: {
    volume: 0.5,
    build(k) {
      k.tone({ type: 'triangle', freq: 523.25, dur: 0.11, peak: 0.34, attack: 0.004 });
      k.tone({ type: 'triangle', freq: 783.99, dur: 0.17, peak: 0.34, attack: 0.004, delay: 0.085 });
    },
  },

  // Soft blip for scrolling through the palette.
  colorChange: {
    volume: 0.34,
    build(k) {
      k.tone({ type: 'triangle', freq: 920, freqEnd: 1180, dur: 0.07, peak: 0.35, attack: 0.002 });
      k.noise({ type: 'highpass', freq: 3800, dur: 0.025, peak: 0.12, attack: 0.001 });
    },
  },

  // Two short beeps, once per counted second.
  countdown: {
    volume: 0.55,
    build(k) {
      for (let i = 0; i < 2; i++) {
        const delay = i * 0.11;
        k.tone({ type: 'triangle', freq: 880, dur: 0.07, peak: 0.3, attack: 0.003, delay });
        k.tone({
          type: 'square', freq: 880, dur: 0.06, peak: 0.16, attack: 0.003, delay,
          filter: { type: 'lowpass', freq: 2600 },
        });
      }
    },
  },

  // Higher, brighter and longer than the countdown beeps.
  go: {
    volume: 0.8,
    build(k) {
      k.tone({ type: 'triangle', freq: 660, freqEnd: 1318.5, dur: 0.1, peak: 0.22, attack: 0.002 });
      k.tone({ type: 'triangle', freq: 1318.5, dur: 0.42, peak: 0.34, attack: 0.004, delay: 0.06 });
      k.tone({
        type: 'square', freq: 1760, dur: 0.36, peak: 0.11, attack: 0.006, delay: 0.06,
        filter: { type: 'lowpass', freq: 4200 },
      });
    },
  },

  // Rising major arpeggio: C5 - E5 - G5 - C6, with a shimmering tail.
  win: {
    volume: 0.8,
    build(k) {
      const notes = [523.25, 659.25, 783.99, 1046.5];
      for (let i = 0; i < notes.length; i++) {
        const last = i === notes.length - 1;
        const delay = i * 0.085;
        k.tone({
          type: 'triangle', freq: notes[i], dur: last ? 0.5 : 0.16,
          peak: 0.3, attack: 0.004, delay,
        });
        k.tone({
          type: 'square', freq: notes[i], dur: last ? 0.45 : 0.14,
          peak: 0.08, attack: 0.006, delay, detune: 7,
          filter: { type: 'lowpass', freq: 3200 },
        });
      }
      k.tone({ type: 'triangle', freq: 1567.98, dur: 0.55, peak: 0.15, attack: 0.012, delay: 0.34 });
    },
  },

  // Upward whoosh as a tank materializes.
  spawn: {
    volume: 0.45,
    build(k) {
      k.tone({ type: 'sine', freq: 180, freqEnd: 760, dur: 0.28, peak: 0.32, attack: 0.006 });
      k.noise({ type: 'bandpass', freq: 420, freqEnd: 2200, Q: 1.4, dur: 0.26, peak: 0.2, attack: 0.02 });
    },
  },

  // Bright coin-like sparkle when a crate is collected.
  pickup: {
    volume: 0.6,
    build(k) {
      k.tone({ type: 'triangle', freq: 987.77, dur: 0.07, peak: 0.32, attack: 0.002 });
      k.tone({ type: 'triangle', freq: 1318.5, dur: 0.22, peak: 0.32, attack: 0.003, delay: 0.06 });
      k.tone({ type: 'sine', freq: 2637, dur: 0.18, peak: 0.1, attack: 0.004, delay: 0.06 });
      k.noise({ type: 'highpass', freq: 4200, dur: 0.05, peak: 0.12, attack: 0.001 });
    },
  },

  // Crate slamming into the ground: sub thump, dust, wooden clatter.
  airdrop: {
    volume: 0.85,
    build(k) {
      k.tone({ type: 'sine', freq: 115, freqEnd: 38, dur: 0.45, peak: 0.55, attack: 0.003 });
      k.noise({ type: 'lowpass', freq: 1700, freqEnd: 180, Q: 0.9, dur: 0.33, peak: 0.5, attack: 0.002 });
      k.noise({ type: 'bandpass', freq: 2500, Q: 6, dur: 0.14, peak: 0.22, attack: 0.001, delay: 0.03 });
    },
  },

  // Rocket launch: ignition crack plus a rising jet hiss.
  rocketFire: {
    volume: 0.7,
    build(k) {
      k.noise({ type: 'highpass', freq: 1600, dur: 0.06, peak: 0.45, attack: 0.001 });
      k.noise({ type: 'bandpass', freq: 320, freqEnd: 2600, Q: 1.6, dur: 0.5, peak: 0.4, attack: 0.03 });
      k.tone({
        type: 'sawtooth', freq: 95, freqEnd: 190, dur: 0.45, peak: 0.2, attack: 0.01,
        filter: { type: 'lowpass', freq: 900 },
      });
    },
  },

  // Glassy shatter when a shield absorbs a lethal hit.
  shieldBreak: {
    volume: 0.72,
    build(k) {
      const shards = [
        { freq: 1760, freqEnd: 1180, dur: 0.16, peak: 0.18, delay: 0 },
        { freq: 2093, freqEnd: 1400, dur: 0.14, peak: 0.15, delay: 0.02 },
        { freq: 2637, freqEnd: 1700, dur: 0.12, peak: 0.12, delay: 0.045 },
      ];
      for (const s of shards) {
        k.tone({
          type: 'square', freq: s.freq, freqEnd: s.freqEnd, dur: s.dur, peak: s.peak,
          attack: 0.001, delay: s.delay, filter: { type: 'highpass', freq: 900 },
        });
      }
      k.noise({ type: 'highpass', freq: 3600, freqEnd: 1200, dur: 0.3, peak: 0.35, attack: 0.002 });
      k.tone({ type: 'sine', freq: 170, freqEnd: 60, dur: 0.22, peak: 0.3, attack: 0.003 });
    },
  },
};

/* ------------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------------ */

export const Audio = {
  /**
   * Prepare the module. Deliberately does NOT create an AudioContext (autoplay
   * policy); it only listens for the first user gesture to unlock audio.
   */
  init() {
    if (gestureHooked || typeof window === 'undefined') return;
    gestureHooked = true;
    const opts = { passive: true };
    window.addEventListener('pointerdown', onUserGesture, opts);
    window.addEventListener('touchend', onUserGesture, opts);
    window.addEventListener('mousedown', onUserGesture, opts);
    window.addEventListener('keydown', onUserGesture, opts);
  },

  /** Call from a real user gesture: creates and resumes the AudioContext. */
  unlock() {
    const context = ensureContext();
    if (!context) return;
    resumeContext();
    try {
      // A one-sample silent buffer satisfies the stricter iOS unlock rules.
      const src = context.createBufferSource();
      src.buffer = context.createBuffer(1, 1, context.sampleRate);
      src.connect(context.destination);
      src.start(0);
    } catch (err) {
      // Not fatal - resume() alone is enough on every desktop browser.
    }
  },

  /** @param {boolean} m */
  setMuted(m) {
    muted = !!m;
    if (!masterGain || !ctx) return;
    try {
      const t = ctx.currentTime;
      const g = masterGain.gain;
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(muted ? 0 : MASTER_VOLUME, t + 0.03);
    } catch (err) {
      masterGain.gain.value = muted ? 0 : MASTER_VOLUME;
    }
  },

  /** @returns {boolean} */
  isMuted() {
    return muted;
  },

  /**
   * Play one of the synthesized effects.
   * @param {string} name one of the keys of SOUNDS
   * @param {{volume?:number, rate?:number, pan?:number}} [opts]
   */
  play(name, opts) {
    if (muted || unavailable) return;
    const def = SOUNDS[name];
    if (!def) return;

    const context = ensureContext();
    if (!context) return;
    if (context.state !== 'running') {
      // Still locked by the autoplay policy: try to open it, stay silent now.
      resumeContext();
      return;
    }

    const o = opts || {};
    const volume = clamp(def.volume * (o.volume != null ? o.volume : 1), 0, 4);
    if (volume <= 0) return;
    const rate = clamp(o.rate != null ? o.rate : 1, 0.25, 4);
    const pan = clamp(o.pan != null ? o.pan : 0, -1, 1);

    if (!makeRoom(context, volume)) return;

    let voice;
    try {
      voice = new Voice(context, masterGain, volume, pan);
      const kit = {
        tone: (params) => addTone(voice, params, rate),
        noise: (params) => addNoise(voice, params, rate),
      };
      def.build(kit);
      voice.arm();
      voices.push(voice);
    } catch (err) {
      // A failed voice must not leave nodes hanging on the master bus.
      if (voice) voice.dispose();
    }
  },
};
