const state = {
  job: null,
  layout: "carousel",
  count: 4,
  quality: "keep",
  audio: "all",
  poll: null,
};

const $ = (id) => document.getElementById(id);

function detailOf(data) {
  if (!data) return "";
  if (typeof data.detail === "string") return data.detail;
  if (Array.isArray(data.detail)) {
    return data.detail.map((x) => x.msg || x.detail || JSON.stringify(x)).join("\n");
  }
  return data.error || "";
}

const HINTS = {
  carousel: "横滑：左→右 01 到 04，贴到同一条帖子。现在的 X 就是这样。",
  stack: "竖叠：上→下 01 到 04。点开帖子后往下看才接得上。",
  grid: "宫格：左上 01、右上 02、左下 03、右下 04。旧版 X / Bluesky 还是 2×2。",
};

const QUALITY = {
  keep: "裁切必须重编码。原像素 = 不缩放，H.264 CRF 14，分辨率按源画面裁。",
  x: "必要时补黑边或缩小到 X 上限（不放大），CRF 16，更稳能传上去。",
};

async function health() {
  const el = $("health");
  try {
    const data = await fetch("/api/health").then((r) => r.json());
    if (data.ok) {
      el.textContent = data.ffmpeg.replace(/^ffmpeg version /i, "FFmpeg ") || "FFmpeg 就绪";
      el.classList.remove("bad");
    } else {
      el.textContent = data.error || "找不到 FFmpeg";
      el.classList.add("bad");
    }
  } catch {
    el.textContent = "服务没连上";
    el.classList.add("bad");
  }
}

function setSeg(rootSelector, attr, value) {
  document.querySelectorAll(`${rootSelector} [${attr}]`).forEach((btn) => {
    btn.classList.toggle("on", btn.getAttribute(attr) === String(value));
  });
}

function layoutButtons() {
  document.querySelectorAll("[data-layout]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      state.layout = btn.dataset.layout;
      if (state.layout === "grid") state.count = 4;
      $("layoutHint").textContent = HINTS[state.layout];
      $("countSeg").hidden = state.layout === "grid";
      setSeg(".chest", "data-layout", state.layout);
      setSeg("#countSeg", "data-count", state.count);
      await syncPlan();
    });
  });
  document.querySelectorAll("[data-count]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      state.count = Number(btn.dataset.count);
      setSeg("#countSeg", "data-count", state.count);
      await syncPlan();
    });
  });
  document.querySelectorAll("[data-quality]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      state.quality = btn.dataset.quality;
      $("qualityHint").textContent = QUALITY[state.quality];
      setSeg(".chest", "data-quality", state.quality);
      await syncPlan();
    });
  });
  document.querySelectorAll("[data-audio]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      state.audio = btn.dataset.audio;
      setSeg(".chest", "data-audio", state.audio);
      await syncPlan();
    });
  });
}

function wireDrop() {
  const drop = $("drop");
  const file = $("file");
  const prevent = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };
  ["dragenter", "dragover"].forEach((ev) => {
    document.addEventListener(ev, (e) => {
      prevent(e);
      drop.classList.add("hot");
      document.body.classList.add("dragging");
    });
  });
  ["dragleave", "drop"].forEach((ev) => {
    document.addEventListener(ev, (e) => {
      prevent(e);
      if (ev === "dragleave" && e.target !== document.body) return;
      drop.classList.remove("hot");
      document.body.classList.remove("dragging");
    });
  });
  document.addEventListener("drop", async (e) => {
    prevent(e);
    drop.classList.remove("hot");
    const f = e.dataTransfer?.files?.[0];
    if (f) await openFile(f);
  });
  file.addEventListener("change", async () => {
    if (file.files[0]) await openFile(file.files[0]);
  });
  $("openBtn").addEventListener("click", () => openSource());
  $("path").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      openSource();
    }
  });
}

async function openFile(file) {
  $("fileLabel").textContent = file.name;
  const fd = new FormData();
  fd.append("file", file, file.name);
  await postOpen(fd);
}

async function openSource() {
  const path = $("path").value.trim();
  if (path) {
    const fd = new FormData();
    fd.append("path", path);
    $("fileLabel").textContent = path;
    await postOpen(fd);
    return;
  }
  $("file").click();
}

async function postOpen(fd) {
  $("cutBtn").disabled = true;
  $("mediaMeta").textContent = "在读…";
  const res = await fetch("/api/open", { method: "POST", body: fd });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    $("mediaMeta").textContent = "";
    alert(detailOf(data) || "读不了这个文件");
    return;
  }
  applyJob(data);
}

function applyJob(job) {
  state.job = job;
  state.layout = job.layout;
  state.count = job.count;
  state.quality = job.quality;
  state.audio = job.audio;
  setSeg(".chest", "data-layout", state.layout);
  setSeg("#countSeg", "data-count", state.count);
  setSeg(".chest", "data-quality", state.quality);
  setSeg(".chest", "data-audio", state.audio);
  $("layoutHint").textContent = HINTS[state.layout];
  $("qualityHint").textContent = QUALITY[state.quality];
  $("countSeg").hidden = state.layout === "grid";
  $("audioTool").hidden = job.info.kind === "image";
  $("mediaMeta").textContent = job.info.label;
  $("cutBtn").disabled = job.status === "running";
  renderPlan(job);
  renderProgress(job);
  renderResults(job);
}

async function syncPlan() {
  if (!state.job) {
    renderPlan(null);
    return;
  }
  const res = await fetch(`/api/jobs/${state.job.id}/plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      layout: state.layout,
      count: state.count,
      quality: state.quality,
      audio: state.audio,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    alert(detailOf(data) || "方案算不出来");
    return;
  }
  applyJob(data);
}

function renderPlan(job) {
  const film = $("film");
  const empty = $("empty");
  const pieces = $("pieces");
  const phone = $("phoneScreen");
  if (!job || !job.plan) {
    film.hidden = true;
    empty.hidden = false;
    $("orderHint").textContent = "";
    $("tileSpec").textContent = "";
    $("warnings").hidden = true;
    phone.className = "handset-screen";
    phone.innerHTML = `<p class="phone-empty">读入片子后可横滑预览</p>`;
    return;
  }
  empty.hidden = true;
  film.hidden = false;
  const plan = job.plan;
  pieces.className = `pieces ${plan.layout}`;
  pieces.innerHTML = plan.tiles.map((t) => pieceHtml(job, t)).join("");
  $("orderHint").textContent = plan.order_hint;
  const first = plan.tiles[0];
  $("tileSpec").textContent =
    `源 ${plan.source_w}×${plan.source_h} → 每份 ${first.out_w}×${first.out_h}` +
    ` · ${plan.cols}×${plan.rows}`;
  if (plan.warnings.length) {
    $("warnings").hidden = false;
    $("warnings").textContent = plan.warnings.join("\n");
  } else {
    $("warnings").hidden = true;
  }
  renderPhone(job);
}

function pieceHtml(job, tile) {
  return `<div class="piece">
    <span class="tab">${tile.label || String(tile.index).padStart(2, "0")}</span>
    <div class="piece-shot">${shotInner(job, tile)}</div>
  </div>`;
}

function shotInner(job, tile) {
  const srcW = job.info.width;
  const srcH = job.info.height;
  const done = job.status === "done";
  const out = (job.outputs || []).find((o) => o.name === tile.filename);
  if (done && out) {
    if (job.info.kind === "image") {
      return `<img class="fit" src="${out.url}" alt="${tile.filename}">`;
    }
    return `<video class="fit" src="${out.url}" muted autoplay loop playsinline></video>`;
  }
  const wPct = (srcW / tile.w) * 100;
  const hPct = (srcH / tile.h) * 100;
  const left = (-tile.x / tile.w) * 100;
  const top = (-tile.y / tile.h) * 100;
  return `<img src="${job.preview}" alt="" style="width:${wPct}%;height:${hPct}%;left:${left}%;top:${top}%;">`;
}

function renderPhone(job) {
  const phone = $("phoneScreen");
  const plan = job.plan;
  phone.className = `handset-screen ${plan.layout}`;
  phone.innerHTML = plan.tiles
    .map((t) => `<div class="phone-slide"><div class="piece-shot">${shotInner(job, t)}</div></div>`)
    .join("");
  $("phoneCap").textContent =
    plan.layout === "carousel"
      ? "在这只手机框里用手指横滑。发到 X 上也是这个顺序。"
      : plan.layout === "stack"
        ? "竖着滑。点开帖子后的长图就是这个接法。"
        : "四格同时播。现在的 X 时间线不一定还这样排。";
}

function renderProgress(job) {
  const running = job && job.status === "running";
  $("progress").hidden = !running && !(job && job.status === "error");
  $("progressBar").style.width = `${job ? job.percent : 0}%`;
  $("progressText").textContent = job
    ? job.status === "error"
      ? job.error || "失败"
      : `${job.message || ""} ${Math.round(job.percent || 0)}%`
    : "";
  $("cutBtn").disabled = !job || running;
  $("cancelBtn").hidden = !running;
}

function renderResults(job) {
  const box = $("results");
  if (!job || job.status !== "done") {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  $("zipBtn").href = `/api/jobs/${job.id}/zip`;
  $("outList").innerHTML = job.outputs
    .map((o, i) => {
      const media =
        job.info.kind === "image"
          ? `<img src="${o.url}" alt="${o.name}">`
          : `<video src="${o.url}" controls playsinline></video>`;
      return `<li>
        ${media}
        <a href="${o.url}" download="${o.name}">${String(i + 1).padStart(2, "0")} · ${o.name}</a>
      </li>`;
    })
    .join("");
}

async function cut() {
  if (!state.job) return;
  const res = await fetch(`/api/jobs/${state.job.id}/split`, { method: "POST" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    alert(detailOf(data) || "切不开");
    return;
  }
  applyJob(data);
  poll();
}

function poll() {
  if (state.poll) clearInterval(state.poll);
  state.poll = setInterval(async () => {
    if (!state.job) return;
    const res = await fetch(`/api/jobs/${state.job.id}`);
    const data = await res.json();
    applyJob(data);
    if (data.status === "done" || data.status === "error") {
      clearInterval(state.poll);
      state.poll = null;
    }
  }, 280);
}

async function cancel() {
  if (!state.job) return;
  await fetch(`/api/jobs/${state.job.id}/cancel`, { method: "POST" });
}

async function reveal() {
  if (!state.job) return;
  await fetch(`/api/jobs/${state.job.id}/reveal`, { method: "POST" });
}

function boot() {
  health();
  layoutButtons();
  wireDrop();
  $("cutBtn").addEventListener("click", cut);
  $("cancelBtn").addEventListener("click", cancel);
  $("revealBtn").addEventListener("click", reveal);
}

boot();
