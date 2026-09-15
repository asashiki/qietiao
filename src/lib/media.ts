import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  canEncodeVideo,
  CanvasSink,
  Conversion,
  ConversionCanceledError,
  Input,
  Mp4OutputFormat,
  Output,
  Quality,
} from "mediabunny";
import { buildGlobalPalette, createGifEncoder, encodeGifFrame } from "./gif-encode";
import {
  even,
  isImageName,
  type MediaInfo,
  PIXIV_GIF_MAX_BYTES,
  PIXIV_UGOIRA_MAX_FRAME_BYTES,
  PIXIV_UGOIRA_MAX_TOTAL_BYTES,
  pixivDelayMs,
  pixivFrameCount,
  pixivFrameTimestamps,
  type SplitPlan,
  SplitError,
  type Tile,
  tileDestRect,
  ugoiraFrameCount,
  ugoiraFrameName,
  ugoiraGuideText,
} from "./splitter";
import { zipBlobs } from "./zip";

export type ProbedMedia = {
  info: MediaInfo;
  previewUrl: string;
};

export type OutputFile = {
  name: string;
  blob: Blob;
  url: string;
  bytes: number;
  note?: string;
  width?: number;
  height?: number;
  frames?: { name: string; url: string }[];
  delayMs?: number;
};

export async function browserCanEncodeVideo(): Promise<boolean> {
  try {
    return await canEncodeVideo("avc");
  } catch {
    return typeof VideoEncoder !== "undefined";
  }
}

export async function probeMedia(file: File): Promise<ProbedMedia> {
  if (file.size < 32) throw new SplitError("文件是空的");
  if (isImageName(file.name) && !file.name.toLowerCase().endsWith(".gif")) {
    return probeImage(file);
  }
  try {
    return await probeVideo(file);
  } catch (err) {
    if (isImageName(file.name) || file.type.startsWith("image/")) {
      return probeImage(file);
    }
    throw err;
  }
}

async function probeImage(file: File): Promise<ProbedMedia> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new SplitError("读不了这张图片。");
  }
  const width = bitmap.width;
  const height = bitmap.height;
  bitmap.close();
  if (width < 2 || height < 2) throw new SplitError("画面尺寸无效。");
  return {
    info: {
      name: file.name,
      kind: "image",
      width,
      height,
      duration: 0,
      fps: null,
      has_audio: false,
      video_codec: "image",
      audio_codec: null,
      size_bytes: file.size,
    },
    previewUrl: URL.createObjectURL(file),
  };
}

async function probeVideo(file: File): Promise<ProbedMedia> {
  const input = new Input({
    formats: ALL_FORMATS,
    source: new BlobSource(file),
  });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new SplitError("没有视频或图片轨。");
    const width = await track.getDisplayWidth();
    const height = await track.getDisplayHeight();
    if (width < 2 || height < 2) throw new SplitError("画面尺寸无效。");
    const duration = await input.computeDuration();
    const audio = await input.getPrimaryAudioTrack();
    const codec = (await track.getCodec()) ?? "unknown";
    const audioCodec = audio ? ((await audio.getCodec()) ?? "unknown") : null;
    let fps: number | null = null;
    try {
      const metrics = await track.computeFrameRateMetrics({ targetPacketCount: 48 });
      fps = metrics.bestGuessFrameRate || null;
    } catch {
      fps = null;
    }
    const still = duration <= 0.15;
    const t = still ? 0 : Math.min(Math.max(duration * 0.15, 0), Math.max(duration - 0.05, 0));
    const sink = new CanvasSink(track, { width: Math.min(width, 1280) });
    const wrapped = await sink.getCanvas(t);
    let previewUrl: string;
    if (wrapped?.canvas) {
      previewUrl = URL.createObjectURL(await canvasToJpeg(wrapped.canvas, 0.92));
    } else {
      previewUrl = URL.createObjectURL(file);
    }
    return {
      info: {
        name: file.name,
        kind: still ? "image" : "video",
        width,
        height,
        duration: still ? 0 : duration,
        fps: still ? null : fps,
        has_audio: Boolean(audio),
        video_codec: codec,
        audio_codec: audioCodec,
        size_bytes: file.size,
      },
      previewUrl,
    };
  } catch (err) {
    if (err instanceof SplitError) throw err;
    throw new SplitError(err instanceof Error ? `读文件失败：${err.message}` : "读不了这个文件");
  } finally {
    input.dispose();
  }
}

async function canvasToJpeg(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  quality = 0.92,
): Promise<Blob> {
  if (canvas instanceof OffscreenCanvas) {
    return canvas.convertToBlob({ type: "image/jpeg", quality });
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("抽帧失败"))),
      "image/jpeg",
      quality,
    );
  });
}

export async function splitMedia(options: {
  file: File;
  info: MediaInfo;
  plan: SplitPlan;
  signal: AbortSignal;
  onProgress: (percent: number, message: string) => void;
}): Promise<OutputFile[]> {
  const { file, info, plan, signal, onProgress } = options;
  if (signal.aborted) throw new SplitError("已取消。");
  if (info.kind === "image") {
    onProgress(8, "裁图片");
    const files = await splitImage(file, plan);
    onProgress(100, "切好了");
    return files;
  }
  if (plan.quality === "pixiv") {
    return splitVideoToGif(file, info, plan, signal, onProgress);
  }
  if (plan.quality === "ugoira") {
    return splitVideoToUgoira(file, info, plan, signal, onProgress);
  }
  return splitVideo(file, plan, signal, onProgress);
}

async function splitImage(file: File, plan: SplitPlan): Promise<OutputFile[]> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new SplitError("读不了这张图片。");
  }
  try {
    const out: OutputFile[] = [];
    for (const tile of plan.tiles) {
      const canvas = document.createElement("canvas");
      canvas.width = tile.out_w;
      canvas.height = tile.out_h;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new SplitError("画布不可用。");
      ctx.imageSmoothingEnabled = tile.scaled;
      ctx.imageSmoothingQuality = "high";
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const d = tileDestRect(tile);
      ctx.drawImage(bitmap, tile.x, tile.y, tile.w, tile.h, d.dx, d.dy, d.dw, d.dh);
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new SplitError("png 写不出"))), "image/png");
      });
      out.push(toOutput(tile.filename, blob, { width: tile.out_w, height: tile.out_h }));
    }
    return out;
  } finally {
    bitmap.close();
  }
}

async function splitVideo(
  file: File,
  plan: SplitPlan,
  signal: AbortSignal,
  onProgress: (percent: number, message: string) => void,
): Promise<OutputFile[]> {
  const ok = await browserCanEncodeVideo();
  if (!ok) {
    throw new SplitError("这个浏览器编不了 H.264 视频。换 Chrome、Edge 或 Safari 试试。");
  }
  const out: OutputFile[] = [];
  const n = plan.tiles.length;
  for (let i = 0; i < n; i++) {
    if (signal.aborted) throw new SplitError("已取消。");
    const tile = plan.tiles[i]!;
    const start = (i / n) * 100;
    const span = 100 / n;
    onProgress(start, `编码 ${tile.label}`);
    const blob = await convertTile(file, plan, tile, i, signal, (p) => {
      onProgress(start + p * span * 0.98, `编码 ${tile.label}`);
    });
    out.push(toOutput(tile.filename, blob, { width: tile.out_w, height: tile.out_h }));
  }
  onProgress(100, "切好了");
  return out;
}

async function splitVideoToGif(
  file: File,
  info: MediaInfo,
  plan: SplitPlan,
  signal: AbortSignal,
  onProgress: (percent: number, message: string) => void,
): Promise<OutputFile[]> {
  const out: OutputFile[] = [];
  const n = plan.tiles.length;
  for (let i = 0; i < n; i++) {
    if (signal.aborted) throw new SplitError("已取消。");
    const tile = plan.tiles[i]!;
    const start = (i / n) * 100;
    const span = 100 / n;
    onProgress(start, `编 GIF ${tile.label}`);
    const { blob, note, width, height } = await convertTileToGif(file, info, tile, signal, (p, msg) => {
      onProgress(start + p * span * 0.98, msg);
    });
    out.push(toOutput(tile.filename, blob, { note, width, height }));
  }
  onProgress(100, "切好了");
  return out;
}

async function splitVideoToUgoira(
  file: File,
  info: MediaInfo,
  plan: SplitPlan,
  signal: AbortSignal,
  onProgress: (percent: number, message: string) => void,
): Promise<OutputFile[]> {
  const out: OutputFile[] = [];
  const n = plan.tiles.length;
  for (let i = 0; i < n; i++) {
    if (signal.aborted) throw new SplitError("已取消。");
    const tile = plan.tiles[i]!;
    const start = (i / n) * 100;
    const span = 100 / n;
    onProgress(start, `抽帧 ${tile.label}`);
    const result = await convertTileToUgoira(file, info, tile, signal, (p, msg) => {
      onProgress(start + p * span * 0.98, msg);
    });
    out.push(result);
  }
  onProgress(100, "切好了");
  return out;
}

async function convertTile(
  file: File,
  plan: SplitPlan,
  tile: Tile,
  index: number,
  signal: AbortSignal,
  onProgress: (unit: number) => void,
): Promise<Blob> {
  const input = new Input({
    formats: ALL_FORMATS,
    source: new BlobSource(file),
  });
  const target = new BufferTarget();
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: "in-memory" }),
    target,
  });
  const keepAudio =
    plan.audio === "all" || (plan.audio === "first" && index === 0);
  const needsFit = tile.padded || tile.scaled || tile.out_w !== tile.w || tile.out_h !== tile.h;
  let conversion: Conversion | null = null;
  const abort = () => {
    void conversion?.cancel();
  };
  signal.addEventListener("abort", abort);
  try {
    conversion = await Conversion.init({
      input,
      output,
      tracks: "primary",
      copy: false,
      tags: {},
      showWarnings: false,
      video: {
        codec: "avc",
        crop: { left: tile.x, top: tile.y, width: tile.w, height: tile.h },
        ...(needsFit
          ? { width: tile.out_w, height: tile.out_h, fit: "contain" as const }
          : {}),
        quality: new Quality(plan.quality === "keep" ? "very-high" : "high"),
        forceTranscode: true,
        allowRotationMetadata: false,
      },
      audio: keepAudio
        ? { codec: "aac", quality: new Quality("high"), numberOfChannels: 2, sampleRate: 44100 }
        : { discard: true },
    });
    if (!conversion.isValid) {
      const why = conversion.discardedTracks.map((t) => t.reason).join("；") || "无法编码";
      throw new SplitError(`切不开：${why}`);
    }
    conversion.onProgress = (progress) => onProgress(progress);
    if (signal.aborted) throw new SplitError("已取消。");
    await conversion.execute();
    const buffer = target.buffer;
    if (!buffer || buffer.byteLength < 32) throw new SplitError(`没有写出 ${tile.filename}`);
    return new Blob([buffer], { type: "video/mp4" });
  } catch (err) {
    if (err instanceof ConversionCanceledError || signal.aborted) {
      throw new SplitError("已取消。");
    }
    if (err instanceof SplitError) throw err;
    throw new SplitError(err instanceof Error ? `编码失败：${err.message}` : "编码失败");
  } finally {
    signal.removeEventListener("abort", abort);
    input.dispose();
  }
}

async function convertTileToGif(
  file: File,
  info: MediaInfo,
  tile: Tile,
  signal: AbortSignal,
  onProgress: (unit: number, message: string) => void,
): Promise<{ blob: Blob; note?: string; width: number; height: number }> {
  const frames = pixivFrameCount(info.duration, info.fps);
  const delayMs = pixivDelayMs(info.duration, frames);
  const timestamps = pixivFrameTimestamps(info.duration, frames);
  let scale = 1;
  let lastBytes: Uint8Array | null = null;
  let lastW = tile.out_w;
  let lastH = tile.out_h;
  let scaled = false;

  for (let attempt = 0; attempt < 5; attempt++) {
    if (signal.aborted) throw new SplitError("已取消。");
    const fitW = Math.max(1, Math.round(tile.out_w * scale));
    const fitH = Math.max(1, Math.round(tile.out_h * scale));
    lastW = fitW;
    lastH = fitH;
    onProgress(attempt * 0.05, attempt === 0 ? `抽帧 ${tile.label}` : "超过 16MB，缩小再编");
    const bytes = await encodeGifAttempt(file, tile, timestamps, delayMs, fitW, fitH, signal, (p) => {
      onProgress(0.08 + p * 0.9, `编 GIF ${tile.label}`);
    });
    lastBytes = bytes;
    if (bytes.byteLength <= PIXIV_GIF_MAX_BYTES) {
      const blob = bytesToGifBlob(bytes);
      const note =
        scaled || fitW !== tile.out_w || fitH !== tile.out_h
          ? `为压进 16MB 缩到 ${fitW}×${fitH}`
          : undefined;
      return { blob, note, width: fitW, height: fitH };
    }
    const ratio = PIXIV_GIF_MAX_BYTES / bytes.byteLength;
    scale = Math.max(0.22, scale * Math.sqrt(ratio) * 0.9);
    scaled = true;
  }

  if (lastBytes && lastBytes.byteLength <= PIXIV_GIF_MAX_BYTES) {
    return {
      blob: bytesToGifBlob(lastBytes),
      note: `为压进 16MB 缩到 ${lastW}×${lastH}`,
      width: lastW,
      height: lastH,
    };
  }
  throw new SplitError("压不进 Pixiv 的 16MB GIF 上限。试试更短的片段，或先切成更小的条。");
}

async function convertTileToUgoira(
  file: File,
  info: MediaInfo,
  tile: Tile,
  signal: AbortSignal,
  onProgress: (unit: number, message: string) => void,
): Promise<OutputFile> {
  const frames = ugoiraFrameCount(info.duration, info.fps);
  const delayMs = pixivDelayMs(info.duration, frames);
  const timestamps = pixivFrameTimestamps(info.duration, frames);
  let scale = 1;
  let jpegQ = 0.92;
  let last: { blobs: Blob[]; width: number; height: number } | null = null;

  for (let attempt = 0; attempt < 6; attempt++) {
    if (signal.aborted) throw new SplitError("已取消。");
    const fitW = Math.max(2, even(Math.round(tile.out_w * scale)));
    const fitH = Math.max(2, even(Math.round(tile.out_h * scale)));
    onProgress(attempt * 0.04, attempt === 0 ? `抽帧 ${tile.label}` : "超过 30MB，再压一档");
    const blobs = await encodeUgoiraAttempt(file, tile, timestamps, fitW, fitH, jpegQ, signal, (p) => {
      onProgress(0.08 + p * 0.82, `编 JPEG ${tile.label}`);
    });
    last = { blobs, width: fitW, height: fitH };
    const total = blobs.reduce((sum, b) => sum + b.size, 0);
    const maxOne = blobs.reduce((m, b) => Math.max(m, b.size), 0);
    if (total <= PIXIV_UGOIRA_MAX_TOTAL_BYTES && maxOne <= PIXIV_UGOIRA_MAX_FRAME_BYTES) {
      return packUgoira(tile, blobs, fitW, fitH, delayMs, scale < 1 || fitW !== tile.out_w);
    }
    if (jpegQ > 0.78) {
      jpegQ = Math.max(0.76, jpegQ - 0.08);
    } else {
      const ratio = Math.min(
        PIXIV_UGOIRA_MAX_TOTAL_BYTES / Math.max(total, 1),
        PIXIV_UGOIRA_MAX_FRAME_BYTES / Math.max(maxOne, 1),
      );
      scale = Math.max(0.4, scale * Math.sqrt(ratio) * 0.92);
      jpegQ = 0.84;
    }
  }

  if (last) {
    const total = last.blobs.reduce((sum, b) => sum + b.size, 0);
    const maxOne = last.blobs.reduce((m, b) => Math.max(m, b.size), 0);
    if (total <= PIXIV_UGOIRA_MAX_TOTAL_BYTES && maxOne <= PIXIV_UGOIRA_MAX_FRAME_BYTES) {
      return packUgoira(tile, last.blobs, last.width, last.height, delayMs, true);
    }
  }
  throw new SplitError("压不进 Pixiv 动图的 30MB / 150 张上限。试试更短的片段。");
}

async function packUgoira(
  tile: Tile,
  blobs: Blob[],
  width: number,
  height: number,
  delayMs: number,
  scaled: boolean,
): Promise<OutputFile> {
  const stem = tile.filename.replace(/\.zip$/i, "") || "clip";
  const files = blobs.map((blob, i) => ({
    name: ugoiraFrameName(stem, i),
    blob,
    url: URL.createObjectURL(blob),
  }));
  const guide = new Blob(
    [
      ugoiraGuideText({
        width,
        height,
        frames: files.length,
        delayMs,
        files: files.map((f) => f.name),
      }),
    ],
    { type: "text/plain;charset=utf-8" },
  );
  const zip = await zipBlobs([...files.map((f) => ({ name: f.name, blob: f.blob })), { name: "投稿说明.txt", blob: guide }]);
  const note = [
    `JPEG ${files.length} 帧 · 每帧 ${delayMs}ms`,
    scaled ? `为压进 30MB 缩到 ${width}×${height}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return toOutput(tile.filename, zip, {
    note,
    width,
    height,
    frames: files.map((f) => ({ name: f.name, url: f.url })),
    delayMs,
  });
}

async function encodeUgoiraAttempt(
  file: File,
  tile: Tile,
  timestamps: number[],
  outW: number,
  outH: number,
  jpegQ: number,
  signal: AbortSignal,
  onProgress: (unit: number) => void,
): Promise<Blob[]> {
  const input = new Input({
    formats: ALL_FORMATS,
    source: new BlobSource(file),
  });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new SplitError("没有视频轨。");
    const sink = new CanvasSink(track, {
      crop: { left: tile.x, top: tile.y, width: tile.w, height: tile.h },
      width: outW,
      height: outH,
      fit: "contain",
      poolSize: 1,
    });
    const blobs: Blob[] = [];
    const n = timestamps.length;
    for (let i = 0; i < n; i++) {
      if (signal.aborted) throw new SplitError("已取消。");
      const wrapped = await sink.getCanvas(timestamps[i]!);
      if (!wrapped?.canvas) throw new SplitError("抽帧失败。");
      blobs.push(await canvasToJpeg(wrapped.canvas, jpegQ));
      onProgress((i + 1) / n);
      if (i % 8 === 7) await yieldToUi();
    }
    if (!blobs.length) throw new SplitError("没有抽到帧。");
    return blobs;
  } finally {
    input.dispose();
  }
}

async function encodeGifAttempt(
  file: File,
  tile: Tile,
  timestamps: number[],
  delayMs: number,
  outW: number,
  outH: number,
  signal: AbortSignal,
  onProgress: (unit: number) => void,
): Promise<Uint8Array> {
  const input = new Input({
    formats: ALL_FORMATS,
    source: new BlobSource(file),
  });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new SplitError("没有视频轨。");
    const sink = new CanvasSink(track, {
      crop: { left: tile.x, top: tile.y, width: tile.w, height: tile.h },
      width: outW,
      height: outH,
      fit: "contain",
      poolSize: 3,
    });

    const sampleTs = sampleTimestamps(timestamps, 8);
    const samples: Uint8Array[] = [];
    for await (const wrapped of sink.canvasesAtTimestamps(sampleTs)) {
      if (signal.aborted) throw new SplitError("已取消。");
      if (!wrapped) continue;
      samples.push(readRgba(wrapped.canvas).data);
    }
    if (!samples.length) throw new SplitError("抽不出帧来编 GIF。");
    const palette = buildGlobalPalette(samples, 256);

    const gif = createGifEncoder(outW, outH, timestamps.length);
    let written = 0;
    for await (const wrapped of sink.canvasesAtTimestamps(timestamps)) {
      if (signal.aborted) throw new SplitError("已取消。");
      if (!wrapped) continue;
      const frame = readRgba(wrapped.canvas);
      encodeGifFrame(gif, frame.data, frame.width, frame.height, palette, delayMs, written === 0);
      written++;
      onProgress(written / timestamps.length);
      if (written % 4 === 0) await yieldToUi();
    }
    if (written < 1) throw new SplitError("GIF 没有写出任何帧。");
    gif.finish();
    return gif.bytes();
  } catch (err) {
    if (signal.aborted) throw new SplitError("已取消。");
    if (err instanceof SplitError) throw err;
    throw new SplitError(err instanceof Error ? `GIF 编码失败：${err.message}` : "GIF 编码失败");
  } finally {
    input.dispose();
  }
}

function sampleTimestamps(timestamps: number[], count: number): number[] {
  if (timestamps.length <= count) return timestamps;
  const out: number[] = [];
  const last = count - 1;
  for (let i = 0; i < count; i++) {
    const idx = Math.round((i / last) * (timestamps.length - 1));
    out.push(timestamps[idx]!);
  }
  return out;
}

function readRgba(canvas: HTMLCanvasElement | OffscreenCanvas): {
  data: Uint8Array;
  width: number;
  height: number;
} {
  const ctx = canvas.getContext("2d", { willReadFrequently: true }) as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!ctx) throw new SplitError("画布不可用。");
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { data: new Uint8Array(img.data), width: canvas.width, height: canvas.height };
}

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function bytesToGifBlob(bytes: Uint8Array): Blob {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return new Blob([buffer], { type: "image/gif" });
}

function toOutput(
  name: string,
  blob: Blob,
  extra?: {
    note?: string;
    width?: number;
    height?: number;
    frames?: { name: string; url: string }[];
    delayMs?: number;
  },
): OutputFile {
  return {
    name,
    blob,
    url: URL.createObjectURL(blob),
    bytes: blob.size,
    note: extra?.note,
    width: extra?.width,
    height: extra?.height,
    frames: extra?.frames,
    delayMs: extra?.delayMs,
  };
}

export function downloadBlob(blob: Blob, name: string, existingUrl?: string) {
  const url = existingUrl || URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.target = "_blank";
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  if (!existingUrl) setTimeout(() => URL.revokeObjectURL(url), 4000);
}
