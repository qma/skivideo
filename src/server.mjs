import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig, publicConfig } from "./config.mjs";
import { JsonStore } from "./lib/fsStore.mjs";
import { listRootEventFolders, buildFolderManifest } from "./adapters/graph.mjs";
import { buildRestFolderManifest, listRootEventFoldersRest, pickOldestFolder } from "./adapters/sharepointRest.mjs";
import { correlateFolderWithLiveTiming, fetchFarWestU14Events, fetchLiveTimingSearch, matchFoldersToEvents } from "./adapters/events.mjs";
import { processFolder } from "./pipeline/processFolder.mjs";
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
  if (req.method === "POST" && url.pathname === "/api/process-folder") {
    const body = await readBody(req);
    return processFolder(config, store, body.folderId);
  }
  if (req.method === "POST" && url.pathname === "/api/export-lean") {
    const result = await store.exportLean();
    return { ok: true, exportPath: result.exportPath, counts: countStore(result.lean) };
  }
  return { error: "Not found" };
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
