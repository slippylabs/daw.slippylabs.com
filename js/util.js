// ============================================================
// SlipDAW — shared helpers
// ============================================================

/** Deterministic PRNG (mulberry32).
 *
 * Every noise source in this DAW draws from a seeded generator rather than
 * Math.random(). That is not fussiness: an offline export has to be
 * reproducible, and a bare Math.random() in a hat or a plucked-string seed
 * makes two renders of the same project differ sample-for-sample. Seeded
 * noise keeps the render deterministic and keeps the "render twice, compare"
 * test meaningful. */
export function makeRng(seed = 0x5eed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** MIDI note number -> Hz (A4 = 69 = 440Hz). */
export const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const midiToName = (m) => `${NOTE_NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
export const isBlackKey = (m) => [1, 3, 6, 8, 10].includes(((m % 12) + 12) % 12);

/** dB <-> linear gain. -Infinity dB is silence, not NaN. */
export const dbToGain = (db) => (db <= -60 ? 0 : Math.pow(10, db / 20));
export const gainToDb = (g) => (g <= 0.001 ? -60 : 20 * Math.log10(g));

let idCounter = 0;
export function uid(prefix = 'id') {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

/** Beats -> seconds at a given tempo. Single source of truth: every
 *  beat->time conversion in the engine goes through this, so a tempo change
 *  can never be applied inconsistently between the scheduler and the
 *  offline renderer. */
export const beatsToSec = (beats, bpm) => (beats * 60) / bpm;
export const secToBeats = (sec, bpm) => (sec * bpm) / 60;

/** Format a beat position as BAR:BEAT:SIXTEENTH, 1-indexed like a DAW. */
export function formatPosition(beat, beatsPerBar = 4) {
  const b = Math.max(0, beat);
  const bar = Math.floor(b / beatsPerBar) + 1;
  const beatInBar = Math.floor(b % beatsPerBar) + 1;
  const sixteenth = Math.floor((b * 4) % 4) + 1;
  return `${bar}:${beatInBar}:${sixteenth}`;
}

export function formatTime(sec) {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest.toFixed(2).padStart(5, '0')}`;
}

/** Smooth parameter changes. Direct assignment to an AudioParam that is
 *  already producing sound clicks; every user-facing knob goes through this.
 *  Lifted from the synth's effects chain, which uses the same 20ms constant. */
export function rampParam(param, value, ctx, tau = 0.02) {
  try {
    param.setTargetAtTime(value, ctx.currentTime, tau);
  } catch {
    param.value = value;
  }
}

export const clone = (obj) => (typeof structuredClone === 'function'
  ? structuredClone(obj)
  : JSON.parse(JSON.stringify(obj)));

/** Shared noise buffer builder — seeded, so renders stay reproducible. */
export function createNoiseBuffer(ctx, seconds = 2, seed = 1337) {
  const rng = makeRng(seed);
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = rng() * 2 - 1;
  return buf;
}
