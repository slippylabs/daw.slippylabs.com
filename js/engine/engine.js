// ============================================================
// SlipDAW — live transport and scheduler
//
// The scheduler is the Chris-Wilson lookahead pattern (a coarse setInterval
// waking up often enough to schedule sample-accurate events a little way
// into the future), generalised from the Trap Machine's 16 fixed steps to
// arbitrary beat positions on a playlist.
//
// Timing rule: note times are derived from an *anchor* (a known
// AudioContext time paired with a known beat) plus an exact beat offset.
// Nothing accumulates a running "+= stepDelay" in floating point, and
// nothing reads ctx.currentTime to decide when a note lands — that is what
// keeps a five-minute render free of drift.
// ============================================================

import { buildGraph, collectEvents, collectAudioClips, buildClipIndex, fireEvent } from './graph.js';
import { beatsToSec, secToBeats, clamp } from '../util.js';
import { songLengthBeats } from '../model/project.js';

const LOOKAHEAD_MS = 25;
const SCHEDULE_AHEAD = 0.12;

export class Engine {
  constructor() {
    this.ctx = null;
    this.graph = null;
    this.project = null;
    this.playing = false;
    this.mode = 'pattern';        // 'pattern' | 'song'
    this.loopEnabled = true;
    this.metronome = false;
    this.timer = null;
    this.anchors = [];            // [{ time, beat }] — newest last
    this.schedBeat = 0;
    this.startBeat = 0;
    this.clipIndex = null;
    this.audioBuffers = new Map();  // assetId -> AudioBuffer
    this.onTick = null;
    this._pendingRebuild = false;
  }

  /** The AudioContext can only start from a user gesture; every entry point
   *  funnels through here so no caller has to remember that. */
  async ensureContext() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC({ latencyHint: 'interactive' });
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    return this.ctx;
  }

  setProject(project) {
    this.project = project;
    this.clipIndex = buildClipIndex(project);
    if (this.ctx) this.rebuild();
  }

  /** Tear down and rebuild the whole mixer graph. Called when structure
   *  changes (a channel added, an effect inserted). Cheap enough at this
   *  size, and far less bug-prone than surgically patching a live graph. */
  rebuild() {
    if (!this.ctx || !this.project) return;
    const wasPlaying = this.playing;
    const at = this.currentBeat();
    if (this.graph) this.graph.dispose();
    this.graph = buildGraph(this.ctx, this.project);
    this.clipIndex = buildClipIndex(this.project);
    if (wasPlaying) {
      this.stop(true);
      this.play(at);
    }
  }

  /** Light-touch updates that don't need a rebuild — faders, pans, mutes.
   *  Rebuilding on every fader move would click and drop voices. */
  syncMixer() {
    if (!this.graph || !this.project) return;
    const soloedInserts = this.project.mixer.inserts.some((i, idx) => idx > 0 && i.solo);
    this.project.mixer.inserts.forEach((cfg, idx) => {
      const strip = this.graph.inserts[idx];
      if (!strip) return;
      const audible = idx === 0 ? !cfg.mute : (!cfg.mute && (!soloedInserts || cfg.solo));
      strip.fader.gain.setTargetAtTime(audible ? cfg.volume : 0, this.ctx.currentTime, 0.02);
      if (strip.panner) strip.panner.pan.setTargetAtTime(clamp(cfg.pan || 0, -1, 1), this.ctx.currentTime, 0.02);
      (strip.sends || []).forEach((g, i) => {
        g.gain.setTargetAtTime((cfg.sends && cfg.sends[i]) || 0, this.ctx.currentTime, 0.02);
      });
    });
    const soloedChannels = this.project.channels.some((c) => c.solo);
    this.project.channels.forEach((ch) => {
      const node = this.graph.channels.get(ch.id);
      if (!node) return;
      const audible = !ch.mute && (!soloedChannels || ch.solo);
      node.gate.gain.setTargetAtTime(audible ? 1 : 0, this.ctx.currentTime, 0.015);
    });
  }

  setEffectParam(insertIndex, fxIndex, name, value) {
    const strip = this.graph && this.graph.inserts[insertIndex];
    if (strip && strip.fx[fxIndex]) strip.fx[fxIndex].setParam(name, value);
  }

  setInstrumentParam(channelId, name, value) {
    const node = this.graph && this.graph.channels.get(channelId);
    if (node) node.inst.setParam(name, value);
  }

  /** Play a note right now, for the on-screen keyboard and MIDI input. */
  previewOn(channelId, pitch, vel = 100) {
    if (!this.graph) return;
    const node = this.graph.channels.get(channelId);
    if (node) node.inst.noteOn(pitch, vel, this.ctx.currentTime);
  }
  previewOff(channelId, pitch) {
    if (!this.graph) return;
    const node = this.graph.channels.get(channelId);
    if (node) node.inst.noteOff(pitch, this.ctx.currentTime);
  }

  loopRange() {
    if (this.mode === 'pattern') {
      const pat = this.project.patterns.find((p) => p.id === this.project.selection.patternId);
      return [0, pat ? Math.max(0.25, pat.lengthBeats) : 4];
    }
    return [0, songLengthBeats(this.project)];
  }

  play(fromBeat = 0) {
    if (!this.ctx || !this.graph) return;
    this.playing = true;
    const start = this.ctx.currentTime + 0.06;
    this.startBeat = fromBeat;
    this.schedBeat = fromBeat;
    this.anchors = [{ time: start, beat: fromBeat }];
    this.lastMetroBeat = Math.floor(fromBeat) - 1;
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this._tick(), LOOKAHEAD_MS);
    this._tick();
  }

  stop(keepPosition = false) {
    this.playing = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.graph) {
      const now = this.ctx ? this.ctx.currentTime : 0;
      this.graph.channels.forEach((c) => c.inst.allNotesOff(now));
      (this._liveSources || []).forEach((s) => { try { s.stop(); } catch {} });
    }
    this._liveSources = [];
    if (!keepPosition) { this.schedBeat = this.startBeat; this.anchors = []; }
  }

  /** Where the playhead is, in beats. Derived from the newest anchor whose
   *  time has actually arrived, so a loop wrap doesn't make it jump early. */
  currentBeat() {
    if (!this.playing || !this.ctx || !this.anchors.length) return this.schedBeat;
    const now = this.ctx.currentTime;
    let a = this.anchors[0];
    for (let i = this.anchors.length - 1; i >= 0; i--) {
      if (this.anchors[i].time <= now) { a = this.anchors[i]; break; }
    }
    return a.beat + secToBeats(now - a.time, this.project.bpm);
  }

  _timeAtBeat(beat) {
    const a = this.anchors[this.anchors.length - 1];
    return a.time + beatsToSec(beat - a.beat, this.project.bpm);
  }

  _tick() {
    if (!this.playing || !this.project || !this.graph) return;
    const { bpm } = this.project;
    const horizon = this.ctx.currentTime + SCHEDULE_AHEAD;
    const [loopStart, loopEnd] = this.loopRange();

    // Prune anchors we have already passed, keeping one for the playhead.
    while (this.anchors.length > 1 && this.anchors[1].time <= this.ctx.currentTime - 1) {
      this.anchors.shift();
    }

    for (let guard = 0; guard < 64; guard++) {
      const anchor = this.anchors[this.anchors.length - 1];
      const availBeat = anchor.beat + secToBeats(horizon - anchor.time, bpm);
      const segEnd = this.loopEnabled ? Math.min(availBeat, loopEnd) : availBeat;
      if (segEnd <= this.schedBeat) break;

      const events = collectEvents(this.project, this.schedBeat, segEnd, this.mode, this.clipIndex);
      events.forEach((ev) => fireEvent(this.graph, this.project, ev, (b) => this._timeAtBeat(b)));

      if (this.mode === 'song') this._scheduleAudioClips(this.schedBeat, segEnd);
      if (this.metronome) this._scheduleMetronome(this.schedBeat, segEnd);

      this.schedBeat = segEnd;

      if (this.loopEnabled && this.schedBeat >= loopEnd - 1e-9) {
        // Re-anchor exactly at the loop point. Because the new anchor time is
        // computed from the old one, wrap after wrap accumulates no error.
        const wrapTime = this._timeAtBeat(loopEnd);
        this.anchors.push({ time: wrapTime, beat: loopStart });
        this.schedBeat = loopStart;
        this.lastMetroBeat = Math.floor(loopStart) - 1;
      } else break;
    }

    if (this.onTick) this.onTick(this.currentBeat());
  }

  _scheduleAudioClips(fromBeat, toBeat) {
    const hits = collectAudioClips(this.project, fromBeat, toBeat, this.clipIndex);
    this._liveSources = this._liveSources || [];
    hits.forEach(({ clip, track }) => {
      const buffer = this.audioBuffers.get(clip.ref);
      if (!buffer) return;
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      const g = this.ctx.createGain();
      g.gain.value = clip.gain ?? 1;
      src.connect(g);
      const strip = this.graph.inserts[track.insert || 0] || this.graph.master;
      g.connect(strip.input);
      const when = this._timeAtBeat(clip.start);
      const offsetSec = beatsToSec(clip.offset || 0, this.project.bpm);
      const durSec = beatsToSec(clip.length, this.project.bpm);
      try { src.start(when, offsetSec, durSec); } catch {}
      this._liveSources.push(src);
    });
  }

  _scheduleMetronome(fromBeat, toBeat) {
    const first = Math.ceil(fromBeat - 1e-9);
    for (let b = first; b < toBeat; b++) {
      if (b <= this.lastMetroBeat) continue;
      this.lastMetroBeat = b;
      const when = this._timeAtBeat(b);
      const accent = Math.round(b) % (this.project.beatsPerBar || 4) === 0;
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = accent ? 1600 : 1000;
      g.gain.setValueAtTime(0.0001, when);
      g.gain.linearRampToValueAtTime(accent ? 0.16 : 0.09, when + 0.001);
      g.gain.exponentialRampToValueAtTime(0.0001, when + 0.045);
      osc.connect(g);
      g.connect(this.graph.master.input);
      osc.start(when);
      osc.stop(when + 0.06);
    }
  }
}
