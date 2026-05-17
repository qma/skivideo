import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import express from "express";
import { loadConfig, publicConfig } from "./config.mjs";
import { JsonStore } from "./lib/fsStore.mjs";
import { syncMetadataBackend } from "./lib/metadataBackend.mjs";
import { listRootEventFolders, buildFolderManifest } from "./adapters/graph.mjs";
import { buildRestFolderManifest, listRootEventFoldersRest, pickOldestFolder } from "./adapters/sharepointRest.mjs";
import { fetchFarWestU14Events, fetchLiveTimingSearch, matchFoldersToEvents } from "./adapters/events.mjs";
import { processFolder, relabelFolder } from "./pipeline/processFolder.mjs";
import { prepareEventFolder } from "./pipeline/prepareEvent.mjs";
import { confirmLiveTimingSelection, ensureFolderManifest, ensureLiveTimingCorrelation } from "./pipeline/eventDependencies.mjs";
import { detectTranscriptionBackends } from "./adapters/transcription.mjs";
import { normalizeText } from "./lib/text.mjs";

const config = loadConfig();
const store = new JsonStore(config);
await store.ensure();
await store.failRunningJobs();

const app = express();

app.use(express.json({ limit: "2mb" }));

app.get("/api/config", asyncRoute(async () => ({
  ...publicConfig(config),
  transcriptionBackends: await detectTranscriptionBackends(config)
})));
app.get("/api/store", asyncRoute(() => store.read()));
app.get("/api/summary", asyncRoute(() => summary()));
app.get("/api/job", asyncRoute((req) => jobDetail(req.query.id || "")));
app.get("/api/event", asyncRoute((req) => eventDetail(req.query.folderId || "")));
app.get("/api/search", asyncRoute((req) => search(req.query.q || "")));

app.post("/api/ingest-sample", asyncRoute(async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(config.rootDir, "samples/sample-manifest.json"), "utf8"));
  await store.upsertFolders(manifest.folders || []);
  await store.upsertVideos(manifest.videos || []);
  return { ok: true, folders: manifest.folders?.length || 0, videos: manifest.videos?.length || 0 };
}));
app.post("/api/fetch-events", asyncRoute(async () => {
  const events = await fetchFarWestU14Events(config);
  await store.upsertEvents(events);
  const state = await store.read();
  if (state.folders.length && events.length) await store.upsertFolders(matchFoldersToEvents(state.folders, events));
  return { ok: true, events: events.length };
}));
app.post("/api/fetch-live-timing", asyncRoute((req) => fetchLiveTimingSearch(config, req.body.query || "")));
app.post("/api/correlate-folder-live-timing", asyncRoute(async (req) => {
  const correlation = await ensureLiveTimingCorrelation(config, store, req.body.folderId, { force: true });
  return {
    ok: true,
    folderId: req.body.folderId,
    query: correlation.query,
    races: correlation.races,
    candidates: correlation.candidates,
    selection: correlation.selection,
    candidateRoster: correlation.candidateRoster,
    tptRoster: correlation.tptRoster,
    assets: correlation.assets
  };
}));
app.post("/api/confirm-live-timing", asyncRoute(async (req) => {
  const confirmation = await confirmLiveTimingSelection(config, store, req.body.folderId, req.body.raceIds || []);
  const relabel = await relabelFolder(config, store, req.body.folderId);
  return {
    ...confirmation,
    relabel,
    message: `${confirmation.message}; recalculated ${relabel.indexed} indexed and ${relabel.needsReview} review label status${relabel.videos === 1 ? "" : "es"}`
  };
}));
app.post("/api/list-sharepoint", asyncRoute(async () => {
  const folders = await listRootEventFolders(config);
  await store.upsertFolders(folders);
  return { ok: true, folders };
}));
app.post("/api/list-sharepoint-rest", asyncRoute(async (req) => {
  const rootUrl = await lookupSharePointRootUrl(config, store, req.body);
  const folders = await listRootEventFoldersRest(config, rootUrl);
  await store.upsertFolders(folders);
  return { ok: true, folders };
}));
app.post("/api/manifest-sharepoint", asyncRoute(async (req) => {
  const manifest = await buildFolderManifest(config, req.body.folderUrl);
  await store.upsertFolders(manifest.folders || []);
  await store.upsertVideos(manifest.videos || []);
  return { ok: true, manifest };
}));
app.post("/api/manifest-sharepoint-rest", asyncRoute(async (req) => {
  const rootUrl = await lookupSharePointRootUrl(config, store, req.body);
  const manifest = await buildRestFolderManifest(config, req.body.serverRelativeUrl, rootUrl);
  await store.upsertFolders(manifest.folders || []);
  await store.upsertVideos(manifest.videos || []);
  return { ok: true, manifest };
}));
app.post("/api/ingest-oldest-sharepoint-folder", asyncRoute(async (req) => {
  const rootUrl = await lookupSharePointRootUrl(config, store, req.body);
  const folder = await pickOldestFolder(config, rootUrl);
  const manifest = await buildRestFolderManifest(config, folder.serverRelativeUrl, rootUrl);
  await store.upsertFolders(manifest.folders || []);
  await store.upsertVideos(manifest.videos || []);
  return { ok: true, selectedFolder: manifest.folders[0], videos: manifest.videos.length };
}));
app.post("/api/prepare-folder", asyncRoute((req) => prepareEventFolder(config, store, {
  folderId: req.body.folderId,
  serverRelativeUrl: req.body.serverRelativeUrl
})));
app.post("/api/ensure-folder-manifest", asyncRoute((req) => ensureFolderManifest(config, store, req.body.folderId)));
app.post("/api/process-folder", asyncRoute((req) => processFolder(config, store, req.body.folderId, {
  parallel: req.body.parallel || 4,
  forceTranscribe: Boolean(req.body.forceTranscribe),
  transcriptionPrompt: req.body.transcriptionPrompt,
  noDownload: Boolean(req.body.noDownload),
  reprocess: Boolean(req.body.reprocess),
  whisperCppNoGpu: booleanOrUndefined(req.body.whisperCppNoGpu)
})));
app.post("/api/process-folder-async", asyncRoute(async (req) => {
  const folderId = req.body.folderId;
  if (!folderId) throw new Error("folderId is required.");
  const parallel = normalizeParallel(req.body.parallel, 4);
  processFolder(config, store, folderId, {
    parallel,
    forceTranscribe: Boolean(req.body.forceTranscribe),
    transcriptionPrompt: req.body.transcriptionPrompt,
    noDownload: Boolean(req.body.noDownload),
    reprocess: Boolean(req.body.reprocess),
    whisperCppNoGpu: booleanOrUndefined(req.body.whisperCppNoGpu)
  }).catch((error) => {
    console.error(`Background processing failed for ${folderId}:`, error);
  });
  return {
    ok: true,
    folderId,
    parallel,
    message: `Processing started in the background with ${parallel} workers. Watch the Jobs panel for live progress.`
  };
}));
app.post("/api/relabel-folder", asyncRoute((req) => relabelFolder(config, store, req.body.folderId)));
app.post("/api/delete-folder", asyncRoute(async (req) => {
  console.log("Delete folder requested:", req.body.folderId);
  if (!req.body.folderId) throw new Error("folderId is required.");
  await store.removeFolder(req.body.folderId);
  return { ok: true, folderId: req.body.folderId };
}));
app.post("/api/reset-folder", asyncRoute(async (req) => {
  console.log("Reset folder requested:", req.body.folderId);
  if (!req.body.folderId) throw new Error("folderId is required.");
  await store.resetFolder(req.body.folderId);
  return {
    ok: true,
    folderId: req.body.folderId,
    message: "Folder reset to discovered state. Local media files on disk were not deleted."
  };
}));
app.post("/api/review-video", asyncRoute((req) => reviewVideo(req.body)));
app.post("/api/bulk-review", asyncRoute(async (req) => {
  if (!req.body.folderId) throw new Error("folderId is required.");
  if (!["mark-indexed", "clear-labels"].includes(req.body.action)) throw new Error("Unsupported bulk action.");
  await store.bulkReviewVideos(req.body.folderId, req.body.action);
  return { ok: true, folderId: req.body.folderId, action: req.body.action };
}));
app.post("/api/export-lean", asyncRoute(async () => {
  const result = await store.exportLean();
  return { ok: true, exportPath: result.exportPath, counts: countStore(result.lean) };
}));
app.post("/api/sync-metadata", asyncRoute(async () => syncMetadataBackend(config, await store.read())));

// Public Preview Routes
// Allows viewing the public-facing UI code (from apps/public-next/out) with live metadata.
// Requires 'npm run public:build' to have been run at least once to generate the UI code.
app.get("/data/lean-index.json", asyncRoute(async () => {
  const result = await store.exportPublicLean();
  return result.lean;
}));
app.use("/_next", express.static(path.join(config.rootDir, "apps/public-next/out/_next")));
app.use("/public-preview", (req, res) => {
  const indexPath = path.join(config.rootDir, "apps/public-next/out/index.html");
  if (!fsSync.existsSync(indexPath)) {
    return res.status(503).send("<h1>Public Preview Unavailable</h1><p>Please run <code>npm run public:build</code> first to generate the UI code.</p>");
  }
  res.sendFile(indexPath);
});

app.get("/media/:videoId", asyncRoute(async (req, res) => serveMedia(req, res, req.params.videoId)));
app.use(express.static(path.join(config.rootDir, "public")));
app.use((req, res) => res.status(404).json({ error: "Not found" }));
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  res.status(error.status || 500).json({ error: error.message || "Internal server error" });
});

app.listen(config.port, config.host, () => {
  console.log(`Ski Video Companion running at http://${config.host}:${config.port}`);
});

function asyncRoute(fn) {
  return async (req, res, next) => {
    try {
      const result = await fn(req, res);
      if (!res.headersSent) res.json(result);
    } catch (error) {
      next(error);
    }
  };
}

function normalizeParallel(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(16, Math.floor(parsed)));
}

function booleanOrUndefined(value) {
  return typeof value === "boolean" ? value : undefined;
}

async function reviewVideo(body) {
  if (!body.videoId) throw new Error("videoId is required.");
  if (!["manual-label", "clear-labels"].includes(body.action)) throw new Error("Unsupported review action.");
  const labelName = String(body.labelName || "").trim();
  if (body.action === "manual-label" && !labelName) throw new Error("labelName is required.");
  let updated = null;
  await store.updateVideoWith((state) => {
    state.videos = state.videos.map((video) => {
      if (video.id !== body.videoId) return video;
      if (body.action === "clear-labels") {
        updated = {
          ...video,
          athleteLabels: [],
          processing: {
            ...(video.processing || {}),
            status: "needs_review",
            reviewedAt: new Date().toISOString()
          }
        };
        return updated;
      }
      const manualLabel = {
        name: labelName,
        confidence: 0.99,
        source: "manual_review",
        evidence: "Manually assigned in event review UI",
        matchedRoster: false,
        methodVersion: "manual-v1"
      };
      updated = {
        ...video,
        athleteLabels: [manualLabel, ...(video.athleteLabels || []).filter((label) => label.source !== "manual_review")],
        processing: {
          ...(video.processing || {}),
          status: "indexed",
          reviewedAt: new Date().toISOString()
        }
      };
      return updated;
    });
    return state;
  });
  if (!updated) throw new Error(`Video not found: ${body.videoId}`);
  return { ok: true, video: updated };
}

async function search(query) {
  const state = await store.read();
  const needle = normalizeText(query);
  const results = await Promise.all(state.videos
    .filter((video) => !needle || normalizeText([
      video.filename,
      video.transcript?.text,
      ...(video.athleteLabels || []).map((label) => label.name)
    ].join(" ")).includes(needle))
    .map(async (video) => {
      const folder = state.folders.find((item) => item.id === video.folderId);
      return {
        ...video,
        folder,
        localVideoPlayable: Boolean(video.localVideoPath && await readableLocalMedia(video.localVideoPath))
      };
    }));
  return { query, results };
}

async function summary() {
  const state = await store.read();
  const foldersById = new Map(state.folders.map((folder) => [folder.id, folder]));
  const folderStats = new Map(state.folders.map((folder) => [folder.id, {
    videoCount: 0,
    indexed: 0,
    needsReview: 0,
    failed: 0,
    localVideoRefs: 0,
    localVideo: 0,
    transcripts: 0,
    labels: 0
  }]));
  let labels = 0;
  for (const video of state.videos) {
    const stats = folderStats.get(video.folderId);
    const labelCount = video.athleteLabels?.length || 0;
    labels += labelCount;
    if (!stats) continue;
    stats.videoCount += 1;
    stats.labels += labelCount;
    if (video.localVideoPath) stats.localVideoRefs += 1;
    if (video.localVideoPath && await readableLocalMedia(video.localVideoPath)) stats.localVideo += 1;
    if (video.transcript?.text) stats.transcripts += 1;
    const status = video.processing?.status || "pending";
    if (status === "indexed") stats.indexed += 1;
    else if (status === "needs_review") stats.needsReview += 1;
    else if (status === "failed") stats.failed += 1;
  }
  return {
    counts: {
      folders: state.folders.length,
      videos: state.videos.length,
      labels
    },
    folders: state.folders.map((folder) => ({
      id: folder.id,
      source: folder.source,
      name: folder.name,
      path: folder.path,
      serverRelativeUrl: folder.serverRelativeUrl,
      sharepointUrl: folder.sharepointUrl,
      itemCount: folder.itemCount,
      timeCreated: folder.timeCreated,
      timeLastModified: folder.timeLastModified,
      discoveredAt: folder.discoveredAt,
      eventMatch: folder.eventMatch,
      raceAssetCount: folder.raceAssets?.length || 0,
      candidateRosterCount: folder.candidateRoster?.length || 0,
      stats: folderStats.get(folder.id) || {
        videoCount: 0,
        indexed: 0,
        needsReview: 0,
        failed: 0,
        localVideoRefs: 0,
        localVideo: 0,
        transcripts: 0,
        labels: 0
      }
    })),
    jobs: state.jobs.slice(0, 8).map((job) => summarizeJob(job, foldersById)),
    events: state.events.slice(0, 12)
  };
}

function summarizeJob(job, foldersById) {
  const staleAfterMs = 60 * 60 * 1000;
  const updatedAt = Date.parse(job.updatedAt || job.startedAt || "");
  const isStale = job.status === "running" && Number.isFinite(updatedAt) && Date.now() - updatedAt > staleAfterMs;
  const logs = jobLogs(job);
  const { logs: _logs, ...summaryJob } = job;
  return {
    ...summaryJob,
    status: isStale ? "stale" : job.status,
    folderName: foldersById.get(job.folderId)?.name || "",
    stale: isStale,
    logCount: logs.length
  };
}

async function jobDetail(jobId) {
  if (!jobId) throw new Error("job id is required.");
  const state = await store.read();
  const foldersById = new Map(state.folders.map((folder) => [folder.id, folder]));
  const job = state.jobs.find((item) => item.id === jobId);
  if (!job) throw new Error(`Job not found: ${jobId}`);
  return {
    ok: true,
    job: summarizeJob(job, foldersById),
    logs: jobLogs(job)
  };
}

function jobLogs(job) {
  if (Array.isArray(job.logs) && job.logs.length) return job.logs;
  const entries = [{
    at: job.startedAt || job.updatedAt || "",
    status: job.status || "",
    message: job.message || "",
    details: job.details || "",
    indexed: job.indexed || 0,
    needsReview: job.needsReview || 0,
    failed: job.failed || 0,
    parallel: job.parallel || 0
  }];
  if (job.completedAt && job.completedAt !== entries[0].at) {
    entries.push({
      ...entries[0],
      at: job.completedAt,
      status: job.status || "",
      message: job.message || ""
    });
  }
  return entries;
}

async function eventDetail(folderId) {
  if (!folderId) throw new Error("folderId is required.");
  const state = await store.read();
  const folder = state.folders.find((item) => item.id === folderId);
  if (!folder) throw new Error(`Folder not found: ${folderId}`);
  return {
    folder,
    videos: await Promise.all(state.videos
      .filter((video) => video.folderId === folderId)
      .map(async (video) => ({
          ...video,
          localVideoPlayable: Boolean(video.localVideoPath && await readableLocalMedia(video.localVideoPath)),
          transcript: video.transcript ? {
            source: video.transcript.source,
            text: String(video.transcript.text || "").slice(0, 500),
            segments: []
          } : video.transcript
        })))
  };
}

async function serveMedia(req, res, videoId) {
  const state = await store.read();
  const video = state.videos.find((item) => item.id === videoId);
  if (!video) return res.status(404).json({ error: "Video not found" });
  const localMedia = video.localVideoPath ? await readableLocalMedia(video.localVideoPath) : null;
  if (!localMedia) {
    // Redirect to SharePoint original source to avoid server bandwidth bloat from proxying.
    // This may prompt for login in the browser if the user does not have a session.
    return res.redirect(302, video.sharepointUrl);
  }
  const range = req.headers.range;
  if (!range) {
    res.writeHead(200, {
      "content-length": localMedia.stat.size,
      "content-type": video.mimeType || "video/mp4",
      "accept-ranges": "bytes"
    });
    if (req.method === "HEAD") return res.end();
    return pipeMediaStream(fsSync.createReadStream(video.localVideoPath), res);
  }
  const match = range.match(/bytes=(\d+)-(\d*)/);
  const start = match ? Number(match[1]) : 0;
  const end = match && match[2] ? Number(match[2]) : localMedia.stat.size - 1;
  res.writeHead(206, {
    "content-range": `bytes ${start}-${end}/${localMedia.stat.size}`,
    "accept-ranges": "bytes",
    "content-length": end - start + 1,
    "content-type": video.mimeType || "video/mp4"
  });
  if (req.method === "HEAD") return res.end();
  return pipeMediaStream(fsSync.createReadStream(video.localVideoPath, { start, end }), res);
}

async function readableLocalMedia(localPath) {
  try {
    const stat = await fs.stat(localPath);
    if (!stat.isFile() || stat.size <= 0) return null;
    if (Number(stat.blocks) === 0) return null;
    return { stat };
  } catch {
    return null;
  }
}

function pipeMediaStream(stream, res) {
  stream.on("error", () => {
    if (!res.headersSent) {
      res.status(500).json({ error: "Media read failed" });
      return;
    }
    res.destroy();
  });
  return stream.pipe(res);
}

function countStore(state) {
  return {
    folders: state.folders?.length || 0,
    events: state.events?.length || 0,
    videos: state.videos?.length || 0
  };
}

async function lookupSharePointRootUrl(config, store, input = {}) {
  if (config.sharepointRootUrl && !config.sharepointRootUrl.includes("<tenant>")) {
    return config.sharepointRootUrl;
  }
  const state = await store.read();
  const teamId = input.teamId || state.teams[0]?.id;
  const team = state.teams.find((t) => t.id === teamId);
  if (team?.sharepointRootUrl) return team.sharepointRootUrl;
  return config.sharepointRootUrl;
}
