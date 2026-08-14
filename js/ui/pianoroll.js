// ============================================================
// SlipDAW — piano roll
//
// Canvas, not DOM. A busy pattern is thousands of notes and a DOM node per
// note makes dragging visibly stutter; drawing is one pass over an array.
// Hit-testing is done in model space (beats and pitches), never in pixels,
// so zooming can never desynchronise what you see from what you click.
// ============================================================

import { midiToName, isBlackKey, clamp } from '../util.js';
import { DRUM_VOICES } from '../engine/instruments.js';

const KEY_W = 62;      // piano keyboard gutter
const ROW_H = 13;      // one semitone
const HEAD_H = 20;     // bar ruler
const LOW = 24;        // lowest MIDI note shown
const HIGH = 96;       // highest

export class PianoRoll {
  constructor(canvas, wrap, app) {
    this.canvas = canvas;
    this.wrap = wrap;
    this.app = app;
    this.ctx = canvas.getContext('2d');
    this.pxPerBeat = 48;
    this.snap = 0.25;
    this.vel = 100;
    this.drag = null;
    this.selected = null;

    canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    canvas.addEventListener('pointermove', (e) => this.onMove(e));
    window.addEventListener('pointerup', (e) => this.onUp(e));
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** Rows are pitch rows for melodic instruments, and named drum voices for a
   *  kit — a kit on a piano keyboard is unreadable, and the eight voices are
   *  what a producer is actually aiming at. */
  rows() {
    const ch = this.app.selectedChannel();
    // A kit in "drum" mode shows its eight named voices — a piano keyboard is
    // useless for programming drums. In "pitched" mode it shows the full
    // chromatic range instead, because the kit's 808 follows pitch and is
    // meant to be played as a bass instrument; with only the eight fixed
    // voice rows, an 808 bassline written on other notes is invisible here
    // and cannot be edited at all.
    if (ch && ch.instrument === 'drumkit' && !ch.pitched) {
      return DRUM_VOICES.slice().reverse().map((v) => ({ pitch: v.pitch, label: v.name, drum: true }));
    }
    const drumNames = new Map(DRUM_VOICES.map((v) => [v.pitch, v.name]));
    const showDrumNames = ch && ch.instrument === 'drumkit';
    const out = [];
    for (let p = HIGH; p >= LOW; p--) {
      out.push({
        pitch: p,
        label: showDrumNames && drumNames.has(p) ? drumNames.get(p) : midiToName(p),
        drum: false,
      });
    }
    return out;
  }

  notes() {
    const pat = this.app.selectedPattern();
    const ch = this.app.selectedChannel();
    if (!pat || !ch) return null;
    if (!pat.notes[ch.id]) pat.notes[ch.id] = [];
    return pat.notes[ch.id];
  }

  layout() {
    const pat = this.app.selectedPattern();
    const beats = pat ? pat.lengthBeats : 4;
    const rows = this.rows();
    return {
      beats,
      rows,
      w: KEY_W + beats * this.pxPerBeat + 40,
      h: HEAD_H + rows.length * ROW_H,
    };
  }

  draw(playBeat = null) {
    const { beats, rows, w, h } = this.layout();
    const c = this.canvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (c.width !== Math.floor(w * dpr) || c.height !== Math.floor(h * dpr)) {
      c.width = Math.floor(w * dpr);
      c.height = Math.floor(h * dpr);
      c.style.width = `${w}px`;
      c.style.height = `${h}px`;
    }
    const g = this.ctx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    g.fillStyle = '#060d12';
    g.fillRect(0, 0, w, h);

    const bpb = this.app.project.beatsPerBar || 4;

    // rows
    rows.forEach((row, i) => {
      const y = HEAD_H + i * ROW_H;
      g.fillStyle = row.drum
        ? (i % 2 ? 'rgba(255,255,255,.035)' : 'rgba(255,255,255,.015)')
        : (isBlackKey(row.pitch) ? 'rgba(255,255,255,.02)' : 'rgba(255,255,255,.05)');
      g.fillRect(KEY_W, y, beats * this.pxPerBeat, ROW_H);
      g.strokeStyle = 'rgba(57,255,143,.07)';
      g.beginPath(); g.moveTo(KEY_W, y + 0.5); g.lineTo(w, y + 0.5); g.stroke();
    });

    // vertical grid
    const step = this.snap > 0 ? this.snap : 0.25;
    for (let b = 0; b <= beats + 0.0001; b += step) {
      const x = KEY_W + b * this.pxPerBeat;
      const isBar = Math.abs(b % bpb) < 1e-6;
      const isBeat = Math.abs(b % 1) < 1e-6;
      g.strokeStyle = isBar ? 'rgba(57,255,143,.45)' : isBeat ? 'rgba(57,255,143,.2)' : 'rgba(57,255,143,.08)';
      g.beginPath(); g.moveTo(x + 0.5, HEAD_H); g.lineTo(x + 0.5, h); g.stroke();
    }

    // ruler
    g.fillStyle = 'rgba(6,14,18,.95)';
    g.fillRect(0, 0, w, HEAD_H);
    g.fillStyle = '#7fa695';
    g.font = '10px Consolas, monospace';
    for (let b = 0; b <= beats; b += bpb) {
      const x = KEY_W + b * this.pxPerBeat;
      g.fillText(String(Math.floor(b / bpb) + 1), x + 3, 13);
    }

    // key gutter
    g.fillStyle = 'rgba(6,14,18,.98)';
    g.fillRect(0, HEAD_H, KEY_W, h - HEAD_H);
    rows.forEach((row, i) => {
      const y = HEAD_H + i * ROW_H;
      if (!row.drum) {
        g.fillStyle = isBlackKey(row.pitch) ? '#0b1a15' : '#c9e8d8';
        g.fillRect(0, y + 1, KEY_W - 6, ROW_H - 1);
        if (row.pitch % 12 === 0) {
          g.fillStyle = '#0b1a15';
          g.font = '9px Consolas, monospace';
          g.fillText(row.label, 4, y + ROW_H - 3);
        }
      } else {
        g.fillStyle = '#0b1a15';
        g.fillRect(0, y + 1, KEY_W - 6, ROW_H - 1);
        g.fillStyle = '#7fa695';
        g.font = '9px Consolas, monospace';
        g.fillText(row.label.slice(0, 9), 3, y + ROW_H - 3);
      }
    });

    // notes
    const notes = this.notes() || [];
    const rowIndex = new Map(rows.map((r, i) => [r.pitch, i]));
    const colour = (this.app.selectedChannel() || {}).color || '#39ff8f';
    notes.forEach((n) => {
      const ri = rowIndex.get(n.pitch);
      if (ri === undefined) return;
      const x = KEY_W + n.beat * this.pxPerBeat;
      const y = HEAD_H + ri * ROW_H;
      const wpx = Math.max(4, n.dur * this.pxPerBeat - 1);
      const a = 0.35 + 0.65 * ((n.vel ?? 100) / 127);
      g.globalAlpha = a;
      g.fillStyle = colour;
      g.fillRect(x, y + 1, wpx, ROW_H - 2);
      g.globalAlpha = 1;
      g.strokeStyle = n === this.selected ? '#fff' : 'rgba(0,0,0,.6)';
      g.strokeRect(x + 0.5, y + 1.5, wpx - 1, ROW_H - 3);
    });

    // playhead
    if (playBeat !== null && playBeat >= 0) {
      const x = KEY_W + (playBeat % beats) * this.pxPerBeat;
      g.strokeStyle = '#ff9130';
      g.beginPath(); g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, h); g.stroke();
    }
  }

  pos(e) {
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const rows = this.rows();
    const ri = Math.floor((y - HEAD_H) / ROW_H);
    return {
      x, y,
      beat: (x - KEY_W) / this.pxPerBeat,
      row: ri,
      pitch: rows[ri] ? rows[ri].pitch : null,
      inGrid: x > KEY_W && ri >= 0 && ri < rows.length,
    };
  }

  quantize(beat) {
    if (!this.snap) return Math.max(0, beat);
    return Math.max(0, Math.round(beat / this.snap) * this.snap);
  }

  hit(beat, pitch) {
    const notes = this.notes() || [];
    // Reverse order so the note drawn last (on top) is the one you grab.
    for (let i = notes.length - 1; i >= 0; i--) {
      const n = notes[i];
      if (n.pitch === pitch && beat >= n.beat && beat <= n.beat + n.dur) return n;
    }
    return null;
  }

  onDown(e) {
    const p = this.pos(e);
    const notes = this.notes();
    if (!notes) return;

    if (!p.inGrid) {
      // Clicking the key gutter auditions that pitch.
      if (p.pitch !== null) this.app.preview(p.pitch);
      return;
    }
    const existing = this.hit(p.beat, p.pitch);

    if (e.button === 2) {
      if (existing) {
        this.app.pushUndo();
        notes.splice(notes.indexOf(existing), 1);
        this.selected = null;
        this.app.touch();
      }
      return;
    }

    if (existing) {
      const endPx = KEY_W + (existing.beat + existing.dur) * this.pxPerBeat;
      const onEdge = Math.abs(p.x - endPx) < 6;
      this.app.pushUndo();
      this.selected = existing;
      this.drag = {
        note: existing,
        mode: onEdge ? 'resize' : 'move',
        grabBeat: p.beat,
        startBeat: existing.beat,
        startDur: existing.dur,
        startPitch: existing.pitch,
      };
      this.canvas.setPointerCapture(e.pointerId);
      this.app.preview(existing.pitch);
    } else {
      this.app.pushUndo();
      const note = {
        beat: this.quantize(p.beat),
        dur: this.snap || 0.25,
        pitch: p.pitch,
        vel: this.vel,
      };
      notes.push(note);
      this.selected = note;
      this.drag = { note, mode: 'resize', grabBeat: p.beat, startBeat: note.beat, startDur: note.dur, startPitch: note.pitch };
      this.canvas.setPointerCapture(e.pointerId);
      this.app.preview(note.pitch);
    }
    this.app.touch();
  }

  onMove(e) {
    if (!this.drag) {
      const p = this.pos(e);
      if (p.inGrid) {
        const n = this.hit(p.beat, p.pitch);
        const endPx = n ? KEY_W + (n.beat + n.dur) * this.pxPerBeat : 0;
        this.canvas.style.cursor = n ? (Math.abs(p.x - endPx) < 6 ? 'ew-resize' : 'move') : 'crosshair';
      } else this.canvas.style.cursor = 'default';
      return;
    }
    const p = this.pos(e);
    const d = this.drag;
    const pat = this.app.selectedPattern();
    if (d.mode === 'move') {
      const delta = p.beat - d.grabBeat;
      d.note.beat = clamp(this.quantize(d.startBeat + delta), 0, Math.max(0, pat.lengthBeats - 0.0625));
      const rows = this.rows();
      if (p.row >= 0 && p.row < rows.length) d.note.pitch = rows[p.row].pitch;
    } else {
      const end = this.quantize(Math.max(d.note.beat + (this.snap || 0.0625), p.beat));
      d.note.dur = clamp(end - d.note.beat, this.snap || 0.0625, pat.lengthBeats);
    }
    this.app.touch();
  }

  onUp() {
    if (this.drag) {
      this.drag = null;
      this.app.autosave();
    }
  }

  deleteSelected() {
    const notes = this.notes();
    if (!notes || !this.selected) return;
    const i = notes.indexOf(this.selected);
    if (i >= 0) {
      this.app.pushUndo();
      notes.splice(i, 1);
      this.selected = null;
      this.app.touch();
    }
  }
}
