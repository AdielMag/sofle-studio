# rgbpk raw HID protocol (v1)

Transport: the zmk-nice-oled raw HID interface, usage page `0xFF60`, usage `0x61`, 32-byte input and output reports, **no report id** (WebHID `sendReport(0, data)`; replies arrive in `inputreport` with `reportId 0`). Works over USB; over BLE the same GATT report is used (reply goes to the active profile). Constants: `include/rgbpk/proto.h`.

Reports whose byte 0 is not `0x52` belong to zmk-hid-host (`0xAA..0xAF` language/time/volume) and are ignored by rgbpk, so both can run at once. nice-oled also ignores `0x52`. Only one app can open the HID device at a time on some OSes; test on Windows.

## Frame
All multi-byte values little endian. Reports are always 32 bytes, unused bytes 0.

| Byte | Request | Reply |
|---|---|---|
| 0 | `0x52` | `0x52` |
| 1 | cmd | same cmd |
| 2 | seq (host-chosen, any value) | same seq |
| 3 | 0 | status |
| 4..31 | payload (28 B) | payload |

Match replies on `cmd + seq`; retry a request with the same seq on timeout (every command is idempotent). The firmware queues 4 requests; send one at a time. Request handling runs on the ZMK low-priority work queue (about one frame, ~33 ms, worst case).

Status: `0` OK, `1` BAD_CMD, `2` BAD_ARG (index/offset/length), `3` BAD_CRC, `4` BAD_VERSION, `5` INVALID (a value out of range), `6` NO_STAGE, `7` FAILED (internal).

## Commands
Payload offsets below are relative to byte 4 (`p[0]` = report byte 4).

| cmd | name | request payload | reply payload |
|---|---|---|---|
| `01` | INFO | - | `p0` proto version (1), `p1` cfg version (2), `p2` layers (4), `p3` positions (60), `p4` LEDs (29), `p5` effect count (8), `p6` react count (5), `p7..8` cfg size u16 (1004), `p9` BRT_MAX (40), `p10` key mode count (5), `p11` chunk max (24), `p12` state flags |
| `02` | GET_CHUNK | `p0..1` offset u16, `p2` max bytes (0 = 24, capped at 24) | `p0..1` offset, `p2` n, `p3..3+n-1` data |
| `03` | SET_CHUNK | `p0..1` offset u16, `p2` n (1..24), `p3..` data | `p0..1` offset, `p2` n |
| `04` | PREVIEW | `p0` flags (bit0 `FIX_CRC`) | - |
| `05` | SAVE | `p0` flags (bit0 `FIX_CRC`) | - |
| `06` | SET_GLOBAL | `p0` mask, `p1` on, `p2` effect, `p3` speed, `p4` react, `p5..6` hue u16, `p7` sat, `p8` val, `p9` flags (bit0 save later) | `p0` mask, then the resulting global: `p1` on, `p2` effect, `p3` speed, `p4` react, `p5..6` hue, `p7` sat, `p8` val |
| `07` | DEFAULTS | - | - |
| `08` | GET_STATE | - | `p0..3` layer mask u32 (bit n = layer n active, BASE always set), `p4` top active layer, `p5` state flags, `p6` staged edits pending (1/0) |
| `09` | SET_KEY | `p0` layer, `p1` pos, `p2..5` packed key entry | `p0` layer, `p1` pos |
| `0A` | WALK | - | - (starts the LED walk test) |

State flags: bit0 LEDs on, bit1 idle-blanked, bit2 walk test running.
SET_GLOBAL mask bits: `01` on, `02` effect, `04` speed, `08` react, `10` hue, `20` sat, `40` val. Only masked fields are changed, the others keep their value. `val` is clamped to BRT_MAX (40); the reply shows the applied value. `p9` bit0 also schedules the debounced 5 s save.

## Config image (what GET/SET_CHUNK address)
The packed `struct rgbpk_cfg`, exactly as stored in flash (`include/rgbpk/config.h`), 1004 bytes:

| Offset | Size | Field |
|---|---|---|
| 0 | 1 | version (= 2) |
| 1 | 1 | reserved (0) |
| 2 | 2 | CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF, no reflection, no xorout) over bytes 4..1003 |
| 4 | 8 | global: on, effect, speed, react, hue u16, sat, val |
| 12 | 32 | 4 x layer: react (0xFF = inherit), decay, ripple_speed, flags, hue u16, sat, val |
| 44 | 960 | keys[layer 0..3][pos 0..59][4 B] |

Key entry (4 B): `b0` bits0-2 mode (0 TRANS, 1 OFF, 2 SOLID, 3 EFFECT, 4 NO_REACT), bit7 = hue bit 8; `b1` hue low 8 bits; `b2` sat 0..100; `b3` val 0..100. Hue 0..359. Enums: effect 0 solid, 1 breathe, 2 spectrum, 3 swirl, 4 wave, 5 radial, 6 gradient, 7 starlight; react 0 off, 1 fade, 2 ripple, 3 held, 4 color.

Chunking: 1004 B = 42 chunks of 24 B (last chunk 20 B).

## Flows
**Read all:** INFO; GET_CHUNK offset 0, 24, 48, ... (the chunk at offset 0 snapshots the live config so the whole download is one consistent image); check CRC.

**Edit all + preview/save:** SET_CHUNK x42 (the first SET_CHUNK copies the live config into a staging buffer, so partial uploads patch the live image); then PREVIEW (apply live, not saved) or SAVE (apply + write flash). Validation on apply: version, CRC (or set `FIX_CRC` to let the firmware recompute version+CRC, handy after patching a few bytes), enum/range checks; on error the live config is untouched, the staged data is kept (fix with another SET_CHUNK and retry) and the status says why. On success staging is cleared. `g.val` is clamped to BRT_MAX; key/layer `val` above BRT_MAX is accepted and clamped when rendered.

**Live editing:** SET_GLOBAL for the quick controls, SET_KEY for one key (applies live to the running config at once, not saved; it does not touch staged data, so don't mix it with an unapplied SET_CHUNK upload). SAVE with nothing staged just saves the live config. PREVIEW with nothing staged returns NO_STAGE.

**UI state:** poll GET_STATE (e.g. 4 Hz) for the active layer / layer mask. The firmware never sends unsolicited reports.

**Reset:** DEFAULTS restores factory colors and saves.

## Split sync (Phase 4: left/central -> right/peripheral)
Not a HID protocol; internal. The central calls `zmk_split_central_invoke_behavior(0, &rgbpk, ...)` (pressed) with reserved `&rgbpk` params: `param1` bits 31..24 = `0xC0 | cmd` (normal `&rgbpk` params are < 64), 8 data bytes = `param1` low 24 bits + `param2` (LE) + the position byte (BLE keeps 8 bits). The peripheral's `behavior_rgbpk.c` routes them to `rgbpk_split_rx()` (`src/split_sync.c`). The BLE write is unacked and the central queue holds 5 messages, so sends are paced (15 ms) and repeated.

| cmd | data | when |
|---|---|---|
| `0 STATE` | w0 = on, react<<1, layer mask<<4; w1 = effect, speed<<4; w2-3 hue; w4 sat; w5 val | global change, connect (sent twice, 250 ms apart) |
| `1 LAYER` | w0 = layer mask | layer change (sent twice) |
| `2 BEGIN` | w0 = generation | start of an image; generation seeded from uptime (nonzero); BEGIN repeated at the start of pass 2 |
| `3 CHUNK` | w0 generation, w1 index (0..84), w2-7 data | 2 passes, 800 ms apart |
| `4 SAVE` | - | after the central saved: peripheral persists too |

Image = crc16 (CRC-16/CCITT-FALSE of the rest) + global (8 B) + layer cfg (32 B) + key entries of the 29 right-half positions (layer-major) = 506 B / 85 chunks. The peripheral keeps a chunk bitmap per generation, so a chunk lost in pass 1 is filled by pass 2; when complete and the CRC matches it merges the data into its config and applies it live (not persisted until `SAVE`). Triggers: web edits (`apply`/`set_key`/`set_layer`/`set_global`/defaults, 300 ms debounce), layer change, save, and the central's BLE connection to the peripheral (first messages at +0.8 s, image at +1.0 s, whole sequence repeated at +5 s). Left-half key presses never ripple on the right half and vice versa (local only). Until the first sync the peripheral runs on its defaults (same as the central's).
