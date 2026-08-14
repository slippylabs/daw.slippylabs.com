// ============================================================
// SlipDAW — mixer view and the generic plugin window
//
// The plugin window is driven entirely by each plugin's parameter
// descriptor, so adding a new instrument or effect means adding a data entry,
// not writing another panel.
// ============================================================

import { EFFECT_TYPES, EFFECT_DEFAULTS, paramsFor } from '../engine/effects.js';
import { INSTRUMENT_PARAMS, INSTRUMENT_TYPES, INSTRUMENT_DEFAULTS, ANALOG_PRESETS } from '../engine/instruments.js';
import { uid, gainToDb } from '../util.js';

export class MixerView {
  constructor(root, app) {
    this.root = root;
    this.app = app;
    this.selected = 0;
    this.strips = [];
  }

  render() {
    const p = this.app.project;
    this.root.innerHTML = '';
    this.strips = [];
    p.mixer.inserts.forEach((ins, idx) => {
      this.root.appendChild(this.strip(ins, idx));
    });
    p.mixer.returns.forEach((r, i) => {
      this.root.appendChild(this.returnStrip(r, i));
    });
  }

  strip(ins, idx) {
    const el = document.createElement('div');
    el.className = `strip${idx === 0 ? ' master' : ''}${idx === this.selected ? ' sel' : ''}`;
    el.addEventListener('pointerdown', () => { this.selected = idx; this.render(); });

    const title = document.createElement('h4');
    title.textContent = ins.name;
    title.title = 'Click to rename';
    title.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      const v = prompt('Insert name', ins.name);
      if (v) { this.app.pushUndo(); ins.name = v; this.render(); this.app.autosave(); }
    });
    el.appendChild(title);

    const slots = document.createElement('div');
    slots.className = 'fx-slots';
    ins.fx.forEach((fx, fi) => {
      const meta = EFFECT_TYPES.find((t) => t.type === fx.type);
      const s = document.createElement('div');
      s.className = `fx-slot${fx.bypass ? ' byp' : ''}`;
      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = `${meta ? meta.icon : ''} ${meta ? meta.name : fx.type}`;
      nm.addEventListener('click', (e) => {
        e.stopPropagation();
        this.app.openEffectWindow(idx, fi);
      });
      const byp = document.createElement('button');
      byp.className = 'dot-btn';
      byp.textContent = 'B';
      byp.title = 'Bypass';
      byp.addEventListener('click', (e) => {
        e.stopPropagation();
        this.app.pushUndo();
        fx.bypass = !fx.bypass;
        this.app.engine.rebuild();
        this.render();
        this.app.autosave();
      });
      const del = document.createElement('button');
      del.className = 'dot-btn';
      del.textContent = '×';
      del.title = 'Remove';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        this.app.pushUndo();
        ins.fx.splice(fi, 1);
        this.app.engine.rebuild();
        this.render();
        this.app.autosave();
      });
      s.append(nm, byp, del);
      slots.appendChild(s);
    });
    const add = document.createElement('div');
    add.className = 'fx-slot fx-add';
    add.textContent = '+ plugin';
    add.addEventListener('click', (e) => {
      e.stopPropagation();
      this.app.effectMenu(e, (type) => {
        this.app.pushUndo();
        ins.fx.push({ id: uid('fx'), type, params: { ...(EFFECT_DEFAULTS[type] || {}) }, bypass: false });
        this.app.engine.rebuild();
        this.render();
        this.app.autosave();
      });
    });
    slots.appendChild(add);
    el.appendChild(slots);

    if (idx > 0) {
      el.appendChild(this.slider('Pan', ins.pan, -1, 1, 0.01, (v) => {
        ins.pan = v; this.app.engine.syncMixer(); this.app.autosaveSoon();
      }));
      const sendA = this.slider('Rev', ins.sends[0] || 0, 0, 1, 0.01, (v) => {
        ins.sends[0] = v; this.app.engine.syncMixer(); this.app.autosaveSoon();
      });
      const sendB = this.slider('Dly', ins.sends[1] || 0, 0, 1, 0.01, (v) => {
        ins.sends[1] = v; this.app.engine.syncMixer(); this.app.autosaveSoon();
      });
      el.append(sendA, sendB);
    }

    const vu = document.createElement('div');
    vu.className = 'vu';
    vu.innerHTML = '<i></i>';
    el.appendChild(vu);

    const fader = document.createElement('input');
    fader.type = 'range';
    fader.className = 'fader';
    fader.min = 0; fader.max = 1.3; fader.step = 0.01;
    fader.value = ins.volume;
    const val = document.createElement('div');
    val.className = 'val num';
    val.textContent = `${gainToDb(ins.volume).toFixed(1)} dB`;
    fader.addEventListener('input', () => {
      ins.volume = Number(fader.value);
      val.textContent = `${gainToDb(ins.volume).toFixed(1)} dB`;
      this.app.engine.syncMixer();
      this.app.autosaveSoon();
    });
    el.append(fader, val);

    if (idx > 0) {
      const row = document.createElement('div');
      row.className = 'row';
      const m = document.createElement('button');
      m.className = `dot-btn${ins.mute ? ' on' : ''}`;
      m.textContent = 'M';
      m.addEventListener('click', (e) => {
        e.stopPropagation(); ins.mute = !ins.mute;
        this.app.engine.syncMixer(); this.render(); this.app.autosave();
      });
      const s = document.createElement('button');
      s.className = `dot-btn solo${ins.solo ? ' on' : ''}`;
      s.textContent = 'S';
      s.addEventListener('click', (e) => {
        e.stopPropagation(); ins.solo = !ins.solo;
        this.app.engine.syncMixer(); this.render(); this.app.autosave();
      });
      row.append(m, s);
      el.appendChild(row);
    }

    this.strips.push({ idx, vu: vu.querySelector('i') });
    return el;
  }

  returnStrip(r, i) {
    const el = document.createElement('div');
    el.className = 'strip';
    const title = document.createElement('h4');
    title.textContent = r.name;
    title.style.color = '#4fc3f7';
    el.appendChild(title);
    const slots = document.createElement('div');
    slots.className = 'fx-slots';
    r.fx.forEach((fx, fi) => {
      const meta = EFFECT_TYPES.find((t) => t.type === fx.type);
      const s = document.createElement('div');
      s.className = 'fx-slot';
      s.textContent = `${meta ? meta.icon : ''} ${meta ? meta.name : fx.type}`;
      s.addEventListener('click', () => this.app.openReturnEffectWindow(i, fi));
      slots.appendChild(s);
    });
    el.appendChild(slots);
    const fader = document.createElement('input');
    fader.type = 'range'; fader.min = 0; fader.max = 1.3; fader.step = 0.01;
    fader.value = r.volume;
    fader.addEventListener('input', () => {
      r.volume = Number(fader.value);
      this.app.engine.rebuild();
      this.app.autosaveSoon();
    });
    el.appendChild(fader);
    return el;
  }

  slider(label, value, min, max, step, onInput) {
    const wrap = document.createElement('div');
    wrap.className = 'knob-row';
    const top = document.createElement('div');
    top.className = 'top';
    const b = document.createElement('b');
    b.className = 'num';
    b.textContent = Number(value).toFixed(2);
    top.append(Object.assign(document.createElement('span'), { textContent: label }), b);
    const input = document.createElement('input');
    input.type = 'range';
    input.min = min; input.max = max; input.step = step; input.value = value;
    input.addEventListener('input', () => {
      const v = Number(input.value);
      b.textContent = v.toFixed(2);
      onInput(v);
    });
    input.addEventListener('pointerdown', (e) => e.stopPropagation());
    wrap.append(top, input);
    return wrap;
  }
}

// ---------------------------------------------------------------
// Generic plugin window
// ---------------------------------------------------------------

export function renderPluginWindow(container, titleEl, spec, app) {
  container.innerHTML = '';
  titleEl.textContent = spec.title;

  spec.params.forEach((desc) => {
    const row = document.createElement('div');
    row.className = 'knob-row';
    const top = document.createElement('div');
    top.className = 'top';
    const name = document.createElement('span');
    name.textContent = desc.label;
    const val = document.createElement('b');
    val.className = 'num';
    top.append(name, val);
    row.appendChild(top);

    const current = spec.get(desc.name);

    if (desc.type === 'enum') {
      val.textContent = '';
      const sel = document.createElement('select');
      desc.options.forEach((o) => {
        const opt = document.createElement('option');
        opt.value = o.value; opt.textContent = o.label;
        sel.appendChild(opt);
      });
      sel.value = current;
      sel.addEventListener('change', () => spec.set(desc.name, sel.value));
      row.appendChild(sel);
    } else if (desc.type === 'bool') {
      const btn = document.createElement('button');
      btn.className = `mini${current ? ' on' : ''}`;
      btn.textContent = current ? 'On' : 'Off';
      btn.addEventListener('click', () => {
        const next = !spec.get(desc.name);
        spec.set(desc.name, next);
        btn.textContent = next ? 'On' : 'Off';
        btn.classList.toggle('on', next);
      });
      row.appendChild(btn);
    } else {
      const input = document.createElement('input');
      input.type = 'range';
      input.min = desc.min; input.max = desc.max; input.step = desc.step;
      const num = current === null || current === undefined ? desc.min : current;
      input.value = num;
      const fmt = (v) => `${Number(v).toFixed(desc.step < 0.1 ? 2 : 0)}${desc.unit ? ` ${desc.unit}` : ''}`;
      val.textContent = fmt(num);
      input.addEventListener('input', () => {
        const v = Number(input.value);
        val.textContent = fmt(v);
        spec.set(desc.name, v);
      });
      row.appendChild(input);
    }
    container.appendChild(row);
  });

  // A spec can contribute its own section beyond the flat parameter list —
  // the drum kit's sample slots are one, and doing it through a hook keeps
  // the generic renderer generic.
  if (spec.custom) spec.custom(container);

  if (spec.footer) {
    const f = document.createElement('div');
    f.style.cssText = 'font-size:.62rem;color:#7fa695;line-height:1.5;border-top:1px solid rgba(57,255,143,.2);padding-top:8px';
    f.textContent = spec.footer;
    container.appendChild(f);
  }
}

export function instrumentSpec(app, channel) {
  const meta = INSTRUMENT_TYPES.find((t) => t.type === channel.instrument);
  return {
    custom: channel.instrument === 'drumkit' ? (el) => app.renderSampleSlots(el, channel) : null,
    title: `${meta ? meta.icon : ''} ${meta ? meta.name : channel.instrument} — ${channel.name}`,
    params: INSTRUMENT_PARAMS[channel.instrument] || [],
    footer: meta ? meta.blurb : '',
    get: (name) => {
      if (channel.params[name] !== undefined && channel.params[name] !== null) {
        return channel.params[name];
      }
      const defaults = INSTRUMENT_DEFAULTS[channel.instrument] || {};
      const fallback = defaults[name];
      // Analog's cutoff/attack/release deliberately default to null, meaning
      // "whatever the selected preset says" — so that is what the knob should
      // read, not the slider's minimum.
      if (fallback === null || fallback === undefined) {
        if (channel.instrument === 'analog') {
          const presetId = channel.params.preset ?? defaults.preset;
          const preset = ANALOG_PRESETS.find((x) => x.id === presetId);
          if (preset && preset[name] !== undefined) return preset[name];
        }
        return fallback === null ? 0 : null;
      }
      return fallback;
    },
    set: (name, value) => {
      channel.params[name] = value;
      // A preset swap changes the whole voice structure, so the instrument
      // has to be rebuilt; a knob can be applied live without dropping notes.
      if (name === 'preset') app.engine.rebuild();
      else app.engine.setInstrumentParam(channel.id, name, value);
      app.autosaveSoon();
    },
  };
}

export function effectSpec(app, fx, insertIndex, fxIndex, onLive) {
  const meta = EFFECT_TYPES.find((t) => t.type === fx.type);
  return {
    title: `${meta ? meta.icon : ''} ${meta ? meta.name : fx.type}`,
    params: paramsFor(fx.type),
    get: (name) => {
      if (fx.params[name] !== undefined) return fx.params[name];
      const d = EFFECT_DEFAULTS[fx.type] || {};
      if (d[name] !== undefined) return d[name];
      return name === 'mix' ? 1 : 0;
    },
    set: (name, value) => {
      fx.params[name] = value;
      onLive(name, value);
      app.autosaveSoon();
    },
  };
}
