// ============================================================
// SlipDAW — application shell
//
// Owns the project document, the undo stack, and the wiring between the UI
// and the audio engine. The engine never reads the DOM and the views never
// touch AudioNodes; everything meets here.
// ============================================================

import { Engine } from './engine/engine.js';
import { renderProject, encodeWav, peakOf } from './engine/render.js';
import { buildClipIndex } from './engine/graph.js';
import {
  demoProject, emptyProject, normalizeProject, createChannel, createPattern,
  createInsert, createPlaylistTrack, createClip, findPattern, findChannel,
  songLengthBeats, PPQ_SNAP, TRACK_COLORS,
} from './model/project.js';
import { INSTRUMENT_TYPES, DRUM_VOICES } from './engine/instruments.js';
import { EFFECT_TYPES } from './engine/effects.js';
import { PianoRoll } from './ui/pianoroll.js';
import { Playlist } from './ui/playlist.js';
import { MixerView, renderPluginWindow, instrumentSpec, effectSpec } from './ui/mixer.js';
import {
  saveProjectLocal, loadProjectLocal, clearProjectLocal,
  putAsset, getAsset, downloadBlob,
} from './io/storage.js';
import { clone, clamp, midiToName, isBlackKey, formatPosition, uid } from './util.js';

const $ = (id) => document.getElementById(id);

class App {
  constructor() {
    this.engine = new Engine();
    this.project = null;
    this.undoStack = [];
    this.redoStack = [];
    this.view = 'playlist';
    this.heldKeys = new Set();
    this.autosaveTimer = null;
    this.recording = null;
    this.started = false;
  }

  // ---------- lifecycle ----------

  async start() {
    await this.engine.ensureContext();
    const saved = loadProjectLocal();
    this.project = saved ? normalizeProject(saved) : demoProject();
    this.engine.setProject(this.project);
    this.engine.rebuild();
    await this.reloadAssets();

    this.piano = new PianoRoll($('pr-canvas'), $('pr-wrap'), this);
    this.playlist = new Playlist($('pl-canvas'), $('pl-wrap'), this);
    this.mixer = new MixerView($('mixer-scroll'), this);

    this.bindUI();
    this.buildKeyboard();
    this.renderAll();
    this.started = true;
    this.loop();
    this.toast(saved ? 'Loaded your last session.' : 'Demo song loaded — press play.');
  }

  /** Audio assets live in IndexedDB, not in the project JSON, so they have to
   *  be pulled back in and handed to the engine after a reload. */
  async reloadAssets() {
    for (const asset of this.project.audioAssets) {
      const buf = await getAsset(asset.id, this.engine.ctx);
      if (buf) this.engine.audioBuffers.set(asset.id, buf);
    }
  }

  selectedPattern() { return findPattern(this.project, this.project.selection.patternId); }
  selectedChannel() { return findChannel(this.project, this.project.selection.channelId); }

  // ---------- undo ----------

  pushUndo() {
    this.undoStack.push(clone(this.project));
    if (this.undoStack.length > 60) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  undo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(clone(this.project));
    this.project = normalizeProject(this.undoStack.pop());
    this.afterStructuralChange();
    this.toast('Undo');
  }

  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(clone(this.project));
    this.project = normalizeProject(this.redoStack.pop());
    this.afterStructuralChange();
    this.toast('Redo');
  }

  afterStructuralChange() {
    this.engine.setProject(this.project);
    this.engine.rebuild();
    this.renderAll();
    this.autosave();
  }

  rebuildIndex() { this.engine.clipIndex = buildClipIndex(this.project); }

  // ---------- persistence ----------

  autosave() { saveProjectLocal(this.project); }
  autosaveSoon() {
    clearTimeout(this.autosaveTimer);
    this.autosaveTimer = setTimeout(() => this.autosave(), 700);
  }

  // ---------- rendering ----------

  touch() { this.drawCurrentView(); }

  renderAll() {
    this.renderRack();
    this.renderPatternSelect();
    this.mixer.render();
    this.drawCurrentView();
    $('bpm').value = this.project.bpm;
    $('swing').value = this.project.swing;
  }

  drawCurrentView(beat = null) {
    const b = beat === null ? (this.engine.playing ? this.engine.currentBeat() : null) : beat;
    if (this.view === 'piano') this.piano.draw(b);
    else if (this.view === 'playlist') this.playlist.draw(b);
  }

  setView(v) {
    this.view = v;
    document.querySelectorAll('.tabs .mini[data-view]').forEach((b) => {
      b.classList.toggle('on', b.dataset.view === v);
    });
    document.querySelectorAll('.pane').forEach((p) => {
      p.classList.toggle('show', p.dataset.pane === v);
    });
    if (v === 'mixer') this.mixer.render();
    this.drawCurrentView();
  }

  // ---------- channel rack ----------

  /** One row per playable thing. A drum kit shows its eight voices; a melodic
   *  instrument shows a single row pinned to one note, because a step grid is
   *  for rhythm and the piano roll is where pitch is edited. */
  rowsFor(ch) {
    if (ch.instrument === 'drumkit' && !ch.pitched) {
      return DRUM_VOICES.map((v) => ({ pitch: v.pitch, label: v.name }));
    }
    return [{ pitch: ch.stepPitch ?? 60, label: midiToName(ch.stepPitch ?? 60) }];
  }

  renderRack() {
    const list = $('rack-list');
    list.innerHTML = '';
    const pat = this.selectedPattern();
    const steps = pat ? Math.min(64, Math.round(pat.lengthBeats * 4)) : 16;

    this.project.channels.forEach((ch) => {
      const el = document.createElement('div');
      el.className = `chan${ch.id === this.project.selection.channelId ? ' sel' : ''}`;

      const head = document.createElement('div');
      head.className = 'chan-head';
      const name = document.createElement('div');
      name.className = 'chan-name';
      name.textContent = ch.name;
      name.title = 'Click to select · double-click to open the instrument';
      name.addEventListener('click', () => {
        this.project.selection.channelId = ch.id;
        this.renderRack();
        this.drawCurrentView();
      });
      name.addEventListener('dblclick', () => {
        this.project.selection.channelId = ch.id;
        this.openInstrumentWindow(ch);
      });

      const mk = (label, on, title, fn) => {
        const b = document.createElement('button');
        b.className = `dot-btn${on ? ' on' : ''}${label === 'S' ? ' solo' : ''}`;
        b.textContent = label;
        b.title = title;
        b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
        return b;
      };
      head.append(
        name,
        mk('M', ch.mute, 'Mute', () => {
          ch.mute = !ch.mute; this.engine.syncMixer(); this.renderRack(); this.autosave();
        }),
        mk('S', ch.solo, 'Solo', () => {
          ch.solo = !ch.solo; this.engine.syncMixer(); this.renderRack(); this.autosave();
        }),
        mk('⋯', false, 'Channel options', (e) => this.channelMenu(ch)),
      );
      el.appendChild(head);

      if (pat) {
        if (!pat.notes[ch.id]) pat.notes[ch.id] = [];
        const notes = pat.notes[ch.id];
        this.rowsFor(ch).forEach((row) => {
          const r = document.createElement('div');
          r.className = 'steprow';
          const lbl = document.createElement('span');
          lbl.className = 'lbl';
          lbl.textContent = row.label;
          r.appendChild(lbl);
          const grid = document.createElement('div');
          grid.className = 'steps';
          grid.style.flex = '1';
          for (let i = 0; i < steps; i++) {
            const beat = i * 0.25;
            const on = notes.some((n) => n.pitch === row.pitch && Math.abs(n.beat - beat) < 1e-6);
            const b = document.createElement('button');
            b.className = `step${i % 4 === 0 ? ' beat' : ''}${on ? ' on' : ''}`;
            b.dataset.step = i;
            b.dataset.pitch = row.pitch;
            b.addEventListener('click', () => {
              this.pushUndo();
              const idx = notes.findIndex((n) => n.pitch === row.pitch && Math.abs(n.beat - beat) < 1e-6);
              if (idx >= 0) notes.splice(idx, 1);
              else notes.push({ beat, dur: 0.25, pitch: row.pitch, vel: 100 });
              this.renderRack();
              this.drawCurrentView();
              this.autosave();
            });
            grid.appendChild(b);
          }
          r.appendChild(grid);
          el.appendChild(r);
        });
      }
      list.appendChild(el);
    });
  }

  renderPatternSelect() {
    const sel = $('pattern-select');
    sel.innerHTML = '';
    this.project.patterns.forEach((p) => {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.name;
      sel.appendChild(o);
    });
    sel.value = this.project.selection.patternId || '';
  }

  // ---------- menus ----------

  showMenu(e, items) {
    const menu = $('menu');
    menu.innerHTML = '';
    items.forEach((it) => {
      if (it.header) {
        const h = document.createElement('div');
        h.className = 'hdr';
        h.textContent = it.header;
        menu.appendChild(h);
      } else if (it.sep) {
        const s = document.createElement('div');
        s.className = 'sep';
        menu.appendChild(s);
      } else {
        const b = document.createElement('button');
        b.textContent = it.label;
        b.addEventListener('click', () => { menu.classList.remove('show'); it.action(); });
        menu.appendChild(b);
      }
    });
    menu.classList.add('show');
    // Keep the menu on screen when it opens near a bottom or right edge.
    const x = e.clientX ?? 20;
    const y = e.clientY ?? 20;
    menu.style.left = `${Math.min(x, window.innerWidth - menu.offsetWidth - 8)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - menu.offsetHeight - 8)}px`;
  }

  effectMenu(e, onPick) {
    const groups = [...new Set(EFFECT_TYPES.map((t) => t.group))];
    const items = [];
    groups.forEach((gname) => {
      items.push({ header: gname });
      EFFECT_TYPES.filter((t) => t.group === gname).forEach((t) => {
        items.push({ label: `${t.icon} ${t.name}`, action: () => onPick(t.type) });
      });
    });
    this.showMenu(e, items);
  }

  channelMenu(ch) {
    const e = window.event || { clientX: 200, clientY: 200 };
    const items = [
      { label: 'Open instrument…', action: () => this.openInstrumentWindow(ch) },
      { label: 'Rename…', action: () => {
        const v = prompt('Channel name', ch.name);
        if (v) { this.pushUndo(); ch.name = v; this.renderRack(); this.autosave(); }
      } },
      { header: 'Route to insert' },
    ];
    this.project.mixer.inserts.forEach((ins, i) => {
      items.push({
        label: `${i === 0 ? 'Master' : ins.name}${ch.insert === i ? '  ✓' : ''}`,
        action: () => {
          this.pushUndo(); ch.insert = i; this.engine.rebuild(); this.renderRack(); this.autosave();
        },
      });
    });
    if (ch.instrument === 'drumkit') {
      items.push({ sep: true });
      items.push({
        label: `Pitched 808 mode${ch.pitched ? '  ✓' : ''}`,
        action: () => {
          this.pushUndo();
          ch.pitched = !ch.pitched;
          if (ch.pitched && ch.stepPitch === undefined) ch.stepPitch = 29;
          this.renderRack(); this.touch(); this.autosave();
        },
      });
    }
    if (ch.instrument !== 'drumkit' || ch.pitched) {
      items.push({ header: 'Step note' });
      [24, 29, 34, 48, 55, 60, 64, 67, 72].forEach((p) => {
        items.push({
          label: `${midiToName(p)}${(ch.stepPitch ?? 60) === p ? '  ✓' : ''}`,
          action: () => { this.pushUndo(); ch.stepPitch = p; this.renderRack(); this.autosave(); },
        });
      });
    }
    items.push({ sep: true });
    items.push({ label: 'Delete channel', action: () => {
      if (this.project.channels.length <= 1) { this.toast('Keep at least one channel.'); return; }
      this.pushUndo();
      this.project.channels = this.project.channels.filter((c) => c.id !== ch.id);
      this.project.patterns.forEach((p) => { delete p.notes[ch.id]; });
      if (this.project.selection.channelId === ch.id) {
        this.project.selection.channelId = this.project.channels[0].id;
      }
      this.afterStructuralChange();
    } });
    this.showMenu(e, items);
  }

  trackMenu(e, track) {
    const items = [
      { label: track.mute ? 'Unmute track' : 'Mute track', action: () => {
        this.pushUndo(); track.mute = !track.mute; this.rebuildIndex(); this.touch(); this.autosave();
      } },
      { label: 'Rename…', action: () => {
        const v = prompt('Track name', track.name);
        if (v) { this.pushUndo(); track.name = v; this.touch(); this.autosave(); }
      } },
      { header: 'Audio clips route to' },
    ];
    this.project.mixer.inserts.forEach((ins, i) => {
      items.push({
        label: `${i === 0 ? 'Master' : ins.name}${(track.insert || 0) === i ? '  ✓' : ''}`,
        action: () => { this.pushUndo(); track.insert = i; this.touch(); this.autosave(); },
      });
    });
    items.push({ sep: true });
    items.push({ label: 'Clear clips', action: () => {
      this.pushUndo(); track.clips = []; this.rebuildIndex(); this.touch(); this.autosave();
    } });
    this.showMenu(e, items);
  }

  // ---------- plugin windows ----------

  openWindow(spec) {
    renderPluginWindow($('plug-body'), $('plug-title'), spec, this);
    $('plugwin').classList.add('show');
  }

  openInstrumentWindow(ch) {
    this.openWindow(instrumentSpec(this, ch));
  }

  openEffectWindow(insertIndex, fxIndex) {
    const ins = this.project.mixer.inserts[insertIndex];
    const fx = ins && ins.fx[fxIndex];
    if (!fx) return;
    this.openWindow(effectSpec(this, fx, insertIndex, fxIndex, (name, value) => {
      this.engine.setEffectParam(insertIndex, fxIndex, name, value);
    }));
  }

  openReturnEffectWindow(returnIndex, fxIndex) {
    const bus = this.project.mixer.returns[returnIndex];
    const fx = bus && bus.fx[fxIndex];
    if (!fx) return;
    this.openWindow(effectSpec(this, fx, -1, fxIndex, (name, value) => {
      const live = this.engine.graph && this.engine.graph.returns[returnIndex];
      if (live && live.fx[fxIndex]) live.fx[fxIndex].setParam(name, value);
    }));
  }

  // ---------- transport ----------

  togglePlay() {
    if (this.engine.playing) {
      this.engine.stop();
      $('btn-play').classList.remove('on');
    } else {
      this.engine.play(this.engine.schedBeat || 0);
      $('btn-play').classList.add('on');
    }
  }

  stop() {
    this.engine.stop();
    this.engine.schedBeat = 0;
    $('btn-play').classList.remove('on');
    this.drawCurrentView(null);
  }

  seek(beat) {
    const wasPlaying = this.engine.playing;
    this.engine.stop(true);
    this.engine.schedBeat = beat;
    if (wasPlaying) this.engine.play(beat);
    else this.drawCurrentView(beat);
  }

  setMode(mode) {
    this.engine.mode = mode;
    $('btn-pat').classList.toggle('on', mode === 'pattern');
    $('btn-song').classList.toggle('on', mode === 'song');
    if (this.engine.playing) { this.engine.stop(true); this.engine.play(0); }
  }

  preview(pitch) {
    const ch = this.selectedChannel();
    if (!ch) return;
    this.engine.previewOn(ch.id, pitch, 110);
    setTimeout(() => this.engine.previewOff(ch.id, pitch), 220);
  }

  // ---------- export ----------

  async exportWav(stems = false) {
    const bars = Math.ceil(songLengthBeats(this.project) / (this.project.beatsPerBar || 4));
    this.toast(`Rendering ${bars} bars…`);
    try {
      if (!stems) {
        const buf = await renderProject(this.project, {
          sampleRate: 44100,
          audioBuffers: this.engine.audioBuffers,
          mode: 'song',
        });
        const wav = encodeWav(buf, 16);
        downloadBlob(new Blob([wav], { type: 'audio/wav' }), `${this.safeName()}.wav`);
        this.toast(`Exported — peak ${(20 * Math.log10(Math.max(1e-6, peakOf(buf)))).toFixed(1)} dBFS`);
      } else {
        for (const ch of this.project.channels) {
          const buf = await renderProject(this.project, {
            sampleRate: 44100,
            audioBuffers: this.engine.audioBuffers,
            mode: 'song',
            channelFilter: ch.id,
          });
          const wav = encodeWav(buf, 16);
          downloadBlob(new Blob([wav], { type: 'audio/wav' }), `${this.safeName()} - ${ch.name}.wav`);
        }
        this.toast(`Exported ${this.project.channels.length} stems.`);
      }
    } catch (err) {
      console.error(err);
      this.toast(`Export failed: ${err.message}`);
    }
  }

  safeName() {
    return (this.project.name || 'slipdaw').replace(/[^\w\- ]+/g, '').trim() || 'slipdaw';
  }

  // ---------- audio import / recording ----------

  async importAudioFiles(files) {
    for (const file of files) {
      try {
        const arr = await file.arrayBuffer();
        const buf = await this.engine.ctx.decodeAudioData(arr);
        await this.addAudioAsset(file.name.replace(/\.[^.]+$/, ''), buf);
      } catch (err) {
        this.toast(`Could not decode ${file.name}`);
      }
    }
  }

  async addAudioAsset(name, buf, placeAtBeat = null) {
    const id = uid('asset');
    this.engine.audioBuffers.set(id, buf);
    await putAsset(id, buf);
    this.pushUndo();
    this.project.audioAssets.push({
      id, name, duration: buf.duration, sampleRate: buf.sampleRate, channels: buf.numberOfChannels,
    });
    // Drop it onto the first track that has room, as a clip whose length is
    // the sample's real duration converted to beats at the current tempo.
    const lengthBeats = (buf.duration * this.project.bpm) / 60;
    let track = this.project.playlist.tracks.find((t) => !t.clips.length);
    if (!track) {
      track = createPlaylistTrack({ name: `Audio ${this.project.playlist.tracks.length + 1}` });
      this.project.playlist.tracks.push(track);
    }
    const start = placeAtBeat === null ? 0 : placeAtBeat;
    track.clips.push(createClip({ type: 'audio', ref: id, start, length: lengthBeats }));
    this.rebuildIndex();
    this.setView('playlist');
    this.touch();
    this.autosave();
    this.toast(`Imported ${name} (${buf.duration.toFixed(1)}s)`);
  }

  async toggleRecord() {
    if (this.recording) {
      this.recording.stop();
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      this.toast('This browser has no microphone access.');
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    } catch (err) {
      // These names are well defined and each means something different.
      const msg = err.name === 'NotAllowedError' ? 'Microphone permission denied.'
        : err.name === 'NotFoundError' ? 'No microphone found.'
        : err.name === 'NotReadableError' ? 'The microphone is in use by another app.'
        : `Microphone error: ${err.name}`;
      this.toast(msg);
      return;
    }
    const rec = new MediaRecorder(stream);
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      $('btn-rec').classList.remove('on');
      this.recording = null;
      try {
        const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
        const buf = await this.engine.ctx.decodeAudioData(await blob.arrayBuffer());
        await this.addAudioAsset(`Take ${new Date().toLocaleTimeString()}`, buf, this.recStartBeat || 0);
      } catch (err) {
        this.toast('Recording could not be decoded.');
      }
    };
    this.recStartBeat = this.engine.playing ? this.engine.currentBeat() : (this.engine.schedBeat || 0);
    rec.start();
    this.recording = rec;
    $('btn-rec').classList.add('on');
    this.toast('Recording — press ● again to stop.');
  }

  // ---------- MIDI ----------

  async initMidi() {
    // Chrome and Edge only. Feature-detect and stay quiet everywhere else
    // rather than throwing at people who were never going to have it.
    if (!navigator.requestMIDIAccess) return;
    try {
      const access = await navigator.requestMIDIAccess();
      const attach = (input) => {
        input.onmidimessage = (msg) => this.onMidi(msg);
      };
      access.inputs.forEach(attach);
      access.onstatechange = (e) => {
        if (e.port && e.port.type === 'input' && e.port.state === 'connected') attach(e.port);
      };
      const n = access.inputs.size;
      if (n) this.toast(`MIDI: ${n} device${n > 1 ? 's' : ''} connected.`);
    } catch { /* user declined, or the permission is blocked by policy */ }
  }

  onMidi(msg) {
    const [status, d1, d2] = msg.data;
    const cmd = status & 0xf0;
    const ch = this.selectedChannel();
    if (!ch) return;
    if (cmd === 0x90 && d2 > 0) {
      this.engine.previewOn(ch.id, d1, d2);
      this.recordLiveNote(d1, d2);
    } else if (cmd === 0x80 || (cmd === 0x90 && d2 === 0)) {
      this.engine.previewOff(ch.id, d1);
    }
  }

  /** When the transport is rolling in pattern mode, played notes land in the
   *  selected pattern, quantised to the piano roll's snap. */
  recordLiveNote(pitch, vel) {
    if (!this.engine.playing || this.engine.mode !== 'pattern') return;
    const pat = this.selectedPattern();
    const ch = this.selectedChannel();
    if (!pat || !ch) return;
    const snap = this.piano.snap || 0.25;
    const raw = this.engine.currentBeat() % pat.lengthBeats;
    const beat = clamp(Math.round(raw / snap) * snap, 0, pat.lengthBeats - snap);
    if (!pat.notes[ch.id]) pat.notes[ch.id] = [];
    pat.notes[ch.id].push({ beat, dur: snap, pitch, vel });
    this.renderRack();
    this.touch();
    this.autosaveSoon();
  }

  // ---------- on-screen keyboard ----------

  buildKeyboard() {
    const el = $('keys');
    el.innerHTML = '';
    const LOW = 48; const HIGH = 84;
    const whites = [];
    for (let p = LOW; p <= HIGH; p++) if (!isBlackKey(p)) whites.push(p);
    const wpct = 100 / whites.length;
    let wi = 0;
    for (let p = LOW; p <= HIGH; p++) {
      const k = document.createElement('div');
      k.dataset.pitch = p;
      if (isBlackKey(p)) {
        k.className = 'key black';
        k.style.left = `${wi * wpct - wpct * 0.3}%`;
        k.style.width = `${wpct * 0.6}%`;
      } else {
        k.className = 'key';
        k.style.left = `${wi * wpct}%`;
        k.style.width = `${wpct}%`;
        wi++;
      }
      k.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        this.keyDown(p);
        k.classList.add('down');
      });
      const up = () => { this.keyUp(p); k.classList.remove('down'); };
      k.addEventListener('pointerup', up);
      k.addEventListener('pointerleave', () => { if (this.heldKeys.has(p)) up(); });
      el.appendChild(k);
    }
  }

  keyDown(pitch) {
    if (this.heldKeys.has(pitch)) return;
    this.heldKeys.add(pitch);
    const ch = this.selectedChannel();
    if (ch) this.engine.previewOn(ch.id, pitch, 110);
    this.recordLiveNote(pitch, 110);
  }

  keyUp(pitch) {
    if (!this.heldKeys.has(pitch)) return;
    this.heldKeys.delete(pitch);
    const ch = this.selectedChannel();
    if (ch) this.engine.previewOff(ch.id, pitch);
    document.querySelectorAll(`.key[data-pitch="${pitch}"]`).forEach((k) => k.classList.remove('down'));
  }

  // ---------- misc UI ----------

  toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  loop() {
    const tick = () => {
      if (this.started) {
        if (this.engine.playing) {
          const beat = this.engine.currentBeat();
          $('pos').textContent = formatPosition(beat, this.project.beatsPerBar);
          this.drawCurrentView(beat);
          this.highlightSteps(beat);
        }
        this.updateMeters();
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  highlightSteps(beat) {
    const pat = this.selectedPattern();
    if (!pat || this.engine.mode !== 'pattern') return;
    const step = Math.floor((beat % pat.lengthBeats) * 4);
    if (step === this._lastStep) return;
    this._lastStep = step;
    document.querySelectorAll('.step.playing').forEach((s) => s.classList.remove('playing'));
    document.querySelectorAll(`.step[data-step="${step}"]`).forEach((s) => s.classList.add('playing'));
  }

  updateMeters() {
    const g = this.engine.graph;
    if (!g || !g.analyser) return;
    if (!this._meterBuf) this._meterBuf = new Float32Array(g.analyser.fftSize);
    g.analyser.getFloatTimeDomainData(this._meterBuf);
    let peak = 0;
    for (let i = 0; i < this._meterBuf.length; i++) {
      const a = Math.abs(this._meterBuf[i]);
      if (a > peak) peak = a;
    }
    const el = $('master-meter');
    el.firstElementChild.style.right = `${100 - Math.min(100, peak * 100)}%`;
    el.classList.toggle('clip', peak >= 0.999);
  }

  // ---------- wiring ----------

  bindUI() {
    $('btn-play').addEventListener('click', () => this.togglePlay());
    $('btn-stop').addEventListener('click', () => this.stop());
    $('btn-rec').addEventListener('click', () => this.toggleRecord());
    $('btn-pat').addEventListener('click', () => this.setMode('pattern'));
    $('btn-song').addEventListener('click', () => this.setMode('song'));
    $('btn-metro').addEventListener('click', (e) => {
      this.engine.metronome = !this.engine.metronome;
      e.currentTarget.classList.toggle('on', this.engine.metronome);
    });
    $('btn-loop').addEventListener('click', (e) => {
      this.engine.loopEnabled = !this.engine.loopEnabled;
      e.currentTarget.classList.toggle('on', this.engine.loopEnabled);
    });

    $('bpm').addEventListener('change', () => {
      const v = clamp(Number($('bpm').value) || 120, 40, 300);
      this.pushUndo();
      this.project.bpm = v;
      $('bpm').value = v;
      if (this.engine.playing) { const at = this.engine.currentBeat(); this.engine.stop(true); this.engine.play(at); }
      this.autosave();
    });
    $('swing').addEventListener('change', () => {
      const v = clamp(Number($('swing').value) || 0, 0, 100);
      this.project.swing = v;
      $('swing').value = v;
      this.autosave();
    });

    document.querySelectorAll('.tabs .mini[data-view]').forEach((b) => {
      b.addEventListener('click', () => this.setView(b.dataset.view));
    });
    $('btn-undo').addEventListener('click', () => this.undo());
    $('btn-redo').addEventListener('click', () => this.redo());
    $('btn-help').addEventListener('click', () => this.showHelp());
    $('plug-close').addEventListener('click', () => $('plugwin').classList.remove('show'));

    // snap selects
    [['pl-snap', 'playlist'], ['pr-snap', 'piano']].forEach(([id, which]) => {
      const sel = $(id);
      PPQ_SNAP.forEach((s) => {
        const o = document.createElement('option');
        o.value = s.beats; o.textContent = s.label;
        sel.appendChild(o);
      });
      sel.value = which === 'piano' ? 0.25 : 1;
      sel.addEventListener('change', () => {
        const v = Number(sel.value);
        if (which === 'piano') this.piano.snap = v; else this.playlist.snap = v;
        this.touch();
      });
    });
    $('pr-zoom').addEventListener('input', (e) => { this.piano.pxPerBeat = Number(e.target.value); this.touch(); });
    $('pl-zoom').addEventListener('input', (e) => { this.playlist.pxPerBeat = Number(e.target.value); this.touch(); });
    $('pr-vel').addEventListener('input', (e) => {
      this.piano.vel = Number(e.target.value);
      $('pr-vel-val').textContent = e.target.value;
    });
    $('btn-quantize').addEventListener('click', () => {
      const notes = this.piano.notes();
      if (!notes) return;
      const snap = this.piano.snap || 0.25;
      this.pushUndo();
      notes.forEach((n) => { n.beat = Math.round(n.beat / snap) * snap; });
      this.touch(); this.renderRack(); this.autosave();
      this.toast('Quantized');
    });
    $('btn-clear-notes').addEventListener('click', () => {
      const notes = this.piano.notes();
      if (!notes) return;
      this.pushUndo();
      notes.length = 0;
      this.touch(); this.renderRack(); this.autosave();
    });

    $('pattern-select').addEventListener('change', (e) => {
      this.project.selection.patternId = e.target.value;
      this.renderRack();
      this.touch();
      this.autosave();
    });
    $('btn-add-pat').addEventListener('click', () => {
      this.pushUndo();
      const p = createPattern({
        name: `Pattern ${this.project.patterns.length + 1}`,
        lengthBeats: 4,
        color: TRACK_COLORS[this.project.patterns.length % TRACK_COLORS.length],
      });
      this.project.patterns.push(p);
      this.project.selection.patternId = p.id;
      this.renderPatternSelect();
      this.renderRack();
      this.touch();
      this.autosave();
    });
    $('btn-pat-len').addEventListener('click', () => {
      const pat = this.selectedPattern();
      if (!pat) return;
      const bars = prompt('Pattern length in bars', String(pat.lengthBeats / (this.project.beatsPerBar || 4)));
      const n = Number(bars);
      if (!n || n <= 0) return;
      this.pushUndo();
      pat.lengthBeats = n * (this.project.beatsPerBar || 4);
      this.renderRack();
      this.touch();
      this.autosave();
    });
    $('btn-add-chan').addEventListener('click', (e) => {
      this.showMenu(e, INSTRUMENT_TYPES.map((t) => ({
        label: `${t.icon} ${t.name}`,
        action: () => {
          this.pushUndo();
          const insertIndex = Math.min(this.project.mixer.inserts.length - 1, this.project.channels.length + 1);
          const ch = createChannel({
            name: t.name,
            instrument: t.type,
            insert: insertIndex > 0 ? insertIndex : 0,
            color: TRACK_COLORS[this.project.channels.length % TRACK_COLORS.length],
          });
          this.project.channels.push(ch);
          this.project.selection.channelId = ch.id;
          this.afterStructuralChange();
        },
      })));
    });
    $('btn-add-track').addEventListener('click', () => {
      this.pushUndo();
      this.project.playlist.tracks.push(createPlaylistTrack({
        name: `Track ${this.project.playlist.tracks.length + 1}`,
      }));
      this.touch(); this.autosave();
    });

    $('btn-import-audio').addEventListener('click', () => $('audio-input').click());
    $('audio-input').addEventListener('change', async (e) => {
      await this.importAudioFiles([...e.target.files]);
      e.target.value = '';
    });

    $('btn-export').addEventListener('click', (e) => {
      this.showMenu(e, [
        { label: 'Export mixdown (.wav)', action: () => this.exportWav(false) },
        { label: 'Export stems (one per channel)', action: () => this.exportWav(true) },
      ]);
    });

    $('btn-file').addEventListener('click', (e) => {
      this.showMenu(e, [
        { label: 'New empty project', action: () => {
          if (!confirm('Discard the current project?')) return;
          this.pushUndo();
          const p = emptyProject();
          p.mixer.inserts = [createInsert(0, { name: 'Master' }), createInsert(1, { name: 'Insert 1' })];
          const ch = createChannel({ name: 'Drum Kit', instrument: 'drumkit', insert: 1 });
          p.channels = [ch];
          const pat = createPattern({ name: 'Pattern 1' });
          p.patterns = [pat];
          p.playlist.tracks = [createPlaylistTrack({ name: 'Track 1' }), createPlaylistTrack({ name: 'Track 2' })];
          p.selection = { patternId: pat.id, channelId: ch.id };
          this.project = p;
          this.afterStructuralChange();
        } },
        { label: 'Load the demo song', action: () => {
          if (!confirm('Discard the current project?')) return;
          this.pushUndo();
          this.project = demoProject();
          this.afterStructuralChange();
        } },
        { sep: true },
        { label: 'Save project file (.json)', action: () => {
          const blob = new Blob([JSON.stringify(this.project, null, 1)], { type: 'application/json' });
          downloadBlob(blob, `${this.safeName()}.slipdaw.json`);
        } },
        { label: 'Open project file…', action: () => $('project-input').click() },
        { sep: true },
        { label: 'Rename project…', action: () => {
          const v = prompt('Project name', this.project.name);
          if (v) { this.project.name = v; this.autosave(); this.toast('Renamed'); }
        } },
        { label: 'Clear saved session', action: () => { clearProjectLocal(); this.toast('Autosave cleared.'); } },
      ]);
    });

    $('project-input').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try {
        const text = await file.text();
        this.pushUndo();
        this.project = normalizeProject(JSON.parse(text));
        this.afterStructuralChange();
        await this.reloadAssets();
        this.toast(`Opened ${this.project.name}`);
      } catch (err) {
        this.toast('That file could not be read as a SlipDAW project.');
      }
    });

    document.addEventListener('pointerdown', (e) => {
      const menu = $('menu');
      if (menu.classList.contains('show') && !menu.contains(e.target)) menu.classList.remove('show');
    });

    // Computer keyboard: two rows laid out like a piano, plus transport.
    const KEYMAP = {
      z: 48, s: 49, x: 50, d: 51, c: 52, v: 53, g: 54, b: 55, h: 56, n: 57, j: 58, m: 59,
      q: 60, 2: 61, w: 62, 3: 63, e: 64, r: 65, 5: 66, t: 67, 6: 68, y: 69, 7: 70, u: 71, i: 72,
    };
    window.addEventListener('keydown', (e) => {
      if (e.target.matches('input, select, textarea')) return;
      if (e.code === 'Space') { e.preventDefault(); this.togglePlay(); return; }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        if (this.view === 'piano') this.piano.deleteSelected();
        else if (this.view === 'playlist') this.playlist.deleteSelected();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) this.redo(); else this.undo();
        return;
      }
      if (e.repeat) return;
      const p = KEYMAP[e.key.toLowerCase()];
      if (p !== undefined) {
        this.keyDown(p);
        document.querySelectorAll(`.key[data-pitch="${p}"]`).forEach((k) => k.classList.add('down'));
      }
    });
    window.addEventListener('keyup', (e) => {
      const p = KEYMAP[e.key.toLowerCase()];
      if (p !== undefined) this.keyUp(p);
    });

    window.addEventListener('beforeunload', () => this.autosave());
    this.initMidi();
  }

  showHelp() {
    this.openWindow({
      title: 'SlipDAW — how it works',
      params: [],
      footer: [
        'Space plays and pauses. PAT loops the selected pattern; SONG plays the playlist.',
        'Channel Rack: click a step to place a note. Double-click a channel name to open its instrument.',
        'Piano Roll: draw with the left button, right-click to erase, drag the right edge to resize.',
        'Playlist: right-click empty space to drop the selected pattern, right-click a clip to delete it.',
        'Mixer: click + plugin on any insert. The master already has EQ, compression and a limiter.',
        'Export renders the song offline through the same graph you are hearing, then writes a WAV.',
        'Your work autosaves to this browser. Save a .json to keep it anywhere else.',
        '',
        'Real VST/VST3 plugins are native binaries and cannot run in any browser. Everything here is Web Audio.',
      ].join('\n\n'),
    });
  }
}

// ---------------------------------------------------------------

const app = new App();
window.slipdaw = app;   // handy for the console and for headless tests

$('arm-btn').addEventListener('click', async () => {
  $('arm-btn').disabled = true;
  $('arm-btn').textContent = 'Starting…';
  try {
    await app.start();
    $('arm').classList.add('hidden');
    $('shell').removeAttribute('aria-hidden');
  } catch (err) {
    console.error(err);
    $('arm-btn').disabled = false;
    $('arm-btn').textContent = 'Open the studio';
    app.toast(`Could not start audio: ${err.message}`);
  }
});
