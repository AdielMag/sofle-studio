// Keymap tab: edit key bindings over ZMK Studio RPC (Web Serial). Replaces the ZMK Studio web app.
import { h, toast, confirmDialog } from './ui.js';
import { Studio, StudioError, openSerial } from './studio/client.js';
import { createMock } from './studio/mock.js';
import { hidLabel, hidGroups, MODS, split, withMods } from './studio/keycodes.js';

const S = { dev: null, t: null, info: null, beh: new Map(), km: null, layout: null, layer: 0, sel: null, locked: true, unsaved: false, busy: false, filter: '', renaming: false, poll: null };
let chain = Promise.resolve();
let root;
const U = 0.56; // px per 1/100 key unit

const ABBR = { 'Momentary Layer': 'MO', 'Toggle Layer': 'TG', 'To Layer': 'TO', 'Layer-Tap': 'LT', 'Mod-Tap': 'MT', 'Sticky Key': 'SK', 'Sticky Layer': 'SL', 'Bluetooth': 'BT', 'Transparent': '▽', 'None': '', 'Key Toggle': 'KT', 'Caps Word': 'CapsW', 'Key Repeat': 'Rep', 'Studio Unlock': 'Studio', 'Reset': 'Reset', 'Bootloader': 'Boot', 'Output Selection': 'OUT', 'External Power': 'EXT' };
const isKp = (b) => S.beh.get(b?.id)?.name === 'Key Press';

// ---- binding <-> text ----
function matchSet(beh, b) {
  const ok = (list, v) => !list.length || list.some((d) => d.kind === 'nil' ? v === 0 : d.kind === 'const' ? d.value === v : d.kind === 'range' ? v >= d.min && v <= d.max : true);
  return Math.max(0, beh.sets.findIndex((s) => ok(s.p1, b.p1) && ok(s.p2, b.p2)));
}
function paramText(list, v) {
  const d = list.find((x) => x.kind === 'const' ? x.value === v : x.kind !== 'nil') || list[0];
  if (!d || d.kind === 'nil') return '';
  if (d.kind === 'const') return d.name;
  if (d.kind === 'hid') return hidLabel(v);
  if (d.kind === 'layer') return S.km.layers.find((l) => l.id === v)?.name.slice(0, 5) ?? '#' + v;
  return String(v);
}
function labelOf(b) {
  const beh = S.beh.get(b.id);
  if (!beh) return '?';
  const set = beh.sets[matchSet(beh, b)] || { p1: [], p2: [] };
  const a = paramText(set.p1, b.p1), c = paramText(set.p2, b.p2);
  if (beh.name === 'Key Press') return a;
  const nm = ABBR[beh.name] ?? beh.name.split(' ')[0].slice(0, 6);
  return [nm, a, c].filter(Boolean).join(' ');
}

// ---- connect / data ----
async function connect() {
  try {
    if (new URLSearchParams(location.search).has('demo')) { const q = new URLSearchParams(location.search), m = createMock(Number(q.get('lock') || 0)); S.t = m.t; S.dev = m.dev; await load(); return; }
    const t = await openSerial(); S.t = t;
    S.dev = new Studio(t);
    S.dev.onClose = () => { stopPoll(); S.km = null; S.dev = null; S.t = null; toast('Keyboard serial port closed.', { kind: 'err' }); render(); };
    S.dev.onNotify = (n) => { if (n.type === 'lock') { S.locked = n.locked; if (!n.locked && !S.km) { stopPoll(); loadData(); } else render(); } if (n.type === 'unsaved') { S.unsaved = n.unsaved; render(); } };
    await load();
  } catch (e) {
    if (e?.name === 'NotFoundError') return; // user closed the chooser
    toast('Could not connect: ' + (e.message || e) + '. Is the keyboard on USB with Studio firmware?', { kind: 'err' });
    try { await S.t?.close(); } catch {}
    S.dev = null; S.t = null; render();
  }
}
function stopPoll() { if (S.poll) { clearInterval(S.poll); S.poll = null; } }
function startPoll() {
  if (S.poll) return;
  S.poll = setInterval(async () => {
    if (!S.dev) return stopPoll();
    try { const locked = await S.dev.isLocked(); if (!locked) { stopPoll(); S.locked = false; await loadData(); } } catch {}
  }, 1000);
}
async function load() {
  S.busy = true; S.km = null; render();
  try {
    S.info = await S.dev.deviceInfo();
    S.locked = await S.dev.isLocked();
    S.busy = false;
    if (S.locked) { render(); startPoll(); return; }
    await loadData();
  } catch (e) { S.busy = false; toast('Read failed: ' + e.message, { kind: 'err' }); render(); }
}
async function loadData() {
  S.busy = true; render();
  try {
    S.beh = await S.dev.behaviors();
    S.layout = await S.dev.physicalLayout();
    S.km = await S.dev.keymap();
    S.unsaved = await S.dev.unsaved();
    S.layer = Math.min(Number(new URLSearchParams(location.search).get('klayer') ?? S.layer), S.km.layers.length - 1);
    S.sel = Number(new URLSearchParams(location.search).get('ksel') ?? NaN); if (Number.isNaN(S.sel)) S.sel = null;
  } catch (e) {
    if (e instanceof StudioError && e.code === 1) { S.locked = true; startPoll(); } else toast('Read failed: ' + e.message, { kind: 'err' });
  }
  S.busy = false; render();
}
const lay = () => S.km.layers[S.layer];

function run(fn, okMsg) {
  const p = chain.then(async () => {
    try { await fn(); if (okMsg) toast(okMsg); }
    catch (e) { toast(e.message || String(e), { kind: 'err' }); if (e instanceof StudioError && e.code === 1) { S.locked = true; startPoll(); } }
    render();
  });
  chain = p.catch(() => {});
  return p;
}
async function setBinding(b) {
  const l = lay(), pos = S.sel;
  await run(async () => {
    await S.dev.setBinding(l.id, pos, b);
    l.bindings[pos] = { ...b }; S.unsaved = true; S.locked = false;
  });
}

// ---- rendering ----
function bounds() {
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const k of S.layout.keys) {
    const a = (k.r / 100) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    for (const [px, py] of [[k.x, k.y], [k.x + k.w, k.y], [k.x, k.y + k.h], [k.x + k.w, k.y + k.h]]) {
      const dx = px - k.rx, dy = py - k.ry, X = k.rx + dx * c - dy * s, Y = k.ry + dx * s + dy * c;
      x0 = Math.min(x0, X); x1 = Math.max(x1, X); y0 = Math.min(y0, Y); y1 = Math.max(y1, Y);
    }
  }
  return { x0, y0, w: (x1 - x0) * U, h: (y1 - y0) * U };
}
function board() {
  const bd = bounds(), l = lay();
  const wrap = h('div', { class: 'kb-board', style: `width:${bd.w}px;height:${bd.h}px` });
  S.layout.keys.forEach((k, i) => {
    const b = l.bindings[i]; if (!b) return;
    const txt = labelOf(b);
    const el = h('button', {
      type: 'button', class: 'kb-key' + (S.sel === i ? ' sel' : '') + (b.id === -1 || txt === '▽' ? ' trans' : ''), title: `#${i}`,
      style: `left:${(k.x - bd.x0) * U}px;top:${(k.y - bd.y0) * U}px;width:${k.w * U - 3}px;height:${k.h * U - 3}px;` + (k.r ? `transform-origin:${(k.rx - k.x) * U}px ${(k.ry - k.y) * U}px;transform:rotate(${k.r / 100}deg)` : ''),
      onclick: () => { S.sel = i; render(); },
    }, h('span', null, txt));
    wrap.append(el);
  });
  return h('div', { class: 'kb-scroll' }, wrap);
}

function layerBar() {
  const l = lay(), n = S.km.layers.length, busy = !S.dev;
  const tabs = h('div', { class: 'seg', role: 'tablist' }, S.km.layers.map((x, i) =>
    h('button', { type: 'button', class: 'tab', role: 'tab', 'aria-selected': String(i === S.layer), onclick: () => { S.layer = i; S.renaming = false; render(); } }, x.name || `Layer ${i}`)));
  const btn = (txt, fn, dis, title) => h('button', { type: 'button', class: 'btn sm', disabled: dis || busy, title, onclick: fn }, txt);
  return h('div', { class: 'kb-layerbar' }, tabs,
    h('div', { class: 'kb-tools' },
      S.renaming ? renameBox(l) : btn('Rename', () => { S.renaming = true; render(); document.querySelector('.kb-rename')?.focus(); }),
      btn('◀', () => run(async () => { S.km = await S.dev.moveLayer(S.layer, S.layer - 1); S.layer--; S.unsaved = true; }), S.layer === 0, 'Move layer left'),
      btn('▶', () => run(async () => { S.km = await S.dev.moveLayer(S.layer, S.layer + 1); S.layer++; S.unsaved = true; }), S.layer >= n - 1, 'Move layer right'),
      btn('+ Layer', () => run(async () => { const r = await S.dev.addLayer(); S.km = await S.dev.keymap(); S.layer = r.index; S.unsaved = true; }), S.km.available < 1, S.km.available < 1 ? 'No free layer slots' : 'Add layer'),
      btn('Remove', async () => {
        if (!(await confirmDialog({ title: `Remove layer ${l.name}?`, body: 'Its key bindings are dropped. Discard changes to undo before saving.', confirm: 'Remove', danger: true }))) return;
        run(async () => { await S.dev.removeLayer(S.layer); S.km = await S.dev.keymap(); S.layer = Math.min(S.layer, S.km.layers.length - 1); S.sel = null; S.unsaved = true; });
      }, n <= 1)));
}

function renameBox(l) {
  const max = S.km.maxName || 20;
  const inp = h('input', { class: 'kb-rename', maxlength: max, value: l.name, 'aria-label': 'Layer name' });
  const done = (ok) => {
    S.renaming = false; const name = inp.value.trim();
    if (!ok || !name || name === l.name) return render();
    run(async () => { await S.dev.renameLayer(l.id, name); l.name = name; S.unsaved = true; });
  };
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
  setTimeout(() => { inp.focus(); inp.select(); }, 0);
  return h('span', { class: 'kb-renamebox' }, inp, h('button', { type: 'button', class: 'btn sm primary', onclick: () => done(true) }, 'OK'), h('button', { type: 'button', class: 'btn sm', onclick: () => done(false) }, 'Cancel'));
}

// ---- binding editor ----
function editor() {
  const card = h('section', { class: 'card kb-edit' });
  if (S.sel == null) return card.append(h('h2', null, 'Key'), h('p', { class: 'muted' }, 'Click a key above to change what it does.')), card;
  const b = lay().bindings[S.sel];
  card.append(h('div', { class: 'card-head' }, h('h2', null, 'Key'), h('span', { class: 'chip-name' }, `#${S.sel} · ${labelOf(b) || 'none'}`)));
  const list = [...S.beh.values()].sort((a, c) => a.name.localeCompare(c.name));
  const bsel = h('select', { class: 'select', 'aria-label': 'Behaviour', onchange: () => {
    const id = Number(bsel.value), beh = S.beh.get(id), nb = { id, p1: 0, p2: 0 };
    const set = beh.sets[0]; if (set) { for (const [k, ds] of [['p1', set.p1], ['p2', set.p2]]) { const d = ds[0]; if (d?.kind === 'const') nb[k] = d.value; else if (d?.kind === 'range') nb[k] = Math.max(0, d.min); else if (d?.kind === 'layer') nb[k] = lay().id; } }
    setBinding(nb);
  } }, list.map((x) => h('option', { value: x.id, selected: x.id === b.id }, x.name)));
  card.append(h('div', { class: 'grouplabel' }, 'Action'), bsel);
  const beh = S.beh.get(b.id);
  if (!beh) return card;
  const si = matchSet(beh, b), set = beh.sets[si] || { p1: [], p2: [] };
  if (beh.sets.length > 1) {
    const vs = h('select', { class: 'select', 'aria-label': 'Variant', onchange: () => {
      const ns = beh.sets[Number(vs.value)], nb = { id: b.id, p1: 0, p2: 0 };
      for (const [k, ds] of [['p1', ns.p1], ['p2', ns.p2]]) { const d = ds[0]; if (d?.kind === 'const') nb[k] = d.value; else if (d?.kind === 'range') nb[k] = Math.max(0, d.min); else if (d?.kind === 'layer') nb[k] = lay().id; }
      setBinding(nb);
    } }, beh.sets.map((s, i) => h('option', { value: i, selected: i === si }, [...s.p1, ...s.p2].map((d) => d.name).filter(Boolean).join(' ') || `Option ${i + 1}`)));
    card.append(h('div', { class: 'grouplabel' }, 'Variant'), vs);
  }
  for (const [k, ds, label] of [['p1', set.p1, 1], ['p2', set.p2, 2]]) {
    if (!ds.length || ds.every((d) => d.kind === 'nil' || d.kind === 'const')) continue;
    const d = ds.find((x) => x.kind !== 'nil' && x.kind !== 'const') || ds[0];
    card.append(h('div', { class: 'grouplabel' }, d.name || `Parameter ${label}`), control(d, b, k));
  }
  return card;
}
function control(d, b, k) {
  const upd = (v) => setBinding({ ...b, [k]: v });
  if (d.kind === 'range') {
    const i = h('input', { type: 'number', class: 'kb-num', min: d.min, max: d.max, value: b[k], onchange: () => upd(Math.min(d.max, Math.max(d.min, Number(i.value) || 0))) });
    return i;
  }
  if (d.kind === 'layer') {
    const s = h('select', { class: 'select', onchange: () => upd(Number(s.value)) }, S.km.layers.map((l) => h('option', { value: l.id, selected: l.id === b[k] }, l.name)));
    return s;
  }
  if (d.kind === 'hid') return hidPicker(d, b, k);
  return h('span');
}
function hidPicker(d, b, k) {
  const cur = b[k], { mods } = split(cur);
  const wrap = h('div', { class: 'kb-hid' });
  const search = h('input', { type: 'search', class: 'kb-search', placeholder: 'Search keys…', value: S.filter, 'aria-label': 'Search keys', oninput: () => { S.filter = search.value; fill(); } });
  const grid = h('div', { class: 'kb-keys' });
  const fill = () => {
    grid.textContent = ''; const q = S.filter.trim().toLowerCase();
    for (const [title, items] of hidGroups()) {
      const f = items.filter(([lbl]) => !q || lbl.toLowerCase().includes(q) || title.toLowerCase().includes(q));
      if (!f.length) continue;
      grid.append(h('div', { class: 'kb-gt' }, title), h('div', { class: 'kb-gl' }, f.map(([lbl, v]) =>
        h('button', { type: 'button', class: 'kb-opt' + ((cur & 0xffffff) === v ? ' on' : ''), onclick: () => setBinding({ ...b, [k]: withMods(v, mods) }) }, lbl))));
    }
  };
  fill();
  wrap.append(search);
  if (isKp(b) && k === 'p1') {
    wrap.append(h('div', { class: 'kb-mods' }, h('span', { class: 'muted small' }, 'With:'), MODS.map(([n, bit]) =>
      h('label', { class: 'kb-mod' }, h('input', { type: 'checkbox', checked: !!(mods & bit), onchange: (e) => setBinding({ ...b, [k]: withMods(cur, e.target.checked ? mods | bit : mods & ~bit) }) }), n))));
  }
  wrap.append(grid);
  return wrap;
}

function head() {
  const lock = S.locked;
  const stat = h('span', { class: 'status', 'data-state': 'on' }, h('i', { class: 'dot' }), S.info?.name || 'Keyboard');
  const lk = h('span', { class: 'pill-lock' + (lock ? ' locked' : '') }, lock ? '🔒 Locked' : '🔓 Unlocked');
  const bar = h('div', { class: 'kb-bar' }, stat, lk,
    S.unsaved ? h('span', { class: 'pill-warn' }, 'Unsaved changes') : null, h('span', { class: 'spacer' }),
    h('button', { type: 'button', class: 'btn', disabled: !S.unsaved, onclick: async () => {
      if (!(await confirmDialog({ title: 'Discard keymap changes?', body: 'Reverts to the last saved keymap on the keyboard.', confirm: 'Discard' }))) return;
      run(async () => { await S.dev.discard(); S.km = await S.dev.keymap(); S.unsaved = false; }, 'Reverted.');
    } }, 'Discard'),
    h('button', { type: 'button', class: 'btn primary', disabled: !S.unsaved, onclick: () => run(async () => { await S.dev.save(); S.unsaved = false; }, 'Keymap saved to the keyboard.') }, 'Save keymap'),
    h('button', { type: 'button', class: 'btn', onclick: disconnect }, 'Disconnect'));
  return bar;
}
async function disconnect() { const t = S.t; S.dev = null; S.t = null; try { await t?.close(); } catch {} render(); }

export function render() {
  if (!root) return;
  try { draw(); } catch (e) {
    console.error(e); root.textContent = '';
    root.append(h('div', { class: 'notice lockbanner' }, 'Could not draw the keymap: ' + (e.message || e), h('button', { type: 'button', class: 'btn sm', onclick: () => { S.sel = null; render(); } }, 'Reset view')));
  }
}
function unlockPanel() {
  return h('div', { class: 'empty-card unlock' },
    h('div', { class: 'unlock-ic', 'aria-hidden': 'true' }, '🔒'),
    h('h2', null, 'Unlock the keyboard'),
    h('p', null, 'The keyboard is connected but locked, so it will not show or accept key changes yet.'),
    h('ol', { class: 'unlock-steps' },
      h('li', null, 'Hold the ', h('kbd', null, 'MO L'), ' key on your left thumb cluster (LOWER layer).'),
      h('li', null, 'While holding, press the key labelled ', h('kbd', null, 'Studio'), '.'),
      h('li', null, 'Release. This page notices and loads your keymap by itself.')),
    h('p', { class: 'muted small unlock-wait' }, h('i', { class: 'spin' }), 'Waiting for unlock…'),
    h('div', { class: 'empty-actions' }, h('button', { type: 'button', class: 'btn', onclick: disconnect }, 'Disconnect')));
}
function draw() {
  root.textContent = '';
  if (!navigator.serial && !new URLSearchParams(location.search).has('demo')) {
    root.append(h('div', { class: 'empty-card' }, h('h2', null, 'Keymap editing needs Web Serial'), h('p', null, 'Use Chrome or Edge on desktop (https or http://localhost).')));
    return;
  }
  if (!S.dev) {
    root.append(h('div', { class: 'empty-card' },
      h('h2', null, 'Edit your keymap'),
      h('p', null, 'Change what every key does, rename and reorder layers, no ZMK Studio needed. Connect the serial port of the keyboard (shown as a COM port, “Sofle”).'),
      h('p', { class: 'muted small' }, 'Tip: close any other ZMK Studio tab first. The port can only be used by one page.'),
      h('div', { class: 'empty-actions' }, h('button', { type: 'button', class: 'btn primary lg', onclick: connect }, 'Connect serial port'))));
    return;
  }
  if (S.busy && !S.km) { root.append(h('p', { class: 'muted', style: 'padding:24px' }, 'Reading keymap…')); return; }
  if (!S.km) { root.append(unlockPanel()); return; }
  const kids = [head()];
  if (S.locked) kids.push(h('div', { class: 'notice lockbanner' }, 'Locked again: hold MO L and press the Studio key to keep editing.',
    h('button', { type: 'button', class: 'btn sm', onclick: () => run(async () => { S.locked = await S.dev.isLocked(); }) }, 'Check again')));
  kids.push(h('div', { class: 'kb-main' }, h('section', { class: 'card' }, layerBar(), board()), editor()));
  root.append(...kids);
}

export function initKeymap(el) {
  root = el; render();
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.sel != null && !e.target.closest?.('input,select,textarea')) { S.sel = null; render(); } });
}
