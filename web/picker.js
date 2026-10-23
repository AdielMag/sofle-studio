// Reusable HSV colour picker (no dependencies).
// Colours are protocol HSV: h 0..359, s 0..100, v 0..max (max = keyboard brightness cap).
// On screen, brightness is shown relative to the cap (v == max looks fully vivid) so the cap never makes the UI murky.
import { hsvToRgb } from './proto.js';
import { h, clamp, icon } from './ui.js';

export const rgbCss = (r) => `rgb(${r[0]},${r[1]},${r[2]})`;
/** CSS colour of an LED value, relative to the brightness cap. */
export function ledCss(hue, sat, val, max = 100) { return rgbCss(hsvToRgb(hue, sat, max ? clamp(val / max, 0, 1) * 100 : 0)); }
const hex2 = (n) => n.toString(16).padStart(2, '0');
const toHex = (rgb) => '#' + rgb.map(hex2).join('');
function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; let hh = 0;
  if (d) { if (mx === r) hh = ((g - b) / d + 6) % 6; else if (mx === g) hh = (b - r) / d + 2; else hh = (r - g) / d + 4; }
  return { h: Math.round(hh * 60) % 360, s: Math.round(mx ? (d / mx) * 100 : 0), v: Math.round(mx * 100) };
}
export function parseHex(t) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(t).trim()); if (!m) return null;
  let x = m[1]; if (x.length === 3) x = [...x].map((c) => c + c).join('');
  return rgbToHsv(parseInt(x.slice(0, 2), 16), parseInt(x.slice(2, 4), 16), parseInt(x.slice(4, 6), 16));
}

const PRESETS = [['Red', 0, 100], ['Orange', 22, 100], ['Amber', 42, 100], ['Lime', 90, 100], ['Green', 130, 100], ['Teal', 168, 100], ['Cyan', 190, 100], ['Blue', 222, 100], ['Violet', 266, 90], ['Magenta', 305, 100], ['Pink', 340, 60], ['White', 0, 0]];
const RECENT_KEY = 'rgbpk.recent';
let recent = []; try { recent = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]').filter((x) => Array.isArray(x) && x.length === 2).slice(0, 8); } catch { /* ignore */ }
function pushRecent(hue, sat) {
  recent = [[hue, sat], ...recent.filter((x) => !(x[0] === hue && x[1] === sat))].slice(0, 8);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(recent)); } catch { /* ignore */ }
  window.dispatchEvent(new Event('rgbpk-recent'));
}

const RAINBOW = 'linear-gradient(90deg,' + [0, 60, 120, 180, 240, 300, 359].map((x) => rgbCss(hsvToRgb(x, 100, 100))).join(',') + ')';
let uid = 0;

/**
 * opts: { max, hue (bool: this colour has a hue), onInput({h,s,v}), onCommit?({h,s,v}), label }
 * returns { el, set(h,s,v), setMax(n), setHue(bool) }
 */
export function createPicker(opts) {
  const id = 'pk' + ++uid;
  let max = opts.max || 100, hasHue = opts.hue !== false;
  const showVal = opts.showVal !== false;
  const c = { h: 0, s: 100, v: showVal ? 0 : max };

  const thumb = h('div', { class: 'pk-thumb' });
  const sv = h('div', { class: 'pk-sv', tabindex: 0, role: 'slider', 'aria-label': 'Saturation and brightness' }, thumb);
  if (!showVal) sv.hidden = true;

  const hueR = h('input', { type: 'range', id: id + 'h', min: 0, max: 359, step: 1, class: 'pk-range pk-hue' });
  const satR = h('input', { type: 'range', id: id + 's', min: 0, max: 100, step: 1, class: 'pk-range' });
  const valR = h('input', { type: 'range', id: id + 'v', min: 0, max: max, step: 1, class: 'pk-range' });
  const num = (key, mx, lbl) => h('input', { type: 'number', class: 'pk-num', min: 0, max: mx, step: 1, inputmode: 'numeric', 'aria-label': lbl, dataset: { k: key } });
  const nH = num('h', 359, 'Hue, degrees'), nS = num('s', 100, 'Saturation, percent'), nV = num('v', max, 'Brightness');
  const hex = h('input', { type: 'text', class: 'pk-hex', maxlength: 7, spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Hex colour' });
  const sw = h('div', { class: 'pk-preview' });
  const maxTxt = h('span', { class: 'pk-max' });
  const presets = h('div', { class: 'pk-swatches', role: 'group', 'aria-label': 'Preset colours' }, PRESETS.map(([n, hh, ss]) =>
    h('button', { type: 'button', class: 'pk-chip', title: n, 'aria-label': n, style: `--c:${rgbCss(hsvToRgb(hh, ss, 100))}`, onclick: () => pick(hh, ss) })));
  const recentBox = h('div', { class: 'pk-swatches pk-recent', role: 'group', 'aria-label': 'Recent colours' });

  const row = (lbl, input, extra) => h('div', { class: 'pk-row' }, h('label', { for: input.id }, lbl), input, extra || null);
  const valRow = row('Brightness', valR, maxTxt);
  if (!showVal) valRow.hidden = true;
  const vField = h('label', { class: 'pk-f' }, h('span', null, 'V'), nV);
  if (!showVal) vField.hidden = true;

  const el = h('div', { class: 'picker' + (opts.compact ? ' compact' : '') },
    sv,
    h('div', { class: 'pk-hue-row', dataset: { hue: 1 } }, row('Hue', hueR)),
    h('div', { class: 'pk-sat-row', dataset: showVal ? { nohue: 1 } : {} }, row('Saturation', satR)),
    valRow,
    h('div', { class: 'pk-fields' },
      sw,
      h('label', { class: 'pk-f pk-f-hex', dataset: { hue: 1 } }, h('span', null, 'Hex'), hex),
      h('label', { class: 'pk-f', dataset: { hue: 1 } }, h('span', null, 'H'), nH),
      h('label', { class: 'pk-f' }, h('span', null, 'S'), nS),
      vField),
    h('div', { class: 'pk-pre', dataset: { hue: 1 } }, h('span', { class: 'pk-cap' }, 'Presets'), presets),
    h('div', { class: 'pk-pre', dataset: { hue: 1 }, hidden: true }, h('span', { class: 'pk-cap' }, 'Recent'), recentBox));
  const recentRow = recentBox.parentElement;

  function renderRecent() {
    recentBox.textContent = ''; recentRow.hidden = !recent.length;
    recent.forEach(([hh, ss]) => recentBox.appendChild(h('button', { type: 'button', class: 'pk-chip', title: `Hue ${hh}, saturation ${ss}`, 'aria-label': `Recent colour hue ${hh} saturation ${ss}`, style: `--c:${rgbCss(hsvToRgb(hh, ss, 100))}`, onclick: () => pick(hh, ss) })));
  }
  window.addEventListener('rgbpk-recent', renderRecent); renderRecent();

  function paint() {
    const rel = max ? (c.v / max) * 100 : 0;
    const full = rgbCss(hsvToRgb(c.h, 100, 100));
    el.style.setProperty('--hue', full);
    sv.style.setProperty('--hue', full);
    thumb.style.left = c.s + '%'; thumb.style.top = (100 - rel) + '%';
    thumb.style.setProperty('--c', ledCss(c.h, c.s, c.v, max));
    sv.setAttribute('aria-valuenow', Math.round(rel)); sv.setAttribute('aria-valuemin', 0); sv.setAttribute('aria-valuemax', 100);
    sv.setAttribute('aria-valuetext', `Saturation ${c.s}%, brightness ${c.v} of ${max}`);
    hueR.value = c.h; satR.value = c.s; valR.value = c.v;
    hueR.style.setProperty('--thumb', rgbCss(hsvToRgb(c.h, 100, 100)));
    satR.style.background = hasHue
      ? `linear-gradient(90deg,#fff,${full})`
      : 'linear-gradient(90deg,#fff,#ff7b7b,#ffd166,#5fd08a,#4cc9f0,#b185ff)';
    valR.style.background = hasHue ? `linear-gradient(90deg,#000,${rgbCss(hsvToRgb(c.h, c.s, 100))})` : `linear-gradient(90deg,#000,#fff)`;
    const cur = ledCss(c.h, c.s, c.v, max);
    sw.style.background = cur;
    for (const [n, v] of [[nH, c.h], [nS, c.s], [nV, c.v]]) if (document.activeElement !== n) n.value = v;
    if (document.activeElement !== hex) hex.value = toHex(hsvToRgb(c.h, c.s, max ? (c.v / max) * 100 : 0));
    hex.classList.remove('bad');
    maxTxt.textContent = `of ${max}`;
  }
  function apply(patch, commit) {
    Object.assign(c, patch);
    c.h = clamp(Math.round(c.h), 0, 359); c.s = clamp(Math.round(c.s), 0, 100); c.v = clamp(Math.round(c.v), 0, max);
    paint(); opts.onInput({ ...c });
    if (commit) { if (hasHue) pushRecent(c.h, c.s); opts.onCommit?.({ ...c }); }
  }
  function pick(hh, ss) {
    const v = showVal ? (c.v === 0 ? max : c.v) : (opts.getVal ? opts.getVal() : max);
    apply({ h: hh, s: ss, v }, true);
  }

  // saturation / brightness square
  const fromPointer = (e) => {
    const r = sv.getBoundingClientRect();
    apply({ s: ((e.clientX - r.left) / r.width) * 100, v: (1 - (e.clientY - r.top) / r.height) * max });
  };
  sv.addEventListener('pointerdown', (e) => { sv.setPointerCapture(e.pointerId); sv.classList.add('drag'); sv.focus(); fromPointer(e); e.preventDefault(); });
  sv.addEventListener('pointermove', (e) => { if (sv.hasPointerCapture(e.pointerId)) fromPointer(e); });
  const endDrag = (e) => { if (sv.hasPointerCapture(e.pointerId)) { sv.releasePointerCapture(e.pointerId); sv.classList.remove('drag'); apply({}, true); } };
  sv.addEventListener('pointerup', endDrag); sv.addEventListener('pointercancel', endDrag);
  let kTimer;
  sv.addEventListener('keydown', (e) => {
    const st = e.shiftKey ? 10 : 1, vst = e.shiftKey ? Math.max(1, Math.round(max / 10)) : 1;
    const d = { ArrowLeft: [-st, 0], ArrowRight: [st, 0], ArrowUp: [0, vst], ArrowDown: [0, -vst] }[e.key];
    if (!d) return; e.preventDefault();
    apply({ s: c.s + d[0], v: c.v + d[1] });
    clearTimeout(kTimer); kTimer = setTimeout(() => apply({}, true), 500);
  });

  for (const [r, key] of [[hueR, 'h'], [satR, 's'], [valR, 'v']]) {
    r.addEventListener('input', () => apply({ [key]: Number(r.value) }));
    r.addEventListener('change', () => apply({}, true));
  }
  for (const n of [nH, nS, nV]) {
    n.addEventListener('input', () => { if (n.value !== '' && Number.isFinite(Number(n.value))) apply({ [n.dataset.k]: Number(n.value) }); });
    n.addEventListener('change', () => { n.value = c[n.dataset.k]; apply({}, true); });
  }
  const commitHex = () => {
    const p = parseHex(hex.value);
    if (!p) { hex.classList.add('bad'); return; }
    apply({ h: p.h, s: p.s, v: Math.round((p.v / 100) * max) }, true);
  };
  hex.addEventListener('change', commitHex);
  hex.addEventListener('keydown', (e) => { if (e.key === 'Enter') { commitHex(); } });
  hex.addEventListener('input', () => hex.classList.toggle('bad', !!hex.value && !parseHex(hex.value)));

  function setHue(b) { hasHue = b; el.classList.toggle('nohue', !b); paint(); }
  setHue(hasHue); paint();
  return {
    el,
    set(hh, ss, vv) { c.h = clamp(hh, 0, 359); c.s = clamp(ss, 0, 100); c.v = clamp(vv, 0, max); paint(); },
    setMax(m) { max = m; valR.max = m; nV.max = m; c.v = Math.min(c.v, m); paint(); },
    setHue,
  };
}
