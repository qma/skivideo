"use strict";

const RESULT_CAP = 300;
const statusLabels = { indexed: "Indexed", needs_review: "Review" };

const state = { index: null, error: "", query: "", folderId: "all" };
const app = document.getElementById("app");

let foldersById = new Map();

fetch("/data/lean-index.json")
  .then((response) => {
    if (!response.ok) throw new Error(`Unable to load index (${response.status})`);
    return response.json();
  })
  .then((payload) => {
    state.index = payload;
    renderShell();
  })
  .catch((err) => {
    state.error = err.message;
    renderShell();
  });

function renderShell() {
  if (state.error) {
    app.innerHTML = `<section class="notice error">${esc(state.error)}</section>`;
    return;
  }
  if (!state.index) {
    app.innerHTML = `<section class="notice">Loading public video index&hellip;</section>`;
    return;
  }

  const idx = state.index;
  foldersById = new Map((idx.folders || []).map((folder) => [folder.id, folder]));
  const folders = publishedFolders(idx);
  const videos = idx.videos || [];
  const team = (idx.teams || [])[0] || {};
  const totalIndexed = videos.filter((v) => v.processing && v.processing.status === "indexed").length;
  const withNames = videos.filter((v) => v.goldenLabel || (v.athleteLabels && v.athleteLabels.length)).length;
  const rootShareUrl = team.sharepointRootUrl || "";

  app.innerHTML = `
    <header class="topbar">
      <div>
        <p class="eyebrow">${esc(team.orgName || team.name || "Public Index")}</p>
        <h1>${esc(seasonTitle(team))}</h1>
      </div>
      <div class="exportMeta">
        <span class="liveTag">Live preview</span>
        ${team.season ? `<span>${esc(team.season)}</span>` : ""}
        <span>Updated ${esc(formatDateTime(idx.exportedAt))}</span>
      </div>
    </header>

    <section class="summary" aria-label="Index summary">
      ${metric("Events", folders.length)}
      ${metric("Videos", videos.length)}
      ${metric("Indexed", totalIndexed)}
      ${metric("With Names", withNames)}
    </section>

    ${rootShareUrl ? `
    <section class="sharepointNotice">
      <p>SharePoint may ask you to sign in until your browser has opened the public team folder once. Open it once, then video links open directly.</p>
      <a href="${esc(rootShareUrl)}" rel="noreferrer" target="_blank">Open Public Team Folder</a>
    </section>` : ""}

    <section class="searchRow" aria-label="Search controls">
      <label>Search
        <input id="searchInput" type="search" placeholder="Athlete, event, filename, transcript text" value="${esc(state.query)}">
      </label>
      <label>Event
        <select id="folderSelect">
          <option value="all">All published events</option>
          ${folders.map((folder) => `<option value="${esc(folder.id)}">${esc(eventLabel(folder))}</option>`).join("")}
        </select>
      </label>
    </section>

    <section class="contentGrid">
      <aside class="panel" aria-label="Events">
        <div class="sectionHeader"><h2>Events</h2><span>${folders.length}</span></div>
        <div class="events" id="eventList">
          ${folders.map((folder) => eventRow(folder)).join("")}
        </div>
      </aside>
      <section class="panel" aria-label="Videos">
        <div class="sectionHeader"><h2>Videos</h2><span id="resultCount"></span></div>
        <div id="resultBody"></div>
      </section>
    </section>

    <p class="footer">Read-only public index &middot; links open the source video on SharePoint &middot; no media is hosted here.</p>
  `;

  const input = document.getElementById("searchInput");
  input.addEventListener("input", (event) => {
    state.query = event.target.value;
    updateResults();
  });
  document.getElementById("folderSelect").addEventListener("change", (event) => {
    setFolder(event.target.value);
  });
  document.getElementById("eventList").addEventListener("click", (event) => {
    const row = event.target.closest("[data-folder-id]");
    if (!row) return;
    setFolder(row.getAttribute("data-folder-id"));
  });

  updateResults();
}

function setFolder(folderId) {
  state.folderId = folderId;
  const select = document.getElementById("folderSelect");
  if (select && select.value !== folderId) select.value = folderId;
  document.querySelectorAll("#eventList [data-folder-id]").forEach((el) => {
    el.classList.toggle("selected", el.getAttribute("data-folder-id") === folderId);
  });
  updateResults();
}

function updateResults() {
  const results = computeResults();
  const countEl = document.getElementById("resultCount");
  const bodyEl = document.getElementById("resultBody");
  if (countEl) countEl.textContent = `${results.length}${results.length >= RESULT_CAP ? "+" : ""}`;
  if (!bodyEl) return;
  bodyEl.innerHTML = results.length
    ? `<div class="resultList">${results.map((video) => videoRow(video)).join("")}</div>`
    : `<div class="empty">No videos match the current search.</div>`;
}

function computeResults() {
  const videos = state.index.videos || [];
  const q = normalize(state.query);
  const filtered = videos.filter((video) => {
    if (state.folderId !== "all" && video.folderId !== state.folderId) return false;
    if (!q) return true;
    const folder = foldersById.get(video.folderId);
    return normalize([
      video.filename,
      video.transcript && video.transcript.text,
      video.goldenLabel && video.goldenLabel.name,
      video.goldenLabel && video.goldenLabel.evidence,
      folder && folder.name,
      folder && folder.eventMatch && folder.eventMatch.canonicalName,
      ...(video.athleteLabels || []).flatMap((label) => [label.name, label.evidence])
    ].join(" ")).includes(q);
  });
  return filtered
    .sort((a, b) => {
      const fa = foldersById.get(a.folderId);
      const fb = foldersById.get(b.folderId);
      return String((fa && (fa.eventDate || fa.name)) || "").localeCompare(String((fb && (fb.eventDate || fb.name)) || ""))
        || String(a.filename).localeCompare(String(b.filename));
    })
    .slice(0, RESULT_CAP);
}

function eventRow(folder) {
  const selected = state.folderId === folder.id ? " selected" : "";
  const stats = folder.stats || {};
  return `
    <button class="eventRow${selected}" type="button" data-folder-id="${esc(folder.id)}">
      <span class="eventDate">${esc(shortDate(folder.eventDate || folder.timeCreated))}</span>
      <span class="eventName">${esc((folder.eventMatch && folder.eventMatch.canonicalName) || folder.name)}</span>
      <span class="eventCounts">${stats.indexedVideos || 0}/${stats.publishedVideos || 0}</span>
    </button>`;
}

function videoRow(video) {
  const folder = foldersById.get(video.folderId);
  const labels = finalLabels(video);
  const primary = labels[0];
  const status = (video.processing && video.processing.status) || "pending";
  const videoUrl = video.playbackUrl || video.sharepointUrl || "";
  const folderUrl = folder && folder.sharepointUrl;
  const transcript = video.transcript && video.transcript.text;
  return `
    <article class="videoRow">
      <div class="videoMain">
        <div class="videoTitleRow">
          <h3>${esc(primary ? primary.name : "Unlabeled skier")}</h3>
          <span class="status ${esc(status)}">${esc(statusLabels[status] || cap(status))}</span>
        </div>
        <p class="filename">${esc(video.filename || "")}</p>
        <p class="eventLine">${esc(eventLabel(folder))}</p>
        ${labels.length ? `<div class="labelList">${labels.slice(0, 4).map(labelPill).join("")}</div>` : ""}
        ${transcript ? `<p class="transcript">${esc(transcript)}</p>` : ""}
      </div>
      <div class="videoActions">
        ${videoUrl ? `<a href="${esc(videoUrl)}" rel="noreferrer" target="_blank">Open Video</a>` : ""}
        ${folderUrl ? `<a class="secondary" href="${esc(folderUrl)}" rel="noreferrer" target="_blank">Event Folder</a>` : ""}
      </div>
    </article>`;
}

function labelPill(label) {
  const golden = label.source === "golden_review";
  const tail = golden ? "Golden" : `<span class="pct">${Math.round((label.confidence || 0) * 100)}%</span>`;
  return `<span class="labelPill${golden ? " golden" : ""}">${esc(label.name)} ${tail}</span>`;
}

function metric(label, value) {
  return `<div class="metric"><span>${esc(label)}</span><strong>${esc(String(value))}</strong></div>`;
}

/* helpers */
function publishedFolders(idx) {
  return (idx.folders || []).filter((folder) => (folder.stats && folder.stats.publishedVideos) > 0);
}

function finalLabels(video) {
  const predictions = video.athleteLabels || [];
  return video.goldenLabel ? [video.goldenLabel, ...predictions] : predictions;
}

function seasonTitle(team) {
  const org = team.orgName || team.name || "";
  return /U\d/.test(org) ? `${org} Video Index` : "U14 Video Index";
}

function normalize(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function eventLabel(folder) {
  if (!folder) return "Unknown event";
  const date = shortDate(folder.eventDate || folder.timeCreated);
  const name = (folder.eventMatch && folder.eventMatch.canonicalName) || folder.name;
  return date ? `${date} · ${name}` : name;
}

function shortDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(date);
}

function formatDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}

function cap(value) {
  const s = String(value || "");
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "Pending";
}

function esc(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[ch]));
}
