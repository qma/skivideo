#!/usr/bin/env node
import fs from "node:fs/promises";
import { loadConfig, publicConfig } from "./config.mjs";
import { JsonStore } from "./lib/fsStore.mjs";
import { syncMetadataBackend } from "./lib/metadataBackend.mjs";
import { buildFolderManifest, listRootEventFolders } from "./adapters/graph.mjs";
import { buildRestFolderManifest, listRootEventFoldersRest, pickOldestFolder } from "./adapters/sharepointRest.mjs";
import { correlateFolderWithLiveTiming, fetchFarWestU14Events, fetchLiveTimingDailyRaces, fetchLiveTimingRaceData, fetchLiveTimingSearch, matchFoldersToEvents } from "./adapters/events.mjs";
import { processFolder, processVideo, relabelFolder } from "./pipeline/processFolder.mjs";
import { prepareEventFolder } from "./pipeline/prepareEvent.mjs";
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
  if (cmd === "fetch-live-timing-race") return fetchLiveTimingRace(args[0]);
  if (cmd === "correlate-folder-live-timing") return correlateFolderLiveTiming(args[0]);
  if (cmd === "list-sharepoint") return listSharePoint();
  if (cmd === "list-sharepoint-rest") return listSharePointRest();
  if (cmd === "manifest-sharepoint") return manifestSharePoint(args[0]);
  if (cmd === "manifest-sharepoint-rest") return manifestSharePointRest(args.join(" "));
  if (cmd === "ingest-oldest-sharepoint-folder") return ingestOldestSharePointFolder();
  if (cmd === "prepare-folder") return prepareFolderCommand(args);
  if (cmd === "prepare-folder-rest") return prepareFolderRestCommand(args.join(" "));
  if (cmd === "process-folder") return processFolderCommand(args);
  if (cmd === "relabel-folder") return relabelFolderCommand(args);
  if (cmd === "process-video") return processSingleVideo(args[0]);
  if (cmd === "export-lean") return printJson(await store.exportLean());
  if (cmd === "sync-metadata") return printJson(await syncMetadataBackend(config, await store.read()));
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

async function processFolderCommand(args) {
  const { positionals, options } = parseArgs(args);
  const folderId = positionals[0];
  if (!folderId) throw new Error("Folder id is required.");
  return printJson(await processFolder(config, store, folderId, {
    parallel: options.parallel || 1,
    forceTranscribe: Boolean(options.forceTranscribe),
    transcriptionPrompt: options.transcriptionPrompt,
    carryInitialPrompt: options.carryInitialPrompt,
    maxNames: options.transcriptionPromptMaxNames
  }));
}

async function prepareFolderCommand(args) {
  const folderId = args[0];
  if (!folderId) throw new Error("Folder id is required.");
  return printJson(await prepareEventFolder(config, store, { folderId }));
}

async function prepareFolderRestCommand(serverRelativeUrl) {
  if (!serverRelativeUrl) throw new Error("Folder server-relative URL is required.");
  return printJson(await prepareEventFolder(config, store, { serverRelativeUrl }));
}

async function relabelFolderCommand(args) {
  const folderId = args[0];
  if (!folderId) throw new Error("Folder id is required.");
  return printJson(await relabelFolder(config, store, folderId));
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

async function fetchLiveTimingRace(raceId) {
  const result = await fetchLiveTimingRaceData(config, raceId);
  printJson({
    sourceUrl: result.sourceUrl,
    rawPath: result.rawPath,
    race: result.race,
    roster: result.roster.length,
    tptRoster: result.roster.filter((racer) => /^(TPT|TPTA)$/i.test(racer.team || "")).length
  });
}

async function correlateFolderLiveTiming(folderId) {
  if (!folderId) throw new Error("Folder id is required.");
  const state = await store.read();
  const folder = state.folders.find((item) => item.id === folderId);
  if (!folder) throw new Error(`Folder not found: ${folderId}`);
  const correlation = await correlateFolderWithLiveTiming(config, folder);
  await store.updateFolder(folderId, {
    candidateRoster: correlation.candidateRoster,
    raceAssets: correlation.assets,
    eventMatch: {
      ...(folder.eventMatch || {}),
      liveTimingMatch: correlation.liveTimingMatches[0] ? serializeLiveTimingMatch(correlation.liveTimingMatches[0]) : null,
      liveTimingMatches: correlation.liveTimingMatches.map(serializeLiveTimingMatch),
      sources: [...new Set([...(folder.eventMatch?.sources || []), correlation.search.sourceUrl])]
    }
  });
  printJson({
    folderId,
    query: correlation.query,
    races: correlation.liveTimingMatches.map(serializeLiveTimingMatch),
    candidateRoster: correlation.candidateRoster.length,
    tptRoster: correlation.candidateRoster.filter((racer) => /^(TPT|TPTA)$/i.test(racer.team || "")).length,
    assets: correlation.assets
  });
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
  fetch-live-timing-race <raceId>
  correlate-folder-live-timing <folderId>
  list-sharepoint
  list-sharepoint-rest
  manifest-sharepoint <folderUrl>
  manifest-sharepoint-rest <serverRelativeUrl>
  ingest-oldest-sharepoint-folder
  prepare-folder <folderId>
  prepare-folder-rest <serverRelativeUrl>
  process-folder <folderId> [--parallel n] [--force-transcribe] [--transcription-prompt]
  relabel-folder <folderId>
  process-video <videoId>
  export-lean
  sync-metadata
  search <query>
  backends
`);
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function parseArgs(args) {
  const positionals = [];
  const options = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--parallel" || arg === "-p") {
      options.parallel = Number(args[i + 1]);
      i += 1;
    } else if (arg.startsWith("--parallel=")) {
      options.parallel = Number(arg.slice("--parallel=".length));
    } else if (arg === "--force-transcribe") {
      options.forceTranscribe = true;
    } else if (arg === "--transcription-prompt") {
      options.transcriptionPrompt = true;
    } else if (arg === "--no-transcription-prompt") {
      options.transcriptionPrompt = false;
    } else if (arg === "--no-carry-initial-prompt") {
      options.carryInitialPrompt = false;
    } else if (arg === "--transcription-prompt-max-names") {
      options.transcriptionPromptMaxNames = Number(args[i + 1]);
      i += 1;
    } else if (arg.startsWith("--transcription-prompt-max-names=")) {
      options.transcriptionPromptMaxNames = Number(arg.slice("--transcription-prompt-max-names=".length));
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, options };
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
