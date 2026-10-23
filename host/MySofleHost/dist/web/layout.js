// From include/rgbpk/layout_sofle.h (left + right half). 255 = no LED.
export const NO_LED = 255;
export const POS2LED = [
  4,   5,  14,  15,  24,  25,  25,  24,  15,  14,   5,   4,
  3,   6,  13,  16,  23,  28,  28,  23,  16,  13,   6,   3,
  2,   7,  12,  17,  22,  27,  27,  22,  17,  12,   7,   2,
  1,   8,  11,  18,  21,  26, 255, 255,  26,  21,  18,  11,
  8,   1,   0,   9,  10,  19,  20,  20,  19,  10,   9,   0,
];
export const LED_X = [85, 0, 0, 0, 0, 43, 43, 43, 43, 128, 170, 85, 85, 85, 85, 128, 128, 128, 128, 222, 255, 170, 170, 170, 170, 213, 213, 213, 213];
export const LED_Y = [176, 144, 101, 59, 17, 17, 59, 101, 144, 170, 176, 133, 91, 48, 6, 0, 43, 85, 128, 186, 203, 133, 91, 48, 6, 11, 139, 96, 54];

// Positions are keymap order (rows of 12, 12, 12, 14, 10). Right half mirrors the left one.
// pos -> left pos it mirrors.
export const MIRROR = {};
for (let r = 0; r < 3; r++) for (let k = 0; k < 6; k++) MIRROR[r * 12 + 6 + k] = r * 12 + 5 - k;
for (let k = 0; k < 6; k++) MIRROR[44 + k] = 41 - k;
for (let k = 0; k < 5; k++) MIRROR[55 + k] = 54 - k;
