const state = {
  summary: null,
  eventDetail: null,
  config: null,
  query: "",
  selectedFolderId: "",
  eventQuery: "",
  eventStatus: "",
  eventConfidence: "",
  jobPollTimer: null,
  selectedJobId: "",
  jobLogTimer: null
};

const actionTips = {
  view: "Ensure the SharePoint video list if missing, then open this event's table. Does not download media.",
  live: "Refresh Live-Timing race correlation, racer roster, and linked assets. Does not download media.",
  prepare: "Run View and Live dependencies if needed, then relabel from existing metadata/transcripts. Does not download media.",
  process: "Run View, Live, and Prepare dependencies if needed, then download/mirror videos, transcribe, label, and update the index with parallel 4.",
  reprocess: "Force retranscription and relabeling from existing local media/audio only. Does not download missing media."
};

const el = (id) => document.getElementById(id);

init();

async function init() {
  bindActions();
  state.config = await api("/api/config");
  await refresh();
  await runUrlAction();
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
  el("logDialog").addEventListener("close", () => {
    state.selectedJobId = "";
    if (state.jobLogTimer) clearTimeout(state.jobLogTimer);
    state.jobLogTimer = null;
  });
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
  scheduleJobPolling();
}

function renderStatus() {
  const folders = state.summary.counts.folders;
  const videos = state.summary.counts.videos;
  const labels = state.summary.counts.labels;
  const backend = transcriptionBackendLabel(state.config.transcriptionBackends);
  el("statusLine").textContent = `${folders} folders, ${videos} videos, ${labels} labels. ${backend}.`;
}

function renderFolders() {
  const folders = [...state.summary.folders].sort(compareFoldersChronologically);
  el("folders").innerHTML = folders.length ? `
    <div class="eventListHeader">
      <span>Date</span>
      <span>Event</span>
      <span>Status</span>
      <span>Videos</span>
      <span>Index</span>
      <span>Actions</span>
    </div>
    ${folders.map((folder) => {
    const event = folder.eventMatch;
    const stats = folder.stats || {};
    const status = eventProcessingStatus(folder);
    return `
      <article class="eventRow">
        <div class="eventDate">
          <strong>${escapeHtml(eventDateLabel(folder))}</strong>
          <span>${escapeHtml(event?.discipline || "")}</span>
        </div>
        <div class="eventName">
          <strong>${escapeHtml(folder.name)}</strong>
          <span>${escapeHtml([event?.venue, folder.raceAssetCount ? `${folder.raceAssetCount} assets` : "", folder.candidateRosterCount ? `${folder.candidateRosterCount} racers` : ""].filter(Boolean).join(" · "))}</span>
        </div>
        <div>
          <span class="statusBadge ${status.className}">${escapeHtml(status.label)}</span>
        </div>
        <div class="eventCounts">
          <strong>${stats.videoCount || 0}</strong>
          <span>${stats.localVideo || 0} local · ${stats.transcripts || 0} tx</span>
        </div>
        <div class="eventCounts">
          <strong>${stats.indexed || 0}/${stats.videoCount || 0}</strong>
          <span>${stats.needsReview || 0} review · ${stats.failed || 0} failed</span>
        </div>
        <div class="eventActions">
          <a class="actionLink" href="${escapeAttr(actionHref("view", folder.id))}" title="${escapeAttr(actionTips.view)}" aria-label="${escapeAttr(actionTips.view)}">View</a>
          <a class="actionLink subtleActionLink" href="${escapeAttr(actionHref("live", folder.id))}" title="${escapeAttr(actionTips.live)}" aria-label="${escapeAttr(actionTips.live)}">Live</a>
          <a class="actionLink subtleActionLink" href="${escapeAttr(actionHref("prepare", folder.id))}" title="${escapeAttr(actionTips.prepare)}" aria-label="${escapeAttr(actionTips.prepare)}">Prepare</a>
          <a class="actionLink subtleActionLink" href="${escapeAttr(actionHref("process", folder.id))}" title="${escapeAttr(actionTips.process)}" aria-label="${escapeAttr(actionTips.process)}">Process</a>
          <a class="actionLink subtleActionLink" href="${escapeAttr(actionHref("reprocess", folder.id))}" title="${escapeAttr(actionTips.reprocess)}" aria-label="${escapeAttr(actionTips.reprocess)}">Re-Process</a>
        </div>
      </article>
    `;
  }).join("")}
  ` : `<p class="muted">No folders indexed yet.</p>`;
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
    return `
      <tr>
        <td>
          <video
            class="thumbVideo"
            src="${escapeAttr(playbackHref(video))}"
            controls
            preload="metadata"
            playsinline
            title="${escapeAttr(video.localVideoPath ? "Local cached media" : "Source media fallback")}"></video>
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
        <td>
          <a href="${escapeAttr(playbackHref(video))}" target="_blank" rel="noreferrer">Open Video</a>
          ${video.sharepointUrl ? `<a class="sourceLink" href="${escapeAttr(video.sharepointUrl)}" target="_blank" rel="noreferrer">Source</a>` : ""}
        </td>
      </tr>
    `;
  }).join("") || `<tr><td colspan="7" class="muted">No videos in this event.</td></tr>`;
}

function compareFoldersChronologically(a, b) {
  return folderSortKey(a).localeCompare(folderSortKey(b)) || String(a.name).localeCompare(String(b.name));
}

function folderSortKey(folder) {
  const date = folder.eventMatch?.date || folder.timeCreated?.slice(0, 10) || "9999-99-99";
  return `${date}:${folder.name || ""}`;
}

function eventDateLabel(folder) {
  return folder.eventMatch?.date || folder.timeCreated?.slice(0, 10) || "No date";
}

function eventProcessingStatus(folder) {
  const stats = folder.stats || {};
  const total = stats.videoCount || 0;
  if (!total) return { label: "Discovered", className: "statusDiscovered" };
  if (stats.failed) return { label: "Has failures", className: "statusFailed" };
  if ((stats.localVideo || 0) >= total && (stats.indexed || 0) + (stats.needsReview || 0) >= total) {
    return stats.needsReview
      ? { label: "Processed + review", className: "statusReview" }
      : { label: "Processed", className: "statusProcessed" };
  }
  if ((stats.indexed || 0) + (stats.needsReview || 0) >= total) {
    return { label: "Prepared", className: "statusPrepared" };
  }
  return { label: "Pending", className: "statusPending" };
}

function transcriptionBackendLabel(backends = {}) {
  if (backends.mlxWhisper) return "MLX Whisper ready";
  if (backends.whisperCpp) return "whisper.cpp ready";
  if (backends.openai) return "OpenAI transcription ready";
  return "No transcription backend";
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
    <article class="item jobItem ${jobClass(job)}">
      <div class="jobHeader">
        <strong>${escapeHtml([job.type, job.folderName].filter(Boolean).join(" · "))}</strong>
        <a class="jobInspect" href="${escapeAttr(jobHref(job.id))}">Inspect</a>
      </div>
      <p><span class="jobStatusDot"></span>${escapeHtml(job.status)} · ${escapeHtml(job.message || "")}</p>
      <div class="jobMeta">${escapeHtml(jobMeta(job))}</div>
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
          <a href="${escapeAttr(playbackHref(video))}" target="_blank" rel="noreferrer">Open Video</a>
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
    return result;
  } catch (error) {
    showLog({ error: error.message });
    return null;
  }
}

async function startProcessing(folderId) {
  const result = await action("/api/process-folder-async", { folderId, parallel: 4 });
  if (result?.ok) scheduleJobPolling(true);
}

async function startReprocessing(folderId) {
  const confirmed = window.confirm("Re-process this event from local media only? This retranscribes and relabels existing local audio/video, but skips videos that are not already cached.");
  if (!confirmed) return;
  const result = await action("/api/process-folder-async", {
    folderId,
    parallel: 4,
    forceTranscribe: true,
    noDownload: true,
    reprocess: true
  });
  if (result?.ok) scheduleJobPolling(true);
}

async function runUrlAction() {
  const params = new URLSearchParams(window.location.search);
  const jobId = params.get("jobId");
  if (jobId) {
    window.history.replaceState({}, "", window.location.pathname);
    await showJobLog(jobId);
    return;
  }
  const actionName = params.get("action");
  const folderId = params.get("folderId");
  if (!actionName || !folderId) return;
  window.history.replaceState({}, "", window.location.pathname);
  if (actionName === "view") {
    await openEvent(folderId);
  } else if (actionName === "live") {
    await action("/api/correlate-folder-live-timing", { folderId });
  } else if (actionName === "prepare") {
    await action("/api/prepare-folder", { folderId });
  } else if (actionName === "process") {
    await startProcessing(folderId);
  } else if (actionName === "reprocess") {
    await startReprocessing(folderId);
  }
}

async function openEvent(folderId) {
  const ready = await ensureViewManifest(folderId);
  if (!ready) return;
  state.selectedFolderId = folderId;
  state.eventQuery = "";
  state.eventStatus = "";
  state.eventConfidence = "";
  await refresh();
  el("eventViewPanel").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function ensureViewManifest(folderId) {
  const folder = state.summary?.folders?.find((item) => item.id === folderId);
  if ((folder?.stats?.videoCount || 0) > 0) return true;
  try {
    await api("/api/ensure-folder-manifest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ folderId })
    });
    return true;
  } catch (error) {
    showLog({ error: error.message });
    return false;
  }
}

function scheduleJobPolling(force = false) {
  if (state.jobPollTimer) clearTimeout(state.jobPollTimer);
  const hasRunningJob = state.summary?.jobs?.some((job) => job.status === "running");
  if (!force && !hasRunningJob) return;
  state.jobPollTimer = setTimeout(async () => {
    try {
      await refresh();
    } catch (error) {
      showLog({ error: error.message });
    }
  }, 2500);
}

async function showJobLog(jobId) {
  try {
    state.selectedJobId = jobId;
    const detail = await api(`/api/job?id=${encodeURIComponent(jobId)}`);
    renderJobLog(detail);
    if (!el("logDialog").open) el("logDialog").showModal();
    if (detail.job.status === "running") {
      if (state.jobLogTimer) clearTimeout(state.jobLogTimer);
      state.jobLogTimer = setTimeout(() => {
        if (state.selectedJobId === jobId && el("logDialog").open) showJobLog(jobId);
      }, 2500);
    }
  } catch (error) {
    showLog({ error: error.message });
  }
}

function renderJobLog(detail) {
  const job = detail.job;
  const lines = [
    `${job.type || "job"}${job.folderName ? ` · ${job.folderName}` : ""}`,
    `id: ${job.id}`,
    `status: ${job.status}`,
    `started: ${formatDateTime(job.startedAt)}`,
    job.completedAt ? `completed: ${formatDateTime(job.completedAt)}` : "",
    job.parallel ? `parallel: ${job.parallel}` : "",
    "",
    "Log",
    ...detail.logs.map((entry) => {
      const counts = [entry.indexed ? `${entry.indexed} indexed` : "", entry.needsReview ? `${entry.needsReview} review` : "", entry.failed ? `${entry.failed} failed` : ""].filter(Boolean).join(", ");
      return `${formatDateTime(entry.at)}  ${entry.status || "-"}  ${entry.message || ""}${counts ? ` (${counts})` : ""}`;
    })
  ].filter((line) => line !== "");
  el("logOutput").textContent = lines.join("\n");
}

async function api(path, options) {
  const response = await fetch(path, options);
  const json = await response.json();
  if (!response.ok || json.error) throw new Error(json.error || response.statusText);
  return json;
}

function showLog(value) {
  state.selectedJobId = "";
  if (state.jobLogTimer) clearTimeout(state.jobLogTimer);
  state.jobLogTimer = null;
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

function playbackHref(video) {
  return `/media/${encodeURIComponent(video.id)}`;
}

function actionHref(actionName, folderId) {
  return `/?action=${encodeURIComponent(actionName)}&folderId=${encodeURIComponent(folderId)}`;
}

function jobHref(jobId) {
  return `/?jobId=${encodeURIComponent(jobId)}`;
}

function jobClass(job) {
  if (job.status === "running") return "jobRunning";
  if (job.status === "completed") return "jobCompleted";
  if (job.status === "completed_with_errors" || job.status === "failed") return "jobFailed";
  if (job.status === "stale") return "jobStale";
  return "";
}

function jobMeta(job) {
  return [
    job.startedAt ? `started ${formatDateTime(job.startedAt)}` : "",
    job.updatedAt ? `updated ${formatDateTime(job.updatedAt)}` : "",
    job.logCount ? `${job.logCount} log entries` : ""
  ].filter(Boolean).join(" · ");
}

function formatDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit"
  });
}
