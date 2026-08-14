// ============================================================
// SlipDAW — built-in instruments
//
// Every instrument is a factory taking an AudioContext as its first
// argument and reaching for nothing else. That single rule is what lets the
// exact same graph be built against an OfflineAudioContext and rendered to a
// file faster than real time, instead of the DAW having to record its own
// speakers.
//
// The contract:
//   createInstrument(ctx, type, params) -> {
//     type, output, params,
//     noteOn(pitch, vel, when) -> voice | null,
//     noteOff(pitch, when),
//     playNote(pitch, vel, when, durSec),   // one-shot, fully scheduled
//     setParam(name, value), allNotesOff(when), dispose()
//   }
//
// `when` is always an absolute AudioContext time. Nothing here reads
// ctx.currentTime to decide *when* a note happens — the scheduler owns that.
// ============================================================

import { midiToFreq, makeRng, createNoiseBuffer, clamp } from '../util.js';

// Held voices are capped per instrument. Without a cap, a stuck MIDI note or
// a dense pattern climbs until the audio thread gives up; with it, the
// oldest voice is stolen and the DAW degrades gracefully instead.
const MAX_VOICES = 24;

// ---------------------------------------------------------------
// Analog — subtractive synth.
// The preset format (layers / filterEnvelope / lfo) and the voice-building
// logic come from the Test Synth (synth.slippylabs.com), rewritten to take
// an explicit `when` and to clean up via scheduled stop() rather than
// setTimeout — a setTimeout cleanup never fires during an offline render,
// which would leak every voice in an exported song.
// ---------------------------------------------------------------
export const ANALOG_PRESETS = [
  { id: 'sine', name: 'Sine', wave: 'sine', cutoff: 8000, attackMs: 20, releaseMs: 250 },
  { id: 'triangle', name: 'Triangle', wave: 'triangle', cutoff: 8000, attackMs: 20, releaseMs: 250 },
  { id: 'sawtooth', name: 'Sawtooth', wave: 'sawtooth', cutoff: 8000, attackMs: 20, releaseMs: 250 },
  { id: 'square', name: 'Square', wave: 'square', cutoff: 8000, attackMs: 20, releaseMs: 250 },
  {
    id: 'sub-bass', name: 'Sub Bass', wave: 'sine',
    layers: [{ wave: 'sine', semitones: -12, gain: 0.65 }],
    cutoff: 1800, resonance: 0.7, attackMs: 8, releaseMs: 260,
  },
  {
    id: 'warm-pad', name: 'Warm Pad', wave: 'triangle',
    layers: [{ wave: 'triangle', cents: 8, gain: 0.5 }, { wave: 'triangle', cents: -8, gain: 0.5 }],
    cutoff: 3200, resonance: 0.5, attackMs: 320, releaseMs: 900,
  },
  {
    id: 'pluck', name: 'Pluck', wave: 'triangle',
    cutoff: 6000, resonance: 5, attackMs: 2, releaseMs: 160,
    filterEnvelope: { startMult: 4, endMult: 0.6, timeMs: 220 },
  },
  {
    id: 'wobble-bass', name: 'Wobble Bass', wave: 'sawtooth',
    layers: [{ wave: 'sine', semitones: -12, gain: 0.7 }],
    cutoff: 1200, resonance: 6, attackMs: 8, releaseMs: 220,
    lfo: { rate: 5, depth: 900 },
  },
  {
    id: 'bell', name: 'Bell', wave: 'sine',
    layers: [{ wave: 'sine', ratio: 2.01, gain: 0.35 }, { wave: 'sine', ratio: 3.0, gain: 0.2 }],
    cutoff: 9000, resonance: 0.4, attackMs: 4, releaseMs: 700,
  },
  {
    id: 'supersaw', name: 'Supersaw', wave: 'sawtooth',
    layers: [
      { wave: 'sawtooth', cents: 12, gain: 0.6 }, { wave: 'sawtooth', cents: -12, gain: 0.6 },
      { wave: 'sawtooth', cents: 24, gain: 0.35 }, { wave: 'sawtooth', cents: -24, gain: 0.35 },
    ],
    cutoff: 7000, resonance: 1.2, attackMs: 30, releaseMs: 420,
  },
  {
    id: 'organ', name: 'Organ', wave: 'sine',
    layers: [
      { wave: 'sine', semitones: 12, gain: 0.5 }, { wave: 'sine', semitones: 19, gain: 0.28 },
      { wave: 'sine', semitones: 24, gain: 0.18 },
    ],
    cutoff: 9000, resonance: 0.4, attackMs: 6, releaseMs: 120,
  },
  {
    id: 'brass', name: 'Brass', wave: 'sawtooth',
    layers: [{ wave: 'square', cents: 6, gain: 0.32 }],
    cutoff: 2600, resonance: 3, attackMs: 60, releaseMs: 260,
    filterEnvelope: { startMult: 0.6, endMult: 2.4, timeMs: 180 },
  },
];

function createAnalog(ctx, params = {}) {
  const p = {
    preset: 'sawtooth', cutoff: null, attackMs: null, releaseMs: null,
    glideMs: 0, level: 0.8, ...params,
  };
  const output = ctx.createGain();
  output.gain.value = p.level;

  const voices = new Map(); // pitch -> voice
  const order = [];

  const presetFor = () => ANALOG_PRESETS.find((x) => x.id === p.preset) || ANALOG_PRESETS[2];

  function buildVoice(pitch, vel, when) {
    const preset = presetFor();
    const freq = midiToFreq(pitch);
    const attack = (p.attackMs ?? preset.attackMs ?? 20) / 1000;
    const baseCutoff = p.cutoff ?? preset.cutoff ?? 8000;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = preset.resonance !== undefined ? preset.resonance : 0.7;
    if (preset.filterEnvelope) {
      const { startMult, endMult, timeMs } = preset.filterEnvelope;
      filter.frequency.setValueAtTime(clamp(baseCutoff * startMult, 40, 18000), when);
      filter.frequency.exponentialRampToValueAtTime(
        clamp(baseCutoff * endMult, 40, 18000), when + timeMs / 1000,
      );
    } else {
      filter.frequency.setValueAtTime(clamp(baseCutoff, 40, 18000), when);
    }

    const gain = ctx.createGain();
    const peak = Math.max(0.0001, (vel / 127) * 0.9);
    gain.gain.setValueAtTime(0, when);
    gain.gain.linearRampToValueAtTime(peak, when + Math.max(0.001, attack));

    const oscs = [];
    const main = ctx.createOscillator();
    main.type = preset.wave;
    main.frequency.setValueAtTime(freq, when);
    main.connect(filter);
    main.start(when);
    oscs.push(main);

    (preset.layers || []).forEach((layer) => {
      const osc = ctx.createOscillator();
      osc.type = layer.wave || preset.wave;
      if (layer.ratio !== undefined) osc.frequency.setValueAtTime(freq * layer.ratio, when);
      else if (layer.semitones !== undefined) osc.frequency.setValueAtTime(freq * Math.pow(2, layer.semitones / 12), when);
      else {
        osc.frequency.setValueAtTime(freq, when);
        if (layer.cents !== undefined) osc.detune.setValueAtTime(layer.cents, when);
      }
      const lg = ctx.createGain();
      lg.gain.value = layer.gain !== undefined ? layer.gain : 1;
      osc.connect(lg); lg.connect(filter);
      osc.start(when);
      oscs.push(osc);
    });

    filter.connect(gain);
    gain.connect(output);

    let lfo = null;
    if (preset.lfo) {
      lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.setValueAtTime(preset.lfo.rate, when);
      const depth = ctx.createGain();
      depth.gain.value = preset.lfo.depth;
      lfo.connect(depth); depth.connect(filter.frequency);
      lfo.start(when);
    }

    return { pitch, gain, oscs, lfo, release: (preset.releaseMs ?? 250) / 1000 };
  }

  function endVoice(voice, when) {
    const rel = p.releaseMs !== null ? p.releaseMs / 1000 : voice.release;
    const end = when + Math.max(0.005, rel);
    try {
      voice.gain.gain.cancelScheduledValues(when);
      // Hold whatever the envelope had reached, then ramp down from there.
      voice.gain.gain.setValueAtTime(voice.gain.gain.value, when);
      voice.gain.gain.linearRampToValueAtTime(0.0001, end);
    } catch { /* voice already torn down */ }
    voice.oscs.forEach((o) => { try { o.stop(end + 0.02); } catch {} });
    if (voice.lfo) { try { voice.lfo.stop(end + 0.02); } catch {} }
  }

  const api = {
    type: 'analog', output, params: p,
    noteOn(pitch, vel, when) {
      if (voices.has(pitch)) api.noteOff(pitch, when);
      if (order.length >= MAX_VOICES) {
        const oldest = order.shift();
        const v = voices.get(oldest);
        if (v) { endVoice(v, when); voices.delete(oldest); }
      }
      const voice = buildVoice(pitch, vel, when);
      voices.set(pitch, voice);
      order.push(pitch);
      return voice;
    },
    noteOff(pitch, when) {
      const voice = voices.get(pitch);
      if (!voice) return;
      endVoice(voice, when);
      voices.delete(pitch);
      const i = order.indexOf(pitch);
      if (i >= 0) order.splice(i, 1);
    },
    playNote(pitch, vel, when, durSec) {
      api.noteOn(pitch, vel, when);
      api.noteOff(pitch, when + Math.max(0.01, durSec));
    },
    allNotesOff(when) { [...voices.keys()].forEach((k) => api.noteOff(k, when)); },
    setParam(name, value) {
      p[name] = value;
      if (name === 'level') output.gain.setTargetAtTime(value, ctx.currentTime, 0.02);
    },
    voiceCount: () => voices.size,
    dispose() { try { output.disconnect(); } catch {} },
  };
  return api;
}

// ---------------------------------------------------------------
// FM — 2-operator frequency modulation.
// The one instrument written from scratch: a modulator oscillator feeding
// the carrier's frequency through a gain that scales with the carrier pitch,
// so the timbre stays consistent across the keyboard instead of turning to
// mud in the bass.
// ---------------------------------------------------------------
function createFM(ctx, params = {}) {
  const p = {
    ratio: 2, index: 300, attackMs: 8, decayMs: 400, releaseMs: 220,
    modDecayMs: 260, level: 0.7, ...params,
  };
  const output = ctx.createGain();
  output.gain.value = p.level;
  const voices = new Map();
  const order = [];

  function endVoice(v, when) {
    const end = when + Math.max(0.005, p.releaseMs / 1000);
    try {
      v.gain.gain.cancelScheduledValues(when);
      v.gain.gain.setValueAtTime(v.gain.gain.value, when);
      v.gain.gain.linearRampToValueAtTime(0.0001, end);
    } catch {}
    try { v.carrier.stop(end + 0.02); v.mod.stop(end + 0.02); } catch {}
  }

  const api = {
    type: 'fm', output, params: p,
    noteOn(pitch, vel, when) {
      if (voices.has(pitch)) api.noteOff(pitch, when);
      if (order.length >= MAX_VOICES) {
        const o = order.shift(); const v = voices.get(o);
        if (v) { endVoice(v, when); voices.delete(o); }
      }
      const freq = midiToFreq(pitch);
      const carrier = ctx.createOscillator();
      carrier.type = 'sine';
      carrier.frequency.setValueAtTime(freq, when);

      const mod = ctx.createOscillator();
      mod.type = 'sine';
      mod.frequency.setValueAtTime(freq * p.ratio, when);

      // Index scales with pitch so high notes don't lose their character.
      const modDepth = ctx.createGain();
      const peakIndex = (p.index / 440) * freq;
      modDepth.gain.setValueAtTime(peakIndex, when);
      modDepth.gain.exponentialRampToValueAtTime(
        Math.max(1, peakIndex * 0.05), when + Math.max(0.01, p.modDecayMs / 1000),
      );
      mod.connect(modDepth);
      modDepth.connect(carrier.frequency);

      const gain = ctx.createGain();
      const peak = Math.max(0.0001, (vel / 127) * 0.8);
      gain.gain.setValueAtTime(0, when);
      gain.gain.linearRampToValueAtTime(peak, when + Math.max(0.001, p.attackMs / 1000));
      gain.gain.exponentialRampToValueAtTime(
        Math.max(0.0001, peak * 0.35), when + Math.max(0.02, p.decayMs / 1000),
      );

      carrier.connect(gain); gain.connect(output);
      carrier.start(when); mod.start(when);

      const v = { carrier, mod, gain };
      voices.set(pitch, v); order.push(pitch);
      return v;
    },
    noteOff(pitch, when) {
      const v = voices.get(pitch); if (!v) return;
      endVoice(v, when); voices.delete(pitch);
      const i = order.indexOf(pitch); if (i >= 0) order.splice(i, 1);
    },
    playNote(pitch, vel, when, durSec) {
      api.noteOn(pitch, vel, when); api.noteOff(pitch, when + Math.max(0.01, durSec));
    },
    allNotesOff(when) { [...voices.keys()].forEach((k) => api.noteOff(k, when)); },
    setParam(name, value) {
      p[name] = value;
      if (name === 'level') output.gain.setTargetAtTime(value, ctx.currentTime, 0.02);
    },
    voiceCount: () => voices.size,
    dispose() { try { output.disconnect(); } catch {} },
  };
  return api;
}

// ---------------------------------------------------------------
// Pluck — Karplus-Strong.
// Ported from the Air Guitar. The whole string is rendered up front into an
// AudioBuffer rather than built as a DelayNode feedback ring: browsers clamp
// any cycle in the graph to at least one render quantum (~128 samples),
// which most notes here are shorter than, and an in-loop filter can go
// unstable. Rendering avoids both, and costs nothing at these lengths.
// ---------------------------------------------------------------
function createPluck(ctx, params = {}) {
  const p = { decay: 0.996, brightness: 0.5, level: 0.8, ...params };
  const output = ctx.createGain();
  output.gain.value = p.level;
  const active = new Map();
  let seed = 1;

  function renderPluckBuffer(freq) {
    const sr = ctx.sampleRate;
    const period = Math.max(2, Math.round(sr / freq));
    const decay = clamp(p.decay, 0.9, 0.9999);
    const brightMix = 0.1 + 0.75 * clamp(p.brightness, 0, 1);

    const periodsTo60dB = Math.log(0.001) / Math.log(decay);
    const durationSec = clamp(periodsTo60dB / freq, 0.2, 6);
    const total = Math.floor(sr * durationSec);

    // Seeded per note, advancing deterministically, so a re-render of the
    // same project produces the identical waveform.
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const rng = makeRng(seed);

    const ring = new Float32Array(period);
    for (let i = 0; i < period; i++) ring[i] = (rng() * 2 - 1) * (1 - i / period);

    const buffer = ctx.createBuffer(1, total, sr);
    const out = buffer.getChannelData(0);
    let prev = ring[period - 1];
    for (let i = 0; i < total; i++) {
      const idx = i % period;
      const cur = ring[idx];
      out[i] = cur;
      ring[idx] = (brightMix * cur + (1 - brightMix) * ((cur + prev) * 0.5)) * decay;
      prev = cur;
    }
    return buffer;
  }

  const api = {
    type: 'pluck', output, params: p,
    noteOn(pitch, vel, when) {
      const src = ctx.createBufferSource();
      src.buffer = renderPluckBuffer(midiToFreq(pitch));
      const g = ctx.createGain();
      g.gain.setValueAtTime(Math.max(0.0001, (vel / 127) * 0.9), when);
      src.connect(g); g.connect(output);
      src.start(when);
      const v = { src, gain: g };
      active.set(pitch, v);
      return v;
    },
    noteOff(pitch, when) {
      const v = active.get(pitch); if (!v) return;
      // A plucked string decays on its own; note-off just damps it.
      try {
        v.gain.gain.cancelScheduledValues(when);
        v.gain.gain.setValueAtTime(v.gain.gain.value, when);
        v.gain.gain.linearRampToValueAtTime(0.0001, when + 0.25);
        v.src.stop(when + 0.3);
      } catch {}
      active.delete(pitch);
    },
    playNote(pitch, vel, when, durSec) {
      api.noteOn(pitch, vel, when);
      api.noteOff(pitch, when + Math.max(0.02, durSec));
    },
    allNotesOff(when) { [...active.keys()].forEach((k) => api.noteOff(k, when)); },
    setParam(name, value) {
      p[name] = value;
      if (name === 'level') output.gain.setTargetAtTime(value, ctx.currentTime, 0.02);
    },
    voiceCount: () => active.size,
    dispose() { try { output.disconnect(); } catch {} },
  };
  return api;
}

// ---------------------------------------------------------------
// DrumKit — 8 synthesized voices, ported from the Trap Machine.
// Every voice is scheduled against an explicit `when` and routed to the
// instrument's own output rather than straight to a master node, so a kit
// can sit on any mixer insert like anything else.
// ---------------------------------------------------------------
export const DRUM_VOICES = [
  { id: 'kick', name: 'Kick', pitch: 36 },
  { id: 'snare', name: 'Snare', pitch: 38 },
  { id: 'clap', name: 'Clap', pitch: 39 },
  { id: 'chat', name: 'Closed Hat', pitch: 42 },
  { id: 'ohat', name: 'Open Hat', pitch: 46 },
  { id: 'ride', name: 'Ride', pitch: 51 },
  { id: 'perc', name: 'Perc', pitch: 48 },
  { id: '808', name: '808', pitch: 24 },
];
/** The Trap kit's constants, exactly as they were when they were ported from
 *  the Trap Machine. This doubles as the base every other kit is merged onto,
 *  so a kit only has to state what it changes — and so Trap itself is
 *  literally the same numbers it always was. That matters: Trap is the demo
 *  song's kit and the fixture in several engine tests, and "tidying" its
 *  values while refactoring would silently alter every existing project. */
const KIT_BASE = {
  kick: {
    punchStart: 185, punchEnd: 58, punchDrop: 0.05, punchGain: 0.68, punchDecay: 0.1, sat: 9,
    subStart: 62, subEnd: 40, subDrop: 0.3, subGain: 0.64, subAttack: 0.008, subDecay: 0.4,
    clickFreq: 1400, clickQ: 1, clickGain: 0.19, clickDecay: 0.01,
  },
  snare: {
    bodyWave: 'triangle', bodyStart: 200, bodyEnd: 120, bodyDrop: 0.08, bodyGain: 0.7, bodyDecay: 0.1,
    snapFreq: 2800, snapQ: 1.4, snapGain: 0.9, snapDecay: 0.06,
    tailHp: 1500, tailGain: 0.35, tailDecay: 0.22,
  },
  clap: {
    offsets: [0, 0.012, 0.024, 0.036], freq: 1200, q: 4, gain: 0.85, decay: 0.02,
    tailOffset: 0.04, tailFreq: 1100, tailQ: 2, tailGain: 0.6, tailDecay: 0.18,
  },
  chat: { hp: 7500, gain: 0.5, decay: 0.045 },
  ohat: { hp: 7000, gain: 0.45, decay: 0.32 },
  ride: { hp: 2500, partials: [3000, 4200, 5400, 6800], partialGain: 0.22, gain: 0.32, decay: 1.1 },
  perc: {
    start: 520, end: 280, drop: 0.05, gain: 0.5, decay: 0.06,
    noiseFreq: 1000, noiseQ: 3, noiseGain: 0.3, noiseDecay: 0.04,
  },
  b808: { mul: 1.85, drop: 0.06, gain: 0.9, decay: 0.55, sat: 8, fallback: 70 },
};

/** Shallow-merge one level deep — every kit override is `{ voice: { field } }`,
 *  so this is all the merging that is needed and it keeps the table readable. */
function mergeKit(base, over) {
  const out = {};
  Object.keys(base).forEach((voice) => { out[voice] = { ...base[voice], ...(over[voice] || {}) }; });
  return out;
}

export const DRUM_KITS = [
  {
    id: 'trap', name: 'Trap',
    blurb: 'The original Slippy kit — driven sub kick, tight crack, rolling hats.',
    spec: mergeKit(KIT_BASE, {}),
  },
  {
    id: '808', name: '808',
    blurb: 'Long booming kick and a short dry snare, in the style of a TR-808.',
    spec: mergeKit(KIT_BASE, {
      kick: { punchStart: 120, punchEnd: 45, punchDrop: 0.04, punchGain: 0.5, punchDecay: 0.06, sat: 3,
        subStart: 55, subEnd: 38, subDrop: 0.5, subGain: 0.75, subDecay: 0.9, clickGain: 0.1 },
      snare: { bodyStart: 180, bodyEnd: 150, bodyDrop: 0.05, bodyDecay: 0.08,
        snapFreq: 2000, snapQ: 1.8, snapGain: 0.7, snapDecay: 0.09,
        tailHp: 1200, tailGain: 0.28, tailDecay: 0.12 },
      chat: { hp: 8200, gain: 0.42, decay: 0.03 },
      ohat: { hp: 8000, decay: 0.4 },
      perc: { start: 440, end: 380, gain: 0.42, decay: 0.12, noiseGain: 0.12 },
      b808: { sat: 6, decay: 0.8, mul: 1.6 },
    }),
  },
  {
    id: '909', name: '909',
    blurb: 'Punchy clicky kick, noisy snare, bright hats — the house and techno kit.',
    spec: mergeKit(KIT_BASE, {
      kick: { punchStart: 220, punchEnd: 52, punchGain: 0.74, punchDecay: 0.09, sat: 12,
        subStart: 68, subEnd: 44, subDecay: 0.28,
        clickFreq: 2200, clickQ: 1.4, clickGain: 0.3, clickDecay: 0.008 },
      snare: { bodyStart: 240, bodyEnd: 170, bodyDecay: 0.08,
        snapFreq: 3400, snapQ: 1, snapGain: 0.95, snapDecay: 0.05,
        tailHp: 2000, tailGain: 0.42, tailDecay: 0.18 },
      chat: { hp: 9000, gain: 0.52, decay: 0.035 },
      ohat: { hp: 8600, decay: 0.28 },
      ride: { partials: [3600, 5200, 6900, 8400], decay: 1.2 },
      perc: { start: 620, end: 300, decay: 0.05 },
    }),
  },
  {
    id: '606', name: '606',
    blurb: 'Thin and tinny, almost no low end. Great for lo-fi and electro.',
    spec: mergeKit(KIT_BASE, {
      kick: { punchStart: 150, punchEnd: 60, punchGain: 0.6, punchDecay: 0.05, sat: 5,
        subGain: 0.35, subDecay: 0.18, clickGain: 0.14 },
      snare: { bodyStart: 300, bodyEnd: 210, bodyGain: 0.55, bodyDecay: 0.06,
        snapFreq: 3800, snapQ: 1.2, snapDecay: 0.04,
        tailHp: 3000, tailGain: 0.3, tailDecay: 0.1 },
      chat: { hp: 10000, gain: 0.44, decay: 0.025 },
      ohat: { hp: 9500, decay: 0.2 },
      ride: { partials: [4000, 5600, 7200, 9000], gain: 0.24, decay: 0.7 },
      perc: { start: 800, end: 420, decay: 0.04 },
      b808: { decay: 0.3, sat: 4 },
    }),
  },
  {
    id: 'acoustic', name: 'Acoustic',
    blurb: 'Softer saturation, longer skins and a woody ride — closer to a real kit.',
    spec: mergeKit(KIT_BASE, {
      kick: { punchStart: 140, punchEnd: 55, punchDrop: 0.06, punchGain: 0.6, punchDecay: 0.12, sat: 2,
        subStart: 70, subEnd: 48, subDecay: 0.3,
        clickFreq: 3000, clickQ: 0.8, clickGain: 0.25, clickDecay: 0.012 },
      snare: { bodyStart: 220, bodyEnd: 160, bodyDrop: 0.1, bodyGain: 0.62, bodyDecay: 0.12,
        snapFreq: 2400, snapQ: 0.9, snapGain: 0.8, snapDecay: 0.09,
        tailHp: 1100, tailGain: 0.5, tailDecay: 0.3 },
      chat: { hp: 6800, gain: 0.46, decay: 0.06 },
      ohat: { hp: 6200, decay: 0.45 },
      ride: { hp: 2000, partials: [2400, 3300, 4600, 5900], partialGain: 0.18, decay: 1.6 },
      perc: { start: 420, end: 240, decay: 0.09, noiseFreq: 800, noiseDecay: 0.06 },
      b808: { sat: 3, decay: 0.4 },
    }),
  },
  {
    id: 'lofi', name: 'Lo-Fi',
    blurb: 'Dark and dusty — rolled-off hats, soft transients, tape-ish weight.',
    spec: mergeKit(KIT_BASE, {
      kick: { punchStart: 160, punchEnd: 52, punchGain: 0.58, sat: 4,
        subDecay: 0.35, clickGain: 0.06 },
      snare: { bodyStart: 190, bodyEnd: 130, bodyGain: 0.6,
        snapFreq: 1800, snapQ: 2.2, snapGain: 0.62, snapDecay: 0.05,
        tailHp: 900, tailGain: 0.22, tailDecay: 0.16 },
      chat: { hp: 5200, gain: 0.34, decay: 0.035 },
      ohat: { hp: 4800, gain: 0.34, decay: 0.22 },
      ride: { hp: 1800, partials: [2200, 3000, 3900, 4800], partialGain: 0.16, gain: 0.24, decay: 0.8 },
      perc: { start: 380, end: 220, gain: 0.4, noiseFreq: 700, noiseGain: 0.2 },
      b808: { sat: 5, decay: 0.6 },
    }),
  },
  {
    id: 'techno', name: 'Techno',
    blurb: 'Hard saturated kick, clipped hats, relentless.',
    spec: mergeKit(KIT_BASE, {
      kick: { punchStart: 200, punchEnd: 48, punchGain: 0.78, punchDecay: 0.08, sat: 16,
        subStart: 58, subEnd: 36, subGain: 0.8, subDecay: 0.5 },
      snare: { bodyStart: 200, bodyEnd: 140, bodyGain: 0.58,
        snapFreq: 3000, snapQ: 1.6, snapDecay: 0.055,
        tailHp: 2400, tailGain: 0.3, tailDecay: 0.14 },
      chat: { hp: 9500, gain: 0.55, decay: 0.028 },
      ohat: { hp: 9000, decay: 0.24 },
      ride: { partials: [3400, 4800, 6200, 7800], decay: 0.9 },
      perc: { start: 700, end: 340, decay: 0.05, noiseFreq: 1400 },
      b808: { sat: 12, decay: 0.45 },
    }),
  },
  {
    id: 'breakbeat', name: 'Breakbeat',
    blurb: 'Bright snappy snare and short hats, cut for jungle and drum & bass.',
    spec: mergeKit(KIT_BASE, {
      kick: { punchStart: 170, punchEnd: 62, punchDecay: 0.07, sat: 7, subDecay: 0.22, clickGain: 0.22 },
      snare: { bodyStart: 260, bodyEnd: 180, bodyGain: 0.66, bodyDecay: 0.09,
        snapFreq: 3200, snapQ: 1.1, snapGain: 0.92, snapDecay: 0.075,
        tailHp: 1600, tailGain: 0.45, tailDecay: 0.26 },
      chat: { hp: 7800, gain: 0.48, decay: 0.038 },
      ohat: { hp: 7200, decay: 0.26 },
      ride: { partials: [3200, 4400, 5800, 7200], decay: 1.3 },
      perc: { start: 560, end: 300, decay: 0.05 },
    }),
  },
];

const KIT_BY_ID = new Map(DRUM_KITS.map((k) => [k.id, k]));

function createDrumKit(ctx, params = {}) {
  const p = {
    level: 0.9, tune: 0, kit: 'trap',
    // Resolved AudioBuffers keyed by voice id, e.g. { kick: AudioBuffer }.
    // The project stores asset ids; buildGraph resolves them, because the
    // instrument has no business knowing about IndexedDB.
    sampleBuffers: null,
    ...params,
  };
  const output = ctx.createGain();
  output.gain.value = p.level;
  const noise = createNoiseBuffer(ctx, 2, 20250814);
  let openHatVoice = null;
  const satCurves = new Map();

  const kitSpec = () => (KIT_BY_ID.get(p.kit) || KIT_BY_ID.get('trap')).spec;

  function noiseSource() {
    const s = ctx.createBufferSource();
    s.buffer = noise; s.loop = true;
    return s;
  }
  /** Saturation curves are cached per amount now that kits use different
   *  drive settings — the old single-slot cache would have handed the kick's
   *  curve to the 808 and vice versa. */
  function satCurveFor(amount) {
    if (satCurves.has(amount)) return satCurves.get(amount);
    // Note the (n - 1) divisor. With the more obvious `(i * 2) / n - 1` the
    // curve never contains a sample at exactly x = 0 — it straddles zero
    // asymmetrically, so a WaveShaper fed *silence* interpolates to a
    // constant -0.035 DC offset and emits it forever. Each scheduled kick
    // builds its own shaper, so eight kicks in a bar meant eight DC sources
    // stacking into a permanent -0.28 bed under the whole song. It reads as
    // a mystery hum, eats headroom, and thumps whenever a voice is created.
    const n = 257; const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / (n - 1) - 1;
      curve[i] = Math.tanh(amount * x) / Math.tanh(amount);
    }
    satCurves.set(amount, curve);
    return curve;
  }
  function chokeHats(time) {
    if (!openHatVoice) return;
    try {
      openHatVoice.gain.cancelScheduledValues(time);
      openHatVoice.gain.setValueAtTime(openHatVoice.gain.value, time);
      openHatVoice.gain.exponentialRampToValueAtTime(0.001, time + 0.03);
    } catch {}
    openHatVoice = null;
  }

  /** A slot with a user sample loaded plays that instead of synthesizing.
   *  Pitch, when given, is relative to the slot's own default note, so an
   *  808 sample follows a bassline the same way the synthesized one does. */
  const ROOT_OF = new Map(DRUM_VOICES.map((v) => [v.id, v.pitch]));
  function sampleFor(voiceId) {
    return (p.sampleBuffers && p.sampleBuffers[voiceId]) || null;
  }
  function playSample(buf, voiceId, time, amp, pitch) {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    if (pitch !== undefined && pitch !== null) {
      const root = ROOT_OF.get(voiceId) ?? 60;
      src.playbackRate.value = Math.pow(2, (pitch - root) / 12);
    }
    const g = ctx.createGain();
    g.gain.setValueAtTime(Math.max(0.0001, amp), time);
    src.connect(g); g.connect(output);
    src.start(time);
  }

  const V = {
    kick(time, amp) {
      const K = kitSpec().kick;
      const punch = ctx.createOscillator();
      punch.type = 'sine';
      punch.frequency.setValueAtTime(K.punchStart, time);
      punch.frequency.exponentialRampToValueAtTime(K.punchEnd, time + K.punchDrop);
      const shaper = ctx.createWaveShaper();
      shaper.curve = satCurveFor(K.sat); shaper.oversample = '2x';
      const pg = ctx.createGain();
      pg.gain.setValueAtTime(K.punchGain * amp, time);
      pg.gain.exponentialRampToValueAtTime(0.001, time + K.punchDecay);
      punch.connect(shaper); shaper.connect(pg); pg.connect(output);
      punch.start(time); punch.stop(time + K.punchDecay + 0.02);

      const sub = ctx.createOscillator();
      sub.type = 'sine';
      sub.frequency.setValueAtTime(K.subStart, time);
      sub.frequency.exponentialRampToValueAtTime(K.subEnd, time + K.subDrop);
      const sg = ctx.createGain();
      sg.gain.setValueAtTime(0.001, time);
      sg.gain.linearRampToValueAtTime(K.subGain * amp, time + K.subAttack);
      sg.gain.exponentialRampToValueAtTime(0.001, time + K.subDecay);
      sub.connect(sg); sg.connect(output);
      sub.start(time); sub.stop(time + K.subDecay + 0.02);

      const click = noiseSource();
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = K.clickFreq; bp.Q.value = K.clickQ;
      const cg = ctx.createGain();
      cg.gain.setValueAtTime(K.clickGain * amp, time);
      cg.gain.exponentialRampToValueAtTime(0.001, time + K.clickDecay);
      click.connect(bp); bp.connect(cg); cg.connect(output);
      click.start(time); click.stop(time + K.clickDecay + 0.01);
    },
    snare(time, amp) {
      const K = kitSpec().snare;
      const body = ctx.createOscillator();
      body.type = K.bodyWave;
      body.frequency.setValueAtTime(K.bodyStart, time);
      body.frequency.exponentialRampToValueAtTime(K.bodyEnd, time + K.bodyDrop);
      const bg = ctx.createGain();
      bg.gain.setValueAtTime(K.bodyGain * amp, time);
      bg.gain.exponentialRampToValueAtTime(0.001, time + K.bodyDecay);
      body.connect(bg); bg.connect(output);
      body.start(time); body.stop(time + K.bodyDecay + 0.02);

      const snap = noiseSource();
      const sbp = ctx.createBiquadFilter();
      sbp.type = 'bandpass'; sbp.frequency.value = K.snapFreq; sbp.Q.value = K.snapQ;
      const sg = ctx.createGain();
      sg.gain.setValueAtTime(K.snapGain * amp, time);
      sg.gain.exponentialRampToValueAtTime(0.001, time + K.snapDecay);
      snap.connect(sbp); sbp.connect(sg); sg.connect(output);
      snap.start(time); snap.stop(time + K.snapDecay + 0.02);

      const tail = noiseSource();
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass'; hp.frequency.value = K.tailHp;
      const tg = ctx.createGain();
      tg.gain.setValueAtTime(K.tailGain * amp, time);
      tg.gain.exponentialRampToValueAtTime(0.001, time + K.tailDecay);
      tail.connect(hp); hp.connect(tg); tg.connect(output);
      tail.start(time); tail.stop(time + K.tailDecay + 0.02);
    },
    clap(time, amp) {
      const K = kitSpec().clap;
      K.offsets.forEach((off) => {
        const t = time + off;
        const n = noiseSource();
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass'; bp.frequency.value = K.freq; bp.Q.value = K.q;
        const g = ctx.createGain();
        g.gain.setValueAtTime(K.gain * amp, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + K.decay);
        n.connect(bp); bp.connect(g); g.connect(output);
        n.start(t); n.stop(t + K.decay + 0.01);
      });
      const tt = time + K.tailOffset;
      const tn = noiseSource();
      const bp2 = ctx.createBiquadFilter();
      bp2.type = 'bandpass'; bp2.frequency.value = K.tailFreq; bp2.Q.value = K.tailQ;
      const tg = ctx.createGain();
      tg.gain.setValueAtTime(K.tailGain * amp, tt);
      tg.gain.exponentialRampToValueAtTime(0.001, tt + K.tailDecay);
      tn.connect(bp2); bp2.connect(tg); tg.connect(output);
      tn.start(tt); tn.stop(tt + K.tailDecay + 0.02);
    },
    chat(time, amp) {
      const K = kitSpec().chat;
      chokeHats(time);
      const n = noiseSource();
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass'; hp.frequency.value = K.hp;
      const g = ctx.createGain();
      g.gain.setValueAtTime(K.gain * amp, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + K.decay);
      n.connect(hp); hp.connect(g); g.connect(output);
      n.start(time); n.stop(time + K.decay + 0.015);
    },
    ohat(time, amp) {
      const K = kitSpec().ohat;
      chokeHats(time);
      const n = noiseSource();
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass'; hp.frequency.value = K.hp;
      const g = ctx.createGain();
      g.gain.setValueAtTime(K.gain * amp, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + K.decay);
      n.connect(hp); hp.connect(g); g.connect(output);
      n.start(time); n.stop(time + K.decay + 0.02);
      openHatVoice = { gain: g.gain };
    },
    ride(time, amp) {
      const K = kitSpec().ride;
      const bus = ctx.createGain();
      bus.gain.setValueAtTime(0.001, time);
      bus.gain.linearRampToValueAtTime(K.gain * amp, time + 0.005);
      bus.gain.exponentialRampToValueAtTime(0.001, time + K.decay);
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass'; hp.frequency.value = K.hp;
      hp.connect(bus); bus.connect(output);
      K.partials.forEach((f) => {
        const osc = ctx.createOscillator();
        osc.type = 'square'; osc.frequency.value = f;
        const og = ctx.createGain(); og.gain.value = K.partialGain;
        osc.connect(og); og.connect(hp);
        osc.start(time); osc.stop(time + K.decay + 0.05);
      });
      const n = noiseSource();
      n.connect(hp);
      n.start(time); n.stop(time + K.decay + 0.05);
    },
    perc(time, amp) {
      const K = kitSpec().perc;
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(K.start, time);
      osc.frequency.exponentialRampToValueAtTime(K.end, time + K.drop);
      const og = ctx.createGain();
      og.gain.setValueAtTime(K.gain * amp, time);
      og.gain.exponentialRampToValueAtTime(0.001, time + K.decay);
      osc.connect(og); og.connect(output);
      osc.start(time); osc.stop(time + K.decay + 0.02);

      const n = noiseSource();
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = K.noiseFreq; bp.Q.value = K.noiseQ;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(K.noiseGain * amp, time);
      ng.gain.exponentialRampToValueAtTime(0.001, time + K.noiseDecay);
      n.connect(bp); bp.connect(ng); ng.connect(output);
      n.start(time); n.stop(time + K.noiseDecay + 0.01);
    },
    // The 808 is a bass instrument, not a fixed drum hit: it follows pitch,
    // so you can write a bassline with it the way trap producers actually do.
    '808': (time, amp, pitch) => {
      const K = kitSpec().b808;
      const base = pitch !== undefined && pitch !== null ? midiToFreq(pitch) : K.fallback;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(base * K.mul, time);
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, base), time + K.drop);
      const shaper = ctx.createWaveShaper();
      shaper.curve = satCurveFor(K.sat); shaper.oversample = '2x';
      const g = ctx.createGain();
      g.gain.setValueAtTime(K.gain * amp, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + K.decay);
      osc.connect(shaper); shaper.connect(g); g.connect(output);
      osc.start(time); osc.stop(time + K.decay + 0.03);
    },
  };

  // Pitch -> voice, so a drum kit can be played from a piano roll or a pad
  // grid interchangeably. Anything outside the map falls back to the 808 so
  // a stray note is audible rather than silently dropped.
  const byPitch = new Map(DRUM_VOICES.map((v) => [v.pitch, v.id]));

  const api = {
    type: 'drumkit', output, params: p, voices: DRUM_VOICES,
    trigger(voiceId, when, vel = 100, pitch) {
      const amp = clamp(vel / 100, 0, 1.6);
      const buf = sampleFor(voiceId);
      if (buf) { playSample(buf, voiceId, when, amp, pitch); return; }
      const fn = V[voiceId];
      if (fn) fn(when, amp, pitch);
    },
    noteOn(pitch, vel, when) {
      const id = byPitch.get(pitch);
      if (id) api.trigger(id, when, vel);
      else api.trigger('808', when, vel, pitch);
      return null;
    },
    noteOff() { /* one-shots: nothing to release */ },
    playNote(pitch, vel, when) { api.noteOn(pitch, vel, when); },
    allNotesOff() {},
    setParam(name, value) {
      p[name] = value;
      if (name === 'level') output.gain.setTargetAtTime(value, ctx.currentTime, 0.02);
    },
    voiceCount: () => 0,
    dispose() { try { output.disconnect(); } catch {} },
  };
  return api;
}

// ---------------------------------------------------------------
// Sampler — plays an AudioBuffer, pitched by playbackRate.
// The buffer is handed in by the caller (imported file or a recording),
// because decoding is the host's job, not the instrument's.
// ---------------------------------------------------------------
function createSampler(ctx, params = {}) {
  const p = {
    buffer: null, rootPitch: 60, attackMs: 2, releaseMs: 120,
    start: 0, loop: false, level: 0.9, ...params,
  };
  const output = ctx.createGain();
  output.gain.value = p.level;
  const active = new Map();

  const api = {
    type: 'sampler', output, params: p,
    noteOn(pitch, vel, when) {
      if (!p.buffer) return null;
      const src = ctx.createBufferSource();
      src.buffer = p.buffer;
      src.playbackRate.value = Math.pow(2, (pitch - p.rootPitch) / 12);
      src.loop = !!p.loop;
      const g = ctx.createGain();
      const peak = Math.max(0.0001, (vel / 127) * 0.95);
      g.gain.setValueAtTime(0, when);
      g.gain.linearRampToValueAtTime(peak, when + Math.max(0.001, p.attackMs / 1000));
      src.connect(g); g.connect(output);
      src.start(when, clamp(p.start, 0, Math.max(0, p.buffer.duration - 0.01)));
      const v = { src, gain: g };
      active.set(pitch, v);
      return v;
    },
    noteOff(pitch, when) {
      const v = active.get(pitch); if (!v) return;
      const end = when + Math.max(0.005, p.releaseMs / 1000);
      try {
        v.gain.gain.cancelScheduledValues(when);
        v.gain.gain.setValueAtTime(v.gain.gain.value, when);
        v.gain.gain.linearRampToValueAtTime(0.0001, end);
        v.src.stop(end + 0.02);
      } catch {}
      active.delete(pitch);
    },
    playNote(pitch, vel, when, durSec) {
      api.noteOn(pitch, vel, when);
      api.noteOff(pitch, when + Math.max(0.02, durSec));
    },
    allNotesOff(when) { [...active.keys()].forEach((k) => api.noteOff(k, when)); },
    setParam(name, value) {
      p[name] = value;
      if (name === 'level') output.gain.setTargetAtTime(value, ctx.currentTime, 0.02);
    },
    voiceCount: () => active.size,
    dispose() { try { output.disconnect(); } catch {} },
  };
  return api;
}

// ---------------------------------------------------------------

export const INSTRUMENT_TYPES = [
  { type: 'analog', name: 'Analog', icon: '🎹', blurb: 'Subtractive synth with 12 presets — saws, pads, plucks, bells.' },
  { type: 'fm', name: 'FM', icon: '🔔', blurb: 'Two-operator FM. Metallic, bell and electric-piano tones.' },
  { type: 'pluck', name: 'Pluck', icon: '🎸', blurb: 'Karplus-Strong plucked string. Guitars, harps, kotos.' },
  { type: 'drumkit', name: 'Drum Kit', icon: '🥁', blurb: '8 synthesized drum voices with a pitched 808.' },
  { type: 'sampler', name: 'Sampler', icon: '📻', blurb: 'Plays your own audio, pitched across the keyboard.' },
];

export function createInstrument(ctx, type, params = {}) {
  switch (type) {
    case 'analog': return createAnalog(ctx, params);
    case 'fm': return createFM(ctx, params);
    case 'pluck': return createPluck(ctx, params);
    case 'drumkit': return createDrumKit(ctx, params);
    case 'sampler': return createSampler(ctx, params);
    default: return createAnalog(ctx, params);
  }
}

/** The factory defaults, mirrored as data.
 *
 *  Without this the plugin window had no way to know what an *unset*
 *  parameter actually is, so it fell back to the slider minimum: a fresh
 *  drum kit showed "Level 0.00" while really playing at 0.9, and the Kit
 *  dropdown rendered blank because the channel had no explicit kit. Every
 *  value here must match the corresponding factory's `const p = {...}`. */
export const INSTRUMENT_DEFAULTS = {
  analog: { preset: 'sawtooth', cutoff: null, attackMs: null, releaseMs: null, glideMs: 0, level: 0.8 },
  fm: { ratio: 2, index: 300, attackMs: 8, decayMs: 400, releaseMs: 220, modDecayMs: 260, level: 0.7 },
  pluck: { decay: 0.996, brightness: 0.5, level: 0.8 },
  drumkit: { kit: 'trap', level: 0.9, tune: 0 },
  sampler: { rootPitch: 60, start: 0, attackMs: 2, releaseMs: 120, loop: false, level: 0.9 },
};

/** Parameter descriptors drive the generic plugin window — adding a knob is
 *  a data change, not a UI change. */
export const INSTRUMENT_PARAMS = {
  analog: [
    { name: 'preset', label: 'Preset', type: 'enum', options: ANALOG_PRESETS.map((x) => ({ value: x.id, label: x.name })) },
    { name: 'cutoff', label: 'Cutoff', type: 'range', min: 80, max: 14000, step: 10, unit: 'Hz' },
    { name: 'attackMs', label: 'Attack', type: 'range', min: 0, max: 1500, step: 1, unit: 'ms' },
    { name: 'releaseMs', label: 'Release', type: 'range', min: 10, max: 3000, step: 10, unit: 'ms' },
    { name: 'level', label: 'Level', type: 'range', min: 0, max: 1.4, step: 0.01 },
  ],
  fm: [
    { name: 'ratio', label: 'Ratio', type: 'range', min: 0.25, max: 12, step: 0.25 },
    { name: 'index', label: 'Index', type: 'range', min: 0, max: 2000, step: 10 },
    { name: 'modDecayMs', label: 'Mod Decay', type: 'range', min: 10, max: 2000, step: 10, unit: 'ms' },
    { name: 'decayMs', label: 'Decay', type: 'range', min: 20, max: 3000, step: 10, unit: 'ms' },
    { name: 'releaseMs', label: 'Release', type: 'range', min: 10, max: 3000, step: 10, unit: 'ms' },
    { name: 'level', label: 'Level', type: 'range', min: 0, max: 1.4, step: 0.01 },
  ],
  pluck: [
    { name: 'decay', label: 'Sustain', type: 'range', min: 0.9, max: 0.9995, step: 0.0005 },
    { name: 'brightness', label: 'Tone', type: 'range', min: 0, max: 1, step: 0.01 },
    { name: 'level', label: 'Level', type: 'range', min: 0, max: 1.4, step: 0.01 },
  ],
  drumkit: [
    { name: 'kit', label: 'Kit', type: 'enum', options: DRUM_KITS.map((k) => ({ value: k.id, label: k.name })) },
    { name: 'level', label: 'Level', type: 'range', min: 0, max: 1.6, step: 0.01 },
  ],
  sampler: [
    { name: 'rootPitch', label: 'Root Note', type: 'range', min: 24, max: 96, step: 1 },
    { name: 'start', label: 'Start', type: 'range', min: 0, max: 10, step: 0.01, unit: 's' },
    { name: 'attackMs', label: 'Attack', type: 'range', min: 0, max: 500, step: 1, unit: 'ms' },
    { name: 'releaseMs', label: 'Release', type: 'range', min: 5, max: 2000, step: 5, unit: 'ms' },
    { name: 'loop', label: 'Loop', type: 'bool' },
    { name: 'level', label: 'Level', type: 'range', min: 0, max: 1.4, step: 0.01 },
  ],
};
