// Device-free self tests. Used by `?selftest` in the browser and by test.mjs in node.
import * as P from './proto.js';

function eq(a, b, msg) {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error(`${msg || 'not equal'}: got ${x}, expected ${y}`);
}

/** Tiny fake firmware: answers INFO, GET_CHUNK, SET_CHUNK, GET_STATE from an in-memory image. */
export function mockHid(image) {
  const et = new EventTarget();
  const staged = new Uint8Array(P.CFG_SIZE);
  const hid = {
    opened: false, sent: [], dropFirst: 0,
    open: async () => { hid.opened = true; }, close: async () => { hid.opened = false; },
    addEventListener: (...a) => et.addEventListener(...a), removeEventListener: (...a) => et.removeEventListener(...a),
    sendReport: async (id, data) => {
      hid.sent.push(new Uint8Array(data));
      if (hid.dropFirst > 0) { hid.dropFirst--; return; }
      // noise from zmk-hid-host first: must be ignored
      emit(et, new Uint8Array(32).fill(0xaa));
      const [, cmd, seq] = data; const p = new Uint8Array(28); let status = 0;
      if (cmd === P.CMD.INFO) p.set([1, 2, 4, 60, 29, 8, 5, P.CFG_SIZE & 255, P.CFG_SIZE >> 8, 40, 5, 24, 0]);
      else if (cmd === P.CMD.GET_CHUNK) {
        const off = data[4] | (data[5] << 8); const n = Math.min(data[6] || 24, 24, image.length - off);
        p[0] = off & 255; p[1] = off >> 8; p[2] = n; p.set(image.subarray(off, off + n), 3);
      } else if (cmd === P.CMD.SET_CHUNK) {
        const off = data[4] | (data[5] << 8), n = data[6]; staged.set(data.subarray(7, 7 + n), off);
        p[0] = off & 255; p[1] = off >> 8; p[2] = n;
      } else if (cmd === P.CMD.GET_STATE) p.set([3, 0, 0, 0, 1, 1, 0]);
      else status = 1;
      const r = new Uint8Array(32); r.set([P.MAGIC, cmd, seq, status]); r.set(p, 4);
      setTimeout(() => emit(et, r), 1);
    },
    staged,
  };
  return hid;
}
function emit(et, bytes) {
  const ev = new Event('inputreport'); ev.data = new DataView(bytes.buffer.slice(0)); ev.reportId = 0; et.dispatchEvent(ev);
}

export const tests = [
  ['crc16 check vector 123456789 = 0x29B1', () => eq(P.crc16(new TextEncoder().encode('123456789')), 0x29b1)],
  ['crc16 empty = 0xFFFF', () => eq(P.crc16(new Uint8Array(0)), 0xffff)],
  ['config size is 1004 = 42 chunks (last 20)', () => {
    eq(P.CFG_SIZE, 1004);
    const c = P.chunkPlan(P.CFG_SIZE, 24); eq(c.length, 42); eq(c[41], { offset: 984, n: 20 }); eq(c[0], { offset: 0, n: 24 });
    eq(c.reduce((a, x) => a + x.n, 0), 1004);
  }],
  ['request encode/decode', () => {
    const r = P.encodeRequest(P.CMD.SET_KEY, 7, P.encodeSetKey(2, 41, { mode: 2, hue: 300, sat: 90, val: 50 }));
    eq(r.length, 32); eq([r[0], r[1], r[2], r[3]], [0x52, 9, 7, 0]); eq([r[4], r[5]], [2, 41]);
    const d = P.decodeReply(r); eq([d.cmd, d.seq, d.status], [9, 7, 0]); eq(P.unpackKey(d.payload, 2), { mode: 2, hue: 300, sat: 90, val: 50 });
    eq(P.decodeReply(new Uint8Array(32).fill(0xaa)), null, 'foreign report ignored');
  }],
  ['key pack: hue bit 8', () => {
    const b = P.packKey({ mode: 4, hue: 359, sat: 100, val: 100 }); eq([...b], [0x84, 359 & 255, 100, 100]);
    eq(P.unpackKey(b), { mode: 4, hue: 359, sat: 100, val: 100 });
    eq([...P.packKey({ mode: 1, hue: 255, sat: 0, val: 0 })].slice(0, 2), [1, 255]);
  }],
  ['global payload mask', () => {
    const p = P.encodeSetGlobal({ hue: 300, val: 40 }, true); eq([p[0], p[5], p[6], p[8], p[9]], [0x10 | 0x40, 300 & 255, 1, 40, 1]);
    eq(P.encodeSetGlobal({ on: 1, effect: 3, speed: 2, react: 4, sat: 7 })[0], 1 | 2 | 4 | 8 | 32);
  }],
  ['config pack/unpack round trip + CRC', () => {
    const c = P.defaultConfig();
    c.g = { on: 1, effect: 5, speed: 4, react: 2, hue: 333, sat: 80, val: 30 };
    c.fx = { hue2: 270, sat2: 90, angle: 45, star_density: 8, star_mode: 2 };
    c.layers[0] = { react: 0xff, decay: 60, ripple_speed: 0, flags: 0, hue: 120, sat: 100, val: 30 };
    c.keys[3][59] = { mode: 3, hue: 359, sat: 1, val: 2 }; c.keys[1][0] = { mode: 2, hue: 128, sat: 50, val: 100 };
    const b = P.packConfig(c); eq(b.length, 1004); eq(P.checkConfigImage(b), null);
    eq([b[0], b[1]], [2, 0]); eq(P.u16(b, 2), P.crc16(b, 4, 1004));
    eq(b[4 + 4], 333 & 255); eq(b[12], 0xff);
    eq(P.unpackConfig(b), c);
    b[500] ^= 1; if (!/CRC/.test(P.checkConfigImage(b))) throw new Error('corruption not detected');
  }],
  ['JSON export/import round trip', () => {
    const c = P.defaultConfig(); c.keys[2][10] = { mode: 4, hue: 200, sat: 20, val: 10 };
    eq(P.configFromJson(JSON.parse(JSON.stringify(P.configToJson(c)))), c);
    let threw = false; try { P.configFromJson({ format: 'x' }); } catch { threw = true; } if (!threw) throw new Error('bad file accepted');
  }],
  ['hsv to rgb', () => { eq(P.hsvToRgb(0, 100, 100), [255, 0, 0]); eq(P.hsvToRgb(120, 100, 100), [0, 255, 0]); eq(P.hsvToRgb(240, 0, 0), [0, 0, 0]); }],
  ['Device: read config over mock, ignores foreign reports', async () => {
    const c = P.defaultConfig(); c.keys[0][5] = { mode: 2, hue: 210, sat: 100, val: 77 };
    const hid = mockHid(P.packConfig(c)); const d = new P.Device(hid); await d.open();
    const info = await d.info(); eq([info.cfgSize, info.brtMax, info.chunkMax], [1004, 40, 24]);
    eq(P.unpackConfig(await d.readConfig(null, info)), c);
    eq((await d.state()).top, 1);
    await d.close();
  }],
  ['Device: retry with same seq after dropped reply', async () => {
    const hid = mockHid(P.packConfig(P.defaultConfig())); hid.dropFirst = 2;
    const d = new P.Device(hid, { timeout: 30, retries: 3 }); await d.open(); await d.info();
    eq(hid.sent.length, 3); eq(new Set(hid.sent.map((r) => r[2])).size, 1);
  }],
  ['Device: timeout error after retries', async () => {
    const hid = mockHid(P.packConfig(P.defaultConfig())); hid.dropFirst = 99;
    const d = new P.Device(hid, { timeout: 20, retries: 2 }); await d.open();
    let err; try { await d.info(); } catch (e) { err = e; }
    if (!err || err.code !== 'timeout') throw new Error('expected timeout');
  }],
  ['Device: SET_CHUNK upload writes the image', async () => {
    const img = P.packConfig(P.defaultConfig()); const hid = mockHid(img);
    const d = new P.Device(hid); await d.open();
    const c = P.defaultConfig(); c.keys[1][3] = { mode: 1, hue: 1, sat: 2, val: 3 }; const out = P.packConfig(c);
    await d.writeRange(out, 0, out.length); eq([...hid.staged], [...out]);
  }],
];

export async function runAll() {
  const results = [];
  for (const [name, fn] of tests) {
    try { await fn(); results.push({ name, ok: true }); } catch (e) { results.push({ name, ok: false, error: e.message }); }
  }
  return results;
}
