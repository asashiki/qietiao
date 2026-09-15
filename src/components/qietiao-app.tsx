import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  browserCanEncodeVideo,
  downloadBlob,
  probeMedia,
  splitMedia,
  type OutputFile,
} from "@/lib/media";
import {
  formatBytes,
  planSplit,
  sidecarText,
  SplitError,
  type AudioMode,
  type Layout,
  type MediaInfo,
  PIXIV_GIF_MAX_BYTES,
  type Quality,
  type SplitPlan,
  type Tile,
} from "@/lib/splitter";
import { zipBlobs } from "@/lib/zip";

type Status = "idle" | "ready" | "running" | "done" | "error";

function FramePlayer({
  frames,
  delayMs,
  className,
  alt,
}: {
  frames: { url: string }[];
  delayMs: number;
  className?: string;
  alt?: string;
}) {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (frames.length < 2) return;
    const id = window.setInterval(() => {
      setI((n) => (n + 1) % frames.length);
    }, Math.max(20, delayMs || 80));
    return () => window.clearInterval(id);
  }, [frames, delayMs]);
  const src = frames[i]?.url ?? frames[0]?.url;
  if (!src) return null;
  return <img className={className} src={src} alt={alt ?? ""} draggable={false} />;
}

function shotInner(
  info: MediaInfo,
  previewUrl: string,
  tile: Tile,
  outputs: OutputFile[],
  done: boolean,
  asImage: boolean,
) {
  const out = outputs.find((o) => o.name === tile.filename);
  if (done && out) {
    if (out.frames?.length) {
      return (
        <FramePlayer className="fit" frames={out.frames} delayMs={out.delayMs ?? 80} alt={tile.filename} />
      );
    }
    if (asImage) {
      return <img className="fit" src={out.url} alt={tile.filename} draggable={false} />;
    }
    return <video className="fit" src={out.url} muted autoPlay loop playsInline />;
  }
  const wPct = (info.width / tile.w) * 100;
  const hPct = (info.height / tile.h) * 100;
  const left = (-tile.x / tile.w) * 100;
  const top = (-tile.y / tile.h) * 100;
  return (
    <img
      src={previewUrl}
      alt=""
      draggable={false}
      style={{ width: `${wPct}%`, height: `${hPct}%`, left: `${left}%`, top: `${top}%` }}
    />
  );
}

function tileVars(plan: SplitPlan): React.CSSProperties {
  const t = plan.tiles[0]!;
  return {
    ["--tile-w" as string]: t.out_w,
    ["--tile-h" as string]: t.out_h,
    ["--cols" as string]: plan.cols,
    ["--rows" as string]: plan.rows,
  };
}

function DownloadLink({
  href,
  name,
  className,
  children,
}: {
  href: string;
  name: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <a className={className} href={href} download={name} target="_blank" rel="noopener">
      {children}
    </a>
  );
}

function Seg({
  value,
  options,
  attr,
  onChange,
  className,
}: {
  value: string;
  options: { value: string; label: string }[];
  attr: string;
  onChange: (v: string) => void;
  className?: string;
}) {
  return (
    <div className={className ? `seg ${className}` : "seg"} role="radiogroup">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className={`seg-btn${value === opt.value ? " on" : ""}`}
          {...{ [attr]: opt.value }}
          aria-pressed={value === opt.value}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export function QietiaoApp() {
  const [file, setFile] = useState<File | null>(null);
  const [info, setInfo] = useState<MediaInfo | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [layout, setLayout] = useState<Layout>("clean");
  const [count, setCount] = useState(4);
  const [quality, setQuality] = useState<Quality>("keep");
  const [audio, setAudio] = useState<AudioMode>("mute");
  const [stem, setStem] = useState("clip");
  const [status, setStatus] = useState<Status>("idle");
  const [percent, setPercent] = useState(0);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [outputs, setOutputs] = useState<OutputFile[]>([]);
  const [hot, setHot] = useState(false);
  const [health, setHealth] = useState("本机处理 · 不上传");
  const [healthBad, setHealthBad] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const urlsRef = useRef<string[]>([]);

  const rememberUrl = useCallback((url: string) => {
    urlsRef.current.push(url);
    return url;
  }, []);

  const revokeAll = useCallback(() => {
    for (const url of urlsRef.current) URL.revokeObjectURL(url);
    urlsRef.current = [];
  }, []);

  useEffect(() => {
    void browserCanEncodeVideo().then((ok) => {
      if (ok) {
        setHealth("本机处理 · 不上传");
        setHealthBad(false);
      } else {
        setHealth("可切图片 · 视频需 Chrome / Edge");
        setHealthBad(true);
      }
    });
    return () => {
      abortRef.current?.abort();
      revokeAll();
    };
  }, [revokeAll]);

  const plan = useMemo<SplitPlan | null>(() => {
    if (!info) return null;
    try {
      return planSplit(info, layout, count, quality, audio, stem);
    } catch (err) {
      return null;
    }
  }, [info, layout, count, quality, audio, stem]);

  const planError = useMemo(() => {
    if (!info) return null;
    try {
      planSplit(info, layout, count, quality, audio, stem);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : "方案算不出来";
    }
  }, [info, layout, count, quality, audio, stem]);

  async function openFile(next: File) {
    abortRef.current?.abort();
    setStatus("idle");
    setError(null);
    setOutputs([]);
    setMessage("在读…");
    try {
      const probed = await probeMedia(next);
      revokeAll();
      rememberUrl(probed.previewUrl);
      setFile(next);
      setInfo(probed.info);
      setPreviewUrl(probed.previewUrl);
      setStatus("ready");
      setPercent(0);
      setMessage("");
    } catch (err) {
      setInfo(null);
      setFile(null);
      setPreviewUrl(null);
      setStatus("idle");
      setMessage("");
      window.alert(err instanceof Error ? err.message : "读不了这个文件");
    }
  }

  function changeLayout(next: Layout) {
    const prev = layout;
    setLayout(next);
    if (next === "grid") setCount(4);
    if (next === "clean") {
      setCount(1);
      if (prev !== "clean") setAudio("mute");
    }
    setStatus((s) => (s === "done" || s === "error" ? "ready" : s));
    setOutputs([]);
    setError(null);
  }

  async function cut() {
    if (!file || !info) return;
    let nextPlan: SplitPlan;
    try {
      nextPlan = planSplit(info, layout, count, quality, audio, stem);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "方案算不出来");
      return;
    }
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setStatus("running");
    setPercent(0);
    setMessage(quality === "ugoira" && info.kind === "video" ? "开始抽帧" : quality === "pixiv" && info.kind === "video" ? "开始编 GIF" : "开始编码");
    setError(null);
    setOutputs([]);
    try {
      const files = await splitMedia({
        file,
        info,
        plan: nextPlan,
        signal: ac.signal,
        onProgress: (p, msg) => {
          setPercent(p);
          setMessage(msg);
        },
      });
      for (const f of files) {
        rememberUrl(f.url);
        for (const fr of f.frames ?? []) rememberUrl(fr.url);
      }
      setOutputs(files);
      setStatus("done");
      setPercent(100);
      setMessage("切好了");
    } catch (err) {
      const text = err instanceof SplitError || err instanceof Error ? err.message : "失败";
      setStatus("error");
      setError(text);
      setMessage("失败");
    }
  }

  function cancel() {
    abortRef.current?.abort();
    setMessage("正在取消");
  }

  async function downloadZip() {
    if (!outputs.length || !plan || !file) return;
    const extra = new Blob([sidecarText(plan)], { type: "text/plain;charset=utf-8" });
    const zip = await zipBlobs([
      ...outputs.map((o) => ({ name: o.name, blob: o.blob })),
      { name: "投稿顺序.txt", blob: extra },
    ]);
    const stemName = file.name.replace(/\.[^.]+$/, "") || "clip";
    downloadBlob(zip, `${stemName}_split.zip`);
  }

  useEffect(() => {
    const prevent = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
    };
    const onEnter = (e: DragEvent) => {
      prevent(e);
      setHot(true);
      document.body.classList.add("dragging");
    };
    const onLeave = (e: DragEvent) => {
      prevent(e);
      if (e.target !== document.body && e.relatedTarget) return;
      setHot(false);
      document.body.classList.remove("dragging");
    };
    const onDrop = (e: DragEvent) => {
      prevent(e);
      setHot(false);
      document.body.classList.remove("dragging");
      const f = e.dataTransfer?.files?.[0];
      if (f) void openFile(f);
    };
    document.addEventListener("dragenter", onEnter);
    document.addEventListener("dragover", onEnter);
    document.addEventListener("dragleave", onLeave);
    document.addEventListener("drop", onDrop);
    return () => {
      document.removeEventListener("dragenter", onEnter);
      document.removeEventListener("dragover", onEnter);
      document.removeEventListener("dragleave", onLeave);
      document.removeEventListener("drop", onDrop);
      document.body.classList.remove("dragging");
    };
  }, []);

  useEffect(() => {
    if (status !== "done" || !outputs.length) return;
    document.querySelector(".results")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [status, outputs.length]);

  const running = status === "running";
  const clean = layout === "clean";
  const first = plan?.tiles[0];
  const warnings = planError ? [planError] : (plan?.warnings ?? []);
  const asImage = info?.kind === "image" || quality === "pixiv" || quality === "ugoira";
  const pixivGif = quality === "pixiv" && info?.kind === "video";
  const pixivUgoira = quality === "ugoira" && info?.kind === "video";
  const pixivFamily = quality === "pixiv" || quality === "ugoira";
  const solo = outputs.length === 1 ? outputs[0] : null;

  return (
    <>
      <div className="grain" aria-hidden="true" />
      <header className="mast">
        <div className="mast-copy">
          <p className="eyebrow">Splicer for X</p>
          <h1>切条</h1>
        </div>
        <p className={`health${healthBad ? " bad" : ""}`}>{health}</p>
      </header>

      <main className="bench">
        <aside className="chest">
          <form className="chest-form" autoComplete="off" onSubmit={(e) => e.preventDefault()}>
            <section className="tool">
              <h2>片源</h2>
              <label className={`drop${hot ? " hot" : ""}`}>
                <input
                  type="file"
                  accept="video/*,image/*,.mp4,.mov,.webm,.mkv,.gif,.png,.jpg,.jpeg,.webp"
                  suppressHydrationWarning
                  onClick={(e) => {
                    e.currentTarget.value = "";
                  }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void openFile(f);
                  }}
                />
                <span className="drop-kicker">放下视频或图片</span>
                <span className="drop-sub">{file ? file.name : "点这里选，或拖进来"}</span>
              </label>
              <p className="meta">
                {info
                  ? `${info.width}×${info.height}${
                      info.kind === "video" && info.duration ? ` · ${info.duration.toFixed(1)}s` : ""
                    }`
                  : message === "在读…"
                    ? "在读…"
                    : ""}
              </p>
            </section>

            <section className="tool">
              <h2>切法</h2>
              <Seg
                value={layout}
                attr="data-layout"
                onChange={(v) => changeLayout(v as Layout)}
                options={[
                  { value: "clean", label: "整段" },
                  { value: "carousel", label: "横滑" },
                  { value: "stack", label: "竖叠" },
                  { value: "grid", label: "宫格" },
                ]}
              />
              {clean || layout === "grid" ? null : (
                <div className="seg count-seg" role="radiogroup" aria-label="份数" style={{ marginTop: 8 }}>
                  {(["2", "3", "4"] as const).map((n) => (
                    <button
                      key={n}
                      type="button"
                      className={`seg-btn${count === Number(n) ? " on" : ""}`}
                      data-count={n}
                      onClick={() => {
                        setCount(Number(n));
                        setStatus((s) => (s === "done" || s === "error" ? "ready" : s));
                        setOutputs([]);
                      }}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              )}
            </section>

            <section className="tool">
              <h2>画质</h2>
              <Seg
                className="quality-seg"
                value={pixivFamily ? "pixiv-family" : quality}
                attr="data-quality"
                onChange={(v) => {
                  const next = (v === "pixiv-family" ? "ugoira" : v) as Quality;
                  setQuality(next);
                  if (next === "pixiv" || next === "ugoira") setAudio("mute");
                  setStatus((s) => (s === "done" || s === "error" ? "ready" : s));
                  setOutputs([]);
                }}
                options={[
                  { value: "keep", label: "原像素" },
                  { value: "x", label: "X 投稿" },
                  { value: "pixiv-family", label: "Pixiv" },
                ]}
              />
              {pixivFamily ? (
                <>
                  <Seg
                    className="pixiv-kind"
                    value={quality}
                    attr="data-pixiv-kind"
                    onChange={(v) => {
                      setQuality(v as Quality);
                      setAudio("mute");
                      setStatus((s) => (s === "done" || s === "error" ? "ready" : s));
                      setOutputs([]);
                    }}
                    options={[
                      { value: "ugoira", label: "动图" },
                      { value: "pixiv", label: "GIF" },
                    ]}
                  />
                  <p className="meta">
                    {info?.kind === "image"
                      ? "静图仍出 PNG，Pixiv 插画不压画质"
                      : quality === "ugoira"
                        ? "JPEG 连帧 · 150 张 / 30MB，比 GIF 清晰。电脑版点「选择多张图片」"
                        : "GIF 只有 256 色，细雨和渐变会发糊。上限 16MB / 500 帧"}
                  </p>
                </>
              ) : null}
            </section>

            {info?.kind === "image" || pixivFamily ? null : (
              <section className="tool">
                <h2>声音</h2>
                <Seg
                  value={audio}
                  attr="data-audio"
                  onChange={(v) => {
                    setAudio(v as AudioMode);
                    setStatus((s) => (s === "done" || s === "error" ? "ready" : s));
                    setOutputs([]);
                  }}
                  options={[
                    { value: "all", label: "保留" },
                    { value: "mute", label: "去掉" },
                  ]}
                />
              </section>
            )}

            <section className="tool">
              <h2>文件名</h2>
              <label className="path-label">
                导出
                <input
                  type="text"
                  value={stem}
                  maxLength={80}
                  spellCheck={false}
                  suppressHydrationWarning
                  onChange={(e) => setStem(e.target.value)}
                  onBlur={() => setStem((s) => s.trim() || "clip")}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                  }}
                />
              </label>
            </section>

            {warnings.length ? <p className="warn">{warnings.join("\n")}</p> : null}
            <p className="tile-spec">{first?.filename ?? ""}</p>

            <button type="button" className="blade" disabled={!info || running || Boolean(planError)} onClick={() => void cut()}>
              <span>
                {pixivUgoira
                  ? clean
                    ? "转成动图"
                    : "切开成动图"
                  : pixivGif
                    ? clean
                      ? "转成 GIF"
                      : "切开成 GIF"
                    : clean
                      ? "重封装"
                      : "切开"}
              </span>
            </button>
            {running ? (
              <button type="button" className="ghost" onClick={cancel}>
                取消
              </button>
            ) : null}
            {status === "done" && solo ? (
              <DownloadLink className="blade" href={solo.url} name={solo.name}>
                <span>下载</span>
              </DownloadLink>
            ) : null}
            {status === "done" && outputs.length > 1 ? (
              <button type="button" className="blade" onClick={() => void downloadZip()}>
                <span>打包下载</span>
              </button>
            ) : null}
            {status === "done" && outputs.length ? (
              <p className="meta">请点下载拿原文件。复制预览图会变成一张很小的静图。</p>
            ) : null}
            {running || status === "error" ? (
              <div className="progress">
                <div className="progress-bar" style={{ width: `${percent}%` }} />
                <p className="progress-text">
                  {status === "error" ? error || "失败" : `${message} ${Math.round(percent)}%`}
                </p>
              </div>
            ) : null}
          </form>
        </aside>

        <section className="stage" aria-label="切条预览">
          <div className="table">
            {!plan || !info || !previewUrl ? (
              <div className="empty">
                <p>把成片放上切台。</p>
              </div>
            ) : (
              <div className="film" style={tileVars(plan)}>
                <div className="sprocket left" aria-hidden="true" />
                <div className={`pieces ${plan.layout}`}>
                  {plan.tiles.map((tile) => (
                    <div className="piece" key={tile.index}>
                      <span className="tab">{tile.label}</span>
                      <div className="piece-shot">
                        {shotInner(info, previewUrl, tile, outputs, status === "done", asImage)}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="sprocket right" aria-hidden="true" />
              </div>
            )}
          </div>
          <p className="order">{plan && plan.layout !== "clean" ? plan.order_hint : ""}</p>
        </section>

        <aside className="handset-col">
          <p className="handset-label">手机上长这样</p>
          <div className="handset">
            <div className="notch" aria-hidden="true" />
            <div
              className={`handset-screen${plan ? ` ${plan.layout}` : ""}`}
              style={plan ? tileVars(plan) : undefined}
            >
              {!plan || !info || !previewUrl ? (
                <p className="phone-empty">拖片子进来</p>
              ) : (
                plan.tiles.map((tile) => (
                  <div className="phone-slide" key={tile.index}>
                    <div className="piece-shot">
                      {shotInner(info, previewUrl, tile, outputs, status === "done", asImage)}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </aside>
      </main>

      {status === "done" && outputs.length ? (
        <section className="results">
          <div className="results-head">
            <h2>
              {quality === "ugoira"
                ? layout === "clean"
                  ? "动图帧做好了"
                  : "每条都是一套动图帧"
                : quality === "pixiv"
                  ? layout === "clean"
                    ? "Pixiv 动图做好了"
                    : "每个都是一条 Pixiv 动图"
                  : layout === "clean"
                    ? "处理好了"
                    : "按这个顺序上传"}
            </h2>
            <div className="results-actions">
              {solo ? (
                <DownloadLink className="ghost" href={solo.url} name={solo.name}>
                  下载 {solo.name}
                </DownloadLink>
              ) : (
                <button type="button" className="ghost" onClick={() => void downloadZip()}>
                  打包下载
                </button>
              )}
            </div>
          </div>
          <p className="meta results-hint">
            {quality === "ugoira"
              ? "下载 zip，解压后用电脑版 pixiv「选择多张图片」全选 JPEG。复制预览图不是原文件。"
              : "复制预览图拿到的不是原文件，请点下载。"}
          </p>
          <ol className="out-list">
            {outputs.map((o, i) => {
              const over =
                (quality === "pixiv" && o.bytes > PIXIV_GIF_MAX_BYTES) ||
                (quality === "ugoira" && o.bytes > 30 * 1024 * 1024);
              return (
                <li key={o.name}>
                  {o.frames?.length ? (
                    <FramePlayer frames={o.frames} delayMs={o.delayMs ?? 80} alt={o.name} />
                  ) : asImage ? (
                    <img src={o.url} alt={o.name} draggable={false} />
                  ) : (
                    <video src={o.url} controls playsInline />
                  )}
                  <p className="out-name">
                    {String(i + 1).padStart(2, "0")} · {o.name}
                  </p>
                  <p className={`size-meta${over ? " over" : ""}`}>
                    {o.width && o.height ? `${o.width}×${o.height} · ` : ""}
                    {formatBytes(o.bytes)}
                    {quality === "pixiv" ? " / 16 MB" : quality === "ugoira" ? " / 30 MB" : ""}
                    {o.note ? ` · ${o.note}` : ""}
                  </p>
                  <DownloadLink className="ghost out-dl" href={o.url} name={o.name}>
                    下载
                  </DownloadLink>
                </li>
              );
            })}
          </ol>
        </section>
      ) : null}
    </>
  );
}
