# Keymap editor (ZMK Studio RPC over Web Serial)

The web app's **Keymap** tab replaces the ZMK Studio web app. It speaks the same protocol
(`zmkfirmware/zmk-studio-messages`) over the keyboard's USB CDC-ACM port.

- Firmware: already built with `snippet: studio-rpc-usb-uart` + `CONFIG_ZMK_STUDIO=y` (see `build.yaml`). No reflash needed.
- Framing: `0xAB` SOF, `0xAD` EOF, `0xAC` escapes a literal SOF/ESC/EOF byte (`web/studio/pb.js`).
- Messages: hand-rolled protobuf subset (`pb.js`), RPC client (`client.js`): core (device info, lock state),
  behaviors (list, details), keymap (get, set binding, save, discard, layers add/remove/move/rename, physical layout).
- Locked state: edits are refused until the `&studio_unlock` key is pressed (LOWER layer "Studio" key).
- Edits are live in RAM; **Save keymap** persists to flash, **Discard** reverts.
- RGB (raw HID) and keymap (serial) are independent connections. Close other Studio tabs: the port has one owner.
- Demo: `?demo&view=keymap` uses `web/studio/mock.js`. Tests: `node web/test.mjs`.
