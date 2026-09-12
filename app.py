"""Local web UI for the X video/image splicer."""

from __future__ import annotations

import io
import os
import sys
import threading
import time
import uuid
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.formparsers import MultiPartParser

import splitter as sp

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
WORK = ROOT / "work"
OUTPUT = ROOT / "output"

if hasattr(MultiPartParser, "max_part_size"):
    MultiPartParser.max_part_size = 2 * 1024 ** 3
if hasattr(MultiPartParser, "max_file_size"):
    MultiPartParser.max_file_size = 2 * 1024 ** 3

WORK.mkdir(exist_ok=True)
OUTPUT.mkdir(exist_ok=True)

app = FastAPI(title="切条", docs_url=None, redoc_url=None)
app.mount("/static", StaticFiles(directory=STATIC), name="static")

_lock = threading.Lock()
_jobs: dict[str, "Job"] = {}


@dataclass
class Job:
    id: str
    source: Path
    original_name: str
    work_dir: Path
    out_dir: Path
    info: sp.MediaInfo
    preview: Path
    layout: sp.Layout = "carousel"
    count: int = 4
    quality: sp.Quality = "keep"
    audio: sp.AudioMode = "all"
    plan: sp.SplitPlan | None = None
    status: str = "ready"
    percent: float = 0.0
    message: str = ""
    error: str | None = None
    outputs: list[str] = field(default_factory=list)
    cancel: threading.Event = field(default_factory=threading.Event)
    thread: threading.Thread | None = None

    def snapshot(self) -> dict:
        return {
            "id": self.id,
            "name": self.original_name,
            "info": {
                "kind": self.info.kind,
                "width": self.info.width,
                "height": self.info.height,
                "duration": self.info.duration,
                "fps": self.info.fps,
                "has_audio": self.info.has_audio,
                "video_codec": self.info.video_codec,
                "audio_codec": self.info.audio_codec,
                "pix_fmt": self.info.pix_fmt,
                "label": self.info.label,
                "size_bytes": self.info.size_bytes,
            },
            "layout": self.layout,
            "count": self.count,
            "quality": self.quality,
            "audio": self.audio,
            "plan": self.plan.to_dict() if self.plan else None,
            "suggested": list(sp.suggest_layout(self.info)),
            "status": self.status,
            "percent": self.percent,
            "message": self.message,
            "error": self.error,
            "outputs": [
                {
                    "name": Path(p).name,
                    "url": f"/jobs/{self.id}/file/{Path(p).name}",
                    "bytes": Path(p).stat().st_size if Path(p).is_file() else 0,
                }
                for p in self.outputs
            ],
            "preview": f"/jobs/{self.id}/preview",
        }


def _job(job_id: str) -> Job:
    with _lock:
        job = _jobs.get(job_id)
    if not job:
        raise HTTPException(404, "没有这个任务")
    return job


async def _save_upload(upload: UploadFile) -> tuple[str, Path, str]:
    src_name = Path(upload.filename or "clip.mp4").name
    job_id = uuid.uuid4().hex[:12]
    work_dir = WORK / job_id
    work_dir.mkdir(parents=True, exist_ok=True)
    suffix = Path(src_name).suffix.lower() or ".mp4"
    source = work_dir / f"source{suffix}"
    with source.open("wb") as out:
        while True:
            chunk = await upload.read(1024 * 1024)
            if not chunk:
                break
            out.write(chunk)
    return job_id, source, src_name


def _make_job(job_id: str, source: Path, original_name: str) -> Job:
    work_dir = WORK / job_id
    work_dir.mkdir(parents=True, exist_ok=True)
    info = sp.probe(source)
    preview = work_dir / "preview.jpg"
    sp.extract_preview_frame(source, preview)
    layout, count = sp.suggest_layout(info)
    job = Job(
        id=job_id,
        source=source,
        original_name=original_name,
        work_dir=work_dir,
        out_dir=OUTPUT / job_id,
        info=info,
        preview=preview,
        layout=layout,
        count=count,
        audio="all" if info.has_audio else "mute",
    )
    job.plan = sp.plan_split(info, layout, count, job.quality, job.audio, Path(original_name).stem)
    with _lock:
        _jobs[job_id] = job
    return job


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


@app.get("/api/health")
def health():
    try:
        version = sp.ffmpeg_version()
        ok = True
        error = None
    except Exception as exc:
        version = ""
        ok = False
        error = str(exc)
    return {"ok": ok, "ffmpeg": version, "error": error}


@app.post("/api/open")
async def open_media(
    file: UploadFile | None = File(None),
    path: str | None = Form(None),
):
    try:
        if path and path.strip():
            source = Path(path.strip()).expanduser()
            if not source.is_file():
                raise HTTPException(400, f"找不到文件：{source}")
            job_id = uuid.uuid4().hex[:12]
            job = _make_job(job_id, source, source.name)
            return job.snapshot()
        if file is None or not file.filename:
            raise HTTPException(400, "请选择视频或图片")
        job_id, source, name = await _save_upload(file)
        if source.stat().st_size < 32:
            raise HTTPException(400, "文件是空的")
        job = _make_job(job_id, source, name)
        return job.snapshot()
    except HTTPException:
        raise
    except sp.SplitError as exc:
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(500, f"读文件失败：{exc}") from exc


@app.get("/api/jobs/{job_id}")
def job_status(job_id: str):
    return _job(job_id).snapshot()


@app.post("/api/jobs/{job_id}/plan")
async def update_plan(job_id: str, body: dict):
    job = _job(job_id)
    if job.status == "running":
        raise HTTPException(409, "正在切开，先等它结束。")
    layout = body.get("layout", job.layout)
    count = int(body.get("count", job.count))
    quality = body.get("quality", job.quality)
    audio = body.get("audio", job.audio)
    if layout not in ("carousel", "stack", "grid", "clean"):
        raise HTTPException(400, "切法不对")
    if quality not in ("keep", "x"):
        raise HTTPException(400, "画质档不对")
    if audio not in ("all", "first", "mute"):
        raise HTTPException(400, "声音选项不对")
    if layout == "grid":
        count = 4
    if layout == "clean":
        count = 1
        if audio == "first":
            audio = "mute"
    try:
        plan = sp.plan_split(
            job.info,
            layout,
            count,
            quality,
            audio,
            Path(job.original_name).stem,
        )
    except sp.SplitError as exc:
        raise HTTPException(400, str(exc)) from exc
    job.layout = layout
    job.count = count
    job.quality = quality
    job.audio = audio
    job.plan = plan
    job.status = "ready"
    job.error = None
    return job.snapshot()


@app.post("/api/jobs/{job_id}/split")
def start_split(job_id: str):
    job = _job(job_id)
    if job.status == "running":
        return job.snapshot()
    if job.plan is None:
        raise HTTPException(400, "还没有切分方案")
    job.status = "running"
    job.percent = 0
    job.message = "排队"
    job.error = None
    job.outputs = []
    job.cancel = threading.Event()

    def worker():
        try:
            def progress(pct: float, msg: str) -> None:
                job.percent = pct
                job.message = msg

            files = sp.run_split(
                job.info,
                job.plan,
                job.out_dir,
                progress=progress,
                cancel_event=job.cancel,
            )
            job.outputs = [str(p) for p in files]
            job.status = "done"
            job.percent = 100
            job.message = "切好了"
        except sp.SplitError as exc:
            job.status = "error"
            job.error = str(exc)
            job.message = "失败"
        except Exception as exc:
            job.status = "error"
            job.error = f"意外错误：{exc}"
            job.message = "失败"

    job.thread = threading.Thread(target=worker, daemon=True)
    job.thread.start()
    return job.snapshot()


@app.post("/api/jobs/{job_id}/cancel")
def cancel_split(job_id: str):
    job = _job(job_id)
    job.cancel.set()
    job.message = "正在取消"
    return job.snapshot()


@app.get("/jobs/{job_id}/preview")
def preview(job_id: str):
    job = _job(job_id)
    if not job.preview.is_file():
        raise HTTPException(404, "没有预览帧")
    return FileResponse(job.preview, media_type="image/jpeg")


@app.get("/jobs/{job_id}/file/{name}")
def job_file(job_id: str, name: str):
    job = _job(job_id)
    if "/" in name or "\\" in name or name in {".", ".."}:
        raise HTTPException(400, "文件名不合法")
    path = (job.out_dir / name).resolve()
    if path.parent != job.out_dir.resolve() or not path.is_file():
        raise HTTPException(404, "没有这个分片")
    media = "image/png" if path.suffix.lower() == ".png" else "video/mp4"
    return FileResponse(path, filename=name, media_type=media)


@app.get("/api/jobs/{job_id}/zip")
def job_zip(job_id: str):
    job = _job(job_id)
    if job.status != "done" or not job.outputs:
        raise HTTPException(400, "还没切完")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for p in job.outputs:
            path = Path(p)
            if path.is_file():
                zf.write(path, arcname=path.name)
        for extra in ("投稿顺序.txt", "split.json"):
            ep = job.out_dir / extra
            if ep.is_file():
                zf.write(ep, arcname=extra)
    buf.seek(0)
    stem = Path(job.original_name).stem
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{stem}_split.zip"'},
    )


@app.post("/api/jobs/{job_id}/reveal")
def reveal(job_id: str):
    job = _job(job_id)
    target = job.out_dir if job.out_dir.exists() else job.work_dir
    if os.name == "nt":
        os.startfile(target)  # noqa: S606
    elif sys.platform == "darwin":
        os.system(f'open "{target}"')  # noqa: S605
    else:
        os.system(f'xdg-open "{target}"')  # noqa: S605
    return {"ok": True, "path": str(target)}


def main() -> None:
    import webbrowser

    import uvicorn

    host = "127.0.0.1"
    port = int(os.environ.get("SPLICER_PORT", "8765"))
    url = f"http://{host}:{port}"

    def _open():
        time.sleep(0.7)
        if os.environ.get("SPLICER_NO_BROWSER") != "1":
            webbrowser.open(url)

    threading.Thread(target=_open, daemon=True).start()
    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
