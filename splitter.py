"""Spatial splitter for X carousel / stack / 2x2 posts.

Crops a video or image into ordered tiles without scaling the source pixels
unless the chosen profile has to fit X upload limits. Cropping requires a
re-encode; the default profile keeps resolution and uses a visually lossless
CRF so the tiles are as close to the source as H.264 will allow.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import threading
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Callable, Literal

CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0

Layout = Literal["carousel", "stack", "grid"]
Quality = Literal["keep", "x"]
AudioMode = Literal["all", "first", "mute"]
Kind = Literal["video", "image"]

IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}
VIDEO_EXT = {".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi", ".gif", ".wmv", ".mpeg", ".mpg"}

# X (Twitter) practical upload envelope, 2026.
X_MAX_LANDSCAPE = (1920, 1200)
X_MAX_PORTRAIT = (1200, 1920)
X_MIN_AR = 1 / 3
X_MAX_AR = 3 / 1
X_MIN_SIDE = 32
X_MAX_ATTACHMENTS = 4
X_STANDARD_DURATION = 140.0


class SplitError(RuntimeError):
    pass


def even(n: int) -> int:
    return n if n % 2 == 0 else n - 1


def even_floor_div(total: int, parts: int) -> int:
    if parts <= 0:
        raise ValueError("parts must be > 0")
    return even(total // parts)


def find_bin(name: str) -> str:
    exe = shutil.which(name) or shutil.which(f"{name}.exe")
    if exe:
        return exe
    local = os.environ.get("LOCALAPPDATA", "")
    candidates = [
        Path(local) / "Microsoft" / "WinGet" / "Links" / f"{name}.exe",
        Path("C:/ffmpeg/bin") / f"{name}.exe",
        Path(local) / "ffmpeg" / "bin" / f"{name}.exe",
    ]
    for path in candidates:
        if path.is_file():
            return str(path)
    raise SplitError(f"找不到 {name}。请先安装 FFmpeg 并确保它在 PATH 里。")


def ffmpeg_bin() -> str:
    return find_bin("ffmpeg")


def ffprobe_bin() -> str:
    return find_bin("ffprobe")


def run_hidden(cmd: list[str], **kwargs) -> subprocess.CompletedProcess:
    flags = kwargs.pop("creationflags", 0) | CREATE_NO_WINDOW
    return subprocess.run(
        cmd,
        creationflags=flags,
        **kwargs,
    )


@dataclass
class MediaInfo:
    path: str
    kind: Kind
    width: int
    height: int
    duration: float
    fps: float | None
    has_audio: bool
    video_codec: str
    audio_codec: str | None
    pix_fmt: str
    rotation: int
    sar: str
    nb_frames: int | None
    size_bytes: int

    @property
    def aspect(self) -> float:
        return self.width / self.height if self.height else 0.0

    @property
    def label(self) -> str:
        fps = f"{self.fps:.3g}fps" if self.fps else "still"
        dur = f"{self.duration:.2f}s" if self.kind == "video" else "image"
        return f"{self.width}×{self.height} · {self.video_codec} · {fps} · {dur}"


@dataclass
class Tile:
    index: int
    row: int
    col: int
    x: int
    y: int
    w: int
    h: int
    out_w: int
    out_h: int
    pad_w: int
    pad_h: int
    padded: bool
    scaled: bool
    filename: str
    aspect: float
    x_ok: bool
    label: str
    notes: list[str] = field(default_factory=list)


@dataclass
class SplitPlan:
    layout: Layout
    cols: int
    rows: int
    quality: Quality
    audio: AudioMode
    kind: Kind
    canvas_x: int
    canvas_y: int
    canvas_w: int
    canvas_h: int
    source_w: int
    source_h: int
    tiles: list[Tile]
    warnings: list[str]
    order_hint: str
    suggested: bool = False

    def to_dict(self) -> dict:
        data = asdict(self)
        return data


def _rotation_of(stream: dict) -> int:
    rot = 0
    tags = stream.get("tags") or {}
    if "rotate" in tags:
        try:
            rot = int(float(tags["rotate"]))
        except ValueError:
            rot = 0
    for sd in stream.get("side_data_list") or []:
        if sd.get("rotation") is not None:
            try:
                rot = int(float(sd["rotation"]))
            except ValueError:
                pass
    return rot % 360


def _fps_of(stream: dict) -> float | None:
    for key in ("avg_frame_rate", "r_frame_rate"):
        raw = stream.get(key) or "0/0"
        if "/" in raw:
            num, den = raw.split("/", 1)
            try:
                n, d = float(num), float(den)
                if d:
                    return n / d
            except ValueError:
                continue
    return None


def probe(path: str | Path) -> MediaInfo:
    path = Path(path)
    if not path.is_file():
        raise SplitError(f"文件不存在：{path}")
    cmd = [
        ffprobe_bin(),
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        str(path),
    ]
    proc = run_hidden(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if proc.returncode != 0:
        raise SplitError(f"ffprobe 读不了这个文件：{proc.stderr.strip() or path.name}")
    try:
        data = json.loads(proc.stdout or "{}")
    except json.JSONDecodeError as exc:
        raise SplitError("ffprobe 返回了无法解析的 JSON") from exc

    streams = data.get("streams") or []
    fmt = data.get("format") or {}
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    if video is None:
        raise SplitError("没有视频或图片轨。")

    width = int(video.get("width") or 0)
    height = int(video.get("height") or 0)
    rotation = _rotation_of(video)
    if abs(rotation) % 180 == 90:
        width, height = height, width
    if width < 2 or height < 2:
        raise SplitError("画面尺寸无效。")

    sar = video.get("sample_aspect_ratio") or "1:1"
    if sar not in ("1:1", "1/1", "N/A", "0:1"):
        try:
            a, b = re.split(r"[:/]", sar)
            sa, sb = float(a), float(b)
            if sa > 0 and sb > 0 and abs(sa / sb - 1) > 0.01:
                width = max(2, even(round(width * sa / sb)))
        except (ValueError, ZeroDivisionError):
            pass

    duration = 0.0
    for raw in (video.get("duration"), fmt.get("duration")):
        if raw not in (None, "N/A"):
            try:
                duration = float(raw)
                break
            except ValueError:
                continue

    nb_frames = None
    raw_frames = video.get("nb_frames")
    if raw_frames and raw_frames != "N/A":
        try:
            nb_frames = int(raw_frames)
        except ValueError:
            nb_frames = None

    ext = path.suffix.lower()
    codec = (video.get("codec_name") or "").lower()
    is_image = ext in IMAGE_EXT and (duration <= 0.15 or (nb_frames is not None and nb_frames <= 1))
    if codec in {"png", "mjpeg", "bmp", "tiff", "webp"} and (nb_frames == 1 or duration <= 0.05):
        is_image = True
    if ext == ".gif" or (ext == ".webp" and duration > 0.2 and (nb_frames or 2) > 1):
        is_image = False

    size_bytes = 0
    try:
        size_bytes = int(fmt.get("size") or path.stat().st_size)
    except OSError:
        size_bytes = 0

    return MediaInfo(
        path=str(path.resolve()),
        kind="image" if is_image else "video",
        width=width,
        height=height,
        duration=duration,
        fps=_fps_of(video),
        has_audio=audio is not None,
        video_codec=codec or "unknown",
        audio_codec=(audio or {}).get("codec_name"),
        pix_fmt=video.get("pix_fmt") or "",
        rotation=rotation,
        sar=sar,
        nb_frames=nb_frames,
        size_bytes=size_bytes,
    )


def aspect_ok(w: int, h: int) -> bool:
    if w <= 0 or h <= 0:
        return False
    ar = w / h
    return X_MIN_AR - 1e-6 <= ar <= X_MAX_AR + 1e-6


def fit_x_dims(w: int, h: int) -> tuple[int, int, int, int, bool, bool]:
    """Return (out_w, out_h, pad_w, pad_h, padded, scaled). Never upscales."""
    w, h = max(2, even(w)), max(2, even(h))
    pad_w, pad_h = w, h
    padded = False
    ar = w / h
    if ar < X_MIN_AR:
        pad_w = even(max(2, round(h * X_MIN_AR)))
        padded = True
    elif ar > X_MAX_AR:
        pad_h = even(max(2, round(w / X_MAX_AR)))
        padded = True

    max_w, max_h = X_MAX_LANDSCAPE if pad_w >= pad_h else X_MAX_PORTRAIT
    scale = min(1.0, max_w / pad_w, max_h / pad_h)
    scaled = scale < 0.999
    if scaled:
        out_w = max(2, even(round(pad_w * scale)))
        out_h = max(2, even(round(pad_h * scale)))
    else:
        out_w, out_h = pad_w, pad_h
    return out_w, out_h, pad_w, pad_h, padded, scaled


def best_count_for_carousel(width: int, height: int) -> int:
    for n in (4, 3, 2):
        tw = even_floor_div(width, n)
        th = even(height)
        if tw >= X_MIN_SIDE and th >= X_MIN_SIDE and aspect_ok(tw, th):
            return n
    return 2


def best_count_for_stack(width: int, height: int) -> int:
    for n in (4, 3, 2):
        tw = even(width)
        th = even_floor_div(height, n)
        if tw >= X_MIN_SIDE and th >= X_MIN_SIDE and aspect_ok(tw, th):
            return n
    return 2


def suggest_layout(info: MediaInfo) -> tuple[Layout, int]:
    w, h = info.width, info.height
    if h > w * 1.12:
        return "stack", best_count_for_stack(w, h)
    if w > h * 1.12:
        return "carousel", best_count_for_carousel(w, h)
    return "grid", 4


def layout_shape(layout: Layout, count: int) -> tuple[int, int]:
    if layout == "carousel":
        if count not in (2, 3, 4):
            raise SplitError("横滑连环只支持 2 / 3 / 4 条。")
        return count, 1
    if layout == "stack":
        if count not in (2, 3, 4):
            raise SplitError("上下堆叠只支持 2 / 3 / 4 条。")
        return 1, count
    if layout == "grid":
        return 2, 2
    raise SplitError(f"未知切法：{layout}")


def order_hint(layout: Layout) -> str:
    if layout == "carousel":
        return "从左到右：01 → 02 → 03 → 04。一次选中全部附件，不要打乱。"
    if layout == "stack":
        return "从上到下：01 → 02 → 03 → 04。点开帖子后竖着滑才接得上。"
    return "左上 01、右上 02、左下 03、右下 04。适合还在用宫格的时间线 / Bluesky。"


def plan_split(
    info: MediaInfo,
    layout: Layout,
    count: int = 4,
    quality: Quality = "keep",
    audio: AudioMode = "all",
    stem: str | None = None,
) -> SplitPlan:
    cols, rows = layout_shape(layout, count)
    tile_w = even_floor_div(info.width, cols)
    tile_h = even_floor_div(info.height, rows)
    if tile_w < 2 or tile_h < 2:
        raise SplitError("源画面太小，裁不开这么多份。")

    canvas_w = tile_w * cols
    canvas_h = tile_h * rows
    canvas_x = even((info.width - canvas_w) // 2)
    canvas_y = even((info.height - canvas_h) // 2)

    warnings: list[str] = []
    drop_x = info.width - canvas_w
    drop_y = info.height - canvas_h
    if drop_x or drop_y:
        warnings.append(
            f"为了对齐偶数像素，画面被居中裁掉 {drop_x}×{drop_y} 像素"
            f"（源 {info.width}×{info.height} → 使用 {canvas_w}×{canvas_h}）。"
        )

    if info.kind == "video" and info.duration > X_STANDARD_DURATION:
        warnings.append(
            f"时长 {info.duration:.1f}s，超过 X 普通账号 140 秒上限。Premium 才能发更长的。"
        )

    ext = ".png" if info.kind == "image" else ".mp4"
    base = _safe_stem(stem or Path(info.path).stem)

    tiles: list[Tile] = []
    for r in range(rows):
        for c in range(cols):
            idx = r * cols + c + 1
            x = canvas_x + c * tile_w
            y = canvas_y + r * tile_h
            out_w, out_h = tile_w, tile_h
            pad_w, pad_h = tile_w, tile_h
            padded = scaled = False
            notes: list[str] = []
            if quality == "x":
                out_w, out_h, pad_w, pad_h, padded, scaled = fit_x_dims(tile_w, tile_h)
                if padded:
                    notes.append("按 X 的 1:3–3:1 补了黑边")
                if scaled:
                    notes.append("超过 X 分辨率上限，已缩小（不放大）")
            ok = aspect_ok(out_w, out_h) and out_w <= max(X_MAX_LANDSCAPE[0], X_MAX_PORTRAIT[0])
            if quality == "keep" and not aspect_ok(tile_w, tile_h):
                notes.append("宽高比超出 X 的 1:3–3:1，上传可能被加黑边或拒收")
                warnings.append(f"{idx:02d} 的 {tile_w}×{tile_h} 宽高比不在 X 允许范围。")
                ok = False
            max_w, max_h = X_MAX_LANDSCAPE if out_w >= out_h else X_MAX_PORTRAIT
            if quality == "keep" and (tile_w > max_w or tile_h > max_h):
                notes.append("超过 X 分辨率上限")
                warnings.append(f"{idx:02d} 为 {tile_w}×{tile_h}，超过 X 上限 {max_w}×{max_h}。")
                ok = False
            tiles.append(
                Tile(
                    index=idx,
                    row=r,
                    col=c,
                    x=x,
                    y=y,
                    w=tile_w,
                    h=tile_h,
                    out_w=out_w,
                    out_h=out_h,
                    pad_w=pad_w,
                    pad_h=pad_h,
                    padded=padded,
                    scaled=scaled,
                    filename=f"{base}_{idx:02d}{ext}",
                    aspect=(out_w / out_h) if out_h else 0,
                    x_ok=ok,
                    label=f"{idx:02d}",
                    notes=notes,
                )
            )

    total = cols * rows
    if total > X_MAX_ATTACHMENTS:
        warnings.append(f"切出 {total} 份，X 一条帖最多 4 个附件。")

    if info.kind == "video" and not info.has_audio and audio != "mute":
        warnings.append("源视频没有音轨，输出也是静音。")

    return SplitPlan(
        layout=layout,
        cols=cols,
        rows=rows,
        quality=quality,
        audio=audio if info.kind == "video" else "mute",
        kind=info.kind,
        canvas_x=canvas_x,
        canvas_y=canvas_y,
        canvas_w=canvas_w,
        canvas_h=canvas_h,
        source_w=info.width,
        source_h=info.height,
        tiles=tiles,
        warnings=warnings,
        order_hint=order_hint(layout),
    )


def _safe_stem(stem: str) -> str:
    cleaned = re.sub(r"[^\w\u4e00-\u9fff\-]+", "_", stem, flags=re.UNICODE).strip("_")
    return (cleaned or "clip")[:80]


def _tile_filter(tile: Tile, quality: Quality, kind: Kind) -> str:
    chain = [f"crop={tile.w}:{tile.h}:{tile.x}:{tile.y}", "setsar=1"]
    if quality == "x":
        if tile.padded and (tile.pad_w != tile.w or tile.pad_h != tile.h):
            chain.append(f"pad={tile.pad_w}:{tile.pad_h}:(ow-iw)/2:(oh-ih)/2:black")
        if tile.scaled and (tile.out_w != tile.pad_w or tile.out_h != tile.pad_h):
            chain.append(
                f"scale={tile.out_w}:{tile.out_h}:flags=lanczos:force_original_aspect_ratio=disable"
            )
    chain.append("format=rgb24" if kind == "image" else "format=yuv420p")
    return ",".join(chain)


def build_filter_complex(plan: SplitPlan) -> str:
    n = len(plan.tiles)
    if n == 1:
        labels = ["[s0]"]
        split = "[0:v]split=1[s0];"
    else:
        labels = [f"[s{i}]" for i in range(n)]
        split = f"[0:v]split={n}{''.join(labels)};"
    parts = [split]
    for i, tile in enumerate(plan.tiles):
        parts.append(
            f"{labels[i]}{_tile_filter(tile, plan.quality, plan.kind)}[v{i}]"
        )
    return "".join(p if p.endswith(";") else p + ";" for p in parts[:-1]) + parts[-1]


def _video_encode_args(quality: Quality) -> list[str]:
    if quality == "keep":
        return [
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            "14",
            "-profile:v",
            "high",
            "-pix_fmt",
            "yuv420p",
        ]
    return [
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "16",
        "-profile:v",
        "high",
        "-pix_fmt",
        "yuv420p",
    ]


def _image_encode_args() -> list[str]:
    return ["-frames:v", "1", "-c:v", "png"]


def _audio_args() -> list[str]:
    return ["-c:a", "aac", "-b:a", "192k", "-ac", "2", "-ar", "44100"]


def _meta_args() -> list[str]:
    # Fresh container: drop global / stream / chapter metadata. Cropping already
    # re-encodes the video, so C2PA / XMP / uuid boxes in the original file are
    # not copied. This is not a pixel-watermark remover.
    return [
        "-map_metadata",
        "-1",
        "-map_chapters",
        "-1",
        "-fflags",
        "+bitexact",
    ]


def build_ffmpeg_command(
    info: MediaInfo,
    plan: SplitPlan,
    out_dir: Path,
) -> list[str]:
    out_dir.mkdir(parents=True, exist_ok=True)
    cmd: list[str] = [
        ffmpeg_bin(),
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-progress",
        "pipe:1",
        "-nostats",
        "-i",
        info.path,
        "-filter_complex",
        build_filter_complex(plan),
    ]
    for i, tile in enumerate(plan.tiles):
        out_path = out_dir / tile.filename
        cmd += ["-map", f"[v{i}]"]
        want_audio = info.kind == "video" and info.has_audio and (
            plan.audio == "all" or (plan.audio == "first" and i == 0)
        )
        if want_audio:
            cmd += ["-map", "0:a:0"]
        else:
            cmd += ["-an"]
        if info.kind == "image":
            cmd += _image_encode_args()
        else:
            cmd += _video_encode_args(plan.quality)
            cmd += ["-movflags", "+faststart"]
            if want_audio:
                cmd += _audio_args()
        cmd += _meta_args()
        cmd += [str(out_path)]
    return cmd


ProgressCb = Callable[[float, str], None]


def _parse_progress_line(line: str, duration: float) -> float | None:
    line = line.strip()
    if line.startswith("out_time_us="):
        raw = line.split("=", 1)[1]
        if raw.isdigit() and duration > 0:
            return min(99.0, max(0.0, int(raw) / 1_000_000 / duration * 100.0))
    if line.startswith("out_time_ms="):
        raw = line.split("=", 1)[1]
        if raw.isdigit() and duration > 0:
            return min(99.0, max(0.0, int(raw) / 1_000 / duration * 100.0))
    if line == "progress=end":
        return 100.0
    return None


def run_split(
    info: MediaInfo,
    plan: SplitPlan,
    out_dir: str | Path,
    progress: ProgressCb | None = None,
    cancel_event=None,
) -> list[Path]:
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    cmd = build_ffmpeg_command(info, plan, out_dir)
    if progress:
        progress(1.0, "开始编码")

    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        creationflags=CREATE_NO_WINDOW,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    err_chunks: list[str] = []

    def _drain_stderr() -> None:
        if proc.stderr is None:
            return
        for line in proc.stderr:
            err_chunks.append(line)

    drain = threading.Thread(target=_drain_stderr, daemon=True)
    drain.start()
    try:
        assert proc.stdout is not None
        for line in proc.stdout:
            if cancel_event is not None and cancel_event.is_set():
                proc.kill()
                raise SplitError("已取消。")
            pct = _parse_progress_line(line, info.duration or 0)
            if pct is not None and progress:
                progress(pct, f"编码 {pct:.0f}%")
        code = proc.wait()
        drain.join(timeout=5)
        err_tail = [ln.strip() for ln in err_chunks if ln.strip()][-40:]
    except Exception:
        if proc.poll() is None:
            proc.kill()
        drain.join(timeout=2)
        raise
    finally:
        if proc.stdout:
            proc.stdout.close()
        if proc.stderr:
            proc.stderr.close()

    if code != 0:
        detail = "\n".join(err_tail[-12:]) or "ffmpeg 失败，没有错误输出。"
        raise SplitError(f"ffmpeg 退出码 {code}:\n{detail}")

    outputs: list[Path] = []
    for tile in plan.tiles:
        path = out_dir / tile.filename
        if not path.is_file() or path.stat().st_size < 32:
            raise SplitError(f"没有写出 {tile.filename}")
        outputs.append(path)

    write_sidecar(info, plan, out_dir)
    if progress:
        progress(100.0, "完成")
    return outputs


def write_sidecar(info: MediaInfo, plan: SplitPlan, out_dir: Path) -> None:
    order_lines = [
        "X 投稿顺序（一次选中全部，不要打乱）",
        plan.order_hint,
        "",
    ]
    for tile in plan.tiles:
        order_lines.append(
            f"{tile.label}  {tile.filename}  {tile.out_w}x{tile.out_h}  行{tile.row+1}列{tile.col+1}"
        )
    (out_dir / "投稿顺序.txt").write_text("\n".join(order_lines) + "\n", encoding="utf-8")
    payload = {
        "source": info.path,
        "source_label": info.label,
        "plan": plan.to_dict(),
    }
    (out_dir / "split.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def extract_preview_frame(path: str | Path, dest: str | Path, ss: float | None = None) -> Path:
    path = Path(path)
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    info = probe(path)
    t = 0.0
    if info.kind == "video" and info.duration > 0:
        t = ss if ss is not None else min(max(info.duration * 0.15, 0.0), max(info.duration - 0.05, 0.0))
    cmd = [
        ffmpeg_bin(),
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
    ]
    if t > 0:
        cmd += ["-ss", f"{t:.3f}"]
    cmd += [
        "-i",
        str(path),
        "-frames:v",
        "1",
        "-q:v",
        "3",
        str(dest),
    ]
    proc = run_hidden(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if proc.returncode != 0 or not dest.is_file():
        raise SplitError(f"抽帧失败：{proc.stderr.strip() or dest}")
    return dest


def ffmpeg_version() -> str:
    proc = run_hidden(
        [ffmpeg_bin(), "-version"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    first = (proc.stdout or "").splitlines()[0] if proc.stdout else ""
    return first.strip() or "ffmpeg"


def main(argv: list[str] | None = None) -> int:
    import argparse

    p = argparse.ArgumentParser(description="把视频/图片切成 X 连环帖用的有序分片")
    p.add_argument("input")
    p.add_argument("--layout", choices=["carousel", "stack", "grid"], default=None)
    p.add_argument("--count", type=int, default=None)
    p.add_argument("--quality", choices=["keep", "x"], default="keep")
    p.add_argument("--audio", choices=["all", "first", "mute"], default="all")
    p.add_argument("--out", default=None)
    args = p.parse_args(argv)

    info = probe(args.input)
    layout, count = suggest_layout(info)
    if args.layout:
        layout = args.layout
    if args.count:
        count = args.count
    if layout == "grid":
        count = 4
    plan = plan_split(info, layout, count, args.quality, args.audio)
    out = Path(args.out) if args.out else Path(info.path).with_name(Path(info.path).stem + "_split")
    print(info.label)
    print(f"{layout} {plan.cols}x{plan.rows} → {len(plan.tiles)} files in {out}")
    for w in plan.warnings:
        print("!", w)
    run_split(info, plan, out, progress=lambda pct, msg: print(f"\r{msg} {pct:5.1f}%", end="", flush=True))
    print()
    for tile in plan.tiles:
        print(out / tile.filename)
    return 0


if __name__ == "__main__":
    sys.exit(main())
