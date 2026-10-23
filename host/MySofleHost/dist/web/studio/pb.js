// Minimal protobuf wire codec: just what ZMK Studio messages need.
const te = new TextEncoder(), td = new TextDecoder();

export function varint(n) {
  const o = [];
  while (n >= 128) { o.push((n % 128) | 128); n = Math.floor(n / 128); }
  o.push(n);
  return o;
}
export const zig = (n) => ((n << 1) ^ (n >> 31)) >>> 0;
export const unzig = (v) => (v >>> 1) ^ -(v & 1);

const cat = (parts) => { const o = []; for (const p of parts) for (const b of p) o.push(b); return Uint8Array.from(o); };
// field encoders; each returns an array of bytes
export const fV = (f, n) => [...varint(f * 8), ...varint(n)];
export const fB = (f, bytes) => [...varint(f * 8 + 2), ...varint(bytes.length), ...bytes];
export const fS = (f, s) => fB(f, te.encode(s));
export const msg = (...parts) => cat(parts);

/** Parse a message into { field -> [values] }; varints as numbers, length-delimited as Uint8Array. */
export function parse(buf) {
  const m = new Map(); let i = 0;
  const rv = () => { let r = 0, mul = 1, b; do { if (i >= buf.length) throw new Error('truncated varint'); b = buf[i++]; r += (b & 127) * mul; mul *= 128; } while (b & 128); return r; };
  while (i < buf.length) {
    const tag = rv(), f = Math.floor(tag / 8), w = tag & 7; let v;
    if (w === 0) v = rv();
    else if (w === 2) { const n = rv(); if (i + n > buf.length) throw new Error('truncated field'); v = buf.subarray(i, i + n); i += n; }
    else if (w === 5) { v = buf.subarray(i, i + 4); i += 4; }
    else if (w === 1) { v = buf.subarray(i, i + 8); i += 8; }
    else throw new Error('bad wire type ' + w);
    if (!m.has(f)) m.set(f, []);
    m.get(f).push(v);
  }
  return m;
}
export const first = (m, f, d) => (m.has(f) ? m.get(f)[0] : d);
export const str = (b) => (b ? td.decode(b) : '');

// ---- Studio framing (SOF/ESC/EOF) ----
export const SOF = 0xab, ESC = 0xac, EOF = 0xad;
export function frame(payload) {
  const o = [SOF];
  for (const b of payload) { if (b === SOF || b === ESC || b === EOF) o.push(ESC); o.push(b); }
  o.push(EOF);
  return Uint8Array.from(o);
}
/** Incremental de-framer: push(bytes) calls onFrame(Uint8Array) per complete frame. */
export function createDeframer(onFrame) {
  let st = 0, cur = [];
  return (bytes) => {
    for (const b of bytes) {
      if (st === 0) { if (b === SOF) { st = 1; cur = []; } }
      else if (st === 2) { cur.push(b); st = 1; }
      else if (b === ESC) st = 2;
      else if (b === EOF) { st = 0; onFrame(Uint8Array.from(cur)); }
      else if (b === SOF) cur = [];
      else cur.push(b);
    }
  };
}
