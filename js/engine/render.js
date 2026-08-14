// ============================================================
// SlipDAW — offline render and WAV export
//
// This is the real export path, and it is also the test harness: because
// every instrument and effect takes a context as an argument, the identical
// graph can be built against an OfflineAudioContext and rendered faster than
// real time. Nothing here records the speakers.
//
// Scheduling offline is simpler than live — there is no deadline, so every
// event in the song is scheduled up front in one pass instead of through a
// lookahead window.
// ============================================================

import { buildGraph, collectEvents, collectAudioClips, buildClipIndex, fireEvent } from './graph.js';
import { beatsToSec } from '../util.js';
import { songLengthBeats } from '../model/project.js';
import { clone as deepClone } from '../util.js';

/** Copy an AudioBuffer into a different context, resampling linearly if the
 *  rates differ. Buffers are bound to the context that made them, so an
 *  imported sample cannot be handed straight to the offline renderer. */
function transferBuffer(buffer, ctx) {
  if (!buffer) return null;
  const ratio = ctx.sampleRate / buffer.sampleRate;
  const frames = Math.max(1, Math.round(buffer.length * ratio));
  const out = ctx.createBuffer(buffer.numberOfChannels, frames, ctx.sampleRate);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const src = buffer.getChannelData(ch);
    const dst = out.getChannelData(ch);
    if (Math.abs(ratio - 1) < 1e-9) {
      dst.set(src.subarray(0, frames));
    } else {
      for (let i = 0; i < frames; i++) {
        const pos = i / ratio;
        const i0 = Math.floor(pos);
        const i1 = Math.min(src.length - 1, i0 + 1);
        const frac = pos - i0;
        dst[i] = src[i0] * (1 - frac) + src[i1] * frac;
      }
    }
  }
  return out;
}

/**
 * Render a project (or a beat range of it) to an AudioBuffer.
 *
 * `tailSec` matters: a reverb or a long release that is still sounding when
 * the last bar ends would be chopped off mid-decay without it, which is the
 * classic "my export sounds cut short" bug.
 */
export async function renderProject(project, opts = {}) {
  const {
    sampleRate = 44100,
    tailSec = 2.5,
    audioBuffers = new Map(),
    mode = 'song',
    fromBeat = 0,
    toBeat = null,
    channelFilter = null,     // render only this channel id (stem export)
  } = opts;

  const end = toBeat !== null ? toBeat : songLengthBeats(project);
  const durationSec = beatsToSec(Math.max(0.25, end - fromBeat), project.bpm) + tailSec;
  const frames = Math.max(1, Math.ceil(durationSec * sampleRate));

  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new OAC(2, frames, sampleRate);

  // Render a copy: a stem render mutes channels, and mutating the user's
  // live project to do that would be visible in the UI mid-export.
  const proj = deepClone(project);
  if (channelFilter) {
    proj.channels.forEach((c) => { c.mute = c.id !== channelFilter; c.solo = false; });
    proj.mixer.inserts.forEach((i) => { i.solo = false; });
  }

  // Buffers are bound to the context that made them, so every asset has to be
  // copied into this offline context before the graph can use it — otherwise a
  // sampled drum slot or a sampler channel renders silent.
  const offlineBuffers = new Map();
  audioBuffers.forEach((buf, id) => {
    const t = transferBuffer(buf, ctx);
    if (t) offlineBuffers.set(id, t);
  });

  const graph = buildGraph(ctx, proj, { audioBuffers: offlineBuffers });
  const index = buildClipIndex(proj);
  const timeAtBeat = (b) => beatsToSec(b - fromBeat, proj.bpm);

  // Notes: one pass over the whole range.
  const events = collectEvents(proj, fromBeat, end, mode, index);
  events.forEach((ev) => fireEvent(graph, proj, ev, timeAtBeat));

  // Audio clips.
  if (mode === 'song') {
    const clips = collectAudioClips(proj, fromBeat, end, index);
    clips.forEach(({ clip, track }) => {
      const buf = offlineBuffers.get(clip.ref);
      if (!buf) return;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const g = ctx.createGain();
      g.gain.value = clip.gain ?? 1;
      src.connect(g);
      const strip = graph.inserts[track.insert || 0] || graph.master;
      g.connect(strip.input);
      try {
        src.start(
          timeAtBeat(clip.start),
          beatsToSec(clip.offset || 0, proj.bpm),
          beatsToSec(clip.length, proj.bpm),
        );
      } catch { /* clip starts before the render window */ }
    });
  }

  const rendered = await ctx.startRendering();
  graph.dispose();
  return rendered;
}

/**
 * Encode an AudioBuffer as a RIFF/WAVE file.
 *
 * The two things that go wrong here are channel interleaving and little-endian
 * byte order, and both produce a file that still opens — just noise, or one
 * channel, or half speed. The round-trip test decodes the output in Python
 * and compares samples, which is the only way to actually catch that.
 */
export function encodeWav(buffer, bitDepth = 16) {
  const numCh = buffer.numberOfChannels;
  const numFrames = buffer.length;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numCh * bytesPerSample;
  const dataSize = numFrames * blockAlign;
  const out = new ArrayBuffer(44 + dataSize);
  const view = new DataView(out);

  const writeStr = (offset, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);            // PCM chunk size
  view.setUint16(20, 1, true);             // format: PCM
  view.setUint16(22, numCh, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  const channels = [];
  for (let c = 0; c < numCh; c++) channels.push(buffer.getChannelData(c));

  let offset = 44;
  const maxVal = Math.pow(2, bitDepth - 1) - 1;
  for (let i = 0; i < numFrames; i++) {
    for (let c = 0; c < numCh; c++) {
      let s = channels[c][i];
      s = s < -1 ? -1 : s > 1 ? 1 : s;
      const v = Math.round(s * maxVal);
      if (bitDepth === 16) {
        view.setInt16(offset, v, true);
        offset += 2;
      } else {
        // 24-bit has no DataView helper — write three little-endian bytes.
        const u = v < 0 ? v + 0x1000000 : v;
        view.setUint8(offset, u & 0xff);
        view.setUint8(offset + 1, (u >> 8) & 0xff);
        view.setUint8(offset + 2, (u >> 16) & 0xff);
        offset += 3;
      }
    }
  }
  return out;
}

export function peakOf(buffer) {
  let peak = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      const a = Math.abs(d[i]);
      if (a > peak) peak = a;
    }
  }
  return peak;
}

export function rmsOf(buffer) {
  let sum = 0; let n = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) { sum += d[i] * d[i]; n++; }
  }
  return n ? Math.sqrt(sum / n) : 0;
}
