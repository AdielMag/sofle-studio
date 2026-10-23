import assert from 'node:assert/strict';
import { varint, zig, unzig, msg, fV, fB, fS, parse, first, frame, createDeframer } from './pb.js';
import { Studio, decodeKeymap } from './client.js';

const reqOf = (b) => { const r = []; createDeframer((f) => r.push(parse(f)))(b); return r[0]; };

export async function runStudioTests() {
  assert.deepEqual(varint(300), [0xac, 0x02]);
  assert.equal(unzig(zig(-5)), -5); assert.equal(zig(1), 2); assert.equal(zig(-1), 1);
  const m = parse(msg(fV(1, 150), fS(2, 'hi'), fB(3, [1, 2])));
  assert.equal(first(m, 1), 150); assert.equal(Buffer.from(first(m, 2)).toString(), 'hi');

  // framing with escaped control bytes
  const payload = Uint8Array.from([1, 0xab, 0xac, 0xad, 9]); const got = [];
  createDeframer((f) => got.push([...f]))(Uint8Array.from([0, 0, ...frame(payload)]));
  assert.deepEqual(got[0], [...payload]);

  // keymap decode
  const bind = (id, p1, p2) => fB(3, msg(fV(1, zig(id)), fV(2, p1), fV(3, p2)));
  const layer = fB(1, msg(fV(1, 7), fS(2, 'Base'), bind(3, 0x70004, 0), bind(-1, 0, 0)));
  const km = decodeKeymap(msg(layer, fV(2, 2), fV(3, 12)));
  assert.equal(km.layers[0].name, 'Base'); assert.equal(km.layers[0].bindings[0].p1, 0x70004);
  assert.equal(km.layers[0].bindings[1].id, -1); assert.equal(km.available, 2);

  // request/response over a mock device: get_lock_state -> UNLOCKED
  const t = { onData() {}, onClose() {}, async write(b) {
    const id = first(reqOf(b), 1);
    const inner = reqOf(b).get(3)[0]; assert.deepEqual([...inner], [0x10, 1]); // core.get_lock_state = field 2 bool
    setTimeout(() => t.onData(frame(msg(fB(1, msg(fV(1, id), fB(3, msg(fV(2, 1)))))))), 0);
  } };
  assert.equal(await new Studio(t).isLocked(), false);

  // meta error -> rejected with unlock hint
  const t2 = { onData() {}, onClose() {}, async write(b) {
    const id = first(reqOf(b), 1);
    setTimeout(() => t2.onData(frame(msg(fB(1, msg(fV(1, id), fB(2, msg(fV(2, 1)))))))), 0);
  } };
  await assert.rejects(new Studio(t2).isLocked(), /locked/);

  // set_layer_binding request bytes
  let sent;
  const t3 = { onData() {}, onClose() {}, async write(b) {
    sent = reqOf(b); const id = first(sent, 1);
    setTimeout(() => t3.onData(frame(msg(fB(1, msg(fV(1, id), fB(5, msg(fV(2, 0)))))))), 0);
  } };
  await new Studio(t3).setBinding(2, 14, { id: 5, p1: 0x70004, p2: 0 });
  const kr = parse(parse(sent.get(5)[0]).get(2)[0]);
  assert.equal(first(kr, 1), 2); assert.equal(first(kr, 2), 14);
  assert.equal(first(parse(first(kr, 3)), 1), zig(5));
  return 'studio codec ok';
}
