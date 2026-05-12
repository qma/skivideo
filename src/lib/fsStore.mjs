import fs from "node:fs/promises";
import path from "node:path";
import { nowIso } from "./ids.mjs";

const emptyStore = {
  version: 1,
  updatedAt: "",
  folders: [],
  videos: [],
  events: [],
  jobs: []
};

export class JsonStore {
  constructor(config) {
    this.config = config;
    this.storePath = path.join(config.indexDir, "store.json");
  }

  async ensure() {
    for (const dir of [
      this.config.indexDir,
      this.config.rawDir,
      this.config.mediaDir,
      this.config.audioDir,
      this.config.transcriptDir,
      this.config.exportDir
    ]) {
      await fs.mkdir(dir, { recursive: true });
    }
    try {
      await fs.access(this.storePath);
    } catch {
      await this.write(emptyStore);
    }
  }

  async read() {
    await this.ensure();
    const raw = await fs.readFile(this.storePath, "utf8");
    return { ...emptyStore, ...JSON.parse(raw) };
  }

  async write(store) {
    await fs.mkdir(path.dirname(this.storePath), { recursive: true });
    const next = { ...emptyStore, ...store, updatedAt: nowIso() };
    await fs.writeFile(this.storePath, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  }

  async upsertFolders(folders) {
    const store = await this.read();
    const byId = new Map(store.folders.map((folder) => [folder.id, folder]));
    for (const folder of folders) {
      const existing = byId.get(folder.id);
      byId.set(folder.id, mergeFolder(existing, folder));
    }
    store.folders = [...byId.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return this.write(store);
  }

  async updateFolder(folderId, patch) {
    const store = await this.read();
    store.folders = store.folders.map((folder) => folder.id === folderId ? deepMerge(folder, patch) : folder);
    return this.write(store);
  }

  async upsertVideos(videos) {
    const store = await this.read();
    const byId = new Map(store.videos.map((video) => [video.id, video]));
    for (const video of videos) byId.set(video.id, { ...byId.get(video.id), ...video });
    store.videos = [...byId.values()].sort((a, b) => String(a.filename).localeCompare(String(b.filename)));
    return this.write(store);
  }

  async upsertEvents(events) {
    const store = await this.read();
    const byKey = new Map(store.events.map((event) => [event.id || `${event.date}:${event.name}`, event]));
    for (const event of events) byKey.set(event.id || `${event.date}:${event.name}`, event);
    store.events = [...byKey.values()];
    return this.write(store);
  }

  async updateVideo(videoId, patch) {
    const store = await this.read();
    store.videos = store.videos.map((video) => video.id === videoId ? deepMerge(video, patch) : video);
    return this.write(store);
  }

  async addJob(job) {
    const store = await this.read();
    store.jobs = [job, ...store.jobs.filter((existing) => existing.id !== job.id)].slice(0, 50);
    return this.write(store);
  }

  async updateJob(jobId, patch) {
    const store = await this.read();
    store.jobs = store.jobs.map((job) => job.id === jobId ? { ...job, ...patch, updatedAt: nowIso() } : job);
    return this.write(store);
  }

  async exportLean() {
    const store = await this.read();
    const lean = buildLeanStore(store);
    const exportPath = path.join(this.config.exportDir, "lean-index.json");
    await fs.mkdir(path.dirname(exportPath), { recursive: true });
    await fs.writeFile(exportPath, `${JSON.stringify(lean, null, 2)}\n`);
    return { exportPath, lean };
  }
}

export function buildLeanStore(store) {
  return {
    version: store.version,
    exportedAt: nowIso(),
    folders: store.folders,
    events: store.events,
    jobs: (store.jobs || []).slice(0, 50),
    videos: store.videos.map((video) => ({
      id: video.id,
      folderId: video.folderId,
      filename: video.filename,
      sizeBytes: video.sizeBytes || 0,
      mimeType: video.mimeType || "",
      sharepointUrl: video.sharepointUrl,
      localVideoAvailable: Boolean(video.localVideoPath),
      transcriptRef: video.transcriptRef || null,
      transcript: video.transcript ? {
        source: video.transcript.source,
        text: snippet(video.transcript.text, 500),
        segments: []
      } : { source: "unavailable", text: "", segments: [] },
      athleteLabels: video.athleteLabels || [],
      processing: video.processing || {}
    }))
  };
}

function snippet(text, maxLength) {
  const value = String(text || "");
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function mergeFolder(existing = {}, incoming = {}) {
  const merged = { ...existing, ...incoming };
  for (const key of ["candidateRoster", "raceAssets"]) {
    if (Array.isArray(incoming[key]) && incoming[key].length === 0 && Array.isArray(existing[key]) && existing[key].length > 0) {
      merged[key] = existing[key];
    }
  }
  if (incoming.eventMatch && existing.eventMatch) {
    merged.eventMatch = deepMerge(existing.eventMatch, incoming.eventMatch);
  }
  return merged;
}

function deepMerge(base, patch) {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === "object" && !Array.isArray(value) && base[key]) {
      out[key] = deepMerge(base[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}
