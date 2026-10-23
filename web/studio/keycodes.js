// HID usage -> label table. A Studio hid_usage parameter = (page << 16) | id, with implicit modifiers in the top byte.
const kb = {};
'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').forEach((c, i) => { kb[4 + i] = c; });
'1234567890'.split('').forEach((c, i) => { kb[30 + i] = c; });
Object.assign(kb, { 40: 'Enter', 41: 'Esc', 42: 'Bksp', 43: 'Tab', 44: 'Space', 45: '-', 46: '=', 47: '[', 48: ']', 49: '\\', 50: '#', 51: ';', 52: "'", 53: '`', 54: ',', 55: '.', 56: '/', 57: 'Caps',
  70: 'PrtSc', 71: 'ScrLk', 72: 'Pause', 73: 'Ins', 74: 'Home', 75: 'PgUp', 76: 'Del', 77: 'End', 78: 'PgDn', 79: '→', 80: '←', 81: '↓', 82: '↑', 83: 'NumLk',
  84: 'KP /', 85: 'KP *', 86: 'KP -', 87: 'KP +', 88: 'KP Ent', 99: 'KP .', 101: 'Menu',
  224: 'LCtrl', 225: 'LShift', 226: 'LAlt', 227: 'LGui', 228: 'RCtrl', 229: 'RShift', 230: 'RAlt', 231: 'RGui' });
for (let i = 1; i <= 12; i++) kb[57 + i] = 'F' + i;
for (let i = 1; i <= 9; i++) kb[88 + i] = 'KP ' + i; kb[98] = 'KP 0';
for (let i = 13; i <= 24; i++) kb[104 + i - 13] = 'F' + i;

const cons = { 0xe2: 'Mute', 0xe9: 'Vol+', 0xea: 'Vol-', 0xcd: 'Play', 0xb5: 'Next', 0xb6: 'Prev', 0xb7: 'Stop', 0x6f: 'Bri+', 0x70: 'Bri-', 0x192: 'Calc', 0x18a: 'Mail', 0x223: 'WWW', 0x224: 'Back', 0x225: 'Fwd', 0x221: 'Search' };

export const MODS = [['Ctrl', 1], ['Shift', 2], ['Alt', 4], ['Gui', 8]]; // implicit-mod bits (left)

export const usage = (page, id) => ((page << 16) | id) >>> 0;
export const split = (v) => ({ mods: (v >>> 24) & 0xff, page: (v >>> 16) & 0xff, id: v & 0xffff });
export const withMods = (v, mods) => (((mods & 0xff) << 24) | (v & 0xffffff)) >>> 0;

export function hidLabel(v) {
  if (!v) return '';
  const { mods, page, id } = split(v);
  const base = page === 7 ? kb[id] ?? '0x' + id.toString(16) : page === 12 ? cons[id] ?? 'C' + id.toString(16) : `${page}:${id}`;
  const m = MODS.filter(([, b]) => mods & b || mods & (b << 4)).map(([n]) => n[0] + '+').join('');
  return m + base;
}

/** Picker groups: [title, [[label, usageValue], ...]] limited to what the behaviour allows (kbMax/consMax). */
export function hidGroups() {
  const g = (t, ids, page, tbl) => [t, ids.filter((i) => tbl[i] !== undefined).map((i) => [tbl[i], usage(page, i)])];
  const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
  return [
    g('Letters', range(4, 29), 7, kb), g('Numbers', range(30, 39), 7, kb),
    g('Editing', [40, 41, 42, 43, 44, 57, 73, 76, 74, 77, 75, 78, 101], 7, kb),
    g('Symbols', [45, 46, 47, 48, 49, 51, 52, 53, 54, 55, 56], 7, kb),
    g('Arrows', [82, 81, 80, 79], 7, kb),
    g('Function', range(58, 69), 7, kb),
    g('Modifiers', range(224, 231), 7, kb),
    g('Media', [0xe2, 0xe9, 0xea, 0xcd, 0xb5, 0xb6, 0xb7, 0x6f, 0x70], 12, cons),
    g('Other', [70, 71, 72, 83, 84, 85, 86, 87, 88, 98, 99, ...range(89, 97)], 7, kb),
  ];
}
