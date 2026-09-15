import { GIFEncoder, applyPalette, quantize } from "gifenc/dist/gifenc.esm.js";

export type RgbaFrame = {
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
};

/** gifenc reads Uint32 from the backing buffer — only packed copies are safe. */
export function packedRgba(data: Uint8Array | Uint8ClampedArray): Uint8Array {
  if (data instanceof Uint8Array && data.byteOffset === 0 && data.buffer.byteLength === data.byteLength) {
    return data;
  }
  return new Uint8Array(data);
}

export function subsampleRgba(data: Uint8Array | Uint8ClampedArray, pixelStride = 4): Uint8Array {
  const src = packedRgba(data);
  const pixels = src.length >>> 2;
  if (pixels === 0) return src;
  const step = Math.max(1, pixelStride);
  const outPixels = Math.ceil(pixels / step);
  const out = new Uint8Array(outPixels * 4);
  let j = 0;
  for (let i = 0; i < pixels; i += step) {
    const o = i * 4;
    out[j] = src[o]!;
    out[j + 1] = src[o + 1]!;
    out[j + 2] = src[o + 2]!;
    out[j + 3] = src[o + 3]!;
    j += 4;
  }
  return j === out.length ? out : out.subarray(0, j);
}

export function concatRgba(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

export function buildGlobalPalette(samples: Array<Uint8Array | Uint8ClampedArray>, maxColors = 256): number[][] {
  if (!samples.length) throw new Error("没有可用于调色盘的帧。");
  const packed = samples.map((s) => subsampleRgba(s, samples.length > 4 ? 6 : 3));
  const merged = concatRgba(packed);
  const colors = Math.max(2, Math.min(256, maxColors));
  const palette = quantize(merged, colors, { format: "rgb565" });
  if (!palette.length) throw new Error("调色盘量化失败。");
  return palette;
}

export function encodeGifFromFrames(options: {
  frames: RgbaFrame[];
  delayMs: number;
  palette: number[][];
  signal?: AbortSignal;
  onProgress?: (unit: number) => void;
}): Uint8Array {
  const { frames, palette, signal, onProgress } = options;
  if (!frames.length) throw new Error("没有帧可以写成 GIF。");
  const width = frames[0]!.width;
  const height = frames[0]!.height;
  const delayMs = Math.max(20, Math.round(options.delayMs));
  const gif = GIFEncoder({
    auto: true,
    initialCapacity: Math.min(16 * 1024 * 1024, Math.max(4096, width * height * frames.length)),
  });
  for (let i = 0; i < frames.length; i++) {
    if (signal?.aborted) throw new Error("已取消。");
    const frame = frames[i]!;
    if (frame.width !== width || frame.height !== height) {
      throw new Error("GIF 各帧尺寸必须相同。");
    }
    const rgba = packedRgba(frame.data);
    const index = applyPalette(rgba, palette, "rgb565");
    gif.writeFrame(index, width, height, {
      palette: i === 0 ? palette : undefined,
      delay: delayMs,
      repeat: 0,
    });
    onProgress?.((i + 1) / frames.length);
  }
  gif.finish();
  return gif.bytes();
}

export function encodeGifFrame(
  gif: ReturnType<typeof GIFEncoder>,
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  palette: number[][],
  delayMs: number,
  first: boolean,
) {
  const index = applyPalette(packedRgba(rgba), palette, "rgb565");
  gif.writeFrame(index, width, height, {
    palette: first ? palette : undefined,
    delay: Math.max(20, Math.round(delayMs)),
    repeat: 0,
  });
}

export function createGifEncoder(width: number, height: number, frameHint = 24) {
  return GIFEncoder({
    auto: true,
    initialCapacity: Math.min(16 * 1024 * 1024, Math.max(4096, width * height * Math.max(frameHint, 4))),
  });
}
