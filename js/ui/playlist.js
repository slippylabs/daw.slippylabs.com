// ============================================================
// SlipDAW — playlist (the arrangement view)
//
// Canvas for the same reason as the piano roll. Clips are drawn, not DOM
// nodes, and hit-testing happens in beats/track-index space.
// ============================================================

import { clamp } from '../util.js';
import { createClip, findPattern, TRACK_COLORS } from '../model/project.js';

const NAME_W = 96;
const HEAD_H = 22;
const TRACK_H = 46;

export class Playlist {
  constructor(canvas, wrap, app) {
    this.canvas = canvas;
    this.wrap = wrap;
    this.app = app;
    this.ctx = canvas.getContext('2d');
    this.pxPerBeat = 26;
    this.snap = 1;
    this.selected = null;
    this.drag = null;

    canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    canvas.addEventListener('pointermove', (e) => this.onMove(e));
    window.addEventListener('pointerup', () => this.onUp());
    canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); this.onRightClick(e); });
  }

  totalBeats() {
    const p = this.app.project;
    let end = 32;
    p.playlist.tracks.forEach((t) => t.clips.forEach((c) => { end = Math.max(end, c.start + c.length + 8); }));
    return Math.ceil(end / 4) * 4;
  }

  layout() {
    const tracks = this.app.project.playlist.tracks;
    const beats = this.totalBeats();
    return {
      beats,
      tracks,
      w: NAME_W + beats * this.pxPerBeat + 20,
      h: HEAD_H + tracks.length * TRACK_H + 10,
    };
  }

  draw(playBeat = null) {
    const { beats, tracks, w, h } = this.layout();
    const c = this.canvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (c.width !== Math.floor(w * dpr) || c.height !== Math.floor(h * dpr)) {
      c.width = Math.floor(w * dpr); c.height = Math.floor(h * dpr);
      c.style.width = `${w}px`; c.style.height = `${h}px`;
    }
    const g = this.ctx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#060d12';
    g.fillRect(0, 0, w, h);

    const bpb = this.app.project.beatsPerBar || 4;

    tracks.forEach((t, i) => {
      const y = HEAD_H + i * TRACK_H;
      g.fillStyle = i % 2 ? 'rgba(255,255,255,.02)' : 'rgba(255,255,255,.04)';
      g.fillRect(NAME_W, y, beats * this.pxPerBeat, TRACK_H);
      g.strokeStyle = 'rgba(57,255,143,.12)';
      g.beginPath(); g.moveTo(0, y + 0.5); g.lineTo(w, y + 0.5); g.stroke();
    });

    for (let b = 0; b <= beats; b += 1) {
      const x = NAME_W + b * this.pxPerBeat;
      const isBar = b % bpb === 0;
      g.strokeStyle = isBar ? 'rgba(57,255,143,.35)' : 'rgba(57,255,143,.1)';
      g.beginPath(); g.moveTo(x + 0.5, HEAD_H); g.lineTo(x + 0.5, h); g.stroke();
    }

    g.fillStyle = 'rgba(6,14,18,.95)';
    g.fillRect(0, 0, w, HEAD_H);
    g.fillStyle = '#7fa695';
    g.font = '10px Consolas, monospace';
    for (let b = 0; b <= beats; b += bpb) {
      g.fillText(String(b / bpb + 1), NAME_W + b * this.pxPerBeat + 3, 14);
    }

    // track name gutter
    g.fillStyle = 'rgba(6,14,18,.97)';
    g.fillRect(0, HEAD_H, NAME_W, h - HEAD_H);
    tracks.forEach((t, i) => {
      const y = HEAD_H + i * TRACK_H;
      g.fillStyle = t.mute ? '#4a635a' : '#d9fbe8';
      g.font = '11px Consolas, monospace';
      g.fillText(t.name.slice(0, 12), 6, y + 16);
      g.fillStyle = '#7fa695';
      g.font = '9px Consolas, monospace';
      g.fillText(`ins ${t.insert || 0}${t.mute ? ' · mute' : ''}`, 6, y + 30);
    });

    // clips
    tracks.forEach((t, i) => {
      const y = HEAD_H + i * TRACK_H;
      t.clips.forEach((clip) => {
        const x = NAME_W + clip.start * this.pxPerBeat;
        const wpx = Math.max(6, clip.length * this.pxPerBeat - 2);
        let label = 'audio';
        let colour = '#4fc3f7';
        if (clip.type === 'pattern') {
          const pat = findPattern(this.app.project, clip.ref);
          label = pat ? pat.name : '?';
          colour = (pat && pat.color) || TRACK_COLORS[0];
        } else {
          const asset = this.app.project.audioAssets.find((a) => a.id === clip.ref);
          if (asset) label = asset.name;
        }
        g.globalAlpha = t.mute ? 0.35 : 0.85;
        g.fillStyle = colour;
        g.fillRect(x, y + 4, wpx, TRACK_H - 10);
        g.globalAlpha = 1;
        g.strokeStyle = clip === this.selected ? '#fff' : 'rgba(0,0,0,.55)';
        g.lineWidth = clip === this.selected ? 2 : 1;
        g.strokeRect(x + 0.5, y + 4.5, wpx - 1, TRACK_H - 11);
        g.lineWidth = 1;
        g.fillStyle = 'rgba(0,0,0,.8)';
        g.font = '10px Consolas, monospace';
        g.save();
        g.beginPath(); g.rect(x, y + 4, wpx, TRACK_H - 10); g.clip();
        g.fillText(label, x + 5, y + 18);
        g.restore();
      });
    });

    if (playBeat !== null && playBeat >= 0) {
      const x = NAME_W + playBeat * this.pxPerBeat;
      g.strokeStyle = '#ff9130';
      g.beginPath(); g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, h); g.stroke();
    }
  }

  pos(e) {
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const ti = Math.floor((y - HEAD_H) / TRACK_H);
    return {
      x, y, ti,
      beat: (x - NAME_W) / this.pxPerBeat,
      inGrid: x > NAME_W && ti >= 0 && ti < this.app.project.playlist.tracks.length,
      inNames: x <= NAME_W && ti >= 0,
    };
  }

  quantize(b) {
    if (!this.snap) return Math.max(0, b);
    return Math.max(0, Math.round(b / this.snap) * this.snap);
  }

  hit(p) {
    const track = this.app.project.playlist.tracks[p.ti];
    if (!track) return null;
    for (let i = track.clips.length - 1; i >= 0; i--) {
      const c = track.clips[i];
      if (p.beat >= c.start && p.beat <= c.start + c.length) return { clip: c, track };
    }
    return null;
  }

  onDown(e) {
    const p = this.pos(e);
    if (p.inNames) {
      const t = this.app.project.playlist.tracks[p.ti];
      if (t) this.app.trackMenu(e, t);
      return;
    }
    if (!p.inGrid) {
      // Clicking the ruler moves the playhead.
      if (p.y < HEAD_H && p.x > NAME_W) this.app.seek(Math.max(0, this.quantize(p.beat)));
      return;
    }
    const found = this.hit(p);
    if (e.button === 2) return;
    if (found) {
      this.app.pushUndo();
      this.selected = found.clip;
      const endPx = NAME_W + (found.clip.start + found.clip.length) * this.pxPerBeat;
      this.drag = {
        clip: found.clip,
        track: found.track,
        mode: Math.abs(p.x - endPx) < 7 ? 'resize' : 'move',
        grabBeat: p.beat,
        startBeat: found.clip.start,
        startLen: found.clip.length,
        startTi: p.ti,
      };
      this.canvas.setPointerCapture(e.pointerId);
      this.app.touch();
    } else {
      this.selected = null;
      this.app.touch();
    }
  }

  onRightClick(e) {
    const p = this.pos(e);
    if (!p.inGrid) return;
    const found = this.hit(p);
    const track = this.app.project.playlist.tracks[p.ti];
    if (found) {
      this.app.pushUndo();
      track.clips.splice(track.clips.indexOf(found.clip), 1);
      if (this.selected === found.clip) this.selected = null;
    } else {
      const pat = this.app.selectedPattern();
      if (!pat) return;
      this.app.pushUndo();
      const clip = createClip({
        type: 'pattern', ref: pat.id,
        start: this.quantize(p.beat),
        length: pat.lengthBeats,
      });
      track.clips.push(clip);
      this.selected = clip;
    }
    this.app.touch();
    this.app.autosave();
  }

  onMove(e) {
    if (!this.drag) {
      const p = this.pos(e);
      const f = p.inGrid ? this.hit(p) : null;
      if (f) {
        const endPx = NAME_W + (f.clip.start + f.clip.length) * this.pxPerBeat;
        this.canvas.style.cursor = Math.abs(p.x - endPx) < 7 ? 'ew-resize' : 'move';
      } else this.canvas.style.cursor = p.inNames ? 'pointer' : 'default';
      return;
    }
    const p = this.pos(e);
    const d = this.drag;
    if (d.mode === 'move') {
      d.clip.start = this.quantize(d.startBeat + (p.beat - d.grabBeat));
      // Moving between tracks: pull it out of the old one, push to the new.
      const tracks = this.app.project.playlist.tracks;
      if (p.ti >= 0 && p.ti < tracks.length && tracks[p.ti] !== d.track) {
        const from = d.track.clips.indexOf(d.clip);
        if (from >= 0) d.track.clips.splice(from, 1);
        tracks[p.ti].clips.push(d.clip);
        d.track = tracks[p.ti];
      }
    } else {
      d.clip.length = clamp(this.quantize(p.beat) - d.clip.start, this.snap || 0.25, 512);
    }
    this.app.touch();
  }

  onUp() {
    if (this.drag) { this.drag = null; this.app.rebuildIndex(); this.app.autosave(); }
  }

  deleteSelected() {
    if (!this.selected) return;
    const tracks = this.app.project.playlist.tracks;
    for (const t of tracks) {
      const i = t.clips.indexOf(this.selected);
      if (i >= 0) {
        this.app.pushUndo();
        t.clips.splice(i, 1);
        this.selected = null;
        this.app.rebuildIndex();
        this.app.touch();
        return;
      }
    }
  }
}
