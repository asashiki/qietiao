import assert from "node:assert/strict";
import { test } from "node:test";
import {
  even,
  fitPixivDims,
  fitXDims,
  pixivDelayMs,
  pixivFrameCount,
  pixivFrameTimestamps,
  planSplit,
  safeStem,
  sidecarText,
  suggestLayout,
  ugoiraFrameCount,
  ugoiraFrameName,
  type MediaInfo,
  PIXIV_GIF_MAX_FRAMES,
  PIXIV_GIF_MAX_SIDE,
  PIXIV_UGOIRA_MAX_FRAMES,
  X_MIN_AR,
} from "./splitter.ts";

function video(width: number, height: number, extra: Partial<MediaInfo> = {}): MediaInfo {
  return {
    name: "x.mp4",
    kind: "video",
    width,
    height,
    duration: 6,
    fps: 30,
    has_audio: true,
    video_codec: "h264",
    audio_codec: "aac",
    size_bytes: 1,
    ...extra,
  };
}

test("even", () => {
  assert.equal(even(1080), 1080);
  assert.equal(even(1081), 1080);
  assert.equal(even(1), 0);
});

test("carousel 1080p four", () => {
  const plan = planSplit(video(1920, 1080), "carousel", 4, "keep");
  assert.equal(plan.cols, 4);
  assert.equal(plan.rows, 1);
  assert.equal(plan.tiles.length, 4);
  for (const tile of plan.tiles) {
    assert.equal(tile.w, 480);
    assert.equal(tile.h, 1080);
    assert.equal(tile.out_w, 480);
    assert.equal(tile.out_h, 1080);
    assert.equal(tile.x_ok, true);
    assert.equal(tile.padded, false);
    assert.equal(tile.scaled, false);
  }
  assert.deepEqual(
    plan.tiles.map((t) => t.x),
    [0, 480, 960, 1440],
  );
  assert.ok(plan.tiles.every((t) => t.y === 0));
  assert.deepEqual(
    plan.tiles.map((t) => t.label),
    ["01", "02", "03", "04"],
  );
});

test("custom stem", () => {
  const info = video(1280, 720, { duration: 1, fps: 24 });
  const clean = planSplit(info, "clean", 1, "keep", "mute", "猫");
  assert.equal(clean.tiles[0]?.filename, "猫.mp4");
  const parts = planSplit(info, "carousel", 4, "keep", "mute", "v");
  assert.deepEqual(
    parts.tiles.map((t) => t.filename),
    ["v_01.mp4", "v_02.mp4", "v_03.mp4", "v_04.mp4"],
  );
  const def = planSplit(info, "clean", 1, "keep", "mute");
  assert.equal(def.tiles[0]?.filename, "clip.mp4");
});

test("clean full frame", () => {
  const plan = planSplit(video(1920, 1080), "clean", 4, "keep", "mute", "x");
  assert.deepEqual([plan.cols, plan.rows], [1, 1]);
  assert.equal(plan.tiles.length, 1);
  const tile = plan.tiles[0]!;
  assert.deepEqual([tile.w, tile.h], [1920, 1080]);
  assert.equal(tile.filename, "x.mp4");
  assert.equal(tile.label, "整段");
  assert.equal(plan.audio, "mute");
});

test("grid 2x2", () => {
  const plan = planSplit(video(1920, 1080, { duration: 1, has_audio: false }), "grid", 4, "keep");
  assert.deepEqual(
    plan.tiles.map((t) => [t.w, t.h]),
    [
      [960, 540],
      [960, 540],
      [960, 540],
      [960, 540],
    ],
  );
  assert.deepEqual(
    plan.tiles.map((t) => [t.col, t.row]),
    [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ],
  );
});

test("odd source center crop", () => {
  const plan = planSplit(video(1919, 1080, { duration: 1, fps: 24, has_audio: false }), "carousel", 4, "keep");
  assert.ok(plan.tiles.every((t) => t.w % 2 === 0 && t.h % 2 === 0));
  assert.equal(plan.canvas_w, plan.tiles[0]!.w * 4);
  assert.ok(plan.canvas_w + plan.canvas_x <= 1919);
});

test("suggest portrait stack", () => {
  const info = video(1080, 1920, { duration: 1, has_audio: false });
  const [layout, count] = suggestLayout(info);
  assert.equal(layout, "stack");
  assert.equal(count, 4);
  const plan = planSplit(info, layout, count, "keep");
  assert.equal(plan.tiles[0]?.w, 1080);
  assert.equal(plan.tiles[0]?.h, 480);
  assert.ok(plan.tiles.every((t) => t.x_ok));
});

test("x pad too skinny", () => {
  const fit = fitXDims(200, 1920);
  assert.equal(fit.padded, true);
  assert.ok(fit.outW / fit.outH >= X_MIN_AR - 1e-6);
});

test("safe stem keeps CJK", () => {
  assert.ok(safeStem("我的 切条 成片!!!").includes("切条"));
});

test("pixiv gif keeps original pixels and mutes", () => {
  const plan = planSplit(video(1920, 1080), "clean", 1, "pixiv", "all", "p");
  assert.equal(plan.tiles[0]?.filename, "p.gif");
  assert.equal(plan.tiles[0]?.out_w, 1920);
  assert.equal(plan.tiles[0]?.out_h, 1080);
  assert.equal(plan.tiles[0]?.padded, false);
  assert.equal(plan.tiles[0]?.scaled, false);
  assert.equal(plan.audio, "mute");
  assert.ok(plan.warnings.some((w) => w.includes("16MB")));
  assert.ok(plan.warnings.some((w) => w.includes("声音")));
  assert.match(sidecarText(plan), /GIF动图/);
});

test("pixiv still image stays png", () => {
  const info = video(800, 600, { kind: "image", duration: 0, fps: null, has_audio: false });
  const plan = planSplit(info, "clean", 1, "pixiv", "mute", "illust");
  assert.equal(plan.tiles[0]?.filename, "illust.png");
  assert.ok(!plan.warnings.some((w) => w.includes("GIF")));
});

test("pixiv does not warn about X aspect", () => {
  const plan = planSplit(video(200, 1920), "clean", 1, "pixiv");
  assert.equal(plan.tiles[0]?.x_ok, true);
  assert.ok(!plan.warnings.some((w) => w.includes("宽高比")));
});

test("pixiv split filenames", () => {
  const plan = planSplit(video(1920, 1080), "carousel", 4, "pixiv", "mute", "ugo");
  assert.deepEqual(
    plan.tiles.map((t) => t.filename),
    ["ugo_01.gif", "ugo_02.gif", "ugo_03.gif", "ugo_04.gif"],
  );
});

test("pixiv frame budget", () => {
  assert.equal(pixivFrameCount(6, 30), 180);
  assert.equal(pixivFrameCount(30, 30), PIXIV_GIF_MAX_FRAMES);
  assert.equal(pixivFrameCount(6, null), 180);
  assert.equal(pixivDelayMs(6, 180), 33);
  const ts = pixivFrameTimestamps(6, 4);
  assert.equal(ts.length, 4);
  assert.ok(ts[0]! > 0 && ts[3]! < 6);
});

test("pixiv caps extreme long side", () => {
  const fit = fitPixivDims(8000, 2000);
  assert.equal(fit.scaled, true);
  assert.equal(Math.max(fit.outW, fit.outH), PIXIV_GIF_MAX_SIDE);
  const plan = planSplit(video(8000, 2000), "clean", 1, "pixiv");
  assert.equal(plan.tiles[0]?.scaled, true);
  assert.ok(plan.tiles[0]!.out_w <= PIXIV_GIF_MAX_SIDE);
});

test("ugoira keeps original pixels and mutes", () => {
  const plan = planSplit(video(1920, 1080), "clean", 1, "ugoira", "all", "live");
  assert.equal(plan.tiles[0]?.filename, "live.zip");
  assert.equal(plan.tiles[0]?.out_w, 1920);
  assert.equal(plan.tiles[0]?.out_h, 1080);
  assert.equal(plan.audio, "mute");
  assert.ok(plan.warnings.some((w) => w.includes("选择多张图片")));
  assert.match(sidecarText(plan), /选择多张图片/);
});

test("ugoira frame budget", () => {
  assert.equal(ugoiraFrameCount(6, 30), 144);
  assert.equal(ugoiraFrameCount(6, 24), 144);
  assert.equal(ugoiraFrameCount(10, 30), PIXIV_UGOIRA_MAX_FRAMES);
  assert.equal(ugoiraFrameCount(15, 30), PIXIV_UGOIRA_MAX_FRAMES);
  assert.equal(ugoiraFrameName("clip", 0), "clip_001.jpg");
  assert.equal(ugoiraFrameName("clip", 149), "clip_150.jpg");
});

test("ugoira still image stays png", () => {
  const info = video(800, 600, { kind: "image", duration: 0, fps: null, has_audio: false });
  const plan = planSplit(info, "clean", 1, "ugoira", "mute", "illust");
  assert.equal(plan.tiles[0]?.filename, "illust.png");
});
