import * as P from './proto.js';
import { LABELS, LAYER_NAMES } from './labels.js';
import { POS2LED, LED_X, LED_Y, NO_LED, MIRROR } from './layout.js';
import { $, h, icon, mountHelp, toast, confirmDialog, isPopOpen, clamp } from './ui.js';
import { createPicker, ledCss } from './picker.js';
import { initKeymap } from './keymap.js';

const params = new URLSearchParams(location.search);
const DEMO = params.has('demo');

// ---------- domain tables (effect capabilities verified against src/effects.c) ----------
const EFFECT_META = [
  { hue: true, speed: false, d: 'One steady colour on every key.' },
  { hue: true, speed: true, d: 'The colour slowly fades in and out.' },
  { hue: false, speed: true, d: 'The whole board cycles through every hue together.' },
  { hue: false, speed: true, d: 'A rainbow that rotates around the board.' },
  { hue: true, speed: true, d: 'A bright band sweeps from left to right.' },
  { hue: false, speed: true, d: 'Rainbow rings spread outward from the centre.' },
  { hue: true, speed: false, d: 'A still gradient that shifts hue from left to right.' },
  { hue: true, speed: true, d: 'Keys twinkle on and off at random in your colour.' },
  { hue: false, speed: false, d: 'No base lighting. Keys stay dark until you type.' },
];
const REACT_DESC = [
  'Nothing happens when you type.',
  'The pressed key lights up, then fades out in about half a second.',
  'A wave spreads outward from each pressed key.',
  'The key stays lit while held, then fades.',
  'Each press lights the key in the next colour of a rotating palette.',
];
const MODE_UI = [ // protocol mode id -> text; shown in this order
  { m: 0, n: 'Transparent', d: 'Lets the layer below decide, usually the effect.' },
  { m: 2, n: 'Solid colour', d: 'A fixed colour of your choice.' },
  { m: 3, n: 'Follow effect', d: 'Shows the running effect. Keypress effects still apply.' },
  { m: 1, n: 'Off', d: 'The LED stays dark.' },
  { m: 4, n: 'Static', d: 'Ignores keypress effects. Uses your colour, or the effect if none.' },
];

const S = {
  dev: null, info: null, cfg: P.defaultConfig(), savedSnap: '', layer: 0, sel: new Set(), primary: null,
  mask: 1, top: 0, dirty: false, pollFails: 0, ready: false,
  pendKeys: new Map(), pendGlobal: null, pendLayer: false, pendFull: false, timers: {},
  activeStop: 1,
};
const brtMax = () => S.info?.brtMax || 40;
const keyOf = (pos) => S.cfg.keys[S.layer][pos];

// ---------- progress / status / dirty ----------
function progress(f) {
  const p = $('progress'); p.hidden = f == null || f >= 1; p.firstElementChild.style.width = (f ?? 0) * 100 + '%';
  p.setAttribute('aria-valuenow', Math.round((f ?? 0) * 100));
}
function setStatus(state, text) { $('conn').dataset.state = state; $('connText').textContent = text; }
function snap() { return JSON.stringify([S.cfg.g, S.cfg.layers, S.cfg.keys]); }
function touched() {
  S.dirty = snap() !== S.savedSnap;
  $('dirty').hidden = !S.dirty; $('btnSave').disabled = !S.dirty || !S.dev;
  $('btnUndo').disabled = !H.undo.length; $('btnRedo').disabled = !H.redo.length;
}
let VIEW = 'rgb', APP = false;
function showView(app) {
  APP = app; const km = VIEW === 'keymap';
  $('empty').hidden = km || app; $('main').hidden = km || !app; $('studio').hidden = !km;
  document.body.classList.toggle('view-keymap', km);
  $('btnSave').hidden = !app; $('btnUndo').hidden = !app; $('btnRedo').hidden = !app; $('btnIntro').hidden = !app; $('btnConnect').hidden = true; // status pill already shows the connection
  $('dirty').hidden = !app || !S.dirty;
}

// ---------- undo / redo ----------
const H = { undo: [], redo: [], group: null, t: 0 };
function beginEdit(group) {
  const now = performance.now();
  if (group && group === H.group && now - H.t < 900) { H.t = now; return; }
  H.undo.push(snap()); if (H.undo.length > 100) H.undo.shift();
  H.redo.length = 0; H.group = group; H.t = now;
}
function restoreSnap(str) {
  const [g, layers, keys] = JSON.parse(str); const old = S.cfg;
  const gf = {}; for (const k in g) if (g[k] !== old.g[k]) gf[k] = g[k];
  let nKeys = 0; const changed = [];
  for (let l = 0; l < P.NUM_LAYERS; l++) for (let p = 0; p < P.NUM_POS; p++)
    if (JSON.stringify(old.keys[l][p]) !== JSON.stringify(keys[l][p])) { nKeys++; changed.push([l, p]); }
  const layersChanged = JSON.stringify(old.layers) !== JSON.stringify(layers);
  S.cfg = { ...old, g, layers, keys };
  if (Object.keys(gf).length) queueGlobal(gf);
  if (nKeys > 12) queueFull(); else changed.forEach(([l, p]) => queueKey(l, p));
  if (layersChanged && nKeys <= 12) queueLayer();
  H.group = null;
  renderAll();
}
function undo() { if (!H.undo.length || !S.ready) return; H.redo.push(snap()); restoreSnap(H.undo.pop()); touched(); }
function redo() { if (!H.redo.length || !S.ready) return; H.undo.push(snap()); restoreSnap(H.redo.pop()); touched(); }

// ---------- serialized task queue (keeps multi-step ops atomic) ----------
let tasks = Promise.resolve(); let taskCount = 0;
function enqueue(fn) {
  taskCount++;
  const run = async () => { try { return await fn(); } finally { taskCount--; } };
  const p = tasks.then(run, run);
  tasks = p.catch(() => {});
  return p;
}
async function guarded(fn, retry) {
  try { return await fn(); } catch (e) {
    toast(e.message || String(e), { kind: 'err', retry }); progress(null);
    if (e.code === 'send') onDisconnected(true);
    return undefined;
  }
}

// ---------- connection ----------
async function useDevice(hid) {
  if (S.dev) await S.dev.close();
  setStatus('busy', 'Connecting…'); showView(true); setLoading(true);
  const dev = new P.Device(hid, DEMO ? { timeout: 300 } : undefined);
  try {
    await dev.open(); S.dev = dev;
    await loadAll();
    setStatus('on', (DEMO ? 'Demo keyboard' : 'Connected') + (hid.productName && !DEMO ? ' · ' + hid.productName : ''));
  } catch (e) {
    if (!S.ready) { showView(false); setLoading(false); setStatus('err', 'Connection failed'); S.dev = null; }
    throw e;
  }
}
async function loadAll() {
  S.lost?.dismiss?.(); S.lost = null;
  const info = await S.dev.info();
  if (info.proto !== 1 || info.cfgVersion !== P.CFG_VERSION || info.cfgSize !== P.CFG_SIZE || info.layers !== 4 || info.positions !== 60)
    throw new P.ProtoError(`Firmware protocol mismatch (proto ${info.proto}, cfg v${info.cfgVersion}, ${info.cfgSize} B). This page supports proto 1 / cfg v2 / ${P.CFG_SIZE} B.`, 'version');
  S.info = info;
  renderFw(); pickers.g.setMax(info.brtMax); pickers.k.setMax(info.brtMax); pickers.hl.setMax(info.brtMax);
  const img = await S.dev.readConfig(progress, info); progress(null);
  S.cfg = P.unpackConfig(img); S.savedSnap = snap();
  H.undo = []; H.redo = []; H.group = null; S.ready = true;
  setLoading(false); renderAll(); startPoll();
  if (!localStorage.getItem('rgbpk.intro')) $('intro').hidden = false;
}
function setLoading(v) {
  $('main').classList.toggle('is-loading', v); $('boardwrap').classList.toggle('loading', v);
  $('main').setAttribute('aria-busy', v);
}
async function connect() {
  if (!P.hidSupported()) return;
  try {
    const [hid] = await navigator.hid.requestDevice({ filters: [{ usagePage: P.USAGE_PAGE, usage: P.USAGE }] });
    if (!hid) return;
    await guarded(() => useDevice(hid), connect);
  } catch (e) {
    if (e.name === 'NotFoundError' || /No device selected/i.test(e.message)) return;
    toast('Could not select a device: ' + e.message, { kind: 'err' });
  }
}
function onDisconnected(silent) {
  stopPoll(); S.dev = null; S.ready = false; S.dirty = false;
  setStatus('off', 'Not connected'); showView(false); setLoading(false);
  if (!silent) toast('Keyboard disconnected.', { kind: 'err', retry: connect });
}
async function autoReconnect() {
  try {
    const list = (await navigator.hid.getDevices()).filter(P.isRgbpkDevice);
    if (list.length && !S.dev) await guarded(() => useDevice(list[0]), connect);
  } catch { /* ignore */ }
}

// ---------- polling the live layer state ----------
function startPoll() { stopPoll(); S.pollTimer = setInterval(poll, 250); }
function stopPoll() { clearInterval(S.pollTimer); S.pollTimer = null; }
async function poll() {
  if (!S.dev || taskCount > 0 || S.dev.busy > 0 || S.polling) return;
  S.polling = true;
  try {
    const st = await S.dev.state(); S.pollFails = 0;
    if (st.mask !== S.mask || st.top !== S.top) { S.mask = st.mask; S.top = st.top; renderTabs(); }
  } catch (e) {
    if (++S.pollFails === 4) S.lost = toast('Lost contact with the keyboard (' + e.message + ')', { kind: 'err', retry: () => guarded(() => enqueue(() => loadAll())) });
  } finally { S.polling = false; }
}

// ---------- live sending ----------
function throttle(name, ms, fn) { clearTimeout(S.timers[name]); S.timers[name] = setTimeout(fn, ms); }
function queueKey(l, p) { S.pendKeys.set(l * 100 + p, [l, p]); throttle('key', 50, flushKeys); }
function flushKeys() {
  if (!S.dev || !S.pendKeys.size) return Promise.resolve();
  const items = [...S.pendKeys.values()]; S.pendKeys.clear();
  return enqueue(() => guarded(async () => {
    for (const [l, p] of items) await S.dev.request(P.CMD.SET_KEY, P.encodeSetKey(l, p, S.cfg.keys[l][p]));
  }));
}
function queueGlobal(fields) { S.pendGlobal = Object.assign(S.pendGlobal || {}, fields); throttle('glob', 60, flushGlobal); }
function flushGlobal() {
  if (!S.dev || !S.pendGlobal) return Promise.resolve();
  const f = S.pendGlobal; S.pendGlobal = null;
  return enqueue(() => guarded(async () => {
    const r = P.parseGlobalReply((await S.dev.request(P.CMD.SET_GLOBAL, P.encodeSetGlobal(f))).payload);
    if (f.val !== undefined && r.val !== S.cfg.g.val) { S.cfg.g.val = r.val; renderGlobal(); touched(); }
  }));
}
function queueLayer() { S.pendLayer = true; throttle('layer', 250, flushLayer); }
function flushLayer() {
  if (!S.dev || !S.pendLayer) return Promise.resolve();
  S.pendLayer = false;
  return enqueue(() => guarded(async () => {
    const img = P.packConfig(S.cfg);
    await S.dev.writeRange(img, P.OFF_LAYERS, 32);
    await S.dev.request(P.CMD.PREVIEW, [P.F_FIX_CRC]);
  }));
}
/** Whole-config upload for bulk edits (many keys). At most one in flight; newer edits re-run it once. */
function queueFull() { S.pendFull = true; throttle('full', 200, runFull); }
async function runFull() {
  if (!S.dev || !S.pendFull) return;
  if (S.fullRunning) { S.fullAgain = true; return; }
  S.fullRunning = true;
  try {
    do {
      S.fullAgain = false; S.pendFull = false; S.pendKeys.clear(); S.pendGlobal = null; S.pendLayer = false;
      await enqueue(() => guarded(async () => {
        const img = P.packConfig(S.cfg);
        await S.dev.writeRange(img, 0, img.length, progress); progress(null);
        await S.dev.request(P.CMD.PREVIEW, [P.F_FIX_CRC]);
      }));
    } while (S.fullAgain || S.pendFull);
  } finally { S.fullRunning = false; }
}
async function flushAll() {
  for (const t of ['key', 'glob', 'layer', 'full']) clearTimeout(S.timers[t]);
  await runFull(); while (S.fullRunning) await new Promise((r) => setTimeout(r, 30));
  await flushKeys(); await flushLayer(); await flushGlobal();
}

// ---------- keyboard geometry ----------
const SC = 1.4, KS = 46, PAD = 14, GAP = 36, HALF_W = Math.round(255 * SC) + KS;
const TOTAL_W = HALF_W * 2 + 2 * PAD + GAP, VB_H = Math.round(203 * SC) + KS + 2 * PAD + 6;
const ROT = { 10: 4, 19: 12, 20: 22 }; // thumb fan, by LED id
const LEFT = []; for (let p = 0; p < P.NUM_POS; p++) if (POS2LED[p] !== NO_LED) LEFT.push(p);
const rowOf = (p) => (p < 36 ? Math.floor(p / 12) : p < 50 ? 3 : 4);
function keyXY(pos) {
  if (pos in MIRROR) { const led = POS2LED[MIRROR[pos]]; return [TOTAL_W - PAD - KS - Math.round(LED_X[led] * SC), PAD + Math.round(LED_Y[led] * SC), -(ROT[led] || 0)]; }
  const led = POS2LED[pos]; return led === NO_LED ? null : [PAD + Math.round(LED_X[led] * SC), PAD + Math.round(LED_Y[led] * SC), ROT[led] || 0];
}
const XY = {}; LEFT.forEach((p) => { XY[p] = keyXY(p); });
const colInRow = (p) => LEFT.filter((q) => rowOf(q) === rowOf(p)).sort((a, b) => XY[a][0] - XY[b][0]).indexOf(p) + 1;

const NS = 'http://www.w3.org/2000/svg';
function se(tag, attrs, parent, text) {
  const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (text != null) e.textContent = text; parent?.appendChild(e); return e;
}
const cells = {};
function buildBoard() {
  const svg = $('board'); svg.textContent = '';
  const defs = se('defs', {}, svg);
  const f = se('filter', { id: 'blur', x: '-60%', y: '-60%', width: '220%', height: '220%' }, defs);
  se('feGaussianBlur', { stdDeviation: 7 }, f);
  const ghosts = se('g', { class: 'ghosts', 'aria-hidden': 'true' }, svg);
  const encs = se('g', { 'aria-hidden': 'true' }, svg);
  const mk = (x, cls) => { const g = se('g', { class: 'enc ' + cls, transform: `translate(${x},${PAD + Math.round(152 * SC)})` }, encs); se('circle', { r: 19 }, g); se('text', {}, g, 'Enc'); };
  mk(PAD + Math.round(255 * SC) + KS / 2, 'l'); mk(TOTAL_W - PAD - Math.round(255 * SC) - KS / 2, 'r');
  for (const pos of Object.keys(MIRROR).map(Number)) {
    const [x, y, r] = keyXY(pos);
    const g = se('g', { class: 'ghost', transform: `translate(${x},${y}) rotate(${r} ${KS / 2} ${KS / 2})` }, ghosts);
    se('rect', { class: 'cap', width: KS, height: KS, rx: 9 }, g); se('text', { x: KS / 2, y: KS / 2 }, g, '');
  }
  const keys = se('g', { class: 'keys' }, svg);
  for (const pos of LEFT) {
    const [x, y, r] = XY[pos];
    const g = se('g', { class: 'key', transform: `translate(${x},${y}) rotate(${r} ${KS / 2} ${KS / 2})`, tabindex: -1, role: 'button', 'data-pos': pos }, keys);
    const c = {
      g, title: se('title', {}, g),
      glow: se('rect', { class: 'glow', x: -2, y: -2, width: KS + 4, height: KS + 4, rx: 12 }, g),
      cap: se('rect', { class: 'cap', width: KS, height: KS, rx: 9 }, g),
      tint: se('rect', { class: 'tint', width: KS, height: KS, rx: 9 }, g),
      rim: se('rect', { class: 'rim', x: .75, y: .75, width: KS - 1.5, height: KS - 1.5, rx: 8.5 }, g),
      ring: se('rect', { class: 'ring', x: -3, y: -3, width: KS + 6, height: KS + 6, rx: 12 }, g),
      text: se('text', { x: KS / 2, y: KS / 2 }, g),
      tri: se('path', { class: 'tri', d: `M${KS / 2 - 6} ${KS / 2 - 4}h12l-6 9z`, hidden: '' }, g),
    };
    cells[pos] = c;
  }
  svg.addEventListener('click', (e) => { const k = e.target.closest('.key'); if (k) onKeyClick(Number(k.dataset.pos), e); });
  svg.addEventListener('keydown', onBoardKey);
  fitViewBox();
}
function fitViewBox() {
  const narrow = matchMedia('(max-width: 760px)').matches;
  $('board').setAttribute('viewBox', narrow ? `0 0 ${HALF_W + 2 * PAD} ${VB_H}` : `0 0 ${TOTAL_W} ${VB_H}`);
  $('board').classList.toggle('narrow', narrow);
}

function fxColor(pos) {
  const g = S.cfg.g, fx = S.cfg.fx || { hue2: 180, sat2: 100, angle: 0, star_density: 5, star_mode: 0 };
  const led = POS2LED[pos], x = LED_X[led] ?? 128, y = LED_Y[led] ?? 90;
  let hue = g.hue, sat = g.sat, val = g.val;
  if (g.effect === 8) {
    return { h: 0, s: 0, v: 0 };
  }
  const rad = ((fx.angle || 0) * Math.PI) / 180;
  const proj = (x - 128) * Math.cos(rad) + (y - 90) * Math.sin(rad);
  const t = Math.max(0, Math.min(1, (proj + 128) / 255));
  let diff = ((fx.hue2 ?? 180) - g.hue) % 360;
  if (diff > 180) diff -= 360; else if (diff < -180) diff += 360;

  switch (g.effect) {
    case 4: { // Wave
      const waveTri = Math.abs((t * 2) % 2 - 1);
      hue = (g.hue + diff * waveTri + 360) % 360;
      sat = g.sat + ((fx.sat2 ?? 100) - g.sat) * waveTri;
      break;
    }
    case 6: { // Gradient
      hue = (g.hue + diff * t + 360) % 360;
      sat = g.sat + ((fx.sat2 ?? 100) - g.sat) * t;
      break;
    }
    case 7: { // Starlight
      if (fx.star_mode === 1) hue = (led * 47) % 360;
      else if (fx.star_mode === 2) hue = (g.hue + diff * ((led % 7) / 6) + 360) % 360;
      break;
    }
    case 2: case 3: hue = (x / 255) * 300; break;
    case 5: hue = Math.hypot(x - 128, y - 90) * 2; break;
    default: break;
  }
  return { h: Math.round(hue) % 360, s: Math.round(sat), v: val };
}
/** What this key's LED shows on the selected layer, following TRANS down the stack (approximation, no animation). */
function resolve(pos) {
  for (let l = S.layer; l >= 0; l--) {
    const k = S.cfg.keys[l][pos]; if (k.mode === 0) continue;
    const inh = l !== S.layer;
    if (k.mode === 1) return { kind: 'off', inh };
    if (k.mode === 2 || (k.mode === 4 && k.val > 0)) return { kind: 'color', h: k.hue, s: k.sat, v: k.val, inh };
    return { kind: 'fx', ...fxColor(pos), inh };
  }
  return { kind: 'fx', ...fxColor(pos), inh: true };
}
function paintKey(pos) {
  const c = cells[pos]; if (!c) return;
  const k = keyOf(pos), r = resolve(pos), label = LABELS[S.layer][pos] ?? '';
  const max = brtMax(), dark = r.kind === 'off' || (r.kind !== 'off' && r.v === 0);
  const col = dark ? '#000' : ledCss(r.h, r.s, r.v, max);
  const st = c.g.style; st.setProperty('--c', col);
  const dim = k.mode === 0 ? 0.5 : 1;
  st.setProperty('--ga', dark ? 0 : (r.kind === 'color' ? 0.62 : 0.42) * dim);
  st.setProperty('--ta', dark ? 0 : (r.kind === 'color' ? 0.3 : 0.2) * dim);
  st.setProperty('--ra', dark ? 0 : (r.kind === 'color' ? 0.95 : 0.55) * dim);
  c.g.classList.toggle('trans', k.mode === 0); c.g.classList.toggle('off', r.kind === 'off' || dark);
  c.g.classList.toggle('sel', S.sel.has(pos));
  const tri = label === '▽'; c.text.textContent = tri ? '' : label; c.tri.toggleAttribute('hidden', !tri);
  c.g.setAttribute('aria-pressed', S.sel.has(pos));
  const modeName = MODE_UI.find((m) => m.m === k.mode).n;
  const text = `${label || 'Unlabelled'}, position ${pos}, row ${rowOf(pos) + 1} key ${colInRow(pos)}: ${modeName}`;
  c.g.setAttribute('aria-label', text); c.title.textContent = text;
}
function paintBoard() {
  for (const p of LEFT) paintKey(p);
  const hasSel = LEFT.find((p) => S.sel.has(p));
  const tab = S.primary != null && cells[S.primary] ? S.primary : (hasSel ?? LEFT[0]);
  for (const p of LEFT) cells[p].g.tabIndex = p === tab ? 0 : -1;
  $('board').parentElement.classList.toggle('board-off', !S.cfg.g.on); $('offBadge').hidden = !!S.cfg.g.on;
  $('board').parentElement.classList.toggle('board-off', !S.cfg.g.on);
}

// ---------- selection ----------
function setSel(set, primary) {
  S.sel = set; S.primary = primary ?? (set.size ? [...set].pop() : null);
  for (const p of LEFT) { cells[p].g.classList.toggle('sel', set.has(p)); cells[p].g.setAttribute('aria-pressed', set.has(p)); }
  const tab = S.primary ?? LEFT[0]; for (const p of LEFT) cells[p].g.tabIndex = p === tab ? 0 : -1;
  renderKey(); updateSelInfo();
}
function updateSelInfo() {
  const n = S.sel.size;
  $('selInfo').textContent = n ? `${n} key${n > 1 ? 's' : ''} selected` : 'Click a key to edit it';
  $('selRow').disabled = S.primary == null; $('selNone').disabled = !n;
}
function rangeSel(a, b) {
  const [ax, ay] = XY[a], [bx, by] = XY[b], m = KS * 0.6;
  const x0 = Math.min(ax, bx) - m, x1 = Math.max(ax, bx) + m, y0 = Math.min(ay, by) - m, y1 = Math.max(ay, by) + m;
  return LEFT.filter((p) => XY[p][0] >= x0 && XY[p][0] <= x1 && XY[p][1] >= y0 && XY[p][1] <= y1);
}
function onKeyClick(pos, e) {
  const add = e.ctrlKey || e.metaKey;
  if (e.shiftKey && S.primary != null) { const s = add ? new Set(S.sel) : new Set(); rangeSel(S.primary, pos).forEach((p) => s.add(p)); setSel(s, pos); }
  else if (add) { const s = new Set(S.sel); if (s.has(pos)) s.delete(pos); else s.add(pos); setSel(s, s.has(pos) ? pos : [...s].pop() ?? null); }
  else setSel(new Set([pos]), pos);
  cells[pos].g.focus({ preventScroll: true });
}
function neighbor(pos, key) {
  const [cx, cy] = XY[pos]; let best = null, bs = Infinity;
  for (const p of LEFT) {
    if (p === pos) continue; const dx = XY[p][0] - cx, dy = XY[p][1] - cy;
    const [along, across] = key === 'ArrowRight' ? [dx, dy] : key === 'ArrowLeft' ? [-dx, dy] : key === 'ArrowDown' ? [dy, dx] : [-dy, dx];
    if (along < 8 || Math.abs(across) > along * 1.2 + 14) continue;
    const s = along + 2.2 * Math.abs(across); if (s < bs) { bs = s; best = p; }
  }
  return best;
}
function onBoardKey(e) {
  const k = e.target.closest?.('.key'); if (!k) return; const pos = Number(k.dataset.pos);
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onKeyClick(pos, e); }
  else if (e.key.startsWith('Arrow')) {
    e.preventDefault(); const n = neighbor(pos, e.key); if (n == null) return;
    if (e.shiftKey) setSel(new Set([...S.sel, pos, n]), n); else setSel(new Set([n]), n);
    cells[n].g.focus();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); setSel(new Set(LEFT), pos); }
}

// ---------- widgets: radios, collapse ----------
function radios(box, items, onPick, cls) {
  box.textContent = '';
  for (const it of items) {
    const b = h('button', { type: 'button', role: 'radio', class: cls, 'aria-checked': 'false', tabindex: -1, title: it.title, dataset: { v: it.v } },
      cls === 'radio' ? [h('i', { class: 'rb' }), h('b', null, it.label), h('span', { class: 'd' }, it.desc)] : it.label);
    b.addEventListener('click', () => onPick(it.v)); box.appendChild(b);
  }
  box.addEventListener('keydown', (e) => {
    if (!/^Arrow(Left|Right|Up|Down)$/.test(e.key)) return; e.preventDefault();
    const bs = [...box.querySelectorAll('[role=radio]')], i = bs.indexOf(document.activeElement); if (i < 0) return;
    const n = bs[(i + (/Right|Down/.test(e.key) ? 1 : bs.length - 1)) % bs.length]; n.focus(); n.click();
  });
}
function setRadios(box, v) {
  let any = false;
  box.querySelectorAll('[role=radio]').forEach((b) => { const on = v != null && b.dataset.v === String(v); b.setAttribute('aria-checked', on); b.tabIndex = on ? 0 : -1; any = any || on; });
  if (!any) box.querySelector('[role=radio]').tabIndex = 0;
}
function setOpen(wrap, open) { wrap.dataset.open = !!open; wrap.inert = !open; wrap.setAttribute('aria-hidden', !open); }
const setSwitch = (b, on) => b.setAttribute('aria-checked', !!on);

// ---------- rendering ----------
function renderFw() {
  const i = S.info, fw = $('fw'); fw.textContent = '';
  const rows = [['Protocol', `v${i.proto}`], ['Config', `v${i.cfgVersion}, ${i.cfgSize} bytes`], ['Layout', `${i.layers} layers, ${i.positions} keys, ${i.leds} LEDs`], ['Brightness cap', `${i.brtMax} of 100`], ['Link', DEMO ? 'Simulated' : 'WebHID']];
  rows.forEach(([a, b]) => fw.append(h('dt', null, a), h('dd', null, b)));
}
function renderTabs() {
  const t = $('tabs');
  if (!t.children.length) {
    LAYER_NAMES.forEach((n, i) => {
      const b = h('button', { type: 'button', class: 'tab', role: 'tab', id: 'tab' + i, tabindex: -1, onclick: () => selectLayer(i) }, h('span', null, n), h('i', { class: 'live' }));
      t.appendChild(b);
    });
    t.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return; e.preventDefault();
      const i = (S.layer + (e.key === 'ArrowRight' ? 1 : 3)) % 4; selectLayer(i); $('tab' + i).focus();
    });
  }
  [...t.children].forEach((b, i) => {
    const live = !!(S.mask & (1 << i)), top = i === S.top;
    b.setAttribute('aria-selected', i === S.layer); b.tabIndex = i === S.layer ? 0 : -1;
    b.classList.toggle('below', live && !top); b.classList.toggle('ontop', top);
    const note = top ? 'active on the keyboard now' : live ? 'active, covered by a higher layer' : '';
    b.title = note ? `${LAYER_NAMES[i]}: ${note}` : LAYER_NAMES[i];
    b.setAttribute('aria-label', note ? `${LAYER_NAMES[i]}, ${note}` : LAYER_NAMES[i]);
  });
}
function selectLayer(i) { S.layer = i; renderTabs(); paintBoard(); renderKey(); renderLayer(); }

function renderKey() {
  const sel = [...S.sel], has = sel.length > 0;
  $('keyEmpty').hidden = has; $('keyBody').hidden = !has;
  if (!has) { $('keyName').textContent = ''; return; }
  const ks = sel.map((p) => keyOf(p)); const common = ks.every((k) => k.mode === ks[0].mode) ? ks[0].mode : null;
  const pk = keyOf(S.primary ?? sel[0]);
  $('keyName').textContent = sel.length === 1 ? `${LABELS[S.layer][sel[0]] || 'Key'} · #${sel[0]}` : `${sel.length} keys${common == null ? ' · mixed modes' : ''}`;
  setRadios($('modes'), common);
  const colorable = common === 2 || common === 4;
  setOpen($('keyColorWrap'), colorable);
  $('keyCustomRow').hidden = common !== 4; setSwitch($('keyCustom'), pk.val > 0);
  setOpen($('keyPickerWrap'), common === 2 || (common === 4 && pk.val > 0));
  pickers.k.set(pk.hue, pk.sat, pk.val);
}
function renderLayer() {
  $('layerName').textContent = LAYER_NAMES[S.layer];
  const src = $('copySrc'), keep = src.value;
  src.textContent = ''; LAYER_NAMES.forEach((n, i) => { if (i !== S.layer) src.add(new Option(n, i)); });
  if (keep && keep !== String(S.layer)) src.value = keep;
}
const GRADIENT_PRESETS = [
  { name: 'Sunset', h1: 24, s1: 100, h2: 330, s2: 100 },
  { name: 'Cyberpunk', h1: 180, s1: 100, h2: 300, s2: 100 },
  { name: 'Ocean', h1: 220, s1: 100, h2: 150, s2: 90 },
  { name: 'Neon', h1: 85, s1: 100, h2: 275, s2: 100 },
  { name: 'Fire', h1: 50, s1: 100, h2: 0, s2: 100 },
  { name: 'Lavender', h1: 260, s1: 75, h2: 20, s2: 85 },
];

function renderGradient() {
  const g = S.cfg.g;
  const fx = S.cfg.fx || { hue2: 180, sat2: 100, angle: 0, star_density: 5, star_mode: 0 };
  const c1 = P.hsvToRgb(g.hue, g.sat, 100);
  const c2 = P.hsvToRgb(fx.hue2, fx.sat2, 100);
  const hex1 = '#' + c1.map((x) => x.toString(16).padStart(2, '0')).join('');
  const hex2 = '#' + c2.map((x) => x.toString(16).padStart(2, '0')).join('');

  $('gradDot1').style.background = hex1;
  $('gradDot2').style.background = hex2;
  $('gradStartTxt').textContent = hex1;
  $('gradEndTxt').textContent = hex2;
  $('gradPreview').style.background = `linear-gradient(90deg, ${hex1}, ${hex2})`;
  $('gradDial').style.background = `linear-gradient(${fx.angle + 90}deg, ${hex1}, ${hex2})`;
  $('gradKnob').style.transform = `rotate(${fx.angle}deg) translateX(var(--gr))`;
  $('gradDial').setAttribute('aria-valuenow', fx.angle);
  if (document.activeElement !== $('gradAngle')) $('gradAngle').value = fx.angle;


  for (const n of [1, 2]) {
    $('gradStop' + n).classList.toggle('active', S.activeStop === n);
    document.querySelector(`.glabel[data-stop="${n}"]`).classList.toggle('active', S.activeStop === n);
  }

  const box = $('gradPresets');
  box.querySelectorAll('.grad-chip').forEach((btn) => {
    const h1 = Number(btn.dataset.h1), h2 = Number(btn.dataset.h2);
    const match = Math.abs(h1 - g.hue) <= 4 && Math.abs(h2 - fx.hue2) <= 4;
    btn.setAttribute('aria-pressed', match);
  });
}

function renderStarlight() {
  const fx = S.cfg.fx || { hue2: 180, sat2: 100, angle: 0, star_density: 5, star_mode: 0 };
  const mode = fx.star_mode || 0;
  document.querySelectorAll('#starModes .chip').forEach((btn) => {
    const m = Number(btn.dataset.starmode);
    btn.setAttribute('aria-checked', m === mode);
  });
  const hints = [
    'Stars twinkle in one steady colour.',
    'Every star twinkles in a random vibrant rainbow hue.',
    'Stars twinkle in random hues along your chosen gradient.'
  ];
  const d = fx.star_density || 5;
  $('starDensity').value = d;
  $('starDensityO').textContent = String(d);
}

function renderGlobal() {
  const g = S.cfg.g, meta = EFFECT_META[g.effect] || EFFECT_META[0];
  setSwitch($('gOn'), g.on); $('gOnTxt').textContent = g.on ? 'On' : 'Off';
  $('gBody').classList.toggle('dim', !g.on); $('gBody').inert = !g.on;

  // Master Brightness
  $('gBrt').max = brtMax();
  $('gBrt').value = g.val;
  $('gBrtVal').textContent = `${g.val} / ${brtMax()} (${Math.round((g.val / brtMax()) * 100)}%)`;

  setRadios($('gEffect'), g.effect);
  $('gEffectHint').textContent = meta.d;

  // Effect colour modes:
  const isRainbow = g.effect === 2 || g.effect === 3 || g.effect === 5;
  const isGradWave = g.effect === 4 || g.effect === 6;
  const isStarlight = g.effect === 7;
  const isNone = g.effect === 8;

  const showGradient = isGradWave || (isStarlight && (S.cfg.fx?.star_mode === 2));
  const isColor = !isRainbow && !isNone && (!isStarlight || S.cfg.fx?.star_mode !== 1);

  setOpen($('gColorWrap'), isColor);
  setOpen($('gRainbowWrap'), isRainbow);
  setOpen($('gGradientWrap'), showGradient);
  setOpen($('gStarlightWrap'), isStarlight);

  if (showGradient) {
    renderGradient();
    if (S.activeStop === 2) {
      $('gColorTitle').parentElement.hidden = true;
      pickers.g.set(S.cfg.fx?.hue2 ?? 180, S.cfg.fx?.sat2 ?? 100, g.val);
    } else {
      $('gColorTitle').parentElement.hidden = true;
      pickers.g.set(g.hue, g.sat, g.val);
    }
  } else if (isColor) {
    $('gColorTitle').parentElement.hidden = true;
    pickers.g.set(g.hue, g.sat, g.val);
  }

  if (isRainbow) {
    $('gRainbowSat').value = g.sat;
    $('gRainbowSatO').textContent = g.sat + '%';
  }
  if (isStarlight) {
    renderStarlight();
  }

  setOpen($('gSpeedWrap'), meta.speed);
  $('gSpeed').value = g.speed;
  $('gSpeedO').textContent = g.speed;
  setRadios($('gReact'), g.react);
  $('gReactHint').textContent = REACT_DESC[g.react];

  // Keypress effects and highlight are global across all layers
  const canHighlight = g.react !== 0 && g.react !== 4; // Not OFF, not COLOR
  const l0 = S.cfg.layers[0];
  setOpen($('gHlWrap'), canHighlight);
  setSwitch($('gHlSwitch'), l0.val > 0);
  setOpen($('gHlPickerWrap'), canHighlight && l0.val > 0);
  $('gHlHint').textContent = l0.val > 0 ? 'Pressed keys flash this colour across all layers.' : 'Automatic: soft white tinted opposite to the base colour.';
  pickers.hl.set(l0.hue, l0.sat, l0.val);
}
function renderAll() { renderTabs(); paintBoard(); renderKey(); renderLayer(); renderGlobal(); updateSelInfo(); touched(); }

// ---------- edits ----------
function editKeys(f, group) {
  const list = [...S.sel]; if (!list.length) return;
  const plan = list.map((pos) => {
    const k = { ...keyOf(pos), ...f };
    if (f.mode !== undefined && f.mode !== keyOf(pos).mode) {
      if (f.mode === 2 && k.val === 0) k.val = brtMax();
      if (f.mode === 4 && keyOf(pos).mode !== 2) k.val = 0; // Static from a non-colour mode: no colour yet
    }
    return [pos, k];
  }).filter(([pos, k]) => JSON.stringify(k) !== JSON.stringify(keyOf(pos)));
  if (!plan.length) return;
  beginEdit(group || null);
  for (const [pos, k] of plan) { S.cfg.keys[S.layer][pos] = k; paintKey(pos); }
  if (plan.length > 12) queueFull(); else plan.forEach(([pos]) => queueKey(S.layer, pos));
  renderKey(); if (group === undefined || f.mode !== undefined) { /* radios already refreshed */ }
  touched();
}
function editGlobal(f, group) {
  const g = S.cfg.g, diff = {}; for (const k in f) if (g[k] !== f[k]) diff[k] = f[k];
  if (!Object.keys(diff).length) return;
  beginEdit(group || null); Object.assign(g, diff); queueGlobal(diff);
  renderGlobal(); paintBoard(); renderLayer(); touched();
}
function editFx(f, group) {
  if (!S.cfg.fx) S.cfg.fx = { hue2: 180, sat2: 100, angle: 0, star_density: 5, star_mode: 0 };
  const fx = S.cfg.fx, diff = {};
  for (const k in f) if (fx[k] !== f[k]) diff[k] = f[k];
  if (!Object.keys(diff).length) return;
  beginEdit(group || null);
  Object.assign(fx, diff);
  queueGlobal({ fx: S.cfg.fx });
  renderGlobal(); paintBoard(); touched();
}
function editGlobalHighlight(f, group) {
  beginEdit(group || null);
  for (let i = 0; i < P.NUM_LAYERS; i++) {
    Object.assign(S.cfg.layers[i], f);
  }
  queueLayer();
  renderGlobal();
  touched();
}
function bulkKeys(mutate, msg) {
  beginEdit(null); for (let p = 0; p < P.NUM_POS; p++) mutate(S.cfg.keys[S.layer][p], p);
  queueFull(); paintBoard(); renderKey(); touched(); toast(msg, { kind: 'info' });
}

// ---------- UI wiring ----------
const pickers = {};
function initUi() {
  mountHelp(document);
  buildBoard(); matchMedia('(max-width: 760px)').addEventListener('change', fitViewBox);

  radios($('modes'), MODE_UI.map((m) => ({ v: m.m, label: m.n, desc: m.d })), (v) => editKeys({ mode: Number(v) }), 'radio');
  radios($('gEffect'), P.EFFECTS.map((n, i) => ({ v: i, label: n })), (v) => editGlobal({ effect: Number(v) }), 'chip');
  radios($('gReact'), P.REACTS.map((n, i) => ({ v: i, label: n })), (v) => editGlobal({ react: Number(v) }), 'chip');

  pickers.k = createPicker({ max: 40, onInput: (c) => editKeys({ hue: c.h, sat: c.s, val: c.v }, 'kc' + S.layer) });
  pickers.g = createPicker({
    max: 40, compact: true,
    showVal: false,
    getVal: () => S.cfg.g.val,
    onInput: (c) => {
      const g = S.cfg.g;
      const isGradMode = g.effect === 4 || g.effect === 6 || (g.effect === 7 && S.cfg.fx?.star_mode === 2);
      if (isGradMode && S.activeStop === 2) {
        editFx({ hue2: c.h, sat2: c.s }, 'gc2');
      } else {
        editGlobal({ hue: c.h, sat: c.s }, 'gc');
      }
    }
  });
  pickers.hl = createPicker({ max: 40, compact: true, onInput: (c) => editGlobalHighlight({ hue: c.h, sat: c.s, val: c.v }, 'ghl') });
  $('keyPicker').append(pickers.k.el); $('gPicker').append(pickers.g.el); $('gHlPicker').append(pickers.hl.el);

  // Master brightness & effect sliders
  $('gBrt').addEventListener('input', (e) => editGlobal({ val: Number(e.target.value) }, 'gBrt'));
  $('gRainbowSat').addEventListener('input', (e) => editGlobal({ sat: Number(e.target.value) }, 'rainbowSat'));

  $('gradStop1').onclick = () => { S.activeStop = 1; renderGlobal(); };
  $('gradStop2').onclick = () => { S.activeStop = 2; renderGlobal(); };

  document.querySelectorAll('.angle-chip').forEach((btn) => {
    btn.onclick = () => editFx({ angle: Number(btn.dataset.angle) });
  });
  document.querySelectorAll('.glabel').forEach((b) => { b.onclick = () => { S.activeStop = Number(b.dataset.stop); renderGlobal(); }; });
  const setAngle = (a, snap) => {
    a = ((Math.round(a) % 360) + 360) % 360;
    if (snap) for (const t of [0, 45, 90, 135, 180, 225, 270, 315, 360]) if (Math.abs(a - t) <= 4) a = t % 360;
    editFx({ angle: a }, 'gradAngle');
  };
  const dial = $('gradDial');
  const fromPtr = (e) => { const r = dial.getBoundingClientRect(); setAngle(Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2)) * 180 / Math.PI, !e.shiftKey); };
  dial.addEventListener('pointerdown', (e) => { dial.setPointerCapture(e.pointerId); dial.focus(); fromPtr(e); e.preventDefault(); });
  dial.addEventListener('pointermove', (e) => { if (dial.hasPointerCapture(e.pointerId)) fromPtr(e); });
  dial.addEventListener('keydown', (e) => {
    const d = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key]; if (!d) return;
    e.preventDefault(); setAngle((S.cfg.fx?.angle ?? 0) + d * (e.shiftKey ? 15 : 1));
  });
  $('gradAngle').addEventListener('input', (e) => { if (e.target.value !== '') setAngle(Number(e.target.value)); });
  $('gradSwap').onclick = () => {
    const g = S.cfg.g, fx = S.cfg.fx;
    editGlobal({ hue: fx.hue2, sat: fx.sat2 }, 'gradSwap'); editFx({ hue2: g.hue, sat2: g.sat }, 'gradSwap');
  };

  document.querySelectorAll('#starModes .chip').forEach((btn) => {
    btn.onclick = () => editFx({ star_mode: Number(btn.dataset.starmode) });
  });
  $('starDensity').addEventListener('input', (e) => {
    const d = Number(e.target.value);
    $('starDensityO').textContent = String(d);
    editFx({ star_density: d }, 'starDensity');
  });

  $('gHlSwitch').onclick = () => {
    const on = $('gHlSwitch').getAttribute('aria-checked') === 'true';
    editGlobalHighlight({ val: on ? 0 : brtMax() });
  };

  const gp = $('gradPresets');
  GRADIENT_PRESETS.forEach((p) => {
    const c1 = P.hsvToRgb(p.h1, p.s1, 100);
    const c2 = P.hsvToRgb(p.h2, p.s2, 100);
    const grad = `linear-gradient(90deg, rgb(${c1.join(',')}), rgb(${c2.join(',')}))`;
    const b = h('button', {
      type: 'button',
      class: 'grad-chip', title: p.name, 'aria-label': p.name,
      dataset: { h1: p.h1, s1: p.s1, h2: p.h2, s2: p.s2 },
      onclick: () => {
        editGlobal({ hue: p.h1, sat: p.s1 }, 'gradPreset');
        editFx({ hue2: p.h2, sat2: p.s2 }, 'gradPreset');
      }
    }, h('span', { class: 'grad-swatch', style: `--grad:${grad}` }));
    gp.appendChild(b);
  });

  $('keyCustom').onclick = () => { const on = $('keyCustom').getAttribute('aria-checked') === 'true'; editKeys({ val: on ? 0 : brtMax() }); };
  $('gOn').onclick = () => editGlobal({ on: S.cfg.g.on ? 0 : 1 });
  $('gSpeed').addEventListener('input', () => { $('gSpeedO').textContent = $('gSpeed').value; editGlobal({ speed: Number($('gSpeed').value) }, 'gspeed'); });

  $('selAll').onclick = () => setSel(new Set(LEFT), S.primary ?? LEFT[0]);
  $('selRow').onclick = () => { if (S.primary != null) setSel(new Set(LEFT.filter((p) => rowOf(p) === rowOf(S.primary))), S.primary); };
  $('selNone').onclick = () => setSel(new Set(), null);
  $('btnCopy').onclick = () => {
    const src = Number($('copySrc').value); if (Number.isNaN(src)) return;
    bulkKeys((k, p) => Object.assign(k, S.cfg.keys[src][p]), `Copied key settings from ${LAYER_NAMES[src]} to ${LAYER_NAMES[S.layer]}. Ctrl+Z undoes it.`);
  };
  // copy must read the source before any mutation: wrap with a snapshot of src
  const origCopy = $('btnCopy').onclick;
  $('btnCopy').onclick = () => { const src = Number($('copySrc').value); const frozen = S.cfg.keys[src].map((k) => ({ ...k })); bulkKeys((k, p) => Object.assign(k, frozen[p]), `Copied key settings from ${LAYER_NAMES[src]} to ${LAYER_NAMES[S.layer]}. Ctrl+Z undoes it.`); void origCopy; };
  document.querySelectorAll('[data-all]').forEach((b) => {
    b.onclick = () => { const m = Number(b.dataset.all); bulkKeys((k) => { k.mode = m; }, `Every key on ${LAYER_NAMES[S.layer]} set to ${b.textContent}. Ctrl+Z undoes it.`); };
  });

  $('btnConnect').onclick = $('btnConnect2').onclick = connect;
  $('btnUndo').onclick = undo; $('btnRedo').onclick = redo;
  $('btnIntro').onclick = () => { $('intro').hidden = !$('intro').hidden; if (!$('intro').hidden) $('intro').scrollIntoView({ block: 'nearest' }); };
  $('introClose').onclick = () => { $('intro').hidden = true; localStorage.setItem('rgbpk.intro', '1'); };

  $('btnSave').onclick = async () => {
    const b = $('btnSave'); b.classList.add('busy');
    try {
      await guarded(async () => {
        await flushAll(); await enqueue(() => S.dev.request(P.CMD.SAVE, [0]));
        S.savedSnap = snap(); touched(); toast('Saved to the keyboard. It will keep these settings after a restart.');
      });
    } finally { b.classList.remove('busy'); }
  };
  $('btnReload').onclick = async () => {
    if (S.dirty && !(await confirmDialog({ title: 'Discard unsaved changes?', body: 'Re-reading loads what is stored on the keyboard and drops your current preview.', confirm: 'Discard and re-read' }))) return;
    guarded(async () => { await flushAll(); await enqueue(() => loadAll()); toast('Loaded settings from the keyboard.', { kind: 'info' }); });
  };
  $('btnWalk').onclick = () => guarded(async () => { await enqueue(() => S.dev.request(P.CMD.WALK)); toast('LED walk test started. Watch the keyboard.', { kind: 'info' }); });
  $('btnDefaults').onclick = async () => {
    if (!(await confirmDialog({ title: 'Restore default colours and effects?', body: 'This overwrites the settings saved on the keyboard with the factory defaults. You can export your current setup first.', confirm: 'Restore defaults', danger: true }))) return;
    guarded(async () => {
      await flushAll(); await enqueue(async () => { await S.dev.request(P.CMD.DEFAULTS); });
      await enqueue(() => loadAll()); toast('Defaults restored.');
    });
  };
  $('btnExport').onclick = () => {
    const blob = new Blob([JSON.stringify(P.configToJson(S.cfg), null, 1)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'sofle-rgb.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000); toast('Exported sofle-rgb.json.', { kind: 'info' });
  };
  $('btnImport').onclick = () => $('file').click();
  $('file').onchange = async () => {
    const f = $('file').files[0]; $('file').value = ''; if (!f) return;
    let cfg;
    try { cfg = P.configFromJson(JSON.parse(await f.text())); } catch (e) { toast('Import failed: ' + e.message, { kind: 'err' }); return; }
    cfg.g.val = Math.min(cfg.g.val, brtMax());
    beginEdit(null); S.cfg = cfg; queueFull(); renderAll();
    toast('Imported and previewing on the keyboard. Press Save to keep it.', { kind: 'info' });
  };

  document.addEventListener('keydown', (e) => {
    if (!S.ready || e.defaultPrevented) return;
    const t = e.target, typing = t.matches?.('input[type=text],input[type=number],textarea');
    const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
    if (mod && k === 'z' && !typing) { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (mod && k === 'y' && !typing) { e.preventDefault(); redo(); }
    else if (e.key === 'Escape' && !isPopOpen() && !$('dlg').open && S.sel.size && !typing) setSel(new Set(), null);
  });
  window.addEventListener('beforeunload', (e) => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });
}

// ---------- boot ----------
async function boot() {
  if (params.has('selftest')) {
    document.querySelector('header').hidden = true; $('empty').hidden = true; $('progress').hidden = true;
    const box = $('selftest'); box.hidden = false; box.textContent = 'Running self tests...';
    const { runAll } = await import('./selftest.js');
    const res = await runAll(); box.textContent = '';
    for (const r of res) { const d = document.createElement('div'); d.className = r.ok ? 'ok' : 'fail'; d.textContent = (r.ok ? 'PASS ' : 'FAIL ') + r.name + (r.ok ? '' : ' -> ' + r.error); box.appendChild(d); }
    const hh = document.createElement('h3'); const fails = res.filter((r) => !r.ok).length;
    hh.textContent = fails ? `${fails} FAILED` : `All ${res.length} passed`; box.appendChild(hh);
    return;
  }
  initUi(); renderAll(); showView(false);
  initKeymap($('studio'));
  if (params.get('view') === 'keymap') setTimeout(() => { document.querySelector('#viewTabs [data-view=keymap]').click(); if (DEMO) document.querySelector('#studio .btn.primary')?.click(); }, 0);
  document.querySelectorAll('#viewTabs .tab').forEach((b) => { b.onclick = () => {
    VIEW = b.dataset.view; showView(APP);
    document.querySelectorAll('#viewTabs .tab').forEach((x) => x.setAttribute('aria-selected', x === b));
  }; });
  if (DEMO) {
    document.title = 'Sofle RGB configurator (demo)';
    const { demoHid } = await import('./demo.js');
    await guarded(() => useDevice(demoHid()));
    if (params.has('fx')) editGlobal({ effect: Number(params.get('fx')) });
    const selPos = params.has('key') ? Number(params.get('key')) : 14;
    if (LEFT.includes(selPos)) setSel(new Set([selPos]), selPos);
    return;
  }
  if (!P.hidSupported()) {
    $('unsupported').hidden = false; $('btnConnect2').disabled = true; $('btnConnect').disabled = true;
    $('emptyLead').textContent = 'Open this page in a Chromium browser to configure your keyboard.'; return;
  }
  navigator.hid.addEventListener('disconnect', (e) => { if (S.dev && e.device === S.dev.hid) onDisconnected(); });
  navigator.hid.addEventListener('connect', (e) => { if (!S.dev && P.isRgbpkDevice(e.device)) autoReconnect(); });
  autoReconnect();
}
boot();
