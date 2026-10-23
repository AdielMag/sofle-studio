// rgbpk raw HID protocol v1 (see docs/PROTOCOL.md). Pure helpers + a small WebHID transport.

export const MAGIC = 0x52;
export const REPORT_SIZE = 32;
export const HDR = 4;
export const CHUNK_MAX = 16; // replies lose payload bytes past ~17 on real hardware (see debugging notes)
export const USAGE_PAGE = 0xff60;
export const USAGE = 0x61;

export const CMD = {
  INFO: 1, GET_CHUNK: 2, SET_CHUNK: 3, PREVIEW: 4, SAVE: 5,
  SET_GLOBAL: 6, DEFAULTS: 7, GET_STATE: 8, SET_KEY: 9, WALK: 10,
};
export const ST = { OK: 0, BAD_CMD: 1, BAD_ARG: 2, BAD_CRC: 3, BAD_VERSION: 4, INVALID: 5, NO_STAGE: 6, FAILED: 7 };
export const ST_TEXT = [
  'OK', 'unknown command', 'bad argument (index/offset/length)', 'CRC mismatch', 'config version mismatch',
  'value out of range', 'nothing staged', 'internal firmware error',
];
export const F_FIX_CRC = 1;
export const G = { ON: 1, EFFECT: 2, SPEED: 4, REACT: 8, HUE: 16, SAT: 32, VAL: 64, FX: 128 };
export const GF_SAVE_LATER = 1;

export const CFG_VERSION = 2;
export const NUM_LAYERS = 4;
export const NUM_POS = 60;
export const CFG_SIZE = 4 + 8 + 32 + NUM_LAYERS * NUM_POS * 4; // 1004
export const OFF_GLOBAL = 4;
export const OFF_LAYERS = 12;
export const OFF_KEYS = 44;
export const LAYER_REACT_INHERIT = 0xff;

export const EFFECTS = ['Solid', 'Breathe', 'Spectrum', 'Swirl', 'Wave', 'Radial', 'Gradient', 'Starlight', 'None (Typing only)'];
export const REACTS = ['Off', 'Fade', 'Ripple', 'Held', 'Color'];
export const KEY_MODES = ['TRANS', 'OFF', 'SOLID', 'EFFECT', 'NO_REACT'];

export class ProtoError extends Error {
  constructor(message, code, status) { super(message); this.name = 'ProtoError'; this.code = code; this.status = status; }
}

/** CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF, no reflection, no xorout. */
export function crc16(bytes, start = 0, end = bytes.length) {
  let crc = 0xffff;
  for (let i = start; i < end; i++) {
    crc ^= bytes[i] << 8;
    for (let b = 0; b < 8; b++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(v) || 0)));

/** Build a 32-byte request report. payload: array/Uint8Array up to 28 bytes. */
export function encodeRequest(cmd, seq, payload = []) {
  if (payload.length > REPORT_SIZE - HDR) throw new RangeError('payload too long');
  const r = new Uint8Array(REPORT_SIZE);
  r[0] = MAGIC; r[1] = cmd; r[2] = seq & 0xff; r[3] = 0;
  r.set(payload, HDR);
  return r;
}

/** Parse a report; returns null if it is not ours (byte 0 != 0x52) or too short. */
export function decodeReply(data) {
  const b = data instanceof Uint8Array ? data : new Uint8Array(data.buffer ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data);
  if (b.length < REPORT_SIZE || b[0] !== MAGIC) return null;
  return { cmd: b[1], seq: b[2], status: b[3], payload: b.slice(HDR, REPORT_SIZE) };
}

export const u16 = (p, o) => p[o] | (p[o + 1] << 8);

export function parseInfo(p) {
  return {
    proto: p[0], cfgVersion: p[1], layers: p[2], positions: p[3], leds: p[4],
    effectCount: p[5], reactCount: p[6], cfgSize: u16(p, 7), brtMax: p[9],
    keyModeCount: p[10], chunkMax: p[11], flags: p[12],
  };
}

export function parseState(p) {
  const mask = (p[0] | (p[1] << 8) | (p[2] << 16) | (p[3] << 24)) >>> 0;
  return { mask, top: p[4], flags: p[5], staged: !!p[6], on: !!(p[5] & 1), idle: !!(p[5] & 2), walk: !!(p[5] & 4) };
}

export function parseGlobalReply(p) {
  return { mask: p[0], on: p[1], effect: p[2], speed: p[3], react: p[4], hue: u16(p, 5), sat: p[7], val: p[8] };
}

/** SET_GLOBAL payload. fields: subset of {on,effect,speed,react,hue,sat,val,fx}. */
export function encodeSetGlobal(fields, saveLater = false) {
  const p = new Uint8Array(18);
  const set = (bit, off, v, wide) => { p[0] |= bit; p[off] = v & 0xff; if (wide) p[off + 1] = (v >> 8) & 0xff; };
  if ('on' in fields) set(G.ON, 1, fields.on ? 1 : 0);
  if ('effect' in fields) set(G.EFFECT, 2, fields.effect);
  if ('speed' in fields) set(G.SPEED, 3, fields.speed);
  if ('react' in fields) set(G.REACT, 4, fields.react);
  if ('hue' in fields) set(G.HUE, 5, fields.hue, true);
  if ('sat' in fields) set(G.SAT, 7, fields.sat);
  if ('val' in fields) set(G.VAL, 8, fields.val);
  if ('fx' in fields) {
    p[0] |= G.FX;
    const fx = fields.fx;
    p[10] = (fx.hue2 || 0) & 0xff;
    p[11] = ((fx.hue2 || 0) >> 8) & 0xff;
    p[12] = clamp(fx.sat2 ?? 100, 0, 100);
    p[13] = (fx.angle || 0) & 0xff;
    p[14] = ((fx.angle || 0) >> 8) & 0xff;
    p[15] = clamp(fx.star_density ?? 5, 1, 10);
    p[16] = clamp(fx.star_mode ?? 0, 0, 2);
  }
  p[9] = saveLater ? GF_SAVE_LATER : 0;
  return p;
}

// ---- key entries ----
export function packKey(e, out = new Uint8Array(4), o = 0) {
  const hue = clamp(e.hue, 0, 359);
  out[o] = (e.mode & 7) | ((hue >> 1) & 0x80);
  out[o + 1] = hue & 0xff;
  out[o + 2] = clamp(e.sat, 0, 100);
  out[o + 3] = clamp(e.val, 0, 100);
  return out;
}
export function unpackKey(b, o = 0) {
  return { mode: b[o] & 7, hue: ((b[o] & 0x80) << 1) | b[o + 1], sat: b[o + 2], val: b[o + 3] };
}

/** SET_KEY payload: layer, pos, 4 B entry. */
export function encodeSetKey(layer, pos, e) {
  const p = new Uint8Array(6); p[0] = layer; p[1] = pos; packKey(e, p, 2); return p;
}

export function packFx(fx, out, o = OFF_LAYERS + 8) {
  out[o] = (fx.hue2 || 0) & 0xff;
  out[o + 1] = ((fx.hue2 || 0) >> 8) & 0xff;
  out[o + 2] = clamp(fx.sat2 ?? 100, 0, 100);
  out[o + 3] = (fx.angle || 0) & 0xff;
  out[o + 4] = ((fx.angle || 0) >> 8) & 0xff;
  out[o + 5] = clamp(fx.star_density ?? 5, 1, 10);
  out[o + 6] = clamp(fx.star_mode ?? 0, 0, 2);
}

export function unpackFx(b, o = OFF_LAYERS + 8) {
  let hue2 = u16(b, o);
  let sat2 = b[o + 2];
  let angle = u16(b, o + 3);
  let star_density = b[o + 5];
  let star_mode = b[o + 6];
  if (star_density === 0 || star_density > 10) star_density = 5;
  if (star_mode > 2) star_mode = 0;
  if (angle >= 360) angle = 0;
  if (hue2 >= 360) hue2 = 180;
  if (sat2 > 100) sat2 = 100;
  return { hue2, sat2, angle, star_density, star_mode };
}

// ---- config image ----
export function defaultConfig() {
  const keys = [];
  for (let l = 0; l < NUM_LAYERS; l++) keys.push(Array.from({ length: NUM_POS }, () => ({ mode: 0, hue: 0, sat: 100, val: 100 })));
  return {
    version: CFG_VERSION, reserved: 0,
    g: { on: 1, effect: 0, speed: 3, react: 0, hue: 0, sat: 100, val: 20 },
    fx: { hue2: 180, sat2: 100, angle: 0, star_density: 5, star_mode: 0 },
    layers: Array.from({ length: NUM_LAYERS }, () => ({ react: LAYER_REACT_INHERIT, decay: 0, ripple_speed: 0, flags: 0, hue: 0, sat: 100, val: 0 })),
    keys,
  };
}

export function packGlobal(g, out, o = OFF_GLOBAL) {
  out[o] = g.on ? 1 : 0; out[o + 1] = g.effect; out[o + 2] = g.speed; out[o + 3] = g.react;
  out[o + 4] = g.hue & 0xff; out[o + 5] = (g.hue >> 8) & 0xff; out[o + 6] = g.sat; out[o + 7] = g.val;
}
export function packLayer(l, out, o) {
  out[o] = l.react; out[o + 1] = l.decay; out[o + 2] = l.ripple_speed; out[o + 3] = l.flags;
  out[o + 4] = l.hue & 0xff; out[o + 5] = (l.hue >> 8) & 0xff; out[o + 6] = l.sat; out[o + 7] = l.val;
}

/** Serialize to the 1004-byte image. Sets version and CRC unless opts.keepHeader. */
export function packConfig(cfg, opts = {}) {
  const out = new Uint8Array(CFG_SIZE);
  packGlobal(cfg.g, out);
  if (cfg.layers?.[0]) packLayer(cfg.layers[0], out, OFF_LAYERS);
  if (cfg.fx) packFx(cfg.fx, out);
  for (let l = 0; l < NUM_LAYERS; l++)
    for (let p = 0; p < NUM_POS; p++) packKey(cfg.keys[l][p], out, OFF_KEYS + (l * NUM_POS + p) * 4);
  out[0] = opts.keepHeader ? cfg.version : CFG_VERSION;
  out[1] = opts.keepHeader ? cfg.reserved : 0;
  const crc = crc16(out, 4, CFG_SIZE);
  out[2] = crc & 0xff; out[3] = crc >> 8;
  return out;
}

export function checkConfigImage(b) {
  if (b.length !== CFG_SIZE) return `bad size ${b.length}, expected ${CFG_SIZE}`;
  if (b[0] !== CFG_VERSION) return `config version ${b[0]}, expected ${CFG_VERSION}`;
  const crc = crc16(b, 4, CFG_SIZE);
  if (crc !== u16(b, 2)) return `CRC mismatch (stored 0x${u16(b, 2).toString(16)}, computed 0x${crc.toString(16)})`;
  return null;
}

export function unpackConfig(b) {
  if (b.length !== CFG_SIZE) throw new RangeError(`config must be ${CFG_SIZE} bytes`);
  const cfg = {
    version: b[0], reserved: b[1],
    g: { on: b[4], effect: b[5], speed: b[6], react: b[7], hue: u16(b, 8), sat: b[10], val: b[11] },
    fx: unpackFx(b),
    layers: [
      { react: b[OFF_LAYERS], decay: b[OFF_LAYERS + 1], ripple_speed: b[OFF_LAYERS + 2], flags: b[OFF_LAYERS + 3], hue: u16(b, OFF_LAYERS + 4), sat: b[OFF_LAYERS + 6], val: b[OFF_LAYERS + 7] },
      { react: LAYER_REACT_INHERIT, decay: 0, ripple_speed: 0, flags: 0, hue: 0, sat: 100, val: 0 },
      { react: LAYER_REACT_INHERIT, decay: 0, ripple_speed: 0, flags: 0, hue: 0, sat: 100, val: 0 },
      { react: LAYER_REACT_INHERIT, decay: 0, ripple_speed: 0, flags: 0, hue: 0, sat: 100, val: 0 },
    ],
    keys: [],
  };
  for (let l = 0; l < NUM_LAYERS; l++) {
    const row = [];
    for (let p = 0; p < NUM_POS; p++) row.push(unpackKey(b, OFF_KEYS + (l * NUM_POS + p) * 4));
    cfg.keys.push(row);
  }
  return cfg;
}

/** Split [0,total) into [{offset, n}] of at most `max` bytes. */
export function chunkPlan(total = CFG_SIZE, max = CHUNK_MAX) {
  const out = [];
  for (let o = 0; o < total; o += max) out.push({ offset: o, n: Math.min(max, total - o) });
  return out;
}

export function encodeSetChunk(offset, data) {
  const p = new Uint8Array(3 + data.length);
  p[0] = offset & 0xff; p[1] = offset >> 8; p[2] = data.length; p.set(data, 3);
  return p;
}

// ---- JSON import/export ----
export function configToJson(cfg) {
  return { format: 'rgbpk-config', version: cfg.version, global: cfg.g, layers: cfg.layers, keys: cfg.keys };
}
export function configFromJson(j) {
  if (!j || j.format !== 'rgbpk-config') throw new Error('Not an rgbpk config file');
  const cfg = defaultConfig();
  const pick = (dst, src, keys) => { for (const k of keys) if (src && Number.isFinite(src[k])) dst[k] = src[k]; };
  pick(cfg.g, j.global, ['on', 'effect', 'speed', 'react', 'hue', 'sat', 'val']);
  if (!Array.isArray(j.layers) || j.layers.length !== NUM_LAYERS) throw new Error('layers: expected 4 entries');
  if (!Array.isArray(j.keys) || j.keys.length !== NUM_LAYERS) throw new Error('keys: expected 4 layers');
  for (let l = 0; l < NUM_LAYERS; l++) {
    pick(cfg.layers[l], j.layers[l], ['react', 'decay', 'ripple_speed', 'flags', 'hue', 'sat', 'val']);
    if (!Array.isArray(j.keys[l]) || j.keys[l].length !== NUM_POS) throw new Error(`keys[${l}]: expected 60 entries`);
    for (let p = 0; p < NUM_POS; p++) pick(cfg.keys[l][p], j.keys[l][p], ['mode', 'hue', 'sat', 'val']);
  }
  // range check by round trip
  for (const row of cfg.keys) for (const k of row) {
    if (k.mode < 0 || k.mode > 4 || k.hue < 0 || k.hue > 359 || k.sat < 0 || k.sat > 100 || k.val < 0 || k.val > 100) throw new Error('key value out of range');
  }
  return cfg;
}

// ---- hsv ----
export function hsvToRgb(h, s, v) { // h 0..359, s,v 0..100
  s /= 100; v /= 100;
  const f = (n) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return [Math.round(f(5) * 255), Math.round(f(3) * 255), Math.round(f(1) * 255)];
}

// ---- WebHID transport ----
export const hidSupported = () => typeof navigator !== 'undefined' && 'hid' in navigator;
export const isRgbpkDevice = (d) => d.collections?.some((c) => c.usagePage === USAGE_PAGE && c.usage === USAGE);

export class Device {
  /** hid: a HIDDevice (or a mock with open/close/sendReport/addEventListener). */
  constructor(hid, { timeout = 700, retries = 3 } = {}) {
    this.hid = hid; this.timeout = timeout; this.retries = retries;
    this.seq = Math.floor(Math.random() * 256);
    this.pending = null; this.chain = Promise.resolve(); this.busy = 0;
    this.onReport = (ev) => {
      const r = decodeReply(new Uint8Array(ev.data.buffer.slice(ev.data.byteOffset, ev.data.byteOffset + ev.data.byteLength)));
      if (!r) return; // zmk-hid-host or other traffic
      const p = this.pending;
      if (p && p.cmd === r.cmd && p.seq === r.seq) p.resolve(r);
    };
  }
  async open() {
    if (!this.hid.opened) {
      try { await this.hid.open(); } catch (e) { throw new ProtoError(openHint(e), 'open'); }
    }
    this.hid.addEventListener('inputreport', this.onReport);
  }
  async close() {
    this.hid.removeEventListener('inputreport', this.onReport);
    try { await this.hid.close(); } catch { /* ignore */ }
  }
  /** Requests are serialized (firmware wants one at a time). Resolves to {status, payload}; throws ProtoError on non-OK. */
  request(cmd, payload = [], opts = {}) {
    this.busy++;
    const run = () => this._do(cmd, payload, opts);
    const res = this.chain.then(run, run);
    this.chain = res.catch(() => {});
    return res.finally(() => { this.busy--; });
  }
  async _do(cmd, payload, { allowStatus = [], timeout = this.timeout, retries = this.retries } = {}) {
    const seq = this.seq = (this.seq + 1) & 0xff;
    const report = encodeRequest(cmd, seq, payload);
    let lastErr;
    for (let attempt = 0; attempt < retries; attempt++) {
      const wait = new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new ProtoError(`No reply to command 0x${cmd.toString(16)} (try ${attempt + 1}/${retries})`, 'timeout')), timeout);
        this.pending = { cmd, seq, resolve: (r) => { clearTimeout(t); resolve(r); } };
        this._rej = (e) => { clearTimeout(t); reject(e); };
      });
      wait.catch(() => {});
      try { await this.hid.sendReport(0, report); } catch (e) {
        this.pending = null;
        throw new ProtoError(sendHint(e), 'send');
      }
      try {
        const r = await wait; this.pending = null;
        if (r.status !== ST.OK && !allowStatus.includes(r.status))
          throw new ProtoError(`Keyboard rejected command: ${ST_TEXT[r.status] ?? 'status ' + r.status}`, 'status', r.status);
        return r;
      } catch (e) {
        this.pending = null;
        if (e.code !== 'timeout') throw e;
        lastErr = e;
      }
    }
    throw new ProtoError(`${lastErr.message}. Is the keyboard running the rgbpk firmware and not used by another app?`, 'timeout');
  }
  async info() { return parseInfo((await this.request(CMD.INFO)).payload); }
  async state() { return parseState((await this.request(CMD.GET_STATE, [], { retries: 1, timeout: 500 })).payload); }
  async readConfig(onProgress, info) {
    const total = info?.cfgSize ?? CFG_SIZE;
    const maxRetries = 2;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const buf = new Uint8Array(total);
      const plan = chunkPlan(total, Math.min(CHUNK_MAX, info?.chunkMax || CHUNK_MAX));
      let i = 0;
      for (const c of plan) {
        const r = (await this.request(CMD.GET_CHUNK, [c.offset & 0xff, c.offset >> 8, c.n])).payload;
        const off = u16(r, 0), n = r[2];
        if (off !== c.offset || n !== c.n) throw new ProtoError(`Unexpected chunk reply (offset ${off}, n ${n})`, 'chunk');
        buf.set(r.slice(3, 3 + n), off);
        onProgress?.(++i / plan.length);
      }
      const err = checkConfigImage(buf);
      if (!err) return buf;
      if (attempt + 1 < maxRetries) {
        await new Promise((res) => setTimeout(res, 80));
        continue;
      }
      // If version matches but CRC differs (e.g. keypress/edit occurred during download),
      // repair CRC on the downloaded image so the user can continue configuring seamlessly.
      if (buf[0] === CFG_VERSION) {
        console.warn('Config read: CRC auto-repaired from live state', err);
        const crc = crc16(buf, 4, total);
        buf[2] = crc & 0xff; buf[3] = (crc >> 8) & 0xff;
        return buf;
      }
      const hex = Array.from(buf, (x) => x.toString(16).padStart(2, '0')).join('');
      const alt = [[0, total], [2, total], [4, total - 1], [4, total]].map(([a, e]) => `${a}-${e}:0x${crc16(buf, a, e).toString(16)}`).join(' ');
      console.error('rgbpk config image', err, alt, hex);
      globalThis.rgbpkBadImage = buf;
      throw new ProtoError('Config read failed: ' + err + ' (image dumped to console)', 'crc');
    }
  }
  /** Upload bytes [offset, offset+len) of an image via SET_CHUNK. Does not apply. */
  async writeRange(image, offset, len, onProgress) {
    const plan = chunkPlan(len, CHUNK_MAX).map((c) => ({ offset: offset + c.offset, n: c.n }));
    let i = 0;
    for (const c of plan) {
      await this.request(CMD.SET_CHUNK, encodeSetChunk(c.offset, image.subarray(c.offset, c.offset + c.n)));
      onProgress?.(++i / plan.length);
    }
  }
}

export function openHint(e) {
  const m = String(e?.message || e);
  if (/already|busy|NotAllowed|access denied|Failed to open/i.test(m) || e?.name === 'NotAllowedError' || e?.name === 'InvalidStateError')
    return 'Could not open the keyboard: another app (or browser tab) is probably holding the HID interface. Close it and retry. (' + m + ')';
  return 'Could not open the keyboard: ' + m;
}
export function sendHint(e) {
  return 'Could not talk to the keyboard (unplugged or held by another app?): ' + (e?.message || e);
}
