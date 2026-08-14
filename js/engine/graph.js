// ============================================================
// SlipDAW — audio graph construction and event collection
//
// This module is the piece that both the live engine and the offline
// renderer share. Given a context and a project it builds the identical
// graph, and given a beat window it produces the identical event list. That
// is why what you hear and what you export are the same thing rather than
// two implementations that drift apart.
// ============================================================

import { createInstrument } from './instruments.js';
import { createEffect } from './effects.js';
import { beatsToSec, clamp } from '../util.js';
import { findPattern } from '../model/project.js';

/** Swing: push odd 16ths later, the same feel the Trap Machine's stepDelay()
 *  produces, expressed as a position offset in beats so it works for freely
 *  placed piano-roll notes and not just a 16-step grid. */
export function swungBeat(beat, swingPercent) {
  if (!swingPercent) return beat;
  const sixteenth = Math.floor(beat * 4 + 1e-9);
  if (sixteenth % 2 === 0) return beat;
  return beat + (clamp(swingPercent, 0, 100) / 100) * 0.125;
}

/**
 * Build the mixer graph.
 * Returns insert strips, return buses, master, and a per-channel input node.
 *
 * Signal flow per insert:
 *   input ─▶ [fx…] ─▶ panner ─▶ fader ─┬─▶ master input
 *                                       ├─▶ sendA ─▶ Reverb bus
 *                                       └─▶ sendB ─▶ Delay bus
 * Sends are taken post-fader, so pulling a channel down takes its reverb
 * with it — the behaviour people expect from a mixing desk.
 */
export function buildGraph(ctx, project, { destination = null } = {}) {
  const dest = destination || ctx.destination;
  const inserts = [];
  const disposers = [];

  const soloedInserts = project.mixer.inserts.some((i, idx) => idx > 0 && i.solo);

  function buildFxChain(fxList, input, output) {
    let node = input;
    const built = [];
    (fxList || []).forEach((fx) => {
      const eff = createEffect(ctx, fx.type, { ...(fx.params || {}), bypass: !!fx.bypass });
      node.connect(eff.input);
      node = eff.output;
      built.push(eff);
      disposers.push(() => eff.dispose());
    });
    node.connect(output);
    return built;
  }

  // --- master first, so inserts have something to connect to ---
  const masterCfg = project.mixer.inserts[0];
  const masterIn = ctx.createGain();
  const masterFxOut = ctx.createGain();
  const masterFx = buildFxChain(masterCfg.fx, masterIn, masterFxOut);
  const masterFader = ctx.createGain();
  masterFader.gain.value = masterCfg.mute ? 0 : masterCfg.volume;
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  masterFxOut.connect(masterFader);
  masterFader.connect(analyser);
  masterFader.connect(dest);

  const master = { cfg: masterCfg, input: masterIn, fader: masterFader, fx: masterFx, analyser };

  // --- return buses ---
  const returns = (project.mixer.returns || []).map((r) => {
    const input = ctx.createGain();
    const out = ctx.createGain();
    const fx = buildFxChain(r.fx, input, out);
    const fader = ctx.createGain();
    fader.gain.value = r.volume ?? 0.7;
    out.connect(fader);
    fader.connect(masterIn);
    return { cfg: r, input, fader, fx };
  });

  // --- inserts 1..n ---
  project.mixer.inserts.forEach((cfg, idx) => {
    if (idx === 0) { inserts.push(master); return; }
    const input = ctx.createGain();
    const fxOut = ctx.createGain();
    const fx = buildFxChain(cfg.fx, input, fxOut);
    const panner = ctx.createStereoPanner();
    panner.pan.value = clamp(cfg.pan || 0, -1, 1);
    const fader = ctx.createGain();
    const audible = !cfg.mute && (!soloedInserts || cfg.solo);
    fader.gain.value = audible ? cfg.volume : 0;

    fxOut.connect(panner);
    panner.connect(fader);
    fader.connect(masterIn);

    const sends = (cfg.sends || [0, 0]).map((amount, i) => {
      const g = ctx.createGain();
      g.gain.value = amount || 0;
      fader.connect(g);
      if (returns[i]) g.connect(returns[i].input);
      return g;
    });

    inserts.push({ cfg, input, fader, panner, fx, sends });
  });

  // --- instruments, one per channel, routed to its insert ---
  const soloedChannels = project.channels.some((c) => c.solo);
  const channels = new Map();
  project.channels.forEach((ch) => {
    const inst = createInstrument(ctx, ch.instrument, { ...(ch.params || {}) });
    const gate = ctx.createGain();
    const audible = !ch.mute && (!soloedChannels || ch.solo);
    gate.gain.value = audible ? 1 : 0;
    inst.output.connect(gate);
    const target = inserts[ch.insert] || master;
    gate.connect(target.input);
    channels.set(ch.id, { cfg: ch, inst, gate, insertIndex: ch.insert });
    disposers.push(() => inst.dispose());
  });

  return {
    ctx,
    master,
    inserts,
    returns,
    channels,
    analyser,
    dispose() {
      disposers.forEach((d) => { try { d(); } catch {} });
      try { masterIn.disconnect(); masterFader.disconnect(); analyser.disconnect(); } catch {}
    },
  };
}

// ---------------------------------------------------------------
// Event collection
// ---------------------------------------------------------------

/**
 * Notes from one pattern, expressed in absolute song beats, for a clip.
 * A clip longer than its pattern repeats it — that is how one 1-bar pattern
 * fills eight bars of playlist without duplicating any note data.
 */
function notesForClip(project, clip, fromBeat, toBeat, out) {
  const pattern = findPattern(project, clip.ref);
  if (!pattern) return;
  const patLen = Math.max(0.0625, pattern.lengthBeats);
  const clipEnd = clip.start + clip.length;

  const firstRep = Math.max(0, Math.floor((fromBeat - clip.start) / patLen));
  const lastRep = Math.ceil((Math.min(toBeat, clipEnd) - clip.start) / patLen);

  for (let rep = firstRep; rep <= lastRep; rep++) {
    const base = clip.start + rep * patLen;
    if (base >= clipEnd) break;
    Object.keys(pattern.notes).forEach((channelId) => {
      pattern.notes[channelId].forEach((n) => {
        const at = swungBeat(base + n.beat, project.swing);
        if (at < fromBeat || at >= toBeat) return;
        if (at >= clipEnd) return;
        out.push({
          beat: at,
          channelId,
          pitch: n.pitch,
          vel: n.vel ?? 100,
          durBeats: n.dur ?? 0.25,
          gain: clip.gain ?? 1,
        });
      });
    });
  }
}

/**
 * All note events in [fromBeat, toBeat).
 *
 * mode 'pattern' loops the selected pattern (FL's PAT button); mode 'song'
 * plays the playlist.
 *
 * Clips are pre-sorted and scanned from a binary-searched lower bound rather
 * than filtering the whole song on every 25ms tick. On a short demo that is
 * invisible; on a real arrangement with thousands of clips, scanning
 * everything every tick is exactly what makes a browser DAW stutter.
 */
export function collectEvents(project, fromBeat, toBeat, mode, index) {
  const out = [];
  if (toBeat <= fromBeat) return out;

  if (mode === 'pattern') {
    const pattern = findPattern(project, project.selection.patternId);
    if (!pattern) return out;
    const len = Math.max(0.0625, pattern.lengthBeats);
    const firstRep = Math.floor(fromBeat / len);
    const lastRep = Math.ceil(toBeat / len);
    for (let rep = firstRep; rep <= lastRep; rep++) {
      const base = rep * len;
      Object.keys(pattern.notes).forEach((channelId) => {
        pattern.notes[channelId].forEach((n) => {
          const at = swungBeat(base + n.beat, project.swing);
          if (at < fromBeat || at >= toBeat) return;
          out.push({
            beat: at, channelId, pitch: n.pitch, vel: n.vel ?? 100,
            durBeats: n.dur ?? 0.25, gain: 1,
          });
        });
      });
    }
    return out;
  }

  const idx = index || buildClipIndex(project);
  const lower = fromBeat - idx.maxLength;
  let i = lowerBound(idx.patternClips, lower);
  for (; i < idx.patternClips.length; i++) {
    const entry = idx.patternClips[i];
    if (entry.clip.start >= toBeat) break;
    if (entry.trackMuted) continue;
    if (entry.clip.start + entry.clip.length <= fromBeat) continue;
    notesForClip(project, entry.clip, fromBeat, toBeat, out);
  }
  return out;
}

/** Audio clips starting inside the window — these are scheduled as buffer
 *  sources rather than notes. */
export function collectAudioClips(project, fromBeat, toBeat, index) {
  const idx = index || buildClipIndex(project);
  const hits = [];
  let i = lowerBound(idx.audioClips, fromBeat - idx.maxLength);
  for (; i < idx.audioClips.length; i++) {
    const entry = idx.audioClips[i];
    if (entry.clip.start >= toBeat) break;
    if (entry.trackMuted) continue;
    if (entry.clip.start < fromBeat) continue; // only trigger on its start
    hits.push(entry);
  }
  return hits;
}

export function buildClipIndex(project) {
  const patternClips = [];
  const audioClips = [];
  let maxLength = 4;
  project.playlist.tracks.forEach((track) => {
    track.clips.forEach((clip) => {
      maxLength = Math.max(maxLength, clip.length);
      const entry = { clip, track, trackMuted: !!track.mute };
      if (clip.type === 'audio') audioClips.push(entry);
      else patternClips.push(entry);
    });
  });
  patternClips.sort((a, b) => a.clip.start - b.clip.start);
  audioClips.sort((a, b) => a.clip.start - b.clip.start);
  return { patternClips, audioClips, maxLength };
}

function lowerBound(arr, beat) {
  let lo = 0; let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].clip.start < beat) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** Fire one collected event into its instrument. Shared by live playback and
 *  offline render so a note can never sound different between the two. */
export function fireEvent(graph, project, ev, timeAtBeat) {
  const chan = graph.channels.get(ev.channelId);
  if (!chan) return;
  const when = timeAtBeat(ev.beat);
  const durSec = beatsToSec(ev.durBeats, project.bpm);
  chan.inst.playNote(ev.pitch, Math.round(ev.vel * (ev.gain ?? 1)), when, durSec);
}
