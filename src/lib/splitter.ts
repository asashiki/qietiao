export type Layout = "carousel" | "stack" | "grid" | "clean";
export type Quality = "keep" | "x" | "pixiv" | "ugoira";
export type AudioMode = "all" | "first" | "mute";
export type Kind = "video" | "image";

export const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"]);
export const VIDEO_EXT = new Set([
  ".mp4",
  ".mov",
  ".m4v",
  ".webm",
  ".mkv",
  ".avi",
  ".gif",
  ".wmv",
  ".mpeg",
  ".mpg",
]);

export const X_MAX_LANDSCAPE = [1920, 1200] as const;
export const X_MAX_PORTRAIT = [1200, 1920] as const;
export const X_MIN_AR = 1 / 3;
export const X_MAX_AR = 3 / 1;
export const X_MIN_SIDE = 32;
export const X_MAX_ATTACHMENTS = 4;
export const X_STANDARD_DURATION = 140;

/** Official Pixiv うごイラ GIF limits (help center, since 2022-06-01). */
export const PIXIV_GIF_MAX_BYTES = 16 * 1024 * 1024;
export const PIXIV_GIF_MAX_FRAMES = 500;
/** Soft cap: Pixiv rejects extreme pixel sizes even under 16MB. */
export const PIXIV_GIF_MAX_SIDE = 4096;
/** Official Pixiv 动图 via JPEG/PNG sequence (help: 选择多张图片). */
export const PIXIV_UGOIRA_MAX_FRAMES = 150;
export const PIXIV_UGOIRA_MAX_FRAME_BYTES = 8 * 1024 * 1024;
export const PIXIV_UGOIRA_MAX_TOTAL_BYTES = 30 * 1024 * 1024;

export function isPixivMode(quality: Quality): boolean {
  return quality === "pixiv" || quality === "ugoira";
}

export class SplitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SplitError";
  }
}

export type MediaInfo = {
  name: string;
  kind: Kind;
  width: number;
  height: number;
  duration: number;
  fps: number | null;
  has_audio: boolean;
  video_codec: string;
  audio_codec: string | null;
  size_bytes: number;
};

export type Tile = {
  index: number;
  row: number;
  col: number;
  x: number;
  y: number;
  w: number;
  h: number;
  out_w: number;
  out_h: number;
  pad_w: number;
  pad_h: number;
  padded: boolean;
  scaled: boolean;
  filename: string;
  aspect: number;
  x_ok: boolean;
  label: string;
  notes: string[];
};

export type SplitPlan = {
  layout: Layout;
  cols: number;
  rows: number;
  quality: Quality;
  audio: AudioMode;
  kind: Kind;
  canvas_x: number;
  canvas_y: number;
  canvas_w: number;
  canvas_h: number;
  source_w: number;
  source_h: number;
  tiles: Tile[];
  warnings: string[];
  order_hint: string;
};

export function even(n: number): number {
  const i = Math.trunc(n);
  return i % 2 === 0 ? i : i - 1;
}

export function evenFloorDiv(total: number, parts: number): number {
  if (parts <= 0) throw new Error("parts must be > 0");
  return even(Math.floor(total / parts));
}

export function aspectOk(w: number, h: number): boolean {
  if (w <= 0 || h <= 0) return false;
  const ar = w / h;
  return X_MIN_AR - 1e-6 <= ar && ar <= X_MAX_AR + 1e-6;
}

export function fitXDims(w: number, h: number) {
  w = Math.max(2, even(w));
  h = Math.max(2, even(h));
  let padW = w;
  let padH = h;
  let padded = false;
  const ar = w / h;
  if (ar < X_MIN_AR) {
    padW = even(Math.max(2, Math.round(h * X_MIN_AR)));
    padded = true;
  } else if (ar > X_MAX_AR) {
    padH = even(Math.max(2, Math.round(w / X_MAX_AR)));
    padded = true;
  }
  const [maxW, maxH] = padW >= padH ? X_MAX_LANDSCAPE : X_MAX_PORTRAIT;
  const scale = Math.min(1, maxW / padW, maxH / padH);
  const scaled = scale < 0.999;
  const outW = scaled ? Math.max(2, even(Math.round(padW * scale))) : padW;
  const outH = scaled ? Math.max(2, even(Math.round(padH * scale))) : padH;
  return { outW, outH, padW, padH, padded, scaled };
}

export function fitPixivDims(w: number, h: number, scale = 1) {
  const srcW = Math.max(1, Math.round(w * scale));
  const srcH = Math.max(1, Math.round(h * scale));
  const long = Math.max(srcW, srcH);
  if (long <= PIXIV_GIF_MAX_SIDE) {
    return {
      outW: srcW,
      outH: srcH,
      scaled: srcW !== w || srcH !== h,
    };
  }
  const s = PIXIV_GIF_MAX_SIDE / long;
  return {
    outW: Math.max(1, Math.round(srcW * s)),
    outH: Math.max(1, Math.round(srcH * s)),
    scaled: true,
  };
}

export function pixivFrameCount(duration: number, fps: number | null): number {
  const rate = fps && fps > 1 ? fps : 30;
  const dur = Math.max(duration, 0.04);
  return Math.min(PIXIV_GIF_MAX_FRAMES, Math.max(2, Math.round(dur * rate)));
}

export function pixivDelayMs(duration: number, frames: number): number {
  if (frames <= 0) return 100;
  return Math.max(20, Math.round((Math.max(duration, 0.04) / frames) * 1000));
}

export function pixivFrameTimestamps(duration: number, frames: number): number[] {
  const dur = Math.max(duration, 0.04);
  const n = Math.max(1, frames);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = ((i + 0.5) / n) * dur;
    out.push(Math.min(Math.max(t, 0), Math.max(dur - 0.001, 0)));
  }
  return out;
}

export function ugoiraFrameCount(duration: number, fps: number | null): number {
  const dur = Math.max(duration, 0.04);
  const src = fps && fps > 1 ? fps : 24;
  const ideal = Math.round(dur * Math.min(src, 24));
  return Math.max(2, Math.min(PIXIV_UGOIRA_MAX_FRAMES, ideal));
}

export function ugoiraFrameName(stem: string, index: number): string {
  return `${stem}_${String(index + 1).padStart(3, "0")}.jpg`;
}

export function ugoiraGuideText(opts: {
  width: number;
  height: number;
  frames: number;
  delayMs: number;
  files: string[];
}): string {
  return [
    "Pixiv 动图（うごイラ）",
    "",
    "这不是 GIF。官方说用 JPEG/PNG 连帧比 GIF 更清晰、颜色更正。",
    "电脑版 pixiv → 投稿作品 → 插画 → 点「选择多张图片」（不要点「GIF动图」）",
    `全选这 ${opts.frames} 张 JPEG，尺寸 ${opts.width}×${opts.height}，后缀必须一样。`,
    `每帧显示时间设为 ${opts.delayMs} 毫秒（可全选后一次填写）。`,
    "手机和 APP 不能投动图。",
    "",
    ...opts.files,
    "",
  ].join("\n");
}

export function bestCountForCarousel(width: number, height: number): number {
  for (const n of [4, 3, 2]) {
    const tw = evenFloorDiv(width, n);
    const th = even(height);
    if (tw >= X_MIN_SIDE && th >= X_MIN_SIDE && aspectOk(tw, th)) return n;
  }
  return 2;
}

export function bestCountForStack(width: number, height: number): number {
  for (const n of [4, 3, 2]) {
    const tw = even(width);
    const th = evenFloorDiv(height, n);
    if (tw >= X_MIN_SIDE && th >= X_MIN_SIDE && aspectOk(tw, th)) return n;
  }
  return 2;
}

export function suggestLayout(info: MediaInfo): [Layout, number] {
  const { width: w, height: h } = info;
  if (h > w * 1.12) return ["stack", bestCountForStack(w, h)];
  if (w > h * 1.12) return ["carousel", bestCountForCarousel(w, h)];
  return ["grid", 4];
}

export function layoutShape(layout: Layout, count: number): [number, number] {
  if (layout === "carousel") {
    if (![2, 3, 4].includes(count)) throw new SplitError("横滑连环只支持 2 / 3 / 4 条。");
    return [count, 1];
  }
  if (layout === "stack") {
    if (![2, 3, 4].includes(count)) throw new SplitError("上下堆叠只支持 2 / 3 / 4 条。");
    return [1, count];
  }
  if (layout === "grid") return [2, 2];
  if (layout === "clean") return [1, 1];
  throw new SplitError(`未知切法：${layout}`);
}

export function orderHint(layout: Layout, quality: Quality = "keep"): string {
  if (layout === "clean") return "";
  if (quality === "ugoira") {
    if (layout === "carousel") return "每个 zip 解压后单独当动图传，左到右 01 → 04";
    if (layout === "stack") return "每个 zip 解压后单独当动图传，上到下 01 → 04";
    return "每个 zip 解压后单独当动图传：左上 01 · 右上 02 · 左下 03 · 右下 04";
  }
  if (quality === "pixiv") {
    if (layout === "carousel") return "每个 GIF 单独当动图传，左到右 01 → 04";
    if (layout === "stack") return "每个 GIF 单独当动图传，上到下 01 → 04";
    return "每个 GIF 单独当动图传：左上 01 · 右上 02 · 左下 03 · 右下 04";
  }
  if (layout === "carousel") return "上传顺序 01 → 04，左到右";
  if (layout === "stack") return "上传顺序 01 → 04，上到下";
  return "上传顺序 左上 01 · 右上 02 · 左下 03 · 右下 04";
}

export function safeStem(stem: string): string {
  const cleaned = stem
    .replace(/[^a-zA-Z0-9_\u4e00-\u9fff-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return (cleaned || "clip").slice(0, 80);
}

function outputExt(kind: Kind, quality: Quality): string {
  if (kind === "image") return ".png";
  if (quality === "pixiv") return ".gif";
  if (quality === "ugoira") return ".zip";
  return ".mp4";
}

export function planSplit(
  info: MediaInfo,
  layout: Layout,
  count = 4,
  quality: Quality = "keep",
  audio: AudioMode = "all",
  stem?: string | null,
): SplitPlan {
  const [cols, rows] = layoutShape(layout, count);
  const tileW = evenFloorDiv(info.width, cols);
  const tileH = evenFloorDiv(info.height, rows);
  if (tileW < 2 || tileH < 2) {
    throw new SplitError("源画面太小，裁不开这么多份。");
  }

  const canvasW = tileW * cols;
  const canvasH = tileH * rows;
  const canvasX = even(Math.floor((info.width - canvasW) / 2));
  const canvasY = even(Math.floor((info.height - canvasH) / 2));

  const warnings: string[] = [];
  const dropX = info.width - canvasW;
  const dropY = info.height - canvasH;
  if (dropX || dropY) {
    warnings.push(
      `为了对齐偶数像素，画面被居中裁掉 ${dropX}×${dropY} 像素` +
        `（源 ${info.width}×${info.height} → 使用 ${canvasW}×${canvasH}）。`,
    );
  }

  if (!isPixivMode(quality) && info.kind === "video" && info.duration > X_STANDARD_DURATION) {
    warnings.push(
      `时长 ${info.duration.toFixed(1)}s，超过 X 普通账号 140 秒上限。Premium 才能发更长的。`,
    );
  }

  if (quality === "pixiv" && info.kind === "video") {
    const frames = pixivFrameCount(info.duration, info.fps);
    const raw = Math.round(Math.max(info.duration, 0.04) * (info.fps && info.fps > 1 ? info.fps : 30));
    warnings.push(
      `将导出 GIF（约 ${frames} 帧），Pixiv 动图上限 16MB / 500 帧。投稿页请选「GIF动图」，不要当普通插画传。GIF 只有 256 色，细雨和渐变容易发糊。`,
    );
    if (raw > PIXIV_GIF_MAX_FRAMES) {
      warnings.push(`源大约 ${raw} 帧，会均匀抽到 ${PIXIV_GIF_MAX_FRAMES} 帧。`);
    }
    if (info.has_audio) {
      warnings.push("GIF 没有音轨，声音会去掉。");
    }
  }

  if (quality === "ugoira" && info.kind === "video") {
    const frames = ugoiraFrameCount(info.duration, info.fps);
    const delay = pixivDelayMs(info.duration, frames);
    const raw = Math.round(Math.max(info.duration, 0.04) * (info.fps && info.fps > 1 ? info.fps : 24));
    warnings.push(
      `将导出 ${frames} 张 JPEG 连帧（每帧 ${delay}ms），上限 150 张 / 合计 30MB。电脑版投稿点「选择多张图片」，不要选「GIF动图」。`,
    );
    if (raw > PIXIV_UGOIRA_MAX_FRAMES) {
      warnings.push(`源大约 ${raw} 帧，会均匀抽到 ${frames} 帧（约 ${(1000 / delay).toFixed(1)} fps）。想更顺就先剪短。`);
    }
    if (info.has_audio) {
      warnings.push("动图没有音轨，声音会去掉。");
    }
  }

  const ext = outputExt(info.kind, quality);
  const base = safeStem(stem || "clip") || "clip";

  const tiles: Tile[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c + 1;
      const x = canvasX + c * tileW;
      const y = canvasY + r * tileH;
      let outW = tileW;
      let outH = tileH;
      let padW = tileW;
      let padH = tileH;
      let padded = false;
      let scaled = false;
      const notes: string[] = [];
      if (quality === "x") {
        const fit = fitXDims(tileW, tileH);
        outW = fit.outW;
        outH = fit.outH;
        padW = fit.padW;
        padH = fit.padH;
        padded = fit.padded;
        scaled = fit.scaled;
        if (padded) notes.push("按 X 的 1:3–3:1 补了黑边");
        if (scaled) notes.push("超过 X 分辨率上限，已缩小（不放大）");
      } else if (isPixivMode(quality)) {
        const fit = fitPixivDims(tileW, tileH);
        outW = fit.outW;
        outH = fit.outH;
        padW = outW;
        padH = outH;
        scaled = fit.scaled;
        if (scaled) notes.push("长边超过 4096，已缩小以免 Pixiv 拒收");
      }
      let ok = aspectOk(outW, outH) && outW <= Math.max(X_MAX_LANDSCAPE[0], X_MAX_PORTRAIT[0]);
      if (quality === "keep" && !aspectOk(tileW, tileH)) {
        notes.push("宽高比超出 X 的 1:3–3:1，上传可能被加黑边或拒收");
        warnings.push(`${String(idx).padStart(2, "0")} 的 ${tileW}×${tileH} 宽高比不在 X 允许范围。`);
        ok = false;
      }
      const [maxW, maxH] = outW >= outH ? X_MAX_LANDSCAPE : X_MAX_PORTRAIT;
      if (quality === "keep" && (tileW > maxW || tileH > maxH)) {
        notes.push("超过 X 分辨率上限");
        warnings.push(
          `${String(idx).padStart(2, "0")} 为 ${tileW}×${tileH}，超过 X 上限 ${maxW}×${maxH}。`,
        );
        ok = false;
      }
      if (isPixivMode(quality)) ok = true;
      const filename = layout === "clean" ? `${base}${ext}` : `${base}_${String(idx).padStart(2, "0")}${ext}`;
      const label = layout === "clean" ? "整段" : String(idx).padStart(2, "0");
      tiles.push({
        index: idx,
        row: r,
        col: c,
        x,
        y,
        w: tileW,
        h: tileH,
        out_w: outW,
        out_h: outH,
        pad_w: padW,
        pad_h: padH,
        padded,
        scaled,
        filename,
        aspect: outH ? outW / outH : 0,
        x_ok: ok,
        label,
        notes,
      });
    }
  }

  const total = cols * rows;
  if (!isPixivMode(quality) && total > X_MAX_ATTACHMENTS) {
    warnings.push(`切出 ${total} 份，X 一条帖最多 4 个附件。`);
  }
  if (info.kind === "video" && !info.has_audio && audio !== "mute" && !isPixivMode(quality)) {
    warnings.push("源视频没有音轨，输出也是静音。");
  }

  return {
    layout,
    cols,
    rows,
    quality,
    audio: isPixivMode(quality) || info.kind !== "video" ? "mute" : audio,
    kind: info.kind,
    canvas_x: canvasX,
    canvas_y: canvasY,
    canvas_w: canvasW,
    canvas_h: canvasH,
    source_w: info.width,
    source_h: info.height,
    tiles,
    warnings,
    order_hint: orderHint(layout, quality),
  };
}

export function tileDestRect(tile: Tile) {
  const scaleX = tile.out_w / tile.pad_w;
  const scaleY = tile.out_h / tile.pad_h;
  return {
    dx: ((tile.pad_w - tile.w) / 2) * scaleX,
    dy: ((tile.pad_h - tile.h) / 2) * scaleY,
    dw: tile.w * scaleX,
    dh: tile.h * scaleY,
  };
}

export function sidecarText(plan: SplitPlan): string {
  const title =
    plan.quality === "ugoira"
      ? plan.layout === "clean"
        ? "Pixiv 动图（电脑版点「选择多张图片」，解压后全选 JPEG）"
        : "Pixiv 动图（每个 zip 解压后单独以「选择多张图片」上传）"
      : plan.quality === "pixiv"
        ? plan.layout === "clean"
          ? "Pixiv 动图（投稿页选「GIF动图」，不要当普通插画传）"
          : "Pixiv 动图（每个 GIF 单独以「GIF动图」上传）"
        : plan.layout === "clean"
          ? "整段处理（不切开）"
          : "X 投稿顺序（一次选中全部，不要打乱）";
  const lines = [title, plan.order_hint, ""];
  for (const tile of plan.tiles) {
    lines.push(
      `${tile.label}  ${tile.filename}  ${tile.out_w}x${tile.out_h}  行${tile.row + 1}列${tile.col + 1}`,
    );
  }
  return lines.join("\n") + "\n";
}

export function fileExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i).toLowerCase() : "";
}

export function isImageName(name: string): boolean {
  return IMAGE_EXT.has(fileExt(name));
}

export function isVideoName(name: string): boolean {
  return VIDEO_EXT.has(fileExt(name));
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}
