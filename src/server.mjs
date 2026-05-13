import http from "node:http";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig, publicConfig } from "./config.mjs";
import { JsonStore } from "./lib/fsStore.mjs";
import { syncMetadataBackend } from "./lib/metadataBackend.mjs";
import { listRootEventFolders, buildFolderManifest } from "./adapters/graph.mjs";
import { buildRestFolderManifest, listRootEventFoldersRest, pickOldestFolder } from "./adapters/sharepointRest.mjs";
import { correlateFolderWithLiveTiming, fetchFarWestU14Events, fetchLiveTimingSearch, matchFoldersToEvents } from "./adapters/events.mjs";
import { processFolder, relabelFolder } from "./pipeline/processFolder.mjs";
import { prepareEventFolder } from "./pipeline/prepareEvent.mjs";
import { detectTranscriptionBackends } from "./adapters/transcription.mjs";
import { normalizeText } from "./lib/text.mjs";

const config = loadConfig();
const store = new JsonStore(config);
await store.ensure();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) {
      const result = await routeApi(req, url);
      return sendJson(res, result);
    }
    if (url.pathname.startsWith("/media/")) return serveMedia(req, res, decodeURIComponent(url.pathname.replace(/^\/media\//, "")));
    return serveStatic(res, url.pathname);
  } catch (error) {
    sendJson(res, { error: error.message }, 500);
  }
});

server.listen(config.port, config.host, () => {
  console.log(`Ski Video Companion running at http://${config.host}:${config.port}`);
});

async function routeApi(req, url) {
  if (req.method === "GET" && url.pathname === "/api/config") {
    return { ...publicConfig(config), transcriptionBackends: await detectTranscriptionBackends(config) };
  }
  if (req.method === "GET" && url.pathname === "/api/store") return store.read();
  if (req.method === "GET" && url.pathname === "/api/summary") return summary();
  if (req.method === "GET" && url.pathname === "/api/event") return eventDetail(url.searchParams.get("folderId") || "");
  if (req.method === "GET" && url.pathname === "/api/search") return search(url.searchParams.get("q") || "");
  if (req.method === "POST" && url.pathname === "/api/ingest-sample") {
    const manifest = JSON.parse(await fs.readFile(path.join(config.rootDir, "samples/sample-manifest.json"), "utf8"));
    await store.upsertFolders(manifest.folders || []);
    await store.upsertVideos(manifest.videos || []);
    return { ok: true, folders: manifest.folders?.length || 0, videos: manifest.videos?.length || 0 };
  }
  if (req.method === "POST" && url.pathname === "/api/fetch-events") {
    const events = await fetchFarWestU14Events(config);
    await store.upsertEvents(events);
    const state = await store.read();
    if (state.folders.length && events.length) await store.upsertFolders(matchFoldersToEvents(state.folders, events));
    return { ok: true, events: events.length };
  }
  if (req.method === "POST" && url.pathname === "/api/fetch-live-timing") {
    const body = await readBody(req);
    return fetchLiveTimingSearch(config, body.query || "");
  }
  if (req.method === "POST" && url.pathname === "/api/correlate-folder-live-timing") {
    const body = await readBody(req);
    const state = await store.read();
    const folder = state.folders.find((item) => item.id === body.folderId);
    if (!folder) throw new Error(`Folder not found: ${body.folderId}`);
    const correlation = await correlateFolderWithLiveTiming(config, folder);
    await store.updateFolder(body.folderId, {
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
      folderId: body.folderId,
      query: correlation.query,
      races: correlation.liveTimingMatches.map(serializeLiveTimingMatch),
      candidateRoster: correlation.candidateRoster.length,
      tptRoster: correlation.candidateRoster.filter((racer) => /^(TPT|TPTA)$/i.test(racer.team || "")).length,
      assets: correlation.assets
    };
  }
  if (req.method === "POST" && url.pathname === "/api/list-sharepoint") {
    const folders = await listRootEventFolders(config);
    await store.upsertFolders(folders);
    return { ok: true, folders };
  }
  if (req.method === "POST" && url.pathname === "/api/list-sharepoint-rest") {
    const folders = await listRootEventFoldersRest(config);
    await store.upsertFolders(folders);
    return { ok: true, folders };
  }
  if (req.method === "POST" && url.pathname === "/api/manifest-sharepoint") {
    const body = await readBody(req);
    const manifest = await buildFolderManifest(config, body.folderUrl);
    await store.upsertFolders(manifest.folders || []);
    await store.upsertVideos(manifest.videos || []);
    return { ok: true, manifest };
  }
  if (req.method === "POST" && url.pathname === "/api/manifest-sharepoint-rest") {
    const body = await readBody(req);
    const manifest = await buildRestFolderManifest(config, body.serverRelativeUrl);
    await store.upsertFolders(manifest.folders || []);
    await store.upsertVideos(manifest.videos || []);
    return { ok: true, manifest };
  }
  if (req.method === "POST" && url.pathname === "/api/ingest-oldest-sharepoint-folder") {
    const folder = await pickOldestFolder(config);
    const manifest = await buildRestFolderManifest(config, folder.serverRelativeUrl);
    await store.upsertFolders(manifest.folders || []);
    await store.upsertVideos(manifest.videos || []);
    return { ok: true, selectedFolder: manifest.folders[0], videos: manifest.videos.length };
  }
  if (req.method === "POST" && url.pathname === "/api/prepare-folder") {
    const body = await readBody(req);
    return prepareEventFolder(config, store, {
      folderId: body.folderId,
      serverRelativeUrl: body.serverRelativeUrl
    });
  }
  if (req.method === "POST" && url.pathname === "/api/process-folder") {
    const body = await readBody(req);
    return processFolder(config, store, body.folderId, { parallel: body.parallel || 1 });
  }
  if (req.method === "POST" && url.pathname === "/api/relabel-folder") {
    const body = await readBody(req);
    return relabelFolder(config, store, body.folderId);
  }
  if (req.method === "POST" && url.pathname === "/api/review-video") {
    const body = await readBody(req);
    return reviewVideo(body);
  }
  if (req.method === "POST" && url.pathname === "/api/export-lean") {
    const result = await store.exportLean();
    return { ok: true, exportPath: result.exportPath, counts: countStore(result.lean) };
  }
  if (req.method === "POST" && url.pathname === "/api/sync-metadata") {
    return syncMetadataBackend(config, await store.read());
  }
  return { error: "Not found" };
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

async function serveStatic(res, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.join(config.rootDir, "public", safePath.replace(/^\/+/, ""));
  const content = await fs.readFile(filePath);
  const type = filePath.endsWith(".css") ? "text/css"
    : filePath.endsWith(".js") ? "text/javascript"
    : "text/html";
  res.writeHead(200, { "content-type": type });
  res.end(content);
}

async function serveMedia(req, res, videoId) {
  const state = await store.read();
  const video = state.videos.find((item) => item.id === videoId);
  if (!video) return sendJson(res, { error: "Video not found" }, 404);
  if (!video.localVideoPath) {
    res.writeHead(302, { location: video.sharepointUrl });
    return res.end();
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

function pipeMediaStream(stream, res) {
  stream.on("error", () => {
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Media read failed" }));
      return;
    }
    res.destroy();
  });
  return stream.pipe(res);
}

async function readBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res, value, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value, null, 2));
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
