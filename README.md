# SlipDAW

SlipDAW — a full digital audio workstation in your browser. Channel rack, piano roll, playlist and mixer, with 5 instruments, 8 drum kits, 17 effect plugins and 40 built-in loops. Write, record, mix, master and export to WAV. No signup, no install.

**Live:** <https://daw.slippylabs.com/>

## What it does

- Channel rack, piano roll, playlist and mixer — a full arrangement workflow, not a toy sequencer.
- 5 instruments, 8 drum kits, 17 effect plugins and 40 built-in loops.
- Import your own audio, record, quantise, undo/redo.
- Bounce the finished song to a WAV file.

## How it works

Playback and export share **one graph builder**. The realtime path and the offline render path both construct the audio graph through the same code against whichever context they are given, so what you bounce to WAV is what you heard — the usual way browser DAWs go wrong is having a second, subtly different code path for export, and then the exported mix does not match the preview.

The engine is plain WebAudio with no framework and no build step: `js/engine` owns the graph, instruments, effects and offline render; `js/model` holds the project and loop data; `js/ui` is the piano roll, playlist and mixer; `js/io` handles save and load.

## Run it locally

A static site. No build step, no package manager, no dependencies:

```
git clone git@github.com:slippylabs/daw.slippylabs.com.git
cd daw.slippylabs.com
python3 -m http.server 8000
```

Then open <http://localhost:8000>.

## Tests

Open `tests/engine-tests.html` and `tests/ui-tests.html` in a browser — they run on load and report pass/fail in the page. WebAudio needs a real browser, so there is no headless runner.

## Layout

| File | Purpose |
| --- | --- |
| `js/engine/graph.js` | Audio graph construction, shared by playback and export |
| `js/engine/instruments.js` | The 5 instruments and 8 drum kits |
| `js/engine/effects.js` | The 17 effect plugins |
| `js/engine/render.js` | Offline bounce to WAV |
| `js/model/project.js` | Project state |
| `js/model/loops.js` | The built-in loop library |
| `js/ui/pianoroll.js` | Piano roll editor |
| `js/ui/playlist.js` | Song arrangement |
| `js/ui/mixer.js` | Mixer strip |
| `js/io/storage.js` | Save and load |
| `tests/` | Engine and UI test pages |

---

Part of [Slippy Labs](https://slippylabs.com). Every tool is indexed at
[projects.slippylabs.com](https://projects.slippylabs.com).
