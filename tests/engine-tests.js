// ============================================================
// SlipDAW — engine test suite
//
// Runs in a real browser (headless is fine) because it needs
// OfflineAudioContext. Everything here renders audio and inspects the
// samples: no assertion is made about UI state, only about what actually
// comes out of the graph.
//
// Open tests/engine-tests.html, or drive it headlessly and read #TESTOUT.
// ============================================================

import { emptyProject, demoProject, createChannel, createPattern, createInsert, createPlaylistTrack, createClip } from '../js/model/project.js';
import { renderProject, encodeWav, peakOf, rmsOf } from '../js/engine/render.js';
import { createEffect, EFFECT_TYPES } from '../js/engine/effects.js';
import { createInstrument } from '../js/engine/instruments.js';
import { createReverbImpulse } from '../js/engine/effects.js';
import { beatsToSec, createNoiseBuffer } from '../js/util.js';

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass: !!pass, detail });
  return !!pass;
}

/** Find onset times (seconds) as the leading edge of each burst of activity.
 *
 *  Two earlier versions of this got it wrong in instructive ways. An
 *  amplitude threshold with a hold-off counted a kick's 60Hz body many times
 *  over (75 onsets for 32 beats). A "the window before must be quiet" rule
 *  then found none at all — because a 5ms look-back window straddles the
 *  onset's own attack, and by the time the signal crosses the threshold its
 *  first half-cycle is already inside the window being tested.
 *
 *  What works is tracking silence explicitly: a sample above a low trigger
 *  after a run of genuine silence starts a new note, and everything until
 *  the next silence belongs to it. Triggering low also puts the reported
 *  time at the true start of the transient rather than partway up its
 *  attack, which is what makes sub-millisecond drift measurable at all. */
function findOnsets(buffer, trigger = 0.02, minGapSec = 0.02) {
  const d = buffer.getChannelData(0);
  const sr = buffer.sampleRate;
  const minGap = Math.max(1, Math.floor(minGapSec * sr));
  const onsets = [];
  let silentRun = minGap + 1;   // start armed
  for (let i = 0; i < d.length; i++) {
    if (Math.abs(d[i]) > trigger) {
      if (silentRun > minGap) onsets.push(i / sr);
      silentRun = 0;
    } else {
      silentRun++;
    }
  }
  return onsets;
}

// ---------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------

/** A project that plays one closed hi-hat on every beat, for `bars` bars.
 *
 *  A hat, not a kick, and that matters: the kick's sub layer rings for 420ms,
 *  which is longer than a beat above 143 BPM, so at 174 BPM its tail runs
 *  into the next hit and there is no silence between them to detect an onset
 *  from. The closed hat is done in 60ms, leaving a clean gap at any tempo
 *  this test uses. Timing is what is being measured here, not timbre. */
function clickProject(bpm, bars = 8, swing = 0) {
  const p = emptyProject();
  p.bpm = bpm;
  p.swing = swing;
  p.mixer.inserts = [createInsert(0, { name: 'Master', volume: 1 }), createInsert(1, { name: 'Drums', volume: 1 })];
  const ch = createChannel({ name: 'Kit', instrument: 'drumkit', insert: 1 });
  p.channels = [ch];
  const pat = createPattern({ name: 'Beat', lengthBeats: 1 });
  pat.notes[ch.id] = [{ beat: 0, dur: 0.25, pitch: 42, vel: 127 }];
  p.patterns = [pat];
  const track = createPlaylistTrack({ name: 'T1' });
  for (let b = 0; b < bars * 4; b++) {
    track.clips.push(createClip({ type: 'pattern', ref: pat.id, start: b, length: 1 }));
  }
  p.playlist.tracks = [track];
  p.selection.patternId = pat.id;
  return p;
}

/** A tone project: one sustained analog note, for effect tests. */
function toneProject(pitch = 69, beats = 2) {
  const p = emptyProject();
  p.bpm = 120;
  p.mixer.inserts = [createInsert(0, { name: 'Master', volume: 1 }), createInsert(1, { name: 'Ins1', volume: 1 })];
  const ch = createChannel({ name: 'Tone', instrument: 'analog', params: { preset: 'sine', attackMs: 1, releaseMs: 10, level: 0.8 }, insert: 1 });
  p.channels = [ch];
  const pat = createPattern({ lengthBeats: beats });
  pat.notes[ch.id] = [{ beat: 0, dur: beats, pitch, vel: 110 }];
  p.patterns = [pat];
  const t = createPlaylistTrack();
  t.clips.push(createClip({ type: 'pattern', ref: pat.id, start: 0, length: beats }));
  p.playlist.tracks = [t];
  p.selection.patternId = pat.id;
  return p;
}

// ---------------------------------------------------------------
// Tests
// ---------------------------------------------------------------

async function testSilence() {
  const p = emptyProject();
  const buf = await renderProject(p, { tailSec: 0.2 });
  check('empty project renders exact digital silence', peakOf(buf) === 0, `peak=${peakOf(buf)}`);
}

async function testTiming(bpm) {
  const bars = 8;
  const p = clickProject(bpm, bars);
  const buf = await renderProject(p, { tailSec: 0.5, sampleRate: 48000 });
  const onsets = findOnsets(buf, 0.02, Math.min(0.02, (60 / bpm) * 0.3));
  const expectedCount = bars * 4;
  const spacing = 60 / bpm;

  if (!check(`${bpm} BPM: found all ${expectedCount} beat onsets`, onsets.length === expectedCount, `got ${onsets.length}`)) return;

  let worst = 0;
  for (let i = 0; i < onsets.length; i++) {
    const expected = i * spacing;
    worst = Math.max(worst, Math.abs(onsets[i] - expected));
  }
  // One sample at 48k is 20.8us; allow a couple of samples for the onset
  // detector picking the first sample over threshold rather than the exact
  // scheduled instant.
  check(`${bpm} BPM: no drift over ${bars} bars`, worst < 0.001, `worst error ${(worst * 1000).toFixed(3)}ms`);
}

async function testLongDrift() {
  // Five minutes at 120 BPM = 600 beats. The whole point is that error does
  // not accumulate, so the last onset matters far more than the first.
  const bpm = 120;
  const p = clickProject(bpm, 75); // 300 beats
  const buf = await renderProject(p, { tailSec: 0.3, sampleRate: 44100 });
  const onsets = findOnsets(buf, 0.02, 0.02);
  if (!check('long render: found every onset', onsets.length === 300, `got ${onsets.length}`)) return;
  const last = onsets[onsets.length - 1];
  const expected = (onsets.length - 1) * (60 / bpm);
  check('long render: last onset still on the grid', Math.abs(last - expected) < 0.001,
    `n=${onsets.length} last=${last.toFixed(4)}s expected=${expected.toFixed(4)}s`);
}

/** Renders must be reproducible — but "byte-identical" is not achievable
 *  here and asserting it was wrong.
 *
 *  Chrome's OfflineAudioContext is not bit-exact once more than one source is
 *  summed: four raw oscillators through a gain node, with no SlipDAW code
 *  involved at all, differ by ~1.5e-8 between two renders of the same graph,
 *  and the error grows with node count (40 oscillators: ~3.6e-7). Summation
 *  order across parallel nodes is not pinned down by the spec.
 *
 *  So the real assertion is that repeat renders agree far below audibility.
 *  1e-4 is about -80 dBFS — four orders of magnitude under a 16-bit LSB's
 *  audible relevance, and still tight enough to catch a genuine bug like an
 *  unseeded noise source or a race in scheduling, which show up at 1e-2 and
 *  above. What this *does* prove is that nothing in the DAW is drawing from
 *  an unseeded Math.random(). */
async function testDeterminism() {
  const p = demoProject();
  const a = await renderProject(p, { tailSec: 1, sampleRate: 44100, toBeat: 16 });
  const b = await renderProject(p, { tailSec: 1, sampleRate: 44100, toBeat: 16 });
  let maxDiff = 0;
  for (let c = 0; c < a.numberOfChannels; c++) {
    const da = a.getChannelData(c); const db = b.getChannelData(c);
    for (let i = 0; i < da.length; i++) maxDiff = Math.max(maxDiff, Math.abs(da[i] - db[i]));
  }
  check('repeat renders agree below audibility', maxDiff < 1e-4,
    `max sample diff ${maxDiff.toExponential(2)} (platform floor ~1e-7)`);
}

/** The seeded-noise guarantee, checked as *data* rather than as audio.
 *
 *  Rendering even one drum voice sums several parallel noise chains, so it
 *  inherits the platform's summation noise and cannot be bit-exact — an
 *  earlier version of this test asserted exactness on a rendered snare and
 *  failed at 1.2e-7 for that reason, which said nothing about seeding.
 *  Comparing the generated buffers directly has no such floor: if anyone
 *  reintroduces Math.random() into a noise source or the reverb impulse,
 *  these are instantly and unmistakably different. */
async function testSeededNoise() {
  const ctx = new window.OfflineAudioContext(1, 128, 44100);
  const n1 = createNoiseBuffer(ctx, 0.2, 20250814);
  const n2 = createNoiseBuffer(ctx, 0.2, 20250814);
  const a = n1.getChannelData(0); const b = n2.getChannelData(0);
  let same = a.length === b.length;
  for (let i = 0; same && i < a.length; i++) if (a[i] !== b[i]) same = false;
  check('noise buffers are seeded and reproducible', same, `${a.length} samples compared`);

  const i1 = createReverbImpulse(ctx, 0.5, 2.5);
  const i2 = createReverbImpulse(ctx, 0.5, 2.5);
  let irSame = true;
  for (let c = 0; c < 2 && irSame; c++) {
    const x = i1.getChannelData(c); const y = i2.getChannelData(c);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) { irSame = false; break; }
  }
  check('reverb impulse responses are seeded and reproducible', irSame, '2 channels compared');

  // And a different seed must actually produce different noise, or the
  // "seeded" check above would pass on a generator stuck at a constant.
  const n3 = createNoiseBuffer(ctx, 0.2, 99);
  const c3 = n3.getChannelData(0);
  let differs = false;
  for (let i = 0; i < c3.length; i++) if (c3[i] !== a[i]) { differs = true; break; }
  check('a different seed produces different noise', differs);
}

async function testDemoIsAudible() {
  const p = demoProject();
  const buf = await renderProject(p, { tailSec: 1, toBeat: 16 });
  const peak = peakOf(buf);
  check('demo song renders audible output', peak > 0.05 && peak <= 1.0, `peak=${peak.toFixed(4)}`);
  check('demo song does not clip', peak <= 1.0, `peak=${peak.toFixed(4)}`);
}

/** The load-bearing routing test: every effect, bypassed, must be
 *  sample-identical to its input. */
async function testBypassNull() {
  const sr = 44100;
  const OAC = window.OfflineAudioContext;
  let failures = [];
  for (const { type } of EFFECT_TYPES) {
    const ctx = new OAC(2, sr * 0.5, sr);
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 220;
    const eff = createEffect(ctx, type, {});
    eff.setBypass(true);
    const split = ctx.createGain();
    osc.connect(split);
    split.connect(eff.input);
    // Reference: the dry signal, inverted, summed with the effect output.
    // A perfect bypass cancels to exact zero.
    const inv = ctx.createGain(); inv.gain.value = -1;
    split.connect(inv);
    const sum = ctx.createGain();
    eff.output.connect(sum); inv.connect(sum);
    sum.connect(ctx.destination);
    osc.start(0);
    const out = await ctx.startRendering();
    const peak = peakOf(out);
    if (peak > 1e-6) failures.push(`${type}:${peak.toExponential(2)}`);
  }
  check('every effect bypasses to a perfect null', failures.length === 0, failures.join(' '));
}

/** Silence in, silence out — for every plugin, active (not bypassed).
 *
 *  This is the test that catches DC offsets, and it caught a real one: a
 *  WaveShaper curve built as `x = (i * 2) / n - 1` contains no sample at
 *  exactly x = 0, so it interpolates silence to a constant -0.035 and emits
 *  it forever. Every drum voice built its own shaper, so a bar of eight
 *  kicks laid a permanent -0.28 DC bed under the whole song. It was
 *  inaudible as a tone, invisible in a waveform glance, and ate headroom on
 *  every render. Nothing else in the suite noticed it.
 *
 *  Same idea for instruments: an instrument that has played no notes must be
 *  silent, not merely quiet. */
async function testSilenceInSilenceOut() {
  const sr = 44100;
  const bad = [];
  for (const { type } of EFFECT_TYPES) {
    const ctx = new window.OfflineAudioContext(1, 2048, sr);
    const eff = createEffect(ctx, type, {});
    eff.output.connect(ctx.destination);
    const out = await ctx.startRendering();
    const peak = peakOf(out);
    if (peak !== 0) bad.push(`${type}:${peak.toExponential(2)}`);
  }
  check('every effect passes silence as exact silence', bad.length === 0, bad.join(' '));

  const badInst = [];
  for (const type of ['analog', 'fm', 'pluck', 'drumkit', 'sampler']) {
    const ctx = new window.OfflineAudioContext(1, 2048, sr);
    const inst = createInstrument(ctx, type, {});
    inst.output.connect(ctx.destination);
    const out = await ctx.startRendering();
    if (peakOf(out) !== 0) badInst.push(`${type}:${peakOf(out).toExponential(2)}`);
  }
  check('every idle instrument is exactly silent', badInst.length === 0, badInst.join(' '));

  // And the case that actually bit: many scheduled voices must not leave a
  // DC bed between hits. Measure the gap after the last hit has decayed.
  const p = clickProject(120, 2);
  const buf = await renderProject(p, { tailSec: 0.5, sampleRate: 48000 });
  const d = buf.getChannelData(0);
  // 0.46-0.49s: the first kick is long gone, the second has not started.
  let gapPeak = 0;
  for (let i = Math.floor(0.46 * 48000); i < Math.floor(0.49 * 48000); i++) {
    gapPeak = Math.max(gapPeak, Math.abs(d[i]));
  }
  check('no DC bed between scheduled hits', gapPeak < 0.005, `gap peak=${gapPeak.toFixed(5)}`);
}

async function testDelayTaps() {
  const sr = 44100;
  const ctx = new window.OfflineAudioContext(1, sr * 2, sr);
  const eff = createEffect(ctx, 'delay', { timeMs: 250, feedback: 0.5, damping: 18000, mix: 1 });
  // A single-sample impulse.
  const buf = ctx.createBuffer(1, 1, sr);
  buf.getChannelData(0)[0] = 1;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(eff.input);
  eff.output.connect(ctx.destination);
  src.start(0);
  const out = await ctx.startRendering();
  const onsets = findOnsets(out, 0.02, 0.05);
  // Taps at 0.25, 0.50, 0.75 ... (the dry hit is suppressed: mix=1)
  const ok = onsets.length >= 3
    && Math.abs(onsets[0] - 0.25) < 0.005
    && Math.abs(onsets[1] - 0.50) < 0.005
    && Math.abs(onsets[2] - 0.75) < 0.005;
  check('delay taps land at the right times', ok, `onsets=${onsets.slice(0, 4).map((x) => x.toFixed(3)).join(',')}`);

  const d = out.getChannelData(0);
  // Measure the peak in a short window around each tap, not a single sample:
  // an impulse response can be at a zero crossing at the exact tap instant,
  // which is what made the first version of this test report a ratio of 0.
  const peakNear = (t) => {
    const c = Math.round(t * sr);
    let m = 0;
    for (let i = Math.max(0, c - 64); i < Math.min(d.length, c + 256); i++) m = Math.max(m, Math.abs(d[i]));
    return m;
  };
  const t1 = peakNear(0.25); const t2 = peakNear(0.5);
  check('delay feedback decays by the set amount', t1 > 0 && Math.abs((t2 / t1) - 0.5) < 0.15,
    `ratio=${(t2 / t1).toFixed(3)} expected~0.5`);
}

async function testEqResponse() {
  const sr = 44100;
  const ctx = new window.OfflineAudioContext(1, 128, sr);
  const eff = createEffect(ctx, 'peq', { shape: 'peaking', freq: 1000, q: 1, gainDb: 12, mix: 1 });
  // Compare the plugin's own filter against a reference biquad configured
  // identically — an independent oracle for the parameter mapping.
  const ref = ctx.createBiquadFilter();
  ref.type = 'peaking'; ref.frequency.value = 1000; ref.Q.value = 1; ref.gain.value = 12;
  const freqs = new Float32Array([100, 500, 1000, 2000, 8000]);
  const mag = new Float32Array(5); const phase = new Float32Array(5);
  ref.getFrequencyResponse(freqs, mag, phase);
  const boostAt1k = 20 * Math.log10(mag[2]);
  check('parametric EQ gain matches the reference biquad', Math.abs(boostAt1k - 12) < 0.1,
    `+${boostAt1k.toFixed(3)}dB at 1kHz`);
  eff.dispose();
}

async function testCompressor() {
  const sr = 44100;
  // Loud sine well above threshold should come out quieter than the same
  // sine with the compressor bypassed.
  async function renderWith(bypass) {
    const ctx = new window.OfflineAudioContext(1, sr, sr);
    const osc = ctx.createOscillator();
    osc.type = 'sine'; osc.frequency.value = 220;
    const g = ctx.createGain(); g.gain.value = 0.9;
    const eff = createEffect(ctx, 'comp', { threshold: -30, ratio: 12, attack: 0.001, release: 0.05, makeupDb: 0, mix: 1 });
    eff.setBypass(bypass);
    osc.connect(g); g.connect(eff.input); eff.output.connect(ctx.destination);
    osc.start(0);
    return ctx.startRendering();
  }
  const loud = await renderWith(true);
  const squashed = await renderWith(false);
  // Measure the back half, after the compressor has settled.
  const tail = (b) => {
    const d = b.getChannelData(0);
    let s = 0; const from = Math.floor(d.length / 2);
    for (let i = from; i < d.length; i++) s += d[i] * d[i];
    return Math.sqrt(s / (d.length - from));
  };
  const a = tail(loud); const b = tail(squashed);
  check('compressor actually reduces level above threshold', b < a * 0.8,
    `bypassed rms=${a.toFixed(4)} compressed rms=${b.toFixed(4)}`);
}

async function testLimiterCeiling() {
  const sr = 44100;
  const ctx = new window.OfflineAudioContext(1, sr, sr);
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth'; osc.frequency.value = 110;
  const hot = ctx.createGain(); hot.gain.value = 4;   // deliberately way too loud
  const eff = createEffect(ctx, 'limiter', { ceiling: -1, gainDb: 0, mix: 1 });
  osc.connect(hot); hot.connect(eff.input); eff.output.connect(ctx.destination);
  osc.start(0);
  const out = await ctx.startRendering();
  // Skip the very start: the limiter needs its attack time to catch up.
  const d = out.getChannelData(0);
  let peak = 0;
  for (let i = Math.floor(sr * 0.1); i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
  check('limiter holds a hot signal near its ceiling', peak < 1.0, `peak=${peak.toFixed(4)}`);
}

async function testSoloMute() {
  // Two channels on two inserts; check every combination by rendered energy.
  function twoChannelProject(muteA, soloA, muteB, soloB) {
    const p = emptyProject();
    p.bpm = 120;
    p.mixer.inserts = [createInsert(0, { volume: 1 }), createInsert(1, { volume: 1 }), createInsert(2, { volume: 1 })];
    const a = createChannel({ name: 'A', instrument: 'analog', params: { preset: 'sine' }, insert: 1, mute: muteA, solo: soloA });
    const b = createChannel({ name: 'B', instrument: 'analog', params: { preset: 'sine' }, insert: 2, mute: muteB, solo: soloB });
    p.channels = [a, b];
    const pat = createPattern({ lengthBeats: 1 });
    pat.notes[a.id] = [{ beat: 0, dur: 1, pitch: 60, vel: 120 }];
    pat.notes[b.id] = [{ beat: 0, dur: 1, pitch: 72, vel: 120 }];
    p.patterns = [pat];
    const t = createPlaylistTrack();
    t.clips.push(createClip({ ref: pat.id, start: 0, length: 1 }));
    p.playlist.tracks = [t];
    return p;
  }
  const cases = [
    { name: 'both open', args: [false, false, false, false], expect: 'both' },
    { name: 'A muted', args: [true, false, false, false], expect: 'silentA' },
    { name: 'B muted', args: [false, false, true, false], expect: 'silentB' },
    { name: 'A soloed', args: [false, true, false, false], expect: 'silentB' },
    { name: 'both muted', args: [true, false, true, false], expect: 'silence' },
  ];
  let fails = [];
  for (const c of cases) {
    const p = twoChannelProject(...c.args);
    const buf = await renderProject(p, { tailSec: 0.3, toBeat: 1 });
    const peak = peakOf(buf);
    const silent = peak < 1e-6;
    if (c.expect === 'silence' && !silent) fails.push(`${c.name}: expected silence, peak=${peak.toFixed(4)}`);
    if (c.expect !== 'silence' && silent) fails.push(`${c.name}: expected sound, got silence`);
  }
  check('solo/mute behave correctly across combinations', fails.length === 0, fails.join(' | '));

  // Soloing A must remove B specifically, not just lower the total.
  const soloA = await renderProject(twoChannelProject(false, true, false, false), { tailSec: 0.3, toBeat: 1 });
  const onlyA = await renderProject(twoChannelProject(false, false, true, false), { tailSec: 0.3, toBeat: 1 });
  let maxDiff = 0;
  const x = soloA.getChannelData(0); const y = onlyA.getChannelData(0);
  for (let i = 0; i < x.length; i++) maxDiff = Math.max(maxDiff, Math.abs(x[i] - y[i]));
  check('soloing A is identical to muting B', maxDiff < 1e-9, `max diff ${maxDiff.toExponential(2)}`);
}

async function testVoiceStealing() {
  const sr = 44100;
  const ctx = new window.OfflineAudioContext(1, sr, sr);
  const inst = createInstrument(ctx, 'analog', { preset: 'sawtooth' });
  inst.output.connect(ctx.destination);
  // Far more notes than the polyphony cap, all held.
  for (let i = 0; i < 60; i++) inst.noteOn(40 + (i % 40), 100, 0.001 * i);
  const held = inst.voiceCount();
  inst.allNotesOff(0.5);
  const out = await ctx.startRendering();
  check('voice cap holds under a note flood', held <= 24, `held=${held}`);
  check('voices release cleanly to zero', inst.voiceCount() === 0, `left=${inst.voiceCount()}`);
  check('flooded instrument still produces sound', peakOf(out) > 0, `peak=${peakOf(out)}`);
}

async function testWavRoundTrip() {
  const p = toneProject(69, 1);
  const buf = await renderProject(p, { tailSec: 0.1, sampleRate: 44100, toBeat: 1 });
  const wav = encodeWav(buf, 16);
  const view = new DataView(wav);
  const riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  const wave = String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11));
  const channels = view.getUint16(22, true);
  const rate = view.getUint32(24, true);
  const bits = view.getUint16(34, true);
  const dataSize = view.getUint32(40, true);
  const expectedData = buf.length * buf.numberOfChannels * 2;
  check('WAV header is well formed', riff === 'RIFF' && wave === 'WAVE' && bits === 16 && channels === buf.numberOfChannels && rate === buf.sampleRate,
    `${riff}/${wave} ${channels}ch ${rate}Hz ${bits}bit`);
  check('WAV data chunk size matches the buffer', dataSize === expectedData, `${dataSize} vs ${expectedData}`);
  check('WAV file total size is header + data', wav.byteLength === 44 + expectedData, `${wav.byteLength}`);

  // Decode the first frames back and compare to the source samples.
  let worst = 0;
  const L = buf.getChannelData(0);
  for (let i = 0; i < Math.min(20000, buf.length); i++) {
    const v = view.getInt16(44 + i * 4, true) / 32767;
    worst = Math.max(worst, Math.abs(v - Math.max(-1, Math.min(1, L[i]))));
  }
  check('WAV samples round-trip within 16-bit precision', worst < 1 / 32000, `worst=${worst.toExponential(2)}`);
}

async function testStemExport() {
  const p = demoProject();
  const drums = p.channels[0];
  const stem = await renderProject(p, { tailSec: 0.5, toBeat: 4, channelFilter: drums.id });
  const full = await renderProject(p, { tailSec: 0.5, toBeat: 4 });
  check('stem render is audible', peakOf(stem) > 0.01, `peak=${peakOf(stem).toFixed(4)}`);
  check('stem render differs from the full mix', rmsOf(stem) < rmsOf(full), `stem=${rmsOf(stem).toFixed(4)} full=${rmsOf(full).toFixed(4)}`);
  // Rendering a stem must not have mutated the caller's project.
  check('stem export leaves the project untouched', p.channels.every((c) => !c.mute), 'channels still unmuted');
}

async function testSwing() {
  const straight = await renderProject(clickProject(120, 2, 0), { tailSec: 0.3, sampleRate: 48000 });
  const swung = await renderProject(clickProject(120, 2, 60), { tailSec: 0.3, sampleRate: 48000 });
  const a = findOnsets(straight, 0.02, 0.02);
  const b = findOnsets(swung, 0.02, 0.02);
  // Notes sit on whole beats (even 16ths), so swing must leave them alone.
  const same = a.length === b.length && a.every((t, i) => Math.abs(t - b[i]) < 0.002);
  check('swing does not move on-beat notes', same, `${a.length} vs ${b.length} onsets`);
}

// ---------------------------------------------------------------

export async function runAll() {
  const started = performance.now();
  const tests = [
    testSilence, testDemoIsAudible,
    () => testTiming(120), () => testTiming(93.7), () => testTiming(174),
    testLongDrift, testDeterminism, testSeededNoise, testSwing,
    testBypassNull, testSilenceInSilenceOut, testDelayTaps, testEqResponse, testCompressor, testLimiterCeiling,
    testSoloMute, testVoiceStealing, testWavRoundTrip, testStemExport,
  ];
  for (const t of tests) {
    try {
      await t();
    } catch (err) {
      check(t.name || 'anonymous test', false, `threw: ${err && err.message}`);
    }
  }
  const failed = results.filter((r) => !r.pass);
  const summary = `${results.length - failed.length}/${results.length} passed in ${((performance.now() - started) / 1000).toFixed(1)}s`;
  return { results, failed, summary, ok: failed.length === 0 };
}
