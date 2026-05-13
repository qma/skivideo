const state = {
  summary: null,
  eventDetail: null,
  config: null,
  query: "",
  selectedFolderId: "",
  eventQuery: "",
  eventStatus: "",
  eventConfidence: ""
};

const el = (id) => document.getElementById(id);

init();

async function init() {
  bindActions();
  state.config = await api("/api/config");
  await refresh();
}

function bindActions() {
  el("ingestSample").addEventListener("click", () => action("/api/ingest-sample"));
  el("fetchEvents").addEventListener("click", () => action("/api/fetch-events"));
  el("listSharePoint").addEventListener("click", () => action("/api/list-sharepoint"));
  el("listSharePointRest").addEventListener("click", () => action("/api/list-sharepoint-rest"));
  el("ingestOldest").addEventListener("click", () => action("/api/ingest-oldest-sharepoint-folder"));
  el("exportLean").addEventListener("click", () => action("/api/export-lean"));
  el("syncMetadata").addEventListener("click", () => action("/api/sync-metadata"));
  el("manifestFolder").addEventListener("click", () => action("/api/manifest-sharepoint", { folderUrl: el("folderUrl").value }));
  el("manifestRestFolder").addEventListener("click", () => action("/api/manifest-sharepoint-rest", { serverRelativeUrl: el("serverRelativeUrl").value }));
  el("closeEventView").addEventListener("click", () => {
    state.selectedFolderId = "";
    state.eventDetail = null;
    renderEventView();
  });
  el("eventSearchInput").addEventListener("input", (event) => {
    state.eventQuery = event.target.value;
    renderEventView();
  });
  el("eventStatusFilter").addEventListener("change", (event) => {
    state.eventStatus = event.target.value;
    renderEventView();
  });
  el("eventConfidenceFilter").addEventListener("change", (event) => {
    state.eventConfidence = event.target.value;
    renderEventView();
  });
  el("eventViewPanel").addEventListener("click", async (event) => {
    const save = event.target.closest("[data-manual-label]");
    const clear = event.target.closest("[data-clear-labels]");
    if (!save && !clear) return;
    const videoId = (save || clear).dataset.manualLabel || (save || clear).dataset.clearLabels;
    if (save) {
      const input = document.querySelector(`[data-manual-input="${CSS.escape(videoId)}"]`);
      const labelName = input?.value.trim();
      if (!labelName) return;
      await action("/api/review-video", { action: "manual-label", videoId, labelName }, { silent: true });
    } else {
      await action("/api/review-video", { action: "clear-labels", videoId }, { silent: true });
    }
  });
  el("searchInput").addEventListener("input", async (event) => {
    state.query = event.target.value;
    await renderSearch();
  });
}

async function refresh() {
  state.summary = await api("/api/summary");
  if (state.selectedFolderId) {
    state.eventDetail = await api(`/api/event?folderId=${encodeURIComponent(state.selectedFolderId)}`);
  } else {
    state.eventDetail = null;
  }
  renderStatus();
  renderFolders();
  renderEventView();
  renderJobsAndEvents();
  await renderSearch();
}

function renderStatus() {
  const folders = state.summary.counts.folders;
  const videos = state.summary.counts.videos;
  const labels = state.summary.counts.labels;
  const mlx = state.config.transcriptionBackends?.mlxWhisper ? "MLX Whisper ready" : "MLX Whisper not installed";
  el("statusLine").textContent = `${folders} folders, ${videos} videos, ${labels} labels. ${mlx}.`;
}

function renderFolders() {
  el("folders").innerHTML = state.summary.folders.map((folder) => {
    const event = folder.eventMatch;
    const stats = folder.stats || {};
    return `
      <article class="item">
        <div class="itemHeader">
          <div>
            <strong>${escapeHtml(folder.name)}</strong>
            <p>${escapeHtml(folder.path || folder.source || "")}</p>
          </div>
          <button data-view-event="${escapeHtml(folder.id)}">View Event</button>
          <button data-prepare="${escapeHtml(folder.id)}">Prepare</button>
          <button data-process="${escapeHtml(folder.id)}">Process</button>
          <button data-correlate="${escapeHtml(folder.id)}">Live-Timing</button>
        </div>
        <div class="pillRow">
          <span class="pill">${stats.videoCount || 0} videos</span>
          ${stats.indexed ? `<span class="pill">${stats.indexed} indexed</span>` : ""}
          ${stats.needsReview ? `<span class="pill warn">${stats.needsReview} review</span>` : ""}
          ${event ? `<span class="pill">Event ${Math.round((event.confidence || 0) * 100)}%</span>` : `<span class="pill warn">No event match</span>`}
          ${folder.raceAssetCount ? `<span class="pill">${folder.raceAssetCount} race assets</span>` : ""}
          ${folder.candidateRosterCount ? `<span class="pill">${folder.candidateRosterCount} racers</span>` : ""}
        </div>
        ${event ? `<p class="muted">${escapeHtml(event.canonicalName || "")} ${escapeHtml(event.date || "")}</p>` : ""}
      </article>
    `;
  }).join("") || `<p class="muted">No folders indexed yet.</p>`;

  for (const button of document.querySelectorAll("[data-process]")) {
    button.addEventListener("click", () => action("/api/process-folder", { folderId: button.dataset.process }));
  }
  for (const button of document.querySelectorAll("[data-prepare]")) {
    button.addEventListener("click", () => action("/api/prepare-folder", { folderId: button.dataset.prepare }));
  }
  for (const button of document.querySelectorAll("[data-view-event]")) {
    button.addEventListener("click", async () => {
      state.selectedFolderId = button.dataset.viewEvent;
      state.eventQuery = "";
      state.eventStatus = "";
      state.eventConfidence = "";
      await refresh();
      el("eventViewPanel").scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }
  for (const button of document.querySelectorAll("[data-correlate]")) {
    button.addEventListener("click", () => action("/api/correlate-folder-live-timing", { folderId: button.dataset.correlate }));
  }
}

function renderEventView() {
  const panel = el("eventViewPanel");
  const folder = state.eventDetail?.folder;
  if (!folder) {
    panel.hidden = true;
    return;
  }
  const videos = state.eventDetail.videos
    .filter((video) => video.folderId === folder.id)
    .filter((video) => eventVideoMatchesFilters(video, folder))
    .sort((a, b) => compareVideoRows(a, b));
  const allVideos = state.eventDetail.videos.filter((video) => video.folderId === folder.id);
  const indexed = allVideos.filter((video) => video.processing?.status === "indexed").length;
  const review = allVideos.filter((video) => video.processing?.status === "needs_review").length;
  const failed = allVideos.filter((video) => video.processing?.status === "failed").length;
  const pending = allVideos.length - indexed - review - failed;
  panel.hidden = false;
  el("eventSearchInput").value = state.eventQuery;
  el("eventStatusFilter").value = state.eventStatus;
  el("eventConfidenceFilter").value = state.eventConfidence;
  el("eventTitle").textContent = folder.name;
  el("eventMeta").textContent = [
    folder.eventMatch?.date,
    folder.eventMatch?.venue,
    folder.eventMatch?.discipline,
    `${allVideos.length} videos`,
    videos.length !== allVideos.length ? `${videos.length} shown` : "",
    `${indexed} indexed`,
    `${review} review`,
    pending ? `${pending} pending` : "",
    failed ? `${failed} failed` : "",
    folder.candidateRoster?.length ? `${folder.candidateRoster.length} racers` : ""
  ].filter(Boolean).join(" · ");
  el("eventAssets").innerHTML = (folder.raceAssets || []).slice(0, 10).map((asset) => `
    <a class="assetLink" href="${escapeAttr(asset.sourceUrl)}" target="_blank" rel="noreferrer">${escapeHtml(asset.label || asset.type)}</a>
  `).join("");
  el("eventVideoRows").innerHTML = videos.map((video) => {
    const labels = video.athleteLabels || [];
    const best = labels[0];
    const status = video.processing?.status || "pending";
    const localVideo = Boolean(video.localVideoPath);
    return `
      <tr>
        <td>
          ${localVideo
            ? `<video class="thumbVideo" src="/media/${escapeAttr(video.id)}" controls preload="metadata" muted playsinline></video>`
            : `<div class="thumbMissing">SharePoint only</div>`}
        </td>
        <td>
          <strong>${escapeHtml(video.filename)}</strong>
          <div class="muted">${formatBytes(video.sizeBytes)}</div>
          <div class="muted">${escapeHtml((video.transcript?.text || "").slice(0, 90))}</div>
        </td>
        <td>${labels.length ? labels.map((label) => `
          <span class="labelStack ${label.confidence >= 0.65 ? "confident" : "ambiguous"}">
            ${escapeHtml(label.name)}
            <span>${Math.round((label.confidence || 0) * 100)}%</span>
          </span>
        `).join("") : `<span class="muted">Unlabeled</span>`}</td>
        <td><span class="pill ${status === "failed" ? "bad" : status === "needs_review" ? "warn" : ""}">${escapeHtml(status)}</span></td>
        <td class="evidenceCell">${escapeHtml(best?.evidence || video.transcript?.text || "")}</td>
        <td>
          <div class="reviewTools">
            <input data-manual-input="${escapeAttr(video.id)}" placeholder="Correct athlete">
            <button data-manual-label="${escapeAttr(video.id)}">Save</button>
            <button class="subtleButton" data-clear-labels="${escapeAttr(video.id)}">Clear</button>
          </div>
        </td>
        <td>${video.sharepointUrl ? `<a href="${escapeAttr(video.sharepointUrl)}" target="_blank" rel="noreferrer">SharePoint</a>` : ""}</td>
      </tr>
    `;
  }).join("") || `<tr><td colspan="7" class="muted">No videos in this event.</td></tr>`;
}

function eventVideoMatchesFilters(video) {
  const status = video.processing?.status || "pending";
  if (state.eventStatus && status !== state.eventStatus) return false;
  const labels = video.athleteLabels || [];
  if (state.eventConfidence === "confident" && !labels.some((label) => label.confidence >= 0.65)) return false;
  if (state.eventConfidence === "ambiguous" && !labels.some((label) => label.confidence > 0 && label.confidence < 0.65)) return false;
  if (state.eventConfidence === "unlabeled" && labels.length) return false;
  const needle = normalizeClientText(state.eventQuery);
  if (!needle) return true;
  return normalizeClientText([
    video.filename,
    video.transcript?.text,
    video.processing?.status,
    ...labels.flatMap((label) => [label.name, label.evidence, label.source])
  ].join(" ")).includes(needle);
}

function renderJobsAndEvents() {
  const jobs = state.summary.jobs.slice(0, 8).map((job) => `
    <article class="item">
      <strong>${escapeHtml(job.type)}</strong>
      <p>${escapeHtml(job.status)} · ${escapeHtml(job.message || "")}</p>
    </article>
  `).join("") || `<p class="muted">No jobs yet.</p>`;

  const events = state.summary.events.slice(0, 12).map((event) => `
    <article class="item">
      <strong>${escapeHtml(event.name || event.title)}</strong>
      <p>${escapeHtml([event.date, event.venue, event.discipline].filter(Boolean).join(" · "))}</p>
    </article>
  `).join("");

  el("jobs").innerHTML = jobs;
  el("events").innerHTML = events;
}

async function renderSearch() {
  if (!state.query.trim()) {
    el("results").innerHTML = `<p class="muted">Search by athlete name to list matching videos with SharePoint playback links.</p>`;
    return;
  }
  const data = await api(`/api/search?q=${encodeURIComponent(state.query)}`);
  el("results").innerHTML = data.results.map((video) => {
    const labels = video.athleteLabels || [];
    const status = video.processing?.status || "pending";
    return `
      <article class="result">
        <div class="resultHeader">
          <div>
            <strong>${escapeHtml(video.filename)}</strong>
            <p>${escapeHtml(video.folder?.name || "")}</p>
          </div>
          ${video.sharepointUrl ? `<a href="${escapeAttr(video.sharepointUrl)}" target="_blank" rel="noreferrer">Open Video</a>` : ""}
        </div>
        <div class="pillRow">
          <span class="pill ${status === "failed" ? "bad" : status === "needs_review" ? "warn" : ""}">${escapeHtml(status)}</span>
          ${labels.map((label) => `<span class="pill">${escapeHtml(label.name)} ${Math.round((label.confidence || 0) * 100)}%</span>`).join("")}
        </div>
        ${labels[0]?.evidence ? `<p class="muted">${escapeHtml(labels[0].evidence)}</p>` : ""}
      </article>
    `;
  }).join("") || `<p class="muted">No matching videos.</p>`;
}

async function action(path, body = {}, options = {}) {
  try {
    const result = await api(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!options.silent) showLog(result);
    await refresh();
  } catch (error) {
    showLog({ error: error.message });
  }
}

async function api(path, options) {
  const response = await fetch(path, options);
  const json = await response.json();
  if (!response.ok || json.error) throw new Error(json.error || response.statusText);
  return json;
}

function showLog(value) {
  el("logOutput").textContent = JSON.stringify(value, null, 2);
  el("logDialog").showModal();
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("`", "&#096;");
}

function compareVideoRows(a, b) {
  const aLabel = a.athleteLabels?.[0]?.name || "zzzz";
  const bLabel = b.athleteLabels?.[0]?.name || "zzzz";
  return aLabel.localeCompare(bLabel) || String(a.filename).localeCompare(String(b.filename));
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (!bytes) return "";
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function normalizeClientText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
