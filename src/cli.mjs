#!/usr/bin/env node
import fs from "node:fs/promises";
import { loadConfig, publicConfig } from "./config.mjs";
import { auditPublicLeanStore, JsonStore } from "./lib/fsStore.mjs";
import { syncMetadataBackend } from "./lib/metadataBackend.mjs";
import { buildFolderManifest, listRootEventFolders } from "./adapters/graph.mjs";
import { buildRestFolderManifest, listRootEventFoldersRest, pickOldestFolder } from "./adapters/sharepointRest.mjs";
import { fetchFarWestU14Events, fetchLiveTimingDailyRaces, fetchLiveTimingRaceData, fetchLiveTimingSearch, matchFoldersToEvents } from "./adapters/events.mjs";
import { processFolder, processVideo, relabelFolder } from "./pipeline/processFolder.mjs";
import { prepareEventFolder } from "./pipeline/prepareEvent.mjs";
import { ensureLiveTimingCorrelation } from "./pipeline/eventDependencies.mjs";
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
  if (cmd === "list-sharepoint-rest") return listSharePointRest(args);
  if (cmd === "manifest-sharepoint") return manifestSharePoint(args[0]);
  if (cmd === "manifest-sharepoint-rest") return manifestSharePointRest(args.join(" "));
  if (cmd === "ingest-oldest-sharepoint-folder") return ingestOldestSharePointFolder();
  if (cmd === "prepare-folder") return prepareFolderCommand(args);
  if (cmd === "prepare-folder-rest") return prepareFolderRestCommand(args.join(" "));
  if (cmd === "process-folder") return processFolderCommand(args);
  if (cmd === "relabel-folder") return relabelFolderCommand(args);
  if (cmd === "process-video") return processSingleVideo(args[0]);
  if (cmd === "export-lean") return printJson(await store.exportLean());
  if (cmd === "export-public") return exportPublic();
  if (cmd === "audit-public-export") return auditPublicExport(args[0]);
  if (cmd === "audit-media-links") return auditMediaLinks(args);
  if (cmd === "sync-metadata") return printJson(await syncMetadataBackend(config, await store.read()));
  if (cmd === "search") return search(args.join(" "));
  if (cmd === "backends") return printJson(await detectTranscriptionBackends(config));
  if (cmd === "upsert-team") return upsertTeam(args[0]);
  if (cmd === "list-teams") return printJson((await store.read()).teams || []);
  throw new Error(`Unknown command: ${cmd}`);
}

async function upsertTeam(json) {
  if (!json) throw new Error("Team JSON string is required.");
  const team = JSON.parse(json);
  if (!team.id) throw new Error("Team id is required.");
  await store.upsertTeams([team]);
  printJson({ ok: true, teamId: team.id });
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
    maxNames: options.transcriptionPromptMaxNames,
    noDownload: Boolean(options.noDownload),
    reprocess: Boolean(options.reprocess),
    whisperCppNoGpu: options.whisperCppNoGpu
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
  const correlation = await ensureLiveTimingCorrelation(config, store, folderId, { force: true });
  printJson({
    folderId,
    query: correlation.query,
    races: correlation.races,
    candidates: correlation.candidates,
    selection: correlation.selection,
    candidateRoster: correlation.candidateRoster,
    tptRoster: correlation.tptRoster,
    assets: correlation.assets
  });
}

async function listSharePoint() {
  const folders = await listRootEventFolders(config);
  await store.upsertFolders(folders);
  printJson({ folders });
}

async function listSharePointRest(args = []) {
  const { options } = parseArgs(args);
  let rootUrl = options.sharepointUrl || config.sharepointRootUrl;
  if (options.teamId) {
    const state = await store.read();
    const team = state.teams.find((t) => t.id === options.teamId);
    if (team?.sharepointRootUrl) rootUrl = team.sharepointRootUrl;
  }
  const folders = await listRootEventFoldersRest(config, rootUrl);
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
      const labels = [video.goldenLabel?.name, ...(video.athleteLabels || []).map((label) => label.name)].filter(Boolean).join(" ");
      return normalizeText(`${labels} ${video.filename} ${video.transcript?.text || ""}`).includes(needle);
    })
    .map((video) => ({
      id: video.id,
      filename: video.filename,
      sharepointUrl: video.sharepointUrl,
      goldenLabel: video.goldenLabel || null,
      labels: video.athleteLabels || [],
      folder: state.folders.find((folder) => folder.id === video.folderId)?.name || ""
    }));
  printJson(results);
}

async function exportPublic() {
  const result = await store.exportPublicLean();
  if (!result.audit.ok) {
    throw new Error(`Public export audit failed: ${result.audit.findings.join(", ")}`);
  }
  return printJson({
    exportPath: result.exportPath,
    audit: result.audit
  });
}

async function auditPublicExport(filePath = "data/exports/public/lean-index.json") {
  const lean = JSON.parse(await fs.readFile(filePath, "utf8"));
  const audit = auditPublicLeanStore(lean);
  printJson({ filePath, ...audit });
  if (!audit.ok) process.exitCode = 1;
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
  process-folder <folderId> [--parallel n] [--force-transcribe] [--no-download] [--reprocess] [--transcription-prompt] [--whisper-cpp-no-gpu]
  relabel-folder <folderId>
  process-video <videoId>
  export-lean
  export-public
  audit-public-export [path]
  audit-media-links [--all]
  sync-metadata
  search <query>
  backends
`);
}

async function auditMediaLinks(args) {
  const { options } = parseArgs(args);
  const state = await store.read();
  const folders = new Map(state.folders.map((folder) => [folder.id, folder]));
  const videos = options.all
    ? state.videos
    : state.videos.filter((video) => ["indexed", "needs_review", "failed"].includes(video.processing?.status));
  const rows = await Promise.all(videos.map(async (video) => {
    const local = await localMediaStatus(video.localVideoPath);
    const sourceFallback = Boolean(video.sharepointUrl);
    const ok = local.readable || sourceFallback;
    return {
      id: video.id,
      filename: video.filename,
      folder: folders.get(video.folderId)?.name || "",
      processingStatus: video.processing?.status || "pending",
      ok,
      localStatus: local.status,
      hasDownloadUrl: Boolean(video.downloadUrl),
      hasSharepointUrl: Boolean(video.sharepointUrl),
      playbackPath: local.readable ? `/media/${video.id}` : video.sharepointUrl
    };
  }));
  const broken = rows.filter((row) => !row.ok);
  const directSource = rows.filter((row) => row.localStatus !== "readable" && row.hasSharepointUrl);
  printJson({
    scope: options.all ? "all" : "processed",
    checked: rows.length,
    ok: rows.length - broken.length,
    broken: broken.length,
    readableLocal: rows.filter((row) => row.localStatus === "readable").length,
    datalessLocal: rows.filter((row) => row.localStatus === "dataless").length,
    directSharePointFallback: directSource.length,
    brokenRows: broken.slice(0, 50),
    directSharePointRows: directSource.slice(0, 20)
  });
}

async function localMediaStatus(localPath) {
  if (!localPath) return { status: "none", readable: false };
  try {
    const stat = await fs.stat(localPath);
    if (!stat.isFile()) return { status: "not_file", readable: false };
    if (stat.size <= 0) return { status: "empty", readable: false };
    if (Number(stat.blocks) === 0) return { status: "dataless", readable: false };
    return { status: "readable", readable: true };
  } catch {
    return { status: "missing", readable: false };
  }
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
    } else if (arg === "--all") {
      options.all = true;
    } else if (arg === "--no-download" || arg === "--local-only") {
      options.noDownload = true;
    } else if (arg === "--reprocess") {
      options.reprocess = true;
      options.forceTranscribe = true;
      options.noDownload = true;
    } else if (arg === "--transcription-prompt") {
      options.transcriptionPrompt = true;
    } else if (arg === "--no-transcription-prompt") {
      options.transcriptionPrompt = false;
    } else if (arg === "--whisper-cpp-no-gpu" || arg === "--no-whisper-gpu") {
      options.whisperCppNoGpu = true;
    } else if (arg === "--whisper-cpp-gpu") {
      options.whisperCppNoGpu = false;
    } else if (arg === "--no-carry-initial-prompt") {
      options.carryInitialPrompt = false;
    } else if (arg === "--transcription-prompt-max-names") {
      options.transcriptionPromptMaxNames = Number(args[i + 1]);
      i += 1;
    } else if (arg.startsWith("--transcription-prompt-max-names=")) {
      options.transcriptionPromptMaxNames = Number(arg.slice("--transcription-prompt-max-names=".length));
    } else if (arg === "--team-id" || arg === "-t") {
      options.teamId = args[i + 1];
      i += 1;
    } else if (arg.startsWith("--team-id=")) {
      options.teamId = arg.slice("--team-id=".length);
    } else if (arg === "--sharepoint-url" || arg === "-s") {
      options.sharepointUrl = args[i + 1];
      i += 1;
    } else if (arg.startsWith("--sharepoint-url=")) {
      options.sharepointUrl = arg.slice("--sharepoint-url=".length);
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
