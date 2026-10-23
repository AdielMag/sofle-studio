// In-memory fake keyboard for ?demo. Behaves like a WebHID device, so the real P.Device protocol path runs unchanged.
import * as P from './proto.js';

const BRT_MAX = 40;

export function demoConfig() {
  const c = P.defaultConfig();
  c.g = { on: 1, effect: 3, speed: 3, react: 2, hue: 215, sat: 90, val: 30 };
  c.layers[1] = { ...c.layers[1], react: 1, hue: 40, sat: 100, val: 40 };
  c.layers[3].react = 0;
  const set = (l, p, e) => { c.keys[l][p] = { hue: 0, sat: 100, val: 100, ...e }; };
  // BASE: WASD cluster + modifiers
  for (const p of [14, 25, 26, 27]) set(0, p, { mode: 2, hue: 20, sat: 100, val: 40 });
  set(0, 0, { mode: 2, hue: 0, sat: 100, val: 40 }); set(0, 12, { mode: 2, hue: 0, sat: 100, val: 40 });
  for (const p of [50, 51, 52, 53, 54]) set(0, p, { mode: 2, hue: 280, sat: 80, val: 35 });
  set(0, 36, { mode: 4, hue: 150, sat: 100, val: 30 }); set(0, 24, { mode: 1 });
  // LOWER: numbers row cyan, F-keys violet, rest transparent
  for (let p = 12; p < 23; p++) set(1, p, { mode: 2, hue: 190, sat: 100, val: 40 });
  for (let p = 1; p < 11; p++) set(1, p, { mode: 2, hue: 266, sat: 90, val: 40 });
  set(1, 0, { mode: 2, hue: 0, sat: 100, val: 40 });
  // RAISE: arrows
  for (const p of [20, 31, 32, 33]) set(2, p, { mode: 2, hue: 130, sat: 100, val: 40 });
  set(2, 13, { mode: 3 });
  return c;
}

/** Fake HIDDevice. Implements INFO, GET/SET_CHUNK, PREVIEW, SAVE, SET_GLOBAL, DEFAULTS, GET_STATE, SET_KEY, WALK. */
export function demoHid() {
  const et = new EventTarget();
  let live = P.packConfig(demoConfig()); let saved = live.slice(); let staged = live.slice(); let hasStage = false;
  const t0 = Date.now();
  const resync = () => { staged = live.slice(); hasStage = false; };
  const hid = {
    opened: false, productName: 'Sofle RGB (demo)', demo: true,
    open: async () => { hid.opened = true; }, close: async () => { hid.opened = false; },
    addEventListener: (...a) => et.addEventListener(...a), removeEventListener: (...a) => et.removeEventListener(...a),
    sendReport: async (id, data) => {
      const [, cmd, seq] = data; const p = new Uint8Array(28); let status = 0;
      const u16 = (o) => data[4 + o] | (data[5 + o] << 8);
      if (cmd === P.CMD.INFO) p.set([1, P.CFG_VERSION, 4, 60, 29, 8, 5, P.CFG_SIZE & 255, P.CFG_SIZE >> 8, BRT_MAX, 5, P.CHUNK_MAX, 0]);
      else if (cmd === P.CMD.GET_CHUNK) {
        const off = u16(0), n = Math.min(data[6] || 24, P.CHUNK_MAX, live.length - off);
        p[0] = off & 255; p[1] = off >> 8; p[2] = n; p.set(live.subarray(off, off + n), 3);
      } else if (cmd === P.CMD.SET_CHUNK) {
        const off = u16(0), n = data[6]; if (!hasStage) { staged = live.slice(); hasStage = true; }
        staged.set(data.subarray(7, 7 + n), off); p[0] = off & 255; p[1] = off >> 8; p[2] = n;
      } else if (cmd === P.CMD.PREVIEW || cmd === P.CMD.SAVE) {
        const img = hasStage ? staged.slice() : live.slice();
        if (data[4] & P.F_FIX_CRC) { img[0] = P.CFG_VERSION; const crc = P.crc16(img, 4, img.length); img[2] = crc & 255; img[3] = crc >> 8; }
        const err = P.checkConfigImage(img);
        if (err) status = P.ST.BAD_CRC; else { img[11] = Math.min(img[11], BRT_MAX); live = img; resync(); if (cmd === P.CMD.SAVE) saved = live.slice(); }
      } else if (cmd === P.CMD.SET_GLOBAL) {
        const m = data[4], o = P.OFF_GLOBAL;
        const g = live.slice();
        if (m & 1) g[o] = data[5]; if (m & 2) g[o + 1] = data[6]; if (m & 4) g[o + 2] = data[7]; if (m & 8) g[o + 3] = data[8];
        if (m & 16) { g[o + 4] = data[9]; g[o + 5] = data[10]; } if (m & 32) g[o + 6] = data[11]; if (m & 64) g[o + 7] = Math.min(data[12], BRT_MAX);
        const crc = P.crc16(g, 4, g.length); g[2] = crc & 255; g[3] = crc >> 8; live = g; resync();
        p[0] = m; p.set(live.subarray(o, o + 8).map((x, i) => x), 1);
        p[5] = live[o + 4]; p[6] = live[o + 5]; p[7] = live[o + 6]; p[8] = live[o + 7];
      } else if (cmd === P.CMD.SET_KEY) {
        const l = data[4], pos = data[5]; if (l >= 4 || pos >= 60) status = P.ST.BAD_ARG;
        else { const g = live.slice(); g.set(data.subarray(6, 10), P.OFF_KEYS + (l * 60 + pos) * 4); const crc = P.crc16(g, 4, g.length); g[2] = crc & 255; g[3] = crc >> 8; live = g; resync(); p[0] = l; p[1] = pos; }
      } else if (cmd === P.CMD.DEFAULTS) { live = P.packConfig(P.defaultConfig()); saved = live.slice(); resync(); }
      else if (cmd === P.CMD.WALK) { /* nothing to show */ }
      else if (cmd === P.CMD.GET_STATE) {
        const top = Math.floor((Date.now() - t0) / 7000) % 3; // BASE -> LOWER -> RAISE -> ...
        p.set([1 | (top ? 1 << top : 0), 0, 0, 0, top, live[P.OFF_GLOBAL] ? 1 : 0, hasStage ? 1 : 0]);
      } else status = P.ST.BAD_CMD;
      const r = new Uint8Array(32); r.set([P.MAGIC, cmd, seq, status]); r.set(p, 4);
      setTimeout(() => { const ev = new Event('inputreport'); ev.data = new DataView(r.buffer.slice(0)); ev.reportId = 0; et.dispatchEvent(ev); }, 3);
    },
  };
  return hid;
}
