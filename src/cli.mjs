#!/usr/bin/env node
import fs from "node:fs/promises";
import { loadConfig, publicConfig } from "./config.mjs";
import { JsonStore } from "./lib/fsStore.mjs";
import { buildFolderManifest, listRootEventFolders } from "./adapters/graph.mjs";
import { fetchFarWestU14Events, fetchLiveTimingSearch, matchFoldersToEvents } from "./adapters/events.mjs";
import { processFolder } from "./pipeline/processFolder.mjs";
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
  if (cmd === "list-sharepoint") return listSharePoint();
  if (cmd === "manifest-sharepoint") return manifestSharePoint(args[0]);
  if (cmd === "process-folder") return printJson(await processFolder(config, store, args[0]));
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

async function listSharePoint() {
  const folders = await listRootEventFolders(config);
  await store.upsertFolders(folders);
  printJson({ folders });
}

async function manifestSharePoint(folderUrl) {
  const manifest = await buildFolderManifest(config, folderUrl);
  await store.upsertFolders(manifest.folders);
  await store.upsertVideos(manifest.videos);
  printJson(manifest);
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

function printHelp() {
  console.log(`Ski Video Companion CLI

Commands:
  config
  sample
  ingest-sample
  ingest-manifest <path>
  fetch-events
  fetch-live-timing [query]
  list-sharepoint
  manifest-sharepoint <folderUrl>
  process-folder <folderId>
  export-lean
  search <query>
  backends
`);
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}
