// ZMK Studio RPC client over Web Serial (or any {write(bytes), onData, onClose} transport).
import { fV, fB, fS, msg, parse, first, str, zig, unzig, frame, createDeframer } from './pb.js';

const SUB = { core: 3, behaviors: 4, keymap: 5 };
export const ERR = ['generic error', 'locked: press the Studio-unlock key on the keyboard', 'RPC not found', 'bad request', 'bad response'];

export class StudioError extends Error { constructor(m, code) { super(m); this.code = code; } }

export class Studio {
  constructor(transport) {
    this.t = transport; this.id = 1; this.pending = new Map(); this.onNotify = () => {}; this.onClose = () => {};
    this.deframe = createDeframer((f) => this._frame(f));
    transport.onData = (b) => this.deframe(b);
    transport.onClose = () => { for (const p of this.pending.values()) p.reject(new StudioError('Disconnected')); this.pending.clear(); this.onClose(); };
  }
  _frame(f) {
    let r; try { r = parse(f); } catch { return; }
    if (r.has(2)) { // notification
      const n = parse(r.get(2)[0]);
      if (n.has(2)) this.onNotify({ type: 'lock', locked: first(parse(n.get(2)[0]), 1, 0) === 0 });
      if (n.has(5)) this.onNotify({ type: 'unsaved', unsaved: !!first(parse(n.get(5)[0]), 1, 0) });
      return;
    }
    if (!r.has(1)) return;
    const rr = parse(r.get(1)[0]), id = first(rr, 1, 0), p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id); clearTimeout(p.timer);
    if (rr.has(2)) { // meta: error or no_response
      const m = parse(rr.get(2)[0]);
      if (m.has(2)) { const c = m.get(2)[0]; return p.reject(new StudioError(ERR[c] || 'error ' + c, c)); }
      return p.resolve(null);
    }
    for (const f2 of Object.values(SUB)) if (rr.has(f2)) return p.resolve(parse(rr.get(f2)[0]));
    p.resolve(null);
  }
  /** Send one request; body: undefined = bool true, number = varint, Uint8Array = sub-message. */
  call(sub, field, body, timeout = 4000) {
    const id = this.id++; if (this.id > 0x7fffffff) this.id = 1;
    const inner = body === undefined ? msg(fV(field, 1)) : typeof body === 'number' ? msg(fV(field, body)) : msg(fB(field, body));
    const req = msg(fV(1, id), fB(SUB[sub], inner));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new StudioError('Keyboard did not answer (timeout)')); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.t.write(frame(req)).catch((e) => { clearTimeout(timer); this.pending.delete(id); reject(e); });
    });
  }

  // ---- core ----
  async deviceInfo() { const r = await this.call('core', 1); const m = parse(r.get(1)[0]); return { name: str(first(m, 1)), serial: first(m, 2) }; }
  async isLocked() { const r = await this.call('core', 2); return first(r, 2, 0) === 0; }

  // ---- behaviours ----
  async behaviors() {
    const r = await this.call('behaviors', 1);
    const lb = r.has(1) ? parse(r.get(1)[0]) : new Map(); const ids = [];
    for (const v of lb.get(1) || []) {
      if (typeof v === 'number') ids.push(v);
      else { let i = 0; while (i < v.length) { let x = 0, mul = 1, b; do { b = v[i++]; x += (b & 127) * mul; mul *= 128; } while (b & 128); ids.push(x); } } // packed
    }
    const out = new Map();
    for (const id of ids) out.set(id, await this.behaviorDetails(id));
    return out;
  }
  async behaviorDetails(id) {
    const r = await this.call('behaviors', 2, msg(fV(1, id)));
    const d = parse(r.get(2)[0]);
    return { id: first(d, 1, 0), name: str(first(d, 2)), sets: (d.get(3) || []).map(decodeParamSet) };
  }

  // ---- keymap ----
  async keymap() { const r = await this.call('keymap', 1); return decodeKeymap(r.get(1)[0]); }
  async physicalLayout() {
    const r = await this.call('keymap', 6); const m = parse(r.get(6)[0]);
    const active = first(m, 1, 0);
    const layouts = (m.get(2) || []).map((lb) => {
      const l = parse(lb);
      return { name: str(first(l, 1)), keys: (l.get(2) || []).map((kb) => { const k = parse(kb); const s = (f) => unzig(first(k, f, 0)); return { w: s(1), h: s(2), x: s(3), y: s(4), r: s(5), rx: s(6), ry: s(7) }; }) };
    });
    return layouts[active] || layouts[0];
  }
  async setBinding(layerId, pos, b) {
    const bb = msg(fV(1, zig(b.id)), b.p1 ? fV(2, b.p1) : [], b.p2 ? fV(3, b.p2) : []);
    const r = await this.call('keymap', 2, msg(fV(1, layerId), fV(2, pos), fB(3, bb)));
    const code = first(r, 2, 0);
    if (code) throw new StudioError(['', 'invalid key position', 'invalid behaviour', 'invalid parameters'][code] || 'rejected', code);
  }
  async unsaved() { const r = await this.call('keymap', 3); return !!first(r, 3, 0); }
  async save() {
    const r = await this.call('keymap', 4); const m = parse(r.get(4)[0]);
    if (m.has(2)) throw new StudioError(['', 'save failed', 'saving is not supported', 'no space left'][m.get(2)[0]] || 'save failed');
  }
  async discard() { await this.call('keymap', 5); }
  async renameLayer(layerId, name) {
    const r = await this.call('keymap', 12, msg(fV(1, layerId), fS(2, name)));
    if (first(r, 12, 0)) throw new StudioError('rename failed');
  }
  async addLayer() {
    const r = await this.call('keymap', 9, msg()); const m = parse(r.get(9)[0]);
    if (m.has(2)) throw new StudioError(['', 'could not add layer', 'no space for more layers'][m.get(2)[0]] || 'add failed');
    const ok = parse(m.get(1)[0]);
    return { index: first(ok, 1, 0), layer: decodeLayer(first(ok, 2, new Uint8Array())) };
  }
  async removeLayer(index) {
    const r = await this.call('keymap', 10, msg(fV(1, index))); const m = parse(r.get(10)[0]);
    if (m.has(2)) throw new StudioError('could not remove layer');
  }
  async moveLayer(from, to) {
    const r = await this.call('keymap', 8, msg(fV(1, from), fV(2, to))); const m = parse(r.get(8)[0]);
    if (m.has(2)) throw new StudioError('could not move layer');
    return decodeKeymap(m.get(1)[0]);
  }
}

// plain int32 varint (negatives arrive as huge unsigned numbers)
const i32 = (v) => (v > 0x7fffffff ? v - 2 ** 32 : v);

function decodeParamSet(buf) {
  const s = parse(buf);
  const d = (list) => (list || []).map((b) => {
    const m = parse(b), name = str(first(m, 1));
    if (m.has(3)) return { name, kind: 'const', value: m.get(3)[0] };
    if (m.has(4)) { const r = parse(m.get(4)[0]); return { name, kind: 'range', min: i32(first(r, 1, 0)), max: i32(first(r, 2, 0)) }; }
    if (m.has(5)) { const r = parse(m.get(5)[0]); return { name, kind: 'hid', kbMax: first(r, 1, 0), consMax: first(r, 2, 0) }; }
    if (m.has(6)) return { name, kind: 'layer' };
    return { name, kind: 'nil' };
  });
  return { p1: d(s.get(1)), p2: d(s.get(2)) };
}

export function decodeLayer(buf) {
  const l = parse(buf);
  return {
    id: first(l, 1, 0), name: str(first(l, 2)),
    bindings: (l.get(3) || []).map((bb) => { const b = parse(bb); return { id: unzig(first(b, 1, 0)), p1: first(b, 2, 0), p2: first(b, 3, 0) }; }),
  };
}
export function decodeKeymap(buf) {
  const m = parse(buf);
  return { layers: (m.get(1) || []).map(decodeLayer), available: first(m, 2, 0), maxName: first(m, 3, 20) };
}

// ---- Web Serial transport ----
export async function openSerial() {
  const port = await navigator.serial.requestPort();
  await port.open({ baudRate: 115200 });
  const t = { onData: () => {}, onClose: () => {}, port };
  const writer = port.writable.getWriter();
  const reader = port.readable.getReader();
  let closed = false;
  t.write = (b) => writer.write(b);
  t.close = async () => { closed = true; try { await reader.cancel(); } catch {} try { writer.releaseLock(); } catch {} try { await port.close(); } catch {} };
  (async () => {
    try { for (;;) { const { value, done } = await reader.read(); if (done) break; if (value) t.onData(value); } } catch {}
    if (!closed) t.onClose();
  })();
  return t;
}
