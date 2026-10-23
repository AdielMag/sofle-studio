// In-memory fake Studio device for ?demo (no hardware).
import { usage } from './keycodes.js';

const kp = { name: 'Key Press', sets: [{ p1: [{ name: 'Key', kind: 'hid', kbMax: 0xffff, consMax: 0xffff }], p2: [] }] };
const BEH = [
  { id: 1, ...kp },
  { id: 2, name: 'Transparent', sets: [{ p1: [], p2: [] }] },
  { id: 3, name: 'None', sets: [{ p1: [], p2: [] }] },
  { id: 4, name: 'Momentary Layer', sets: [{ p1: [{ name: 'Layer', kind: 'layer' }], p2: [] }] },
  { id: 5, name: 'Mod-Tap', sets: [{ p1: [{ name: 'Hold', kind: 'hid', kbMax: 255, consMax: 0 }], p2: [{ name: 'Tap', kind: 'hid', kbMax: 255, consMax: 0 }] }] },
  { id: 6, name: 'Bluetooth', sets: [{ p1: [{ name: 'Clear', kind: 'const', value: 0 }], p2: [] }, { p1: [{ name: 'Select', kind: 'const', value: 3 }], p2: [{ name: 'Profile', kind: 'range', min: 0, max: 4 }] }] },
];

export function createMock(lockedMs = 0) {
  const t0 = Date.now(); const locked = () => Date.now() - t0 < lockedMs;
  const E = () => Object.assign(new Error('locked'), { code: 1 });
  const row = (x0, y0, n, dx = 100) => Array.from({ length: n }, (_, i) => ({ x: x0 + i * dx, y: y0, w: 100, h: 100, r: 0, rx: 0, ry: 0 }));
  const keys = [];
  for (let r = 0; r < 3; r++) keys.push(...row(0, r * 100, 6), ...row(800, r * 100, 6));
  keys.push(...row(0, 300, 6), { x: 620, y: 300, w: 80, h: 80, r: 0, rx: 0, ry: 0 }, { x: 720, y: 300, w: 80, h: 80, r: 0, rx: 0, ry: 0 }, ...row(800, 300, 6));
  keys.push(...row(100, 420, 5), ...row(800, 420, 5));
  const letters = 'QWERTYUIOPASDFGHJKLZXCVBNM1234567890';
  const mk = (i) => ({ id: 1, p1: usage(7, 4 + (i % 26)), p2: 0 });
  let nextId = 4;
  const mkLayer = (name) => ({ id: nextId++, name, bindings: keys.map((_, i) => name === 'Base' ? mk(i) : { id: 2, p1: 0, p2: 0 }) });
  let km = { layers: [mkLayer('Base'), mkLayer('Lower')], available: 3, maxName: 20 }; void letters;
  const dev = {
    onClose() {}, onNotify() {},
    deviceInfo: async () => ({ name: 'Demo Sofle' }), isLocked: async () => locked(),
    behaviors: async () => { if (locked()) throw E(); return new Map(BEH.map((b) => [b.id, b])); },
    physicalLayout: async () => ({ name: 'Sofle', keys }),
    keymap: async () => JSON.parse(JSON.stringify(km)),
    unsaved: async () => false,
    setBinding: async (lid, pos, b) => { km.layers.find((l) => l.id === lid).bindings[pos] = { ...b }; },
    save: async () => {}, discard: async () => {},
    renameLayer: async (id, n) => { km.layers.find((l) => l.id === id).name = n; },
    addLayer: async () => { const l = mkLayer('Layer ' + km.layers.length); km.layers.push(l); km.available--; return { index: km.layers.length - 1, layer: l }; },
    removeLayer: async (i) => { km.layers.splice(i, 1); km.available++; },
    moveLayer: async (a, b) => { const [l] = km.layers.splice(a, 1); km.layers.splice(b, 0, l); return JSON.parse(JSON.stringify(km)); },
  };
  return { dev, t: { close: async () => {} } };
}
