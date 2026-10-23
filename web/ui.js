// Small UI toolkit: element helper, icons, "?" help popovers, toasts, confirm dialog.

export const $ = (id) => document.getElementById(id);

/** Tiny hyperscript. Props: class, on<Event>, dataset, plus attributes. Kids: string | Node | array | null. */
export function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const k in props || {}) {
    const v = props[k];
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else if (k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'hidden') e[k] = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  const add = (c) => {
    if (c == null || c === false) return;
    if (Array.isArray(c)) c.forEach(add);
    else e.append(c.nodeType ? c : document.createTextNode(String(c)));
  };
  kids.forEach(add);
  return e;
}

const SVGNS = 'http://www.w3.org/2000/svg';
export function icon(name, cls = '') {
  const s = document.createElementNS(SVGNS, 'svg');
  s.setAttribute('class', 'ic ' + cls); s.setAttribute('aria-hidden', 'true');
  const u = document.createElementNS(SVGNS, 'use'); u.setAttribute('href', '#i-' + name);
  s.appendChild(u); return s;
}

// ---------- help popovers ----------
export const HELP = {
  intro: ['What is this page?', 'This page edits the RGB lighting stored on your Sofle. Pick a layer and a key to colour it, or change the global effect. Changes show on the keyboard immediately.'],
  previewSave: ['Preview vs Save', 'Every change is a live preview on the keyboard and is lost when it loses power. Press "Save to keyboard" to write it to flash so it survives a restart.'],
  layers: ['Layers', 'A layer is a set of key meanings (BASE, LOWER, RAISE, ADJUST). Each layer can give its keys their own colour. The dot on a tab marks layers that are active on the keyboard right now; the filled dot is the one on top.'],
  board: ['Keyboard', 'Click a key to edit it. Shift+click selects a range, Ctrl+click adds or removes keys, arrow keys move around. The glow shows the key\'s LED colour (dashed outline: it falls through to a lower layer).'],
  rightHalf: ['Right half', 'Only the left half has LEDs wired up so far. The right half is drawn greyed out as a mirror and cannot be edited yet.'],
  keyMode: ['Key mode', 'Decides what this key\'s LED does on the current layer. Transparent lets the layer below decide (usually the effect). Solid paints a fixed colour. Off turns it dark.'],
  keyColor: ['Key colour', 'Colour of this key\'s LED while this layer is on top. Brightness is limited by the keyboard\'s power safety cap.'],
  highlight: ['Highlight colour', 'The colour a pressed key flashes when typing (Fade, Ripple, or Held). When off, the keyboard uses a soft white tinted opposite to your base colour. Not used by the Color mode, which cycles its own hues.'],
  layerTools: ['Layer tools', 'Bulk helpers for the current layer. Everything here can be undone with Ctrl+Z.'],
  lighting: ['Lighting', 'Global lighting that applies to every layer, unless a key overrides it. The switch turns all LEDs on or off.'],
  effect: ['Effect', 'The animated base pattern behind your keys. Keys set to Solid or Off on a layer ignore it; Transparent and Effect keys show it.'],
  color: ['Base colour', 'The colour used by the effect. Solid, Breathe, Wave, and Starlight use this colour.'],
  rainbow: ['Rainbow effects', 'Spectrum, Swirl, and Radial cycle through all 360° rainbow hues automatically across the keyboard. No single colour needed. You can adjust saturation to make the rainbow pastel or neon.'],
  gradient: ['Gradient effect', 'Shifts colour horizontally by 120° across the keyboard from left to right. Pick a preset pair or slide the starting hue to rotate colors.'],
  brightness: ['Brightness cap', 'Global brightness of all LEDs on the keyboard, from 0 to the hardware safety limit (40). This keeps battery and USB power draw safe.'],
  speed: ['Speed', 'How fast the animation runs, from 1 (slow) to 5 (fast). Solid and Gradient do not move, so they have no speed.'],
  react: ['Keypress effect', 'Global effect that lights up keys when you type: Fade flashes then fades, Ripple sends a wave outwards, Held stays lit while pressed, Color picks a new colour each press. Applies across all layers.'],
  device: ['Keyboard actions', 'Re-read discards unsaved preview and loads what is stored. The LED walk test lights each LED in turn so you can check wiring. Restore defaults overwrites the saved settings.'],
  file: ['Export and import', 'Export downloads your whole configuration as a JSON file. Import loads one as a live preview; press Save to keep it.'],
};

let pop, popBtn;
function ensurePop() {
  if (pop) return;
  pop = h('div', { id: 'pop', class: 'pop', role: 'dialog', 'aria-labelledby': 'popTitle', hidden: true },
    h('div', { class: 'pop-title', id: 'popTitle' }), h('div', { class: 'pop-body', id: 'popBody' }));
  document.body.appendChild(pop);
  document.addEventListener('pointerdown', (e) => { if (popBtn && !pop.contains(e.target) && !popBtn.contains(e.target)) closePop(); }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && popBtn) { e.stopPropagation(); const b = popBtn; closePop(); b.focus(); } }, true);
  window.addEventListener('resize', () => closePop());
  window.addEventListener('scroll', () => closePop(), { passive: true, capture: true });
}
export function closePop() {
  if (!popBtn) return;
  popBtn.setAttribute('aria-expanded', 'false'); popBtn.removeAttribute('aria-describedby');
  pop.hidden = true; popBtn = null;
}
export function isPopOpen() { return !!popBtn; }
function openPop(btn, [title, body]) {
  ensurePop(); if (popBtn) closePop();
  $('popTitle').textContent = title; $('popBody').textContent = body;
  pop.hidden = false; popBtn = btn;
  btn.setAttribute('aria-expanded', 'true'); btn.setAttribute('aria-describedby', 'pop');
  const r = btn.getBoundingClientRect(), pw = pop.offsetWidth, ph = pop.offsetHeight;
  let left = Math.min(Math.max(8, r.left + r.width / 2 - pw / 2), innerWidth - pw - 8);
  let top = r.bottom + 8; if (top + ph > innerHeight - 8) top = Math.max(8, r.top - ph - 8);
  pop.style.left = left + 'px'; pop.style.top = top + 'px';
  pop.style.setProperty('--arrow', Math.round(r.left + r.width / 2 - left) + 'px');
}
/** A "?" button that toggles a popover with HELP[key]. */
export function helpBtn(key) {
  const data = HELP[key]; ensurePop();
  const b = h('button', { type: 'button', class: 'help', 'aria-label': 'Help: ' + data[0], 'aria-expanded': 'false', 'aria-haspopup': 'dialog' }, icon('help'));
  b.addEventListener('click', () => { if (popBtn === b) closePop(); else openPop(b, data); });
  return b;
}
/** Replace every <span data-help="key"> placeholder under root with a help button. */
export function mountHelp(root = document) {
  root.querySelectorAll('[data-help]').forEach((n) => { n.replaceWith(helpBtn(n.dataset.help)); });
}

// ---------- toasts ----------
export function toast(text, { kind = 'ok', retry, sticky = false } = {}) {
  const box = $('toasts');
  const close = () => { t.classList.add('out'); setTimeout(() => t.remove(), 180); };
  const t = h('div', { class: 'toast ' + kind, role: kind === 'err' ? 'alert' : 'status' },
    icon(kind === 'ok' ? 'check' : kind === 'err' ? 'alert' : 'info'),
    h('span', { class: 'toast-text' }, text),
    retry ? h('button', { type: 'button', class: 'btn sm', onclick: () => { close(); retry(); } }, 'Retry') : null,
    h('button', { type: 'button', class: 'iconbtn sm', 'aria-label': 'Dismiss', onclick: close }, icon('x')));
  box.appendChild(t);
  while (box.children.length > 4) box.firstChild.remove();
  if (!sticky && kind !== 'err') setTimeout(close, 4200);
  t.dismiss = close; return t;
}

// ---------- confirm dialog ----------
export function confirmDialog({ title, body, confirm = 'Confirm', danger = false }) {
  const d = $('dlg');
  $('dlgTitle').textContent = title; $('dlgBody').textContent = body;
  const ok = $('dlgOk'); ok.textContent = confirm; ok.className = 'btn ' + (danger ? 'danger-solid' : 'primary');
  return new Promise((resolve) => {
    const done = (v) => { d.removeEventListener('close', onClose); d.removeEventListener('click', onBackdrop); ok.onclick = null; $('dlgCancel').onclick = null; if (d.open) d.close(); resolve(v); };
    const onClose = () => done(false);
    const onBackdrop = (e) => { if (e.target === d) done(false); };
    ok.onclick = () => done(true); $('dlgCancel').onclick = () => done(false);
    d.addEventListener('close', onClose); d.addEventListener('click', onBackdrop);
    d.showModal(); $('dlgCancel').focus();
  });
}

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
