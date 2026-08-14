// ============================================================
// SlipDAW — loop library
//
// These are *pattern* loops, not audio files: each one is a list of notes in
// the same `{ beat, dur, pitch, vel }` shape a pattern already stores. That
// is deliberate. A pattern loop drops onto whichever kit or synth you have
// selected, follows the project tempo without artefacts, and stays fully
// editable in the piano roll — none of which an audio loop can do. If you
// want one as real audio, the Bounce button renders it locally.
//
// Everything here was written for this file, so there is no licence attached
// to any of it and nothing had to be downloaded.
// ============================================================

// Drum voice pitches, matching DRUM_VOICES in engine/instruments.js.
const K = 36, S = 38, CL = 39, CH = 42, OH = 46, RD = 51, PC = 48;

/** Compact note builders. `at()` places one hit; `every()` fills a run of
 *  evenly spaced hits; `seq()` reads a 16-step string where '-' is a rest. */
const at = (beat, pitch, vel = 100, dur = 0.25) => ({ beat, dur, pitch, vel });

function every(fromBeat, count, stepBeats, pitch, vel = 100, dur = 0.12) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(at(fromBeat + i * stepBeats, pitch, vel, dur));
  return out;
}

/** 'x' = hit, 'X' = accent, 'o' = ghost, '-' = rest. One character per 16th. */
function seq(str, pitch, { hit = 100, accent = 122, ghost = 52, dur = 0.12 } = {}) {
  const out = [];
  [...str].forEach((c, i) => {
    if (c === '-' || c === ' ') return;
    const vel = c === 'X' ? accent : c === 'o' ? ghost : hit;
    out.push(at(i * 0.25, pitch, vel, dur));
  });
  return out;
}

const DRUMS = { instrument: 'drumkit', pitched: false, name: 'Drum Kit', params: {} };
const KIT = (kit) => ({ instrument: 'drumkit', pitched: false, name: 'Drum Kit', params: { kit } });
const BASS808 = { instrument: 'drumkit', pitched: true, stepPitch: 29, name: '808 Bass', params: { kit: '808' } };
const SUB = { instrument: 'analog', pitched: false, name: 'Bass', params: { preset: 'sub-bass', level: 0.75 } };
const PAD = { instrument: 'analog', pitched: false, name: 'Pad', params: { preset: 'warm-pad', level: 0.5 } };
const KEYS = { instrument: 'analog', pitched: false, name: 'Keys', params: { preset: 'organ', level: 0.55 } };
const PLUCK = { instrument: 'pluck', pitched: false, name: 'Pluck', params: { decay: 0.994, brightness: 0.6 } };
const LEAD = { instrument: 'analog', pitched: false, name: 'Lead', params: { preset: 'supersaw', level: 0.5 } };
const BELL = { instrument: 'fm', pitched: false, name: 'FM Bell', params: { ratio: 3.5, index: 420 } };

export const LOOPS = [
  // ---------- Drums ----------
  {
    id: 'trap-groove', name: 'Trap Groove', category: 'Drums', bars: 1, bpm: 140, target: KIT('trap'),
    notes: [
      ...seq('X--x----X-------', K),
      ...seq('----X-------X---', S),
      ...seq('xoxoxoxoxoxoxoxo', CH),
      ...seq('--------------x-', OH),
    ],
  },
  {
    id: 'trap-rolls', name: 'Trap + Hat Rolls', category: 'Drums', bars: 1, bpm: 146, target: KIT('trap'),
    notes: [
      ...seq('X-----x-X-------', K),
      ...seq('----X-------X---', S),
      ...seq('xoxoxxxxxoxoxxxx', CH),
      ...every(3.5, 4, 0.125, CH, 70, 0.08),
    ],
  },
  {
    id: 'boom-bap', name: 'Boom Bap', category: 'Drums', bars: 1, bpm: 90, target: KIT('acoustic'),
    notes: [
      ...seq('X-----x---X-----', K),
      ...seq('----X-------X---', S),
      ...seq('x-x-x-x-x-x-x-x-', CH),
      ...seq('--o---------o---', S, { ghost: 40 }),
    ],
  },
  {
    id: 'four-floor', name: 'Four on the Floor', category: 'Drums', bars: 1, bpm: 126, target: KIT('909'),
    notes: [
      ...seq('X---X---X---X---', K),
      ...seq('----X-------X---', CL),
      ...seq('--x---x---x---x-', OH, { hit: 72 }),
      ...seq('x-x-x-x-x-x-x-x-', CH, { hit: 62 }),
    ],
  },
  {
    id: 'techno-drive', name: 'Techno Drive', category: 'Drums', bars: 1, bpm: 132, target: KIT('techno'),
    notes: [
      ...seq('X---X---X---X---', K),
      ...seq('--x---x---x---x-', OH, { hit: 66 }),
      ...seq('xxxxxxxxxxxxxxxx', CH, { hit: 48 }),
      ...seq('--------X-------', CL),
    ],
  },
  {
    id: 'house-shuffle', name: 'House Shuffle', category: 'Drums', bars: 1, bpm: 124, target: KIT('909'),
    notes: [
      ...seq('X---X---X---X---', K),
      ...seq('----X-------X---', S),
      ...seq('--x-x---x-x-x---', CH),
      ...seq('------x-------x-', OH, { hit: 74 }),
    ],
  },
  {
    id: 'breakbeat-amen', name: 'Breakbeat', category: 'Drums', bars: 1, bpm: 172, target: KIT('breakbeat'),
    notes: [
      ...seq('X-----x---X-x---', K),
      ...seq('----X---o---X-o-', S),
      ...seq('x-x-x-x-x-x-x-x-', CH, { hit: 66 }),
    ],
  },
  {
    id: 'jungle-chop', name: 'Jungle Chop', category: 'Drums', bars: 1, bpm: 168, target: KIT('breakbeat'),
    notes: [
      ...seq('X---------X-----', K),
      ...seq('----X---o-o-X---', S),
      ...seq('xoxoxoxoxoxoxoxo', CH, { hit: 58 }),
      ...seq('-------------x--', OH, { hit: 70 }),
    ],
  },
  {
    id: 'half-time', name: 'Half Time', category: 'Drums', bars: 1, bpm: 150, target: KIT('trap'),
    notes: [
      ...seq('X---------------', K),
      ...seq('--------X-------', S),
      ...seq('x-x-x-x-x-x-x-x-', CH, { hit: 70 }),
    ],
  },
  {
    id: 'drill', name: 'Drill', category: 'Drums', bars: 1, bpm: 142, target: KIT('trap'),
    notes: [
      ...seq('X-----x---x-----', K),
      ...seq('--------X-------', S),
      ...seq('x-xxx-x-x-xxx-x-', CH, { hit: 74 }),
      ...seq('------------X---', CL, { hit: 88 }),
    ],
  },
  {
    id: 'funk-16', name: 'Funk Sixteenths', category: 'Drums', bars: 1, bpm: 104, target: KIT('acoustic'),
    notes: [
      ...seq('X---o-x---X-o---', K),
      ...seq('----X---o---X---', S),
      ...seq('xxxxxxxxxxxxxxxx', CH, { hit: 56, accent: 92 }),
    ],
  },
  {
    id: 'lofi-sway', name: 'Lo-Fi Sway', category: 'Drums', bars: 1, bpm: 84, target: KIT('lofi'),
    notes: [
      ...seq('X-------o-X-----', K),
      ...seq('----X-------X---', S),
      ...seq('x--xx--xx--xx--x', CH, { hit: 54 }),
    ],
  },
  {
    id: 'electro-606', name: 'Electro 606', category: 'Drums', bars: 1, bpm: 128, target: KIT('606'),
    notes: [
      ...seq('X---x-X---x-X---', K),
      ...seq('----X-------X---', S),
      ...seq('xxxxxxxxxxxxxxxx', CH, { hit: 46 }),
    ],
  },
  {
    id: 'dnb-two-step', name: 'D&B Two Step', category: 'Drums', bars: 1, bpm: 174, target: KIT('breakbeat'),
    notes: [
      ...seq('X---------x-----', K),
      ...seq('----X-------X---', S),
      ...seq('--x---x---x---x-', CH, { hit: 62 }),
      ...seq('------------x---', RD, { hit: 54 }),
    ],
  },
  {
    id: 'ride-groove', name: 'Ride Groove', category: 'Drums', bars: 1, bpm: 112, target: KIT('acoustic'),
    notes: [
      ...seq('X-------X-------', K),
      ...seq('----X-------X---', S),
      ...every(0, 8, 0.5, RD, 78, 0.4),
    ],
  },

  // ---------- Bass ----------
  {
    id: '808-slide', name: '808 Slide', category: 'Bass', bars: 1, bpm: 140, target: BASS808,
    notes: [at(0, 29, 120, 0.9), at(1.5, 29, 96, 0.4), at(2, 32, 116, 0.9), at(3.25, 34, 108, 0.6)],
  },
  {
    id: '808-minor-walk', name: '808 Minor Walk', category: 'Bass', bars: 1, bpm: 138, target: BASS808,
    notes: [at(0, 29, 120, 0.8), at(1, 36, 100, 0.4), at(2, 34, 116, 0.8), at(3, 32, 104, 0.7)],
  },
  {
    id: '808-triplet', name: '808 Triplets', category: 'Bass', bars: 1, bpm: 144, target: BASS808,
    notes: [
      at(0, 29, 120, 0.6), at(0.66, 29, 92, 0.3), at(1.33, 29, 92, 0.3),
      at(2, 34, 118, 0.6), at(2.66, 34, 92, 0.3), at(3.33, 36, 100, 0.5),
    ],
  },
  {
    id: 'sub-pulse', name: 'Sub Pulse', category: 'Bass', bars: 1, bpm: 128, target: SUB,
    notes: every(0, 8, 0.5, 36, 104, 0.4),
  },
  {
    id: 'offbeat-bass', name: 'Offbeat Bass', category: 'Bass', bars: 1, bpm: 126, target: SUB,
    notes: [at(0.5, 40, 106, 0.4), at(1.5, 40, 106, 0.4), at(2.5, 38, 106, 0.4), at(3.5, 43, 106, 0.4)],
  },
  {
    id: 'walking-bass', name: 'Walking Bass', category: 'Bass', bars: 1, bpm: 116, target: SUB,
    notes: [at(0, 40, 100, 0.9), at(1, 43, 96, 0.9), at(2, 45, 98, 0.9), at(3, 47, 94, 0.9)],
  },
  {
    id: 'acid-line', name: 'Acid Line', category: 'Bass', bars: 1, bpm: 130,
    target: { instrument: 'analog', pitched: false, name: 'Acid', params: { preset: 'wobble-bass', level: 0.6 } },
    notes: [
      at(0, 40, 118, 0.22), at(0.5, 40, 84, 0.22), at(0.75, 52, 104, 0.22), at(1.25, 40, 88, 0.22),
      at(2, 43, 116, 0.22), at(2.5, 40, 84, 0.22), at(3, 47, 106, 0.22), at(3.5, 40, 90, 0.22),
    ],
  },
  {
    id: 'reggae-drop', name: 'Dub Drop', category: 'Bass', bars: 1, bpm: 74, target: SUB,
    notes: [at(0.5, 33, 116, 0.7), at(2, 38, 110, 0.6), at(3, 36, 104, 0.9)],
  },

  // ---------- Chords ----------
  {
    id: 'minor7-bed', name: 'Minor 7 Bed', category: 'Chords', bars: 1, bpm: 120, target: PAD,
    notes: [at(0, 53, 70, 4), at(0, 56, 62, 4), at(0, 60, 58, 4), at(0, 63, 54, 4)],
  },
  {
    id: 'lofi-jazz', name: 'Lo-Fi Jazz Chords', category: 'Chords', bars: 1, bpm: 84, target: KEYS,
    notes: [
      at(0, 57, 74, 1.6), at(0, 60, 66, 1.6), at(0, 64, 62, 1.6), at(0, 67, 58, 1.6),
      at(2, 55, 72, 1.8), at(2, 59, 64, 1.8), at(2, 62, 60, 1.8), at(2, 65, 56, 1.8),
    ],
  },
  {
    id: 'house-stabs', name: 'House Stabs', category: 'Chords', bars: 1, bpm: 126, target: KEYS,
    notes: [
      at(0.5, 60, 96, 0.22), at(0.5, 63, 90, 0.22), at(0.5, 67, 86, 0.22),
      at(1.5, 60, 96, 0.22), at(1.5, 63, 90, 0.22), at(1.5, 67, 86, 0.22),
      at(2.5, 62, 96, 0.22), at(2.5, 65, 90, 0.22), at(2.5, 69, 86, 0.22),
      at(3.5, 62, 96, 0.22), at(3.5, 65, 90, 0.22), at(3.5, 69, 86, 0.22),
    ],
  },
  {
    id: 'sad-progression', name: 'Sad Progression', category: 'Chords', bars: 2, bpm: 92, target: PAD,
    notes: [
      at(0, 57, 68, 2), at(0, 60, 62, 2), at(0, 64, 58, 2),
      at(2, 53, 68, 2), at(2, 57, 62, 2), at(2, 60, 58, 2),
      at(4, 55, 68, 2), at(4, 59, 62, 2), at(4, 62, 58, 2),
      at(6, 52, 68, 2), at(6, 55, 62, 2), at(6, 59, 58, 2),
    ],
  },
  {
    id: 'suspended-swell', name: 'Suspended Swell', category: 'Chords', bars: 2, bpm: 100, target: PAD,
    notes: [at(0, 55, 60, 8), at(0, 60, 56, 8), at(0, 62, 52, 8), at(0, 67, 48, 8)],
  },
  {
    id: 'trap-keys', name: 'Trap Keys', category: 'Chords', bars: 1, bpm: 140, target: BELL,
    notes: [
      at(0, 65, 92, 0.5), at(0, 68, 84, 0.5), at(0, 72, 78, 0.5),
      at(1.5, 63, 90, 0.5), at(1.5, 67, 82, 0.5), at(1.5, 70, 76, 0.5),
      at(3, 60, 88, 0.9), at(3, 63, 80, 0.9), at(3, 67, 74, 0.9),
    ],
  },

  // ---------- Melody ----------
  {
    id: 'pluck-lead', name: 'Pluck Lead', category: 'Melody', bars: 1, bpm: 140, target: PLUCK,
    notes: [
      at(0, 72, 100, 0.5), at(0.5, 75, 92, 0.25), at(1, 77, 104, 0.75),
      at(2, 75, 96, 0.5), at(2.5, 72, 88, 0.25), at(3, 68, 100, 1),
    ],
  },
  {
    id: 'arp-up', name: 'Arp Up', category: 'Melody', bars: 1, bpm: 128, target: PLUCK,
    notes: [60, 63, 67, 70, 72, 70, 67, 63].map((p, i) => at(i * 0.5, p, 94, 0.22)),
  },
  {
    id: 'arp-16', name: 'Sixteenth Arp', category: 'Melody', bars: 1, bpm: 132, target: BELL,
    notes: [60, 64, 67, 72, 67, 64, 60, 64, 67, 72, 76, 72, 67, 64, 60, 55]
      .map((p, i) => at(i * 0.25, p, 84, 0.14)),
  },
  {
    id: 'supersaw-hook', name: 'Supersaw Hook', category: 'Melody', bars: 2, bpm: 128, target: LEAD,
    notes: [
      at(0, 72, 96, 0.75), at(0.75, 74, 90, 0.25), at(1, 76, 100, 1),
      at(2.5, 74, 92, 0.5), at(3, 72, 96, 1),
      at(4, 69, 94, 0.75), at(4.75, 72, 90, 0.25), at(5, 74, 100, 1.5),
      at(7, 76, 98, 1),
    ],
  },
  {
    id: 'bell-motif', name: 'Bell Motif', category: 'Melody', bars: 1, bpm: 96, target: BELL,
    notes: [at(0, 84, 92, 0.5), at(1, 79, 84, 0.5), at(2, 81, 88, 0.5), at(3, 76, 80, 1)],
  },
  {
    id: 'pentatonic-run', name: 'Pentatonic Run', category: 'Melody', bars: 1, bpm: 120, target: PLUCK,
    notes: [60, 63, 65, 67, 70, 72, 75, 77].map((p, i) => at(i * 0.5, p, 90, 0.24)),
  },

  // ---------- Fills ----------
  {
    id: 'hat-roll', name: 'Hat Roll', category: 'Fills', bars: 1, bpm: 140, target: DRUMS,
    notes: [
      ...every(0, 4, 0.5, CH, 78, 0.12),
      ...every(2, 4, 0.25, CH, 88, 0.1),
      ...every(3, 8, 0.125, CH, 100, 0.08),
    ],
  },
  {
    id: 'snare-build', name: 'Snare Build', category: 'Fills', bars: 1, bpm: 128, target: DRUMS,
    notes: [
      ...every(0, 2, 0.5, S, 60, 0.15),
      ...every(1, 4, 0.25, S, 82, 0.12),
      ...every(2, 8, 0.125, S, 104, 0.1),
      ...every(3, 8, 0.125, S, 122, 0.1),
    ],
  },
  {
    id: 'tom-fill', name: 'Perc Fill', category: 'Fills', bars: 1, bpm: 110, target: KIT('acoustic'),
    notes: [
      at(0, PC, 110, 0.2), at(0.5, PC, 96, 0.2), at(1, PC, 104, 0.2), at(1.5, PC, 90, 0.2),
      at(2, S, 108, 0.2), at(2.5, S, 96, 0.2), at(3, S, 112, 0.2), at(3.5, K, 122, 0.3),
    ],
  },
  {
    id: 'clap-stack', name: 'Clap Stack', category: 'Fills', bars: 1, bpm: 126, target: DRUMS,
    notes: [at(3, CL, 90, 0.2), at(3.25, CL, 100, 0.2), at(3.5, CL, 110, 0.2), at(3.75, CL, 122, 0.2)],
  },
  {
    id: 'kick-stutter', name: 'Kick Stutter', category: 'Fills', bars: 1, bpm: 140, target: DRUMS,
    notes: [at(3, K, 100, 0.2), at(3.25, K, 108, 0.2), at(3.5, K, 116, 0.2), at(3.75, K, 124, 0.2)],
  },
];

export const LOOP_CATEGORIES = [...new Set(LOOPS.map((l) => l.category))];
