// ============================================================
// SlipDAW — the project model
//
// Everything on screen is a view over this object. The engine reads it, the
// UI edits it, the renderer replays it, and save/load is just JSON. Nothing
// else holds authoritative state.
//
// Units: positions and lengths are in BEATS, never seconds and never pixels.
// Seconds are derived from bpm at the last possible moment (util.beatsToSec),
// so changing the tempo can never desynchronise the scheduler from the
// renderer.
// ============================================================

import { uid } from '../util.js';

export const PPQ_SNAP = [
  { label: '1/1', beats: 4 },
  { label: '1/2', beats: 2 },
  { label: '1/4', beats: 1 },
  { label: '1/8', beats: 0.5 },
  { label: '1/16', beats: 0.25 },
  { label: '1/32', beats: 0.125 },
  { label: 'off', beats: 0 },
];

export const TRACK_COLORS = [
  '#39ff8f', '#ff9130', '#4fc3f7', '#ff4655', '#c792ea',
  '#ffd166', '#06d6a0', '#ef476f', '#84a9ff', '#f78c6c',
];

export function createChannel(opts = {}) {
  return {
    id: uid('ch'),
    name: 'Channel',
    instrument: 'analog',
    params: {},
    insert: 0,          // mixer insert index
    color: TRACK_COLORS[0],
    mute: false,
    solo: false,
    ...opts,
  };
}

export function createPattern(opts = {}) {
  return {
    id: uid('pat'),
    name: 'Pattern',
    lengthBeats: 4,
    color: TRACK_COLORS[0],
    // notes are keyed by channel id: { [channelId]: [{ beat, dur, pitch, vel }] }
    notes: {},
    ...opts,
  };
}

export function createInsert(index, opts = {}) {
  return {
    id: uid('ins'),
    name: index === 0 ? 'Master' : `Insert ${index}`,
    fx: [],             // [{ id, type, params, bypass }]
    volume: 0.8,
    pan: 0,
    mute: false,
    solo: false,
    sends: [0, 0],      // amounts into return bus A (reverb) and B (delay)
    ...opts,
  };
}

export function createPlaylistTrack(opts = {}) {
  // `insert` routes this track's *audio* clips to a mixer insert. Pattern
  // clips ignore it — they play through their channel's own insert, which is
  // what lets one pattern's drums and bass land on different mixer strips.
  return { id: uid('trk'), name: 'Track', height: 56, mute: false, insert: 0, clips: [], ...opts };
}

export function createClip(opts = {}) {
  return {
    id: uid('clip'),
    type: 'pattern',    // 'pattern' | 'audio'
    ref: null,          // pattern id or audio asset id
    start: 0,           // beats
    length: 4,          // beats
    offset: 0,          // beats into the source (audio only)
    gain: 1,
    ...opts,
  };
}

export function emptyProject() {
  return {
    version: 1,
    name: 'Untitled',
    bpm: 120,
    beatsPerBar: 4,
    swing: 0,
    channels: [],
    patterns: [],
    playlist: { tracks: [] },
    mixer: {
      inserts: [createInsert(0, { name: 'Master' })],
      returns: [
        { id: 'busA', name: 'Reverb Bus', fx: [{ id: uid('fx'), type: 'reverb', params: { mix: 1, size: 2.6, decay: 2.6 }, bypass: false }], volume: 0.7 },
        { id: 'busB', name: 'Delay Bus', fx: [{ id: uid('fx'), type: 'pingpong', params: { mix: 1, timeMs: 300, feedback: 0.4 }, bypass: false }], volume: 0.6 },
      ],
    },
    audioAssets: [],    // { id, name, duration, sampleRate, channels } — samples live in IndexedDB
    selection: { patternId: null, channelId: null },
  };
}

/** The demo song that loads on a first visit.
 *
 *  A DAW that opens on an empty grid gives you nothing to react to, and the
 *  first thing anyone wants is to press play and hear something. This is
 *  four bars of trap: 808 bassline, drums, a pad and a plucked lead, already
 *  routed across four mixer inserts with reverb and delay sends set. */
export function demoProject() {
  const p = emptyProject();
  p.name = 'Demo — Night Drive';
  p.bpm = 140;
  p.swing = 12;

  // Mixer: master + 4 inserts
  p.mixer.inserts = [
    createInsert(0, { name: 'Master', volume: 0.85 }),
    createInsert(1, { name: 'Drums', volume: 0.8, sends: [0.05, 0] }),
    createInsert(2, { name: '808', volume: 0.85 }),
    createInsert(3, { name: 'Pad', volume: 0.5, sends: [0.45, 0.15] }),
    createInsert(4, { name: 'Lead', volume: 0.55, sends: [0.25, 0.3] }),
  ];
  // A little glue on the master, so "mastering" isn't an empty promise on
  // first load — gentle bus compression into a limiter.
  p.mixer.inserts[0].fx = [
    { id: uid('fx'), type: 'eq3', params: { lowDb: 1.5, midDb: -1, highDb: 2, midFreq: 900, mix: 1 }, bypass: false },
    { id: uid('fx'), type: 'comp', params: { threshold: -14, ratio: 2.5, attack: 0.02, release: 0.25, makeupDb: 1.5, mix: 1 }, bypass: false },
    { id: uid('fx'), type: 'limiter', params: { ceiling: -0.8, gainDb: 1, mix: 1 }, bypass: false },
  ];
  p.mixer.inserts[2].fx = [
    { id: uid('fx'), type: 'dist', params: { drive: 25, preGain: 1, postGain: 0.85, mix: 0.35 }, bypass: false },
  ];

  const drums = createChannel({ name: 'Drum Kit', instrument: 'drumkit', insert: 1, color: TRACK_COLORS[1] });
  // `pitched` puts this kit in melodic mode: the step grid and piano roll
  // treat it as a bass instrument rather than eight fixed drum voices, which
  // is what the kit's pitch-following 808 is actually for.
  const bass = createChannel({ name: '808 Bass', instrument: 'drumkit', insert: 2, color: TRACK_COLORS[3], pitched: true, stepPitch: 29 });
  const pad = createChannel({ name: 'Warm Pad', instrument: 'analog', params: { preset: 'warm-pad', level: 0.5 }, insert: 3, color: TRACK_COLORS[4] });
  const lead = createChannel({ name: 'Pluck Lead', instrument: 'pluck', params: { decay: 0.994, brightness: 0.62, level: 0.7 }, insert: 4, color: TRACK_COLORS[2] });
  p.channels = [drums, bass, pad, lead];

  // --- Pattern 1: main groove (4 beats) ---
  const beat = createPattern({ name: 'Groove', lengthBeats: 4, color: TRACK_COLORS[1] });
  const K = 36, S = 38, CH = 42, OH = 46;
  const kicks = [0, 0.75, 2.5];
  const snares = [1, 3];
  const hats = [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3, 3.25, 3.5, 3.75];
  beat.notes[drums.id] = [
    ...kicks.map((b) => ({ beat: b, dur: 0.25, pitch: K, vel: 118 })),
    ...snares.map((b) => ({ beat: b, dur: 0.25, pitch: S, vel: 105 })),
    ...hats.map((b, i) => ({ beat: b, dur: 0.12, pitch: i % 8 === 7 ? OH : CH, vel: i % 2 ? 62 : 88 })),
  ];
  // 808 line in F minor
  beat.notes[bass.id] = [
    { beat: 0, dur: 0.9, pitch: 29, vel: 120 },
    { beat: 1.5, dur: 0.4, pitch: 29, vel: 96 },
    { beat: 2, dur: 0.9, pitch: 32, vel: 116 },
    { beat: 3.25, dur: 0.6, pitch: 34, vel: 108 },
  ];
  beat.notes[pad.id] = [
    { beat: 0, dur: 4, pitch: 53, vel: 70 },
    { beat: 0, dur: 4, pitch: 56, vel: 62 },
    { beat: 0, dur: 4, pitch: 60, vel: 58 },
  ];
  p.patterns.push(beat);

  // --- Pattern 2: lead melody (4 beats) ---
  const melody = createPattern({ name: 'Lead', lengthBeats: 4, color: TRACK_COLORS[2] });
  melody.notes[lead.id] = [
    { beat: 0, dur: 0.5, pitch: 72, vel: 100 },
    { beat: 0.5, dur: 0.25, pitch: 75, vel: 92 },
    { beat: 1, dur: 0.75, pitch: 77, vel: 104 },
    { beat: 2, dur: 0.5, pitch: 75, vel: 96 },
    { beat: 2.5, dur: 0.25, pitch: 72, vel: 88 },
    { beat: 3, dur: 1, pitch: 68, vel: 100 },
  ];
  melody.notes[pad.id] = [
    { beat: 0, dur: 4, pitch: 51, vel: 68 },
    { beat: 0, dur: 4, pitch: 56, vel: 60 },
    { beat: 0, dur: 4, pitch: 60, vel: 56 },
  ];
  p.patterns.push(melody);

  // --- Playlist: 8 bars ---
  const t1 = createPlaylistTrack({ name: 'Groove' });
  const t2 = createPlaylistTrack({ name: 'Lead' });
  for (let bar = 0; bar < 8; bar++) {
    t1.clips.push(createClip({ type: 'pattern', ref: beat.id, start: bar * 4, length: 4 }));
    if (bar >= 2) t2.clips.push(createClip({ type: 'pattern', ref: melody.id, start: bar * 4, length: 4 }));
  }
  p.playlist.tracks = [t1, t2, createPlaylistTrack({ name: 'Track 3' }), createPlaylistTrack({ name: 'Track 4' })];

  p.selection.patternId = beat.id;
  p.selection.channelId = drums.id;
  return p;
}

/** Total song length in beats — the end of the last clip, rounded up to a
 *  bar. Used by the renderer to size the offline buffer. */
export function songLengthBeats(project) {
  let end = 0;
  project.playlist.tracks.forEach((t) => {
    t.clips.forEach((c) => { end = Math.max(end, c.start + c.length); });
  });
  const bar = project.beatsPerBar || 4;
  return Math.max(bar, Math.ceil(end / bar) * bar);
}

export function findPattern(project, id) {
  return project.patterns.find((x) => x.id === id) || null;
}
export function findChannel(project, id) {
  return project.channels.find((x) => x.id === id) || null;
}

/** Sanity-check and repair a loaded project.
 *
 *  Anything can end up in a file the user saved months ago or hand-edited,
 *  and a missing array here surfaces as a crash deep in the audio graph
 *  where the cause is invisible. Repairing at the boundary keeps every
 *  downstream assumption true. */
export function normalizeProject(raw) {
  const base = emptyProject();
  const p = { ...base, ...(raw || {}) };
  p.bpm = Number(p.bpm) > 0 ? Number(p.bpm) : 120;
  p.beatsPerBar = Number(p.beatsPerBar) > 0 ? Number(p.beatsPerBar) : 4;
  p.swing = Number(p.swing) || 0;
  p.channels = Array.isArray(p.channels) ? p.channels : [];
  p.patterns = Array.isArray(p.patterns) ? p.patterns : [];
  p.patterns.forEach((pat) => {
    pat.notes = pat.notes && typeof pat.notes === 'object' ? pat.notes : {};
    pat.lengthBeats = Number(pat.lengthBeats) > 0 ? Number(pat.lengthBeats) : 4;
  });
  p.playlist = p.playlist && Array.isArray(p.playlist.tracks) ? p.playlist : { tracks: [] };
  p.playlist.tracks.forEach((t) => { t.clips = Array.isArray(t.clips) ? t.clips : []; });
  if (!p.mixer || !Array.isArray(p.mixer.inserts) || !p.mixer.inserts.length) {
    p.mixer = base.mixer;
  }
  p.mixer.inserts.forEach((ins) => {
    ins.fx = Array.isArray(ins.fx) ? ins.fx : [];
    ins.sends = Array.isArray(ins.sends) ? ins.sends : [0, 0];
  });
  if (!Array.isArray(p.mixer.returns)) p.mixer.returns = base.mixer.returns;
  p.audioAssets = Array.isArray(p.audioAssets) ? p.audioAssets : [];
  p.selection = p.selection || { patternId: null, channelId: null };
  // Drop clips whose pattern was deleted — they would schedule nothing and
  // draw as ghosts on the playlist.
  const patIds = new Set(p.patterns.map((x) => x.id));
  const assetIds = new Set(p.audioAssets.map((x) => x.id));
  p.playlist.tracks.forEach((t) => {
    t.clips = t.clips.filter((c) => (c.type === 'audio' ? assetIds.has(c.ref) : patIds.has(c.ref)));
  });
  return p;
}
