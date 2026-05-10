#!/usr/bin/env node
import fs from "node:fs/promises";
import { loadConfig, publicConfig } from "./config.mjs";
import { JsonStore } from "./lib/fsStore.mjs";
import { buildFolderManifest, listRootEventFolders } from "./adapters/graph.mjs";
import { buildRestFolderManifest, listRootEventFoldersRest, pickOldestFolder } from "./adapters/sharepointRest.mjs";
import { fetchFarWestU14Events, fetchLiveTimingDailyRaces, fetchLiveTimingSearch, matchFolderToLiveTimingRace, matchFoldersToEvents } from "./adapters/events.mjs";
import { processFolder, processVideo } from "./pipeline/processFolder.mjs";
import { detectTranscriptionBackends } from "./adapters/transcription.mjs";
import { normalizeText } from "./lib/text.mjs";

const config = loadConfig();
const store = new JsonStore(config);
const [command, ...args] = process.argv.slice(2);

await main(command || "help", args);

async function main(cmd, args) {
  if (cmd === "help") return printHelp();
  if (cmd === "config") return printJson(publicConfig(config));
  if (cmd === "sample") return printJson(JSON.parse(await fs.readFile("samples/sample-manifest.json", "utf8")));
  if (cmd === "ingest-sample") return ingestManifest("samples/sample-manifest.json");
  if (cmd === "ingest-manifest") return ingestManifest(args[0]);
  if (cmd === "fetch-events") return fetchEvents();
  if (cmd === "fetch-live-timing") return fetchLiveTiming(args.join(" "));
  if (cmd === "fetch-live-timing-day") return fetchLiveTimingDay(args[0]);
  if (cmd === "correlate-folder-live-timing") return correlateFolderLiveTiming(args[0]);
  if (cmd === "list-sharepoint") return listSharePoint();
  if (cmd === "list-sharepoint-rest") return listSharePointRest();
  if (cmd === "manifest-sharepoint") return manifestSharePoint(args[0]);
  if (cmd === "manifest-sharepoint-rest") return manifestSharePointRest(args.join(" "));
  if (cmd === "ingest-oldest-sharepoint-folder") return ingestOldestSharePointFolder();
  if (cmd === "process-folder") return printJson(await processFolder(config, store, args[0]));
  if (cmd === "process-video") return processSingleVideo(args[0]);
  if (cmd === "export-lean") return printJson(await store.exportLean());
  if (cmd === "search") return search(args.join(" "));
  if (cmd === "backends") return printJson(await detectTranscriptionBackends(config));
  throw new Error(`Unknown command: ${cmd}`);
}

async function ingestManifest(filePath) {
  if (!filePath) throw new Error("Manifest path is required.");
  const manifest = JSON.parse(await fs.readFile(filePath, "utf8"));
  if (manifest.folders?.length) await store.upsertFolders(manifest.folders);
  if (manifest.videos?.length) await store.upsertVideos(manifest.videos);
  printJson({
    folders: manifest.folders?.length || 0,
    videos: manifest.videos?.length || 0
  });
}

async function fetchEvents() {
  const events = await fetchFarWestU14Events(config);
  await store.upsertEvents(events);
  const state = await store.read();
  if (state.folders.length && events.length) {
    await store.upsertFolders(matchFoldersToEvents(state.folders, events));
  }
  printJson({ events: events.length });
}

async function fetchLiveTiming(query) {
  const result = await fetchLiveTimingSearch(config, query);
  printJson(result);
}

async function fetchLiveTimingDay(date) {
  const result = await fetchLiveTimingDailyRaces(config, date);
  printJson({
    sourceUrl: result.sourceUrl,
    rawPath: result.rawPath,
    races: result.races
  });
}

async function correlateFolderLiveTiming(folderId) {
  if (!folderId) throw new Error("Folder id is required.");
  const state = await store.read();
  const folder = state.folders.find((item) => item.id === folderId);
  if (!folder) throw new Error(`Folder not found: ${folderId}`);
  const query = [
    folder.eventMatch?.date,
    folder.eventMatch?.venue,
    folder.eventMatch?.discipline,
    folder.name
  ].filter(Boolean).join(" ");
  const result = await fetchLiveTimingSearch(config, query);
  const daily = folder.eventMatch?.date ? await fetchLiveTimingDailyRaces(config, folder.eventMatch.date) : null;
  const dailyMatch = daily ? matchFolderToLiveTimingRace(folder, daily.races) : null;
  const assets = [
    {
      type: "live_timing_search",
      label: `Live-Timing search: ${query}`,
      sourceUrl: result.sourceUrl,
      localPath: result.rawPath
    },
    ...(daily ? [{
      type: "live_timing_daily_archive",
      label: `Live-Timing daily archive: ${folder.eventMatch.date}`,
      sourceUrl: daily.sourceUrl,
      localPath: daily.rawPath
    }] : []),
    ...(dailyMatch ? [
      {
        type: "race_page",
        label: `${dailyMatch.race.resort} - ${dailyMatch.race.name}`,
        sourceUrl: dailyMatch.race.sourceUrl,
        localPath: ""
      },
      ...dailyMatch.race.reports
    ] : []),
    ...result.assets.filter((asset) => !/^Races$|^Split Second$/i.test(asset.label))
  ];
  await store.updateFolder(folderId, {
    raceAssets: assets,
    eventMatch: {
      ...(folder.eventMatch || {}),
      liveTimingMatch: dailyMatch ? {
        raceId: dailyMatch.race.raceId,
        name: dailyMatch.race.name,
        resort: dailyMatch.race.resort,
        confidence: dailyMatch.confidence,
        sourceUrl: dailyMatch.race.sourceUrl
      } : null,
      sources: [...new Set([...(folder.eventMatch?.sources || []), result.sourceUrl])]
    }
  });
  printJson({ folderId, query, assets });
}

async function listSharePoint() {
  const folders = await listRootEventFolders(config);
  await store.upsertFolders(folders);
  printJson({ folders });
}

async function listSharePointRest() {
  const folders = await listRootEventFoldersRest(config);
  await store.upsertFolders(folders);
  printJson({ folders });
}

async function manifestSharePoint(folderUrl) {
  const manifest = await buildFolderManifest(config, folderUrl);
  await store.upsertFolders(manifest.folders);
  await store.upsertVideos(manifest.videos);
  printJson(manifest);
}

async function manifestSharePointRest(folderServerRelativeUrl) {
  if (!folderServerRelativeUrl) throw new Error("Folder server-relative URL is required.");
  const manifest = await buildRestFolderManifest(config, folderServerRelativeUrl);
  await store.upsertFolders(manifest.folders);
  await store.upsertVideos(manifest.videos);
  printJson({
    folder: manifest.folders[0],
    videos: manifest.videos.length
  });
}

async function ingestOldestSharePointFolder() {
  const folder = await pickOldestFolder(config);
  const manifest = await buildRestFolderManifest(config, folder.serverRelativeUrl);
  await store.upsertFolders(manifest.folders);
  await store.upsertVideos(manifest.videos);
  printJson({
    selectedFolder: manifest.folders[0],
    videos: manifest.videos.length
  });
}

async function search(query) {
  const state = await store.read();
  const needle = normalizeText(query);
  const results = state.videos
    .filter((video) => {
      const labels = (video.athleteLabels || []).map((label) => label.name).join(" ");
      return normalizeText(`${labels} ${video.filename} ${video.transcript?.text || ""}`).includes(needle);
    })
    .map((video) => ({
      id: video.id,
      filename: video.filename,
      sharepointUrl: video.sharepointUrl,
      labels: video.athleteLabels || [],
      folder: state.folders.find((folder) => folder.id === video.folderId)?.name || ""
    }));
  printJson(results);
}

async function processSingleVideo(videoId) {
  if (!videoId) throw new Error("Video id is required.");
  const state = await store.read();
  const video = state.videos.find((item) => item.id === videoId);
  if (!video) throw new Error(`Video not found: ${videoId}`);
  const folder = state.folders.find((item) => item.id === video.folderId);
  const processed = await processVideo(config, video, folder);
  await store.updateVideo(video.id, processed);
  printJson({
    id: processed.id,
    filename: processed.filename,
    status: processed.processing.status,
    errors: processed.processing.errors,
    transcriptSource: processed.transcript?.source,
    transcriptPreview: String(processed.transcript?.text || "").slice(0, 400),
    labels: processed.athleteLabels
  });
}

function printHelp() {
  console.log(`Ski Video Companion CLI

Commands:
  config
  sample
  ingest-sample
  ingest-manifest <path>
  fetch-events
  fetch-live-timing [query]
  fetch-live-timing-day <YYYY-MM-DD>
  correlate-folder-live-timing <folderId>
  list-sharepoint
  list-sharepoint-rest
  manifest-sharepoint <folderUrl>
  manifest-sharepoint-rest <serverRelativeUrl>
  ingest-oldest-sharepoint-folder
  process-folder <folderId>
  process-video <videoId>
  export-lean
  search <query>
  backends
`);
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}
