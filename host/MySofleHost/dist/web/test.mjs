// Run: node web/test.mjs
import assert from 'node:assert/strict';
import * as P from './proto.js';
import { runAll } from './selftest.js';
import { POS2LED, NO_LED } from './layout.js';

assert.equal(P.crc16(Buffer.from('123456789')), 0x29b1);
assert.equal(P.CFG_SIZE, 1004);
assert.equal(P.chunkPlan().length, 63);
const cfg = P.defaultConfig();
cfg.keys[0][59] = { mode: 4, hue: 359, sat: 100, val: 100 };
const img = P.packConfig(cfg);
assert.equal(P.checkConfigImage(img), null);
assert.deepEqual(P.unpackConfig(img), cfg);
assert.equal(img[44 + 59 * 4], 0x84);

// verify 58 positions have LEDs and 2 encoders have NO_LED
assert.equal(POS2LED.length, 60);
assert.equal(POS2LED.filter((p) => p !== NO_LED).length, 58);
assert.equal(POS2LED[42], NO_LED);
assert.equal(POS2LED[43], NO_LED);

import { runStudioTests } from './studio/test.mjs';
console.log(await runStudioTests());
const results = await runAll();
for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.ok ? '' : ' -> ' + r.error}`);
assert.ok(results.every((r) => r.ok), 'self tests failed');
console.log(`\n${results.length} self tests + direct asserts passed`);
