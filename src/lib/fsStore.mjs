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
    this.writeQueue = Promise.resolve();
    this.mutationQueue = Promise.resolve();
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
    const raw = await readJsonWithRetry(this.storePath);
    return { ...emptyStore, ...raw };
  }

  async write(store) {
    const next = { ...emptyStore, ...store, updatedAt: nowIso() };
    const write = this.writeQueue.then(() => writeJsonAtomic(this.storePath, next));
    this.writeQueue = write.catch(() => {});
    await write;
    return next;
  }

  async upsertFolders(folders) {
    return this.mutate((store) => {
      const byId = new Map(store.folders.map((folder) => [folder.id, folder]));
      for (const folder of folders) {
        const existing = byId.get(folder.id);
        byId.set(folder.id, mergeFolder(existing, folder));
      }
      store.folders = [...byId.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
      return store;
    });
  }

  async updateFolder(folderId, patch) {
    return this.mutate((store) => {
      store.folders = store.folders.map((folder) => folder.id === folderId ? deepMerge(folder, patch) : folder);
      return store;
    });
  }

  async upsertVideos(videos) {
    return this.mutate((store) => {
      const byId = new Map(store.videos.map((video) => [video.id, video]));
      for (const video of videos) byId.set(video.id, { ...byId.get(video.id), ...video });
      store.videos = [...byId.values()].sort((a, b) => String(a.filename).localeCompare(String(b.filename)));
      return store;
    });
  }

  async upsertEvents(events) {
    return this.mutate((store) => {
      const byKey = new Map(store.events.map((event) => [event.id || `${event.date}:${event.name}`, event]));
      for (const event of events) byKey.set(event.id || `${event.date}:${event.name}`, event);
      store.events = [...byKey.values()];
      return store;
    });
  }

  async updateVideo(videoId, patch) {
    return this.mutate((store) => {
      store.videos = store.videos.map((video) => video.id === videoId ? deepMerge(video, patch) : video);
      return store;
    });
  }

  async updateVideoWith(fn) {
    return this.mutate((store) => fn(store) || store);
  }

  async addJob(job) {
    return this.mutate((store) => {
      const nextJob = {
        ...job,
        logs: normalizeJobLogs(job, job.logs)
      };
      store.jobs = [nextJob, ...store.jobs.filter((existing) => existing.id !== job.id)].slice(0, 50);
      return store;
    });
  }

  async updateJob(jobId, patch) {
    return this.mutate((store) => {
      const updatedAt = nowIso();
      store.jobs = store.jobs.map((job) => {
        if (job.id !== jobId) return job;
        const nextJob = { ...job, ...patch, updatedAt };
        nextJob.logs = appendJobLog(job, nextJob, updatedAt);
        return nextJob;
      });
      return store;
    });
  }

  async exportLean() {
    const store = await this.read();
    const lean = buildLeanStore(store);
    const exportPath = path.join(this.config.exportDir, "lean-index.json");
    await writeJsonAtomic(exportPath, lean);
    return { exportPath, lean };
  }

  async mutate(fn) {
    const operation = this.mutationQueue.then(async () => {
      const store = await this.read();
      const next = await fn(store);
      return this.write(next || store);
    });
    this.mutationQueue = operation.catch(() => {});
    return operation;
  }
}

async function readJsonWithRetry(filePath) {
  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      return JSON.parse(raw);
    } catch (error) {
      lastError = error;
      if (error.name !== "SyntaxError" && error.code !== "ENOENT") throw error;
      await delay(25 * (attempt + 1));
    }
  }
  throw lastError;
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(tempPath, filePath);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function normalizeJobLogs(job, logs = []) {
  if (Array.isArray(logs) && logs.length) return logs.slice(-500);
  return [jobLogEntry(job, job.startedAt || job.updatedAt || nowIso())];
}

function appendJobLog(previous, next, at) {
  const logs = normalizeJobLogs(previous, previous.logs);
  const last = logs[logs.length - 1] || {};
  const entry = jobLogEntry(next, at);
  if (
    last.status === entry.status
    && last.message === entry.message
    && last.indexed === entry.indexed
    && last.needsReview === entry.needsReview
    && last.failed === entry.failed
  ) {
    return logs;
  }
  return [...logs, entry].slice(-500);
}

function jobLogEntry(job, at) {
  return {
    at,
    status: job.status || "",
    message: job.message || "",
    indexed: job.indexed || 0,
    needsReview: job.needsReview || 0,
    failed: job.failed || 0,
    parallel: job.parallel || 0
  };
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
