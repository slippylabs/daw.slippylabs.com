// ============================================================
// SlipDAW — built-in effect plugins
//
// Same rule as the instruments: a factory taking an AudioContext, never
// touching a module-level one, so the identical chain renders offline.
//
//   createEffect(ctx, type, params) -> {
//     type, input, output, params, setParam(name, v), setBypass(on), dispose()
//   }
//
// Every effect is wired dry/wet in parallel:
//
//     input ─┬─▶ dryGain ────────────▶ output
//            └─▶ [ nodes ] ─▶ wetGain ─▶ output
//
// Bypass sets dry=1, wet=0, which makes a bypassed plugin *sample-identical*
// to its input rather than merely close — that is what the null test in the
// verification suite checks, and it is how routing bugs get caught.
//
// All these are built from stock AudioNodes. No AudioWorklet: there are no
// COOP/COEP headers on this server, so SharedArrayBuffer and threaded WASM
// DSP are unavailable, and everything here is expressible without them.
// ============================================================

import { makeRng, clamp } from '../util.js';

/** Effects with no meaningful "dry" blend — a bypassed EQ should be flat,
 *  not half-filtered — default to fully wet. Time-based effects default to
 *  a sensible blend instead. */
const FULL_WET = new Set(['eq3', 'peq', 'comp', 'limiter', 'gate', 'filter', 'width', 'autopan', 'tremolo', 'bitcrush']);

function shell(ctx, type, params, defaults) {
  const p = { mix: FULL_WET.has(type) ? 1 : 0.35, bypass: false, ...defaults, ...params };
  const input = ctx.createGain();
  const output = ctx.createGain();
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  input.connect(dry); dry.connect(output);
  wet.connect(output);
  const applyMix = () => {
    const on = !p.bypass;
    dry.gain.value = on ? 1 - p.mix : 1;
    wet.gain.value = on ? p.mix : 0;
  };
  applyMix();
  return { p, input, output, dry, wet, applyMix };
}

/** Soft-clip curve, from the Test Synth's distortion. Higher k bends the
 *  curve harder into an S-shape. */
/** Soft-clip curve, from the Test Synth's distortion.
 *
 *  An odd sample count with an (n - 1) divisor, so the curve contains an
 *  exact x = 0 mapping to exact 0. The obvious `(i * 2) / n - 1` does not:
 *  it leaves a WaveShaper emitting a constant DC offset when its input is
 *  silent, which stacks up across every voice and plugin instance. */
export function makeDistortionCurve(amount) {
  const k = typeof amount === 'number' ? amount : 50;
  const samples = 1025;
  const curve = new Float32Array(samples);
  const deg = Math.PI / 180;
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / (samples - 1) - 1;
    curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x));
  }
  return curve;
}

/** Exponentially-decaying seeded noise as a reverb impulse response.
 *  Seeded so two renders of the same project match exactly. */
export function createReverbImpulse(ctx, duration = 2.2, decay = 2.5, seed = 424242) {
  const rate = ctx.sampleRate;
  const length = Math.max(1, Math.floor(rate * duration));
  const impulse = ctx.createBuffer(2, length, rate);
  const rng = makeRng(seed);
  for (let ch = 0; ch < 2; ch++) {
    const data = impulse.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      data[i] = (rng() * 2 - 1) * Math.pow(1 - i / length, decay);
    }
  }
  return impulse;
}

// ---------------------------------------------------------------

const BUILDERS = {
  // ---- EQ / filtering ----
  eq3(ctx, s) {
    const { p, input, wet } = s;
    const low = ctx.createBiquadFilter(); low.type = 'lowshelf'; low.frequency.value = 200;
    const mid = ctx.createBiquadFilter(); mid.type = 'peaking'; mid.Q.value = 1;
    const high = ctx.createBiquadFilter(); high.type = 'highshelf'; high.frequency.value = 3200;
    input.connect(low); low.connect(mid); mid.connect(high); high.connect(wet);
    const sync = () => {
      low.gain.value = p.lowDb; mid.gain.value = p.midDb; high.gain.value = p.highDb;
      mid.frequency.value = p.midFreq;
    };
    sync();
    return { sync, nodes: [low, mid, high] };
  },
  peq(ctx, s) {
    const { p, input, wet } = s;
    const f = ctx.createBiquadFilter();
    input.connect(f); f.connect(wet);
    const sync = () => {
      f.type = p.shape; f.frequency.value = p.freq; f.Q.value = p.q; f.gain.value = p.gainDb;
    };
    sync();
    return { sync, nodes: [f] };
  },
  filter(ctx, s) {
    const { p, input, wet } = s;
    const f = ctx.createBiquadFilter();
    const lfo = ctx.createOscillator();
    const depth = ctx.createGain();
    lfo.type = 'sine';
    lfo.connect(depth); depth.connect(f.frequency);
    input.connect(f); f.connect(wet);
    lfo.start();
    const sync = () => {
      f.type = p.shape; f.frequency.value = p.freq; f.Q.value = p.q;
      lfo.frequency.value = p.lfoRate; depth.gain.value = p.lfoDepth;
    };
    sync();
    return { sync, nodes: [f, lfo, depth], sources: [lfo] };
  },

  // ---- dynamics ----
  comp(ctx, s) {
    const { p, input, wet } = s;
    const c = ctx.createDynamicsCompressor();
    const makeup = ctx.createGain();
    input.connect(c); c.connect(makeup); makeup.connect(wet);
    const sync = () => {
      c.threshold.value = p.threshold; c.ratio.value = p.ratio; c.knee.value = p.knee;
      c.attack.value = p.attack; c.release.value = p.release;
      makeup.gain.value = Math.pow(10, p.makeupDb / 20);
    };
    sync();
    return { sync, nodes: [c, makeup], meterNode: c };
  },
  limiter(ctx, s) {
    const { p, input, wet } = s;
    // Two stages. The compressor does the musical gain reduction, but a
    // DynamicsCompressor is not a brickwall — feed it a signal 12dB too hot
    // and it still overshoots past 0dBFS (measured 1.26 peak before this was
    // added). The WaveShaper behind it is the actual ceiling: its curve is
    // flat outside [-1,1], so *any* input magnitude clamps to the ceiling
    // while everything below it passes through untouched.
    const c = ctx.createDynamicsCompressor();
    c.ratio.value = 20; c.knee.value = 0; c.attack.value = 0.001; c.release.value = 0.05;
    const trim = ctx.createGain();
    const clip = ctx.createWaveShaper();
    input.connect(c); c.connect(trim); trim.connect(clip); clip.connect(wet);
    const sync = () => {
      c.threshold.value = p.ceiling;
      trim.gain.value = Math.pow(10, p.gainDb / 20);
      const ceil = Math.pow(10, p.ceiling / 20);
      const n = 4097;
      const curve = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const x = (i * 2) / (n - 1) - 1;
        curve[i] = clamp(x, -ceil, ceil);
      }
      clip.curve = curve;
    };
    sync();
    return { sync, nodes: [c, trim, clip], meterNode: c };
  },
  gate(ctx, s) {
    const { p, input, wet } = s;
    // Envelope-follower gate. Web Audio has no gate node, so the level is
    // read from an analyser and the gain driven from the UI thread. That is
    // fine for a gate (it is not sample-accurate anyway) but it means the
    // gate does nothing in an offline render — documented, and the reason
    // the mastering chain uses the compressor instead.
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    const g = ctx.createGain();
    input.connect(analyser); input.connect(g); g.connect(wet);
    const buf = new Float32Array(analyser.fftSize);
    let raf = null;
    const tick = () => {
      analyser.getFloatTimeDomainData(buf);
      let peak = 0;
      for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
      const db = peak > 0 ? 20 * Math.log10(peak) : -100;
      const open = db > p.threshold;
      g.gain.setTargetAtTime(open ? 1 : 0, ctx.currentTime, open ? 0.005 : p.release);
      raf = requestAnimationFrame(tick);
    };
    if (typeof requestAnimationFrame === 'function') raf = requestAnimationFrame(tick);
    return {
      sync: () => {},
      nodes: [analyser, g],
      dispose: () => { if (raf) cancelAnimationFrame(raf); },
    };
  },

  // ---- saturation ----
  dist(ctx, s) {
    const { p, input, wet } = s;
    const pre = ctx.createGain();
    const shaper = ctx.createWaveShaper();
    shaper.oversample = '4x';
    const post = ctx.createGain();
    input.connect(pre); pre.connect(shaper); shaper.connect(post); post.connect(wet);
    const sync = () => {
      shaper.curve = makeDistortionCurve(p.drive);
      pre.gain.value = p.preGain;
      post.gain.value = p.postGain;
    };
    sync();
    return { sync, nodes: [pre, shaper, post] };
  },
  bitcrush(ctx, s) {
    const { p, input, wet } = s;
    // Bit depth via a staircase WaveShaper curve; sample-rate reduction via
    // a lowpass standing in for the aliasing filter. A true decimator needs
    // sample-level access, which means a worklet — see the header note.
    const shaper = ctx.createWaveShaper();
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
    input.connect(shaper); shaper.connect(lp); lp.connect(wet);
    const sync = () => {
      const levels = Math.max(2, Math.pow(2, Math.round(p.bits)));
      // Odd length + (n - 1) divisor so x = 0 maps to exactly 0 — see
      // makeDistortionCurve for why that matters.
      const n = 2049; const curve = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const x = (i * 2) / (n - 1) - 1;
        curve[i] = Math.round(x * levels) / levels;
      }
      shaper.curve = curve;
      lp.frequency.value = clamp(p.rate / 2, 200, 20000);
    };
    sync();
    return { sync, nodes: [shaper, lp] };
  },

  // ---- modulation ----
  chorus(ctx, s) {
    const { p, input, wet } = s;
    const delay = ctx.createDelay(0.1);
    const lfo = ctx.createOscillator();
    const depth = ctx.createGain();
    lfo.type = 'sine';
    lfo.connect(depth); depth.connect(delay.delayTime);
    input.connect(delay); delay.connect(wet);
    lfo.start();
    const sync = () => {
      delay.delayTime.value = p.delayMs / 1000;
      lfo.frequency.value = p.rate;
      depth.gain.value = p.depthMs / 1000;
    };
    sync();
    return { sync, nodes: [delay, lfo, depth], sources: [lfo] };
  },
  flanger(ctx, s) {
    const { p, input, wet } = s;
    const delay = ctx.createDelay(0.05);
    const fb = ctx.createGain();
    const lfo = ctx.createOscillator();
    const depth = ctx.createGain();
    lfo.type = 'sine';
    lfo.connect(depth); depth.connect(delay.delayTime);
    input.connect(delay); delay.connect(wet);
    delay.connect(fb); fb.connect(delay);
    lfo.start();
    const sync = () => {
      delay.delayTime.value = p.delayMs / 1000;
      lfo.frequency.value = p.rate;
      depth.gain.value = p.depthMs / 1000;
      // Feedback is clamped below 1 — a flanger ring at unity self-oscillates
      // into a screaming tone that no user asked for.
      fb.gain.value = clamp(p.feedback, 0, 0.9);
    };
    sync();
    return { sync, nodes: [delay, fb, lfo, depth], sources: [lfo] };
  },
  phaser(ctx, s) {
    const { p, input, wet } = s;
    const stages = [];
    for (let i = 0; i < 4; i++) {
      const ap = ctx.createBiquadFilter();
      ap.type = 'allpass';
      stages.push(ap);
    }
    const lfo = ctx.createOscillator();
    const depth = ctx.createGain();
    lfo.type = 'sine';
    lfo.connect(depth);
    stages.forEach((ap) => depth.connect(ap.frequency));
    let node = input;
    stages.forEach((ap) => { node.connect(ap); node = ap; });
    node.connect(wet);
    lfo.start();
    const sync = () => {
      stages.forEach((ap, i) => { ap.frequency.value = p.freq * (1 + i * 0.4); ap.Q.value = p.q; });
      lfo.frequency.value = p.rate;
      depth.gain.value = p.depth;
    };
    sync();
    return { sync, nodes: [...stages, lfo, depth], sources: [lfo] };
  },
  tremolo(ctx, s) {
    const { p, input, wet } = s;
    const g = ctx.createGain();
    const lfo = ctx.createOscillator();
    const depth = ctx.createGain();
    lfo.type = 'sine';
    // Offset so the gain swings between (1-depth) and 1 rather than around 0.
    const offset = ctx.createConstantSource();
    offset.offset.value = 1;
    lfo.connect(depth); depth.connect(g.gain); offset.connect(g.gain);
    g.gain.value = 0;
    input.connect(g); g.connect(wet);
    lfo.start(); offset.start();
    const sync = () => {
      lfo.frequency.value = p.rate;
      depth.gain.value = clamp(p.depth, 0, 1) * 0.5;
      offset.offset.value = 1 - clamp(p.depth, 0, 1) * 0.5;
    };
    sync();
    return { sync, nodes: [g, lfo, depth, offset], sources: [lfo, offset] };
  },
  autopan(ctx, s) {
    const { p, input, wet } = s;
    const panner = ctx.createStereoPanner();
    const lfo = ctx.createOscillator();
    const depth = ctx.createGain();
    lfo.type = 'sine';
    lfo.connect(depth); depth.connect(panner.pan);
    input.connect(panner); panner.connect(wet);
    lfo.start();
    const sync = () => { lfo.frequency.value = p.rate; depth.gain.value = clamp(p.depth, 0, 1); };
    sync();
    return { sync, nodes: [panner, lfo, depth], sources: [lfo] };
  },

  // ---- time ----
  delay(ctx, s) {
    const { p, input, wet } = s;
    // Web Audio inserts one render quantum (128 samples) of latency into any
    // feedback cycle, so a naive ring gives echoes spaced time+2.9ms — the
    // taps measured 250ms, 503ms, 756ms instead of 250/500/750. That drifts
    // audibly against the grid on a tempo-synced delay.
    //
    // Compensating: run the loop delay a quantum short, and put that quantum
    // back in front as a pre-delay. First tap = q + (t-q) = t, and every lap
    // round the loop = (t-q) + q = t. Both exact.
    const q = 128 / ctx.sampleRate;
    const pre = ctx.createDelay(1);
    const d = ctx.createDelay(5);
    const fb = ctx.createGain();
    const damp = ctx.createBiquadFilter(); damp.type = 'lowpass';
    input.connect(pre); pre.connect(d);
    d.connect(damp); damp.connect(fb); fb.connect(d);
    d.connect(wet);
    const sync = () => {
      const t = clamp(p.timeMs / 1000, 0.002, 5);
      pre.delayTime.value = q;
      d.delayTime.value = Math.max(0.0005, t - q);
      fb.gain.value = clamp(p.feedback, 0, 0.95);
      damp.frequency.value = p.damping;
    };
    sync();
    return { sync, nodes: [pre, d, fb, damp] };
  },
  pingpong(ctx, s) {
    const { p, input, wet } = s;
    const splitL = ctx.createDelay(5);
    const splitR = ctx.createDelay(5);
    const fb = ctx.createGain();
    const panL = ctx.createStereoPanner(); panL.pan.value = -0.85;
    const panR = ctx.createStereoPanner(); panR.pan.value = 0.85;
    // Cross-feeding the two lines is what makes it bounce ear to ear.
    input.connect(splitL);
    splitL.connect(panL); panL.connect(wet);
    splitL.connect(splitR);
    splitR.connect(panR); panR.connect(wet);
    splitR.connect(fb); fb.connect(splitL);
    // Unlike the mono delay above, the ping-pong loop passes through two
    // delays, so its round trip carries one render quantum (~2.9ms) of extra
    // latency that cannot be split cleanly between the two hops. Left as-is:
    // it is a slow widening of the bounce rather than a drift against the
    // grid, and inaudible at these times.
    //
    // Worth knowing when comparing two exports: Chrome resolves a feedback
    // cycle's quantum of latency onto one render block or the next
    // non-deterministically, so an echo tail can sit up to ~3ms earlier or
    // later between renders of the same project. Level and energy are
    // unaffected (measured: identical peak, ~1% tail energy), but two
    // exports will not be bit-identical whenever a delay is in use. The
    // engine suite's determinism test asserts perceptual equivalence for
    // exactly this reason.
    const sync = () => {
      const t = clamp(p.timeMs / 1000, 0.001, 5);
      splitL.delayTime.value = t; splitR.delayTime.value = t;
      fb.gain.value = clamp(p.feedback, 0, 0.9);
    };
    sync();
    return { sync, nodes: [splitL, splitR, fb, panL, panR] };
  },
  reverb(ctx, s) {
    const { p, input, wet } = s;
    const conv = ctx.createConvolver();
    const pre = ctx.createDelay(0.5);
    const tone = ctx.createBiquadFilter(); tone.type = 'lowpass';
    input.connect(pre); pre.connect(conv); conv.connect(tone); tone.connect(wet);
    let lastSize = null; let lastDecay = null;
    const sync = () => {
      if (p.size !== lastSize || p.decay !== lastDecay) {
        conv.buffer = createReverbImpulse(ctx, clamp(p.size, 0.1, 8), clamp(p.decay, 0.5, 8));
        lastSize = p.size; lastDecay = p.decay;
      }
      pre.delayTime.value = clamp(p.predelayMs / 1000, 0, 0.5);
      tone.frequency.value = p.tone;
    };
    sync();
    return { sync, nodes: [conv, pre, tone] };
  },

  // ---- stereo ----
  width(ctx, s) {
    const { p, input, wet } = s;
    // Mid/side: mid = (L+R), side = (L-R). Scaling side alone widens or
    // collapses the image without touching the centre.
    const splitter = ctx.createChannelSplitter(2);
    const merger = ctx.createChannelMerger(2);
    const midG = ctx.createGain();
    const sideG = ctx.createGain();
    const invert = ctx.createGain(); invert.gain.value = -1;

    input.connect(splitter);
    splitter.connect(midG, 0); splitter.connect(midG, 1);
    splitter.connect(sideG, 0);
    splitter.connect(invert, 1); invert.connect(sideG);

    const outL = ctx.createGain(); const outR = ctx.createGain();
    const sideInv = ctx.createGain(); sideInv.gain.value = -1;
    midG.connect(outL); sideG.connect(outL);
    midG.connect(outR); sideG.connect(sideInv); sideInv.connect(outR);
    outL.connect(merger, 0, 0); outR.connect(merger, 0, 1);
    merger.connect(wet);

    const sync = () => {
      midG.gain.value = 0.5;
      sideG.gain.value = 0.5 * clamp(p.width, 0, 2);
    };
    sync();
    return { sync, nodes: [splitter, merger, midG, sideG, invert, outL, outR, sideInv] };
  },
};

export const EFFECT_TYPES = [
  { type: 'eq3', name: 'EQ Three', icon: '🎚️', group: 'EQ' },
  { type: 'peq', name: 'Parametric EQ', icon: '📐', group: 'EQ' },
  { type: 'filter', name: 'Filter', icon: '🌊', group: 'EQ' },
  { type: 'comp', name: 'Compressor', icon: '🗜️', group: 'Dynamics' },
  { type: 'limiter', name: 'Limiter', icon: '🧱', group: 'Dynamics' },
  { type: 'gate', name: 'Gate', icon: '🚪', group: 'Dynamics' },
  { type: 'dist', name: 'Saturator', icon: '🔥', group: 'Drive' },
  { type: 'bitcrush', name: 'Bitcrusher', icon: '🧊', group: 'Drive' },
  { type: 'chorus', name: 'Chorus', icon: '🌫️', group: 'Modulation' },
  { type: 'flanger', name: 'Flanger', icon: '✈️', group: 'Modulation' },
  { type: 'phaser', name: 'Phaser', icon: '🌀', group: 'Modulation' },
  { type: 'tremolo', name: 'Tremolo', icon: '📶', group: 'Modulation' },
  { type: 'autopan', name: 'Auto Pan', icon: '↔️', group: 'Modulation' },
  { type: 'delay', name: 'Delay', icon: '⏱️', group: 'Time' },
  { type: 'pingpong', name: 'Ping-Pong Delay', icon: '🏓', group: 'Time' },
  { type: 'reverb', name: 'Reverb', icon: '🏛️', group: 'Time' },
  { type: 'width', name: 'Stereo Width', icon: '↔️', group: 'Stereo' },
];

export const EFFECT_DEFAULTS = {
  eq3: { lowDb: 0, midDb: 0, highDb: 0, midFreq: 1000 },
  peq: { shape: 'peaking', freq: 1000, q: 1, gainDb: 0 },
  filter: { shape: 'lowpass', freq: 2000, q: 1, lfoRate: 0, lfoDepth: 0 },
  comp: { threshold: -18, ratio: 4, knee: 6, attack: 0.01, release: 0.2, makeupDb: 0 },
  limiter: { ceiling: -1, gainDb: 0 },
  gate: { threshold: -45, release: 0.08 },
  dist: { drive: 40, preGain: 1, postGain: 0.7 },
  bitcrush: { bits: 6, rate: 8000 },
  chorus: { rate: 1.2, depthMs: 3, delayMs: 22 },
  flanger: { rate: 0.4, depthMs: 2.5, delayMs: 5, feedback: 0.5 },
  phaser: { rate: 0.5, freq: 700, q: 2, depth: 900 },
  tremolo: { rate: 5, depth: 0.6 },
  autopan: { rate: 0.7, depth: 0.8 },
  delay: { timeMs: 375, feedback: 0.35, damping: 6000 },
  pingpong: { timeMs: 300, feedback: 0.4 },
  reverb: { size: 2.2, decay: 2.5, predelayMs: 15, tone: 7000 },
  width: { width: 1.4 },
};

export const EFFECT_PARAMS = {
  eq3: [
    { name: 'lowDb', label: 'Low', type: 'range', min: -24, max: 24, step: 0.5, unit: 'dB' },
    { name: 'midDb', label: 'Mid', type: 'range', min: -24, max: 24, step: 0.5, unit: 'dB' },
    { name: 'midFreq', label: 'Mid Freq', type: 'range', min: 200, max: 8000, step: 10, unit: 'Hz' },
    { name: 'highDb', label: 'High', type: 'range', min: -24, max: 24, step: 0.5, unit: 'dB' },
  ],
  peq: [
    { name: 'shape', label: 'Shape', type: 'enum', options: ['peaking', 'lowshelf', 'highshelf', 'lowpass', 'highpass', 'bandpass', 'notch'].map((v) => ({ value: v, label: v })) },
    { name: 'freq', label: 'Freq', type: 'range', min: 20, max: 18000, step: 10, unit: 'Hz' },
    { name: 'q', label: 'Q', type: 'range', min: 0.1, max: 18, step: 0.1 },
    { name: 'gainDb', label: 'Gain', type: 'range', min: -24, max: 24, step: 0.5, unit: 'dB' },
  ],
  filter: [
    { name: 'shape', label: 'Shape', type: 'enum', options: ['lowpass', 'highpass', 'bandpass', 'notch'].map((v) => ({ value: v, label: v })) },
    { name: 'freq', label: 'Cutoff', type: 'range', min: 40, max: 18000, step: 10, unit: 'Hz' },
    { name: 'q', label: 'Reso', type: 'range', min: 0.1, max: 20, step: 0.1 },
    { name: 'lfoRate', label: 'LFO Rate', type: 'range', min: 0, max: 12, step: 0.1, unit: 'Hz' },
    { name: 'lfoDepth', label: 'LFO Depth', type: 'range', min: 0, max: 6000, step: 10 },
  ],
  comp: [
    { name: 'threshold', label: 'Threshold', type: 'range', min: -60, max: 0, step: 0.5, unit: 'dB' },
    { name: 'ratio', label: 'Ratio', type: 'range', min: 1, max: 20, step: 0.5 },
    { name: 'attack', label: 'Attack', type: 'range', min: 0, max: 0.5, step: 0.001, unit: 's' },
    { name: 'release', label: 'Release', type: 'range', min: 0.01, max: 1.5, step: 0.01, unit: 's' },
    { name: 'knee', label: 'Knee', type: 'range', min: 0, max: 40, step: 1, unit: 'dB' },
    { name: 'makeupDb', label: 'Makeup', type: 'range', min: 0, max: 24, step: 0.5, unit: 'dB' },
  ],
  limiter: [
    { name: 'ceiling', label: 'Ceiling', type: 'range', min: -24, max: 0, step: 0.1, unit: 'dB' },
    { name: 'gainDb', label: 'Gain', type: 'range', min: 0, max: 18, step: 0.5, unit: 'dB' },
  ],
  gate: [
    { name: 'threshold', label: 'Threshold', type: 'range', min: -80, max: 0, step: 1, unit: 'dB' },
    { name: 'release', label: 'Release', type: 'range', min: 0.01, max: 1, step: 0.01, unit: 's' },
  ],
  dist: [
    { name: 'drive', label: 'Drive', type: 'range', min: 0, max: 400, step: 1 },
    { name: 'preGain', label: 'Input', type: 'range', min: 0.1, max: 4, step: 0.05 },
    { name: 'postGain', label: 'Output', type: 'range', min: 0, max: 1.5, step: 0.01 },
  ],
  bitcrush: [
    { name: 'bits', label: 'Bits', type: 'range', min: 1, max: 12, step: 1 },
    { name: 'rate', label: 'Rate', type: 'range', min: 500, max: 22000, step: 100, unit: 'Hz' },
  ],
  chorus: [
    { name: 'rate', label: 'Rate', type: 'range', min: 0.05, max: 8, step: 0.05, unit: 'Hz' },
    { name: 'depthMs', label: 'Depth', type: 'range', min: 0, max: 12, step: 0.1, unit: 'ms' },
    { name: 'delayMs', label: 'Delay', type: 'range', min: 1, max: 60, step: 0.5, unit: 'ms' },
  ],
  flanger: [
    { name: 'rate', label: 'Rate', type: 'range', min: 0.05, max: 6, step: 0.05, unit: 'Hz' },
    { name: 'depthMs', label: 'Depth', type: 'range', min: 0, max: 8, step: 0.1, unit: 'ms' },
    { name: 'delayMs', label: 'Delay', type: 'range', min: 0.5, max: 20, step: 0.1, unit: 'ms' },
    { name: 'feedback', label: 'Feedback', type: 'range', min: 0, max: 0.9, step: 0.01 },
  ],
  phaser: [
    { name: 'rate', label: 'Rate', type: 'range', min: 0.05, max: 6, step: 0.05, unit: 'Hz' },
    { name: 'freq', label: 'Centre', type: 'range', min: 100, max: 4000, step: 10, unit: 'Hz' },
    { name: 'depth', label: 'Depth', type: 'range', min: 0, max: 3000, step: 10 },
    { name: 'q', label: 'Q', type: 'range', min: 0.1, max: 12, step: 0.1 },
  ],
  tremolo: [
    { name: 'rate', label: 'Rate', type: 'range', min: 0.1, max: 20, step: 0.1, unit: 'Hz' },
    { name: 'depth', label: 'Depth', type: 'range', min: 0, max: 1, step: 0.01 },
  ],
  autopan: [
    { name: 'rate', label: 'Rate', type: 'range', min: 0.05, max: 10, step: 0.05, unit: 'Hz' },
    { name: 'depth', label: 'Depth', type: 'range', min: 0, max: 1, step: 0.01 },
  ],
  delay: [
    { name: 'timeMs', label: 'Time', type: 'range', min: 10, max: 2000, step: 5, unit: 'ms' },
    { name: 'feedback', label: 'Feedback', type: 'range', min: 0, max: 0.95, step: 0.01 },
    { name: 'damping', label: 'Damping', type: 'range', min: 300, max: 18000, step: 100, unit: 'Hz' },
  ],
  pingpong: [
    { name: 'timeMs', label: 'Time', type: 'range', min: 10, max: 2000, step: 5, unit: 'ms' },
    { name: 'feedback', label: 'Feedback', type: 'range', min: 0, max: 0.9, step: 0.01 },
  ],
  reverb: [
    { name: 'size', label: 'Size', type: 'range', min: 0.2, max: 8, step: 0.1, unit: 's' },
    { name: 'decay', label: 'Decay', type: 'range', min: 0.5, max: 8, step: 0.1 },
    { name: 'predelayMs', label: 'Pre-delay', type: 'range', min: 0, max: 200, step: 1, unit: 'ms' },
    { name: 'tone', label: 'Tone', type: 'range', min: 500, max: 18000, step: 100, unit: 'Hz' },
  ],
  width: [
    { name: 'width', label: 'Width', type: 'range', min: 0, max: 2, step: 0.01 },
  ],
};

/** Every effect also gets a Mix knob, appended automatically. */
export function paramsFor(type) {
  const base = EFFECT_PARAMS[type] || [];
  return [...base, { name: 'mix', label: 'Mix', type: 'range', min: 0, max: 1, step: 0.01 }];
}

export function createEffect(ctx, type, params = {}) {
  const defaults = EFFECT_DEFAULTS[type] || {};
  const s = shell(ctx, type, params, defaults);
  const builder = BUILDERS[type];
  const built = builder ? builder(ctx, s) : { sync: () => {}, nodes: [] };

  return {
    type,
    input: s.input,
    output: s.output,
    params: s.p,
    setParam(name, value) {
      s.p[name] = value;
      if (name === 'mix' || name === 'bypass') s.applyMix();
      else built.sync();
    },
    setBypass(on) { s.p.bypass = !!on; s.applyMix(); },
    isBypassed: () => !!s.p.bypass,
    meterNode: built.meterNode || null,
    dispose() {
      if (built.dispose) built.dispose();
      (built.sources || []).forEach((n) => { try { n.stop(); } catch {} });
      (built.nodes || []).forEach((n) => { try { n.disconnect(); } catch {} });
      try { s.input.disconnect(); s.output.disconnect(); s.dry.disconnect(); s.wet.disconnect(); } catch {}
    },
  };
}
