import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildGlobalPalette,
  concatRgba,
  encodeGifFromFrames,
  packedRgba,
  subsampleRgba,
} from "./gif-encode.ts";

function solidFrame(w: number, h: number, r: number, g: number, b: number) {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    data[o] = r;
    data[o + 1] = g;
    data[o + 2] = b;
    data[o + 3] = 255;
  }
  return { data, width: w, height: h };
}

test("packedRgba copies views", () => {
  const raw = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const view = raw.subarray(4);
  const packed = packedRgba(view);
  assert.equal(packed.byteOffset, 0);
  assert.deepEqual([...packed], [5, 6, 7, 8]);
});

test("subsample keeps RGBA groups", () => {
  const data = new Uint8Array([1, 2, 3, 255, 9, 8, 7, 255, 4, 4, 4, 255, 6, 6, 6, 255]);
  const out = subsampleRgba(data, 2);
  assert.equal(out.length, 8);
  assert.deepEqual([...out], [1, 2, 3, 255, 4, 4, 4, 255]);
});

test("concatRgba joins samples", () => {
  const out = concatRgba([new Uint8Array([1, 2]), new Uint8Array([3])]);
  assert.deepEqual([...out], [1, 2, 3]);
});

test("encodes a looping GIF under budget", () => {
  const frames = [
    solidFrame(24, 16, 220, 40, 40),
    solidFrame(24, 16, 40, 180, 70),
    solidFrame(24, 16, 40, 80, 220),
    solidFrame(24, 16, 220, 180, 40),
  ];
  const palette = buildGlobalPalette(frames.map((f) => f.data), 16);
  assert.ok(palette.length >= 2);
  assert.ok(palette.length <= 16);
  const bytes = encodeGifFromFrames({ frames, delayMs: 80, palette });
  assert.ok(bytes.byteLength > 32);
  assert.equal(String.fromCharCode(...bytes.subarray(0, 6)), "GIF89a");
  assert.ok(bytes.byteLength < 64 * 1024);
});
