const state = {
  store: null,
  config: null,
  query: ""
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
  el("manifestFolder").addEventListener("click", () => action("/api/manifest-sharepoint", { folderUrl: el("folderUrl").value }));
  el("manifestRestFolder").addEventListener("click", () => action("/api/manifest-sharepoint-rest", { serverRelativeUrl: el("serverRelativeUrl").value }));
  el("searchInput").addEventListener("input", async (event) => {
    state.query = event.target.value;
    await renderSearch();
  });
}

async function refresh() {
  state.store = await api("/api/store");
  renderStatus();
  renderFolders();
  renderJobsAndEvents();
  await renderSearch();
}

function renderStatus() {
  const folders = state.store.folders.length;
  const videos = state.store.videos.length;
  const labels = state.store.videos.reduce((sum, video) => sum + (video.athleteLabels || []).length, 0);
  const mlx = state.config.transcriptionBackends?.mlxWhisper ? "MLX Whisper ready" : "MLX Whisper not installed";
  el("statusLine").textContent = `${folders} folders, ${videos} videos, ${labels} labels. ${mlx}.`;
}

function renderFolders() {
  el("folders").innerHTML = state.store.folders.map((folder) => {
    const videos = state.store.videos.filter((video) => video.folderId === folder.id);
    const event = folder.eventMatch;
    return `
      <article class="item">
        <div class="itemHeader">
          <div>
            <strong>${escapeHtml(folder.name)}</strong>
            <p>${escapeHtml(folder.path || folder.source || "")}</p>
          </div>
          <button data-process="${escapeHtml(folder.id)}">Process</button>
          <button data-correlate="${escapeHtml(folder.id)}">Live-Timing</button>
        </div>
        <div class="pillRow">
          <span class="pill">${videos.length} videos</span>
          ${event ? `<span class="pill">Event ${Math.round((event.confidence || 0) * 100)}%</span>` : `<span class="pill warn">No event match</span>`}
          ${folder.raceAssets?.length ? `<span class="pill">${folder.raceAssets.length} race assets</span>` : ""}
          ${folder.candidateRoster?.length ? `<span class="pill">${folder.candidateRoster.length} racers</span>` : ""}
        </div>
        ${event ? `<p class="muted">${escapeHtml(event.canonicalName || "")} ${escapeHtml(event.date || "")}</p>` : ""}
      </article>
    `;
  }).join("") || `<p class="muted">No folders indexed yet.</p>`;

  for (const button of document.querySelectorAll("[data-process]")) {
    button.addEventListener("click", () => action("/api/process-folder", { folderId: button.dataset.process }));
  }
  for (const button of document.querySelectorAll("[data-correlate]")) {
    button.addEventListener("click", () => action("/api/correlate-folder-live-timing", { folderId: button.dataset.correlate }));
  }
}

function renderJobsAndEvents() {
  const jobs = state.store.jobs.slice(0, 8).map((job) => `
    <article class="item">
      <strong>${escapeHtml(job.type)}</strong>
      <p>${escapeHtml(job.status)} · ${escapeHtml(job.message || "")}</p>
    </article>
  `).join("") || `<p class="muted">No jobs yet.</p>`;

  const events = state.store.events.slice(0, 12).map((event) => `
    <article class="item">
      <strong>${escapeHtml(event.name || event.title)}</strong>
      <p>${escapeHtml([event.date, event.venue, event.discipline].filter(Boolean).join(" · "))}</p>
    </article>
  `).join("");

  el("jobs").innerHTML = jobs;
  el("events").innerHTML = events;
}

async function renderSearch() {
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

async function action(path, body = {}) {
  try {
    const result = await api(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    showLog(result);
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
