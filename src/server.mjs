import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import express from "express";
import { loadConfig, publicConfig } from "./config.mjs";
import { JsonStore } from "./lib/fsStore.mjs";
import { syncMetadataBackend } from "./lib/metadataBackend.mjs";
import { listRootEventFolders, buildFolderManifest } from "./adapters/graph.mjs";
import { buildRestFolderManifest, establishSharePointSession, listRootEventFoldersRest, pickOldestFolder } from "./adapters/sharepointRest.mjs";
import { correlateFolderWithLiveTiming, fetchFarWestU14Events, fetchLiveTimingSearch, matchFoldersToEvents } from "./adapters/events.mjs";
import { processFolder, relabelFolder } from "./pipeline/processFolder.mjs";
import { prepareEventFolder } from "./pipeline/prepareEvent.mjs";
import { detectTranscriptionBackends } from "./adapters/transcription.mjs";
import { normalizeText } from "./lib/text.mjs";

const config = loadConfig();
const store = new JsonStore(config);
await store.ensure();
let sharePointSessionPromise = null;

const app = express();

app.use(express.json({ limit: "2mb" }));

app.get("/api/config", asyncRoute(async () => ({
  ...publicConfig(config),
  transcriptionBackends: await detectTranscriptionBackends(config)
})));
app.get("/api/store", asyncRoute(() => store.read()));
app.get("/api/summary", asyncRoute(() => summary()));
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
  const state = await store.read();
  const folder = state.folders.find((item) => item.id === req.body.folderId);
  if (!folder) throw new Error(`Folder not found: ${req.body.folderId}`);
  const correlation = await correlateFolderWithLiveTiming(config, folder);
  await store.updateFolder(req.body.folderId, {
    candidateRoster: correlation.candidateRoster,
    raceAssets: correlation.assets,
    eventMatch: {
      ...(folder.eventMatch || {}),
      liveTimingMatch: correlation.liveTimingMatches[0] ? serializeLiveTimingMatch(correlation.liveTimingMatches[0]) : null,
      liveTimingMatches: correlation.liveTimingMatches.map(serializeLiveTimingMatch),
      sources: [...new Set([...(folder.eventMatch?.sources || []), correlation.search.sourceUrl])]
    }
  });
  return {
    ok: true,
    folderId: req.body.folderId,
    query: correlation.query,
    races: correlation.liveTimingMatches.map(serializeLiveTimingMatch),
    candidateRoster: correlation.candidateRoster.length,
    tptRoster: correlation.candidateRoster.filter((racer) => /^(TPT|TPTA)$/i.test(racer.team || "")).length,
    assets: correlation.assets
  };
}));
app.post("/api/list-sharepoint", asyncRoute(async () => {
  const folders = await listRootEventFolders(config);
  await store.upsertFolders(folders);
  return { ok: true, folders };
}));
app.post("/api/list-sharepoint-rest", asyncRoute(async () => {
  const folders = await listRootEventFoldersRest(config);
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
  const manifest = await buildRestFolderManifest(config, req.body.serverRelativeUrl);
  await store.upsertFolders(manifest.folders || []);
  await store.upsertVideos(manifest.videos || []);
  return { ok: true, manifest };
}));
app.post("/api/ingest-oldest-sharepoint-folder", asyncRoute(async () => {
  const folder = await pickOldestFolder(config);
  const manifest = await buildRestFolderManifest(config, folder.serverRelativeUrl);
  await store.upsertFolders(manifest.folders || []);
  await store.upsertVideos(manifest.videos || []);
  return { ok: true, selectedFolder: manifest.folders[0], videos: manifest.videos.length };
}));
app.post("/api/prepare-folder", asyncRoute((req) => prepareEventFolder(config, store, {
  folderId: req.body.folderId,
  serverRelativeUrl: req.body.serverRelativeUrl
})));
app.post("/api/process-folder", asyncRoute((req) => processFolder(config, store, req.body.folderId, {
  parallel: req.body.parallel || 4
})));
app.post("/api/process-folder-async", asyncRoute(async (req) => {
  const folderId = req.body.folderId;
  if (!folderId) throw new Error("folderId is required.");
  const parallel = normalizeParallel(req.body.parallel, 4);
  processFolder(config, store, folderId, { parallel }).catch((error) => {
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
app.post("/api/review-video", asyncRoute((req) => reviewVideo(req.body)));
app.post("/api/export-lean", asyncRoute(async () => {
  const result = await store.exportLean();
  return { ok: true, exportPath: result.exportPath, counts: countStore(result.lean) };
}));
app.post("/api/sync-metadata", asyncRoute(async () => syncMetadataBackend(config, await store.read())));

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
  const results = state.videos
    .filter((video) => !needle || normalizeText([
      video.filename,
      video.transcript?.text,
      ...(video.athleteLabels || []).map((label) => label.name)
    ].join(" ")).includes(needle))
    .map((video) => {
      const folder = state.folders.find((item) => item.id === video.folderId);
      return { ...video, folder };
    });
  return { query, results };
}

async function summary() {
  const state = await store.read();
  const folderStats = new Map(state.folders.map((folder) => [folder.id, {
    videoCount: 0,
    indexed: 0,
    needsReview: 0,
    failed: 0,
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
    if (video.localVideoPath) stats.localVideo += 1;
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
        localVideo: 0,
        transcripts: 0,
        labels: 0
      }
    })),
    jobs: state.jobs.slice(0, 8),
    events: state.events.slice(0, 12)
  };
}

async function eventDetail(folderId) {
  if (!folderId) throw new Error("folderId is required.");
  const state = await store.read();
  const folder = state.folders.find((item) => item.id === folderId);
  if (!folder) throw new Error(`Folder not found: ${folderId}`);
  return {
    folder,
    videos: state.videos
      .filter((video) => video.folderId === folderId)
      .map((video) => ({
        ...video,
        transcript: video.transcript ? {
          source: video.transcript.source,
          text: String(video.transcript.text || "").slice(0, 500),
          segments: []
        } : video.transcript
      }))
  };
}

async function serveMedia(req, res, videoId) {
  const state = await store.read();
  const video = state.videos.find((item) => item.id === videoId);
  if (!video) return res.status(404).json({ error: "Video not found" });
  if (!video.localVideoPath) {
    if (video.downloadUrl) return proxySharePointMedia(req, res, video);
    return res.redirect(302, video.sharepointUrl);
  }
  const stat = await fs.stat(video.localVideoPath);
  const range = req.headers.range;
  if (!range) {
    res.writeHead(200, {
      "content-length": stat.size,
      "content-type": video.mimeType || "video/mp4",
      "accept-ranges": "bytes"
    });
    return pipeMediaStream(fsSync.createReadStream(video.localVideoPath), res);
  }
  const match = range.match(/bytes=(\d+)-(\d*)/);
  const start = match ? Number(match[1]) : 0;
  const end = match && match[2] ? Number(match[2]) : stat.size - 1;
  res.writeHead(206, {
    "content-range": `bytes ${start}-${end}/${stat.size}`,
    "accept-ranges": "bytes",
    "content-length": end - start + 1,
    "content-type": video.mimeType || "video/mp4"
  });
  return pipeMediaStream(fsSync.createReadStream(video.localVideoPath, { start, end }), res);
}

async function proxySharePointMedia(req, res, video) {
  const session = await sharedSharePointSession();
  const headers = {
    cookie: session.cookies
  };
  if (req.headers.range) headers.range = req.headers.range;
  const response = await fetch(video.downloadUrl, { headers });
  if (!response.ok) {
    throw new Error(`SharePoint media proxy failed ${response.status}: ${await response.text()}`);
  }
  const passthroughHeaders = {};
  for (const key of ["content-length", "content-range", "content-type", "accept-ranges"]) {
    const value = response.headers.get(key);
    if (value) passthroughHeaders[key] = value;
  }
  res.writeHead(response.status, passthroughHeaders);
  return pipeMediaStream(Readable.fromWeb(response.body), res);
}

async function sharedSharePointSession() {
  if (!sharePointSessionPromise) sharePointSessionPromise = establishSharePointSession(config.sharepointRootUrl);
  return sharePointSessionPromise;
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

function serializeLiveTimingMatch(match) {
  return {
    raceId: match.race.raceId,
    name: match.race.name,
    gender: match.race.gender,
    type: match.race.type,
    resort: match.race.resort,
    date: match.race.date,
    confidence: match.confidence,
    sourceUrl: match.race.sourceUrl
  };
}
