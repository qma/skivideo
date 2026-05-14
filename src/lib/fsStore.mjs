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

  async removeFolder(folderId) {
    return this.mutate((store) => {
      store.folders = store.folders.filter((folder) => folder.id !== folderId);
      store.videos = store.videos.filter((video) => video.folderId !== folderId);
      store.jobs = store.jobs.filter((job) => job.folderId !== folderId);
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

  async bulkReviewVideos(folderId, action, labelName) {
    return this.mutate((store) => {
      const reviewedAt = nowIso();
      store.videos = store.videos.map((video) => {
        if (video.folderId !== folderId) return video;
        if (action === "clear-labels") {
          return {
            ...video,
            athleteLabels: [],
            processing: {
              ...(video.processing || {}),
              status: "needs_review",
              reviewedAt
            }
          };
        }
        if (action === "mark-indexed") {
          return {
            ...video,
            processing: {
              ...(video.processing || {}),
              status: "indexed",
              reviewedAt
            }
          };
        }
        return video;
      });
      return store;
    });
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

  async exportPublicLean() {
    const store = await this.read();
    const lean = buildPublicLeanStore(store);
    const exportPath = path.join(this.config.exportDir, "public", "lean-index.json");
    await writeJsonAtomic(exportPath, lean);
    return { exportPath, lean, audit: auditPublicLeanStore(lean) };
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

export function buildPublicLeanStore(store) {
  const publishableStatuses = new Set(["indexed", "needs_review"]);
  const folders = store.folders || [];
  const videos = (store.videos || [])
    .filter((video) => publishableStatuses.has(video.processing?.status))
    .filter((video) => video.sharepointUrl)
    .map(sanitizePublicVideo);
  const folderStats = new Map();
  for (const video of videos) {
    const current = folderStats.get(video.folderId) || {
      publishedVideos: 0,
      indexedVideos: 0,
      reviewVideos: 0,
      labeledVideos: 0
    };
    current.publishedVideos += 1;
    if (video.processing.status === "indexed") current.indexedVideos += 1;
    if (video.processing.status === "needs_review") current.reviewVideos += 1;
    if (video.athleteLabels.length) current.labeledVideos += 1;
    folderStats.set(video.folderId, current);
  }
  return {
    schema: "ski-video-public-index",
    version: 1,
    exportedAt: nowIso(),
    source: {
      mode: "static_public_export",
      playbackPolicy: "direct_source_links",
      mediaHosted: false
    },
    teams: [
      {
        id: "team_tpt_u14_2025_2026",
        name: "TPT U14",
        orgName: "Palisades Tahoe",
        season: "2025-2026",
        aliases: ["TPT", "TPTA", "Palisades Tahoe"]
      }
    ],
    folders: folders
      .map((folder) => sanitizePublicFolder(folder, folderStats.get(folder.id)))
      .sort((a, b) => String(a.eventDate || a.name).localeCompare(String(b.eventDate || b.name))),
    videos,
    events: (store.events || []).map(sanitizePublicEvent)
  };
}

export function auditPublicLeanStore(lean) {
  const raw = JSON.stringify(lean);
  const blockedPatterns = [
    { name: "download_url", pattern: /"downloadUrl"\s*:/i },
    { name: "local_path_key", pattern: /"local(Path|VideoPath|AudioPath)"\s*:/i },
    { name: "absolute_user_path", pattern: /\/Users\// },
    { name: "local_data_path", pattern: /data\/(media|audio|transcripts|models|raw|index)\// },
    { name: "server_relative_url", pattern: /"serverRelativeUrl"\s*:/i },
    { name: "job_history", pattern: /"jobs"\s*:/i },
    { name: "credential_like_key", pattern: /"(token|secret|cookie|authorization)[^"]*"\s*:/i }
  ];
  const findings = blockedPatterns
    .filter((check) => check.pattern.test(raw))
    .map((check) => check.name);
  return {
    ok: findings.length === 0,
    findings,
    folders: lean.folders?.length || 0,
    videos: lean.videos?.length || 0,
    events: lean.events?.length || 0,
    bytes: Buffer.byteLength(raw)
  };
}

function sanitizePublicFolder(folder, stats = {}) {
  return {
    id: folder.id,
    teamId: "team_tpt_u14_2025_2026",
    name: folder.name || "",
    source: folder.source || "",
    sharepointUrl: folder.sharepointUrl || "",
    itemCount: folder.itemCount || 0,
    timeCreated: folder.timeCreated || "",
    timeLastModified: folder.timeLastModified || "",
    eventDate: folder.eventMatch?.date || "",
    eventMatch: sanitizePublicEventMatch(folder.eventMatch),
    raceAssets: (folder.raceAssets || []).map(sanitizePublicRaceAsset),
    rosterSummary: summarizeRoster(folder.candidateRoster || []),
    stats: {
      publishedVideos: stats.publishedVideos || 0,
      indexedVideos: stats.indexedVideos || 0,
      reviewVideos: stats.reviewVideos || 0,
      labeledVideos: stats.labeledVideos || 0
    }
  };
}

function sanitizePublicVideo(video) {
  return {
    id: video.id,
    teamId: "team_tpt_u14_2025_2026",
    folderId: video.folderId,
    filename: video.filename || "",
    sizeBytes: video.sizeBytes || 0,
    mimeType: video.mimeType || "",
    sharepointUrl: video.sharepointUrl || "",
    playbackUrl: video.sharepointUrl || "",
    timeCreated: video.timeCreated || "",
    timeLastModified: video.timeLastModified || "",
    transcript: sanitizePublicTranscript(video.transcript),
    transcriptRef: sanitizePublicTranscriptRef(video.transcriptRef),
    athleteLabels: (video.athleteLabels || []).map(sanitizePublicLabel),
    processing: {
      status: video.processing?.status || "pending",
      processedAt: video.processing?.processedAt || "",
      reviewedAt: video.processing?.reviewedAt || ""
    }
  };
}

function sanitizePublicEvent(event) {
  return {
    id: event.id || "",
    date: event.date || "",
    name: event.name || "",
    venue: event.venue || "",
    discipline: event.discipline || "",
    sourceUrl: event.sourceUrl || ""
  };
}

function sanitizePublicEventMatch(eventMatch = {}) {
  return {
    canonicalName: eventMatch.canonicalName || "",
    date: eventMatch.date || "",
    venue: eventMatch.venue || "",
    discipline: eventMatch.discipline || "",
    confidence: eventMatch.confidence || 0,
    reasons: eventMatch.reasons || [],
    sources: eventMatch.sources || [],
    liveTimingMatch: sanitizePublicLiveTimingMatch(eventMatch.liveTimingMatch),
    liveTimingMatches: (eventMatch.liveTimingMatches || []).map(sanitizePublicLiveTimingMatch),
    liveTimingCorrelation: eventMatch.liveTimingCorrelation ? {
      method: eventMatch.liveTimingCorrelation.method || "",
      query: eventMatch.liveTimingCorrelation.query || "",
      matchedAt: eventMatch.liveTimingCorrelation.matchedAt || "",
      matchCount: eventMatch.liveTimingCorrelation.matchCount || 0
    } : null
  };
}

function sanitizePublicLiveTimingMatch(match) {
  if (!match) return null;
  return {
    raceId: match.raceId || match.id || "",
    name: match.name || "",
    date: match.date || "",
    venue: match.venue || "",
    discipline: match.discipline || "",
    gender: match.gender || "",
    sourceUrl: match.sourceUrl || "",
    score: match.score || 0
  };
}

function sanitizePublicRaceAsset(asset) {
  return {
    type: asset.type || "",
    label: asset.label || "",
    sourceUrl: asset.sourceUrl || "",
    raceId: asset.raceId || ""
  };
}

function sanitizePublicTranscript(transcript = {}) {
  return {
    source: transcript.source || "unavailable",
    text: snippet(transcript.text, 320)
  };
}

function sanitizePublicTranscriptRef(ref = {}) {
  return {
    source: ref.source || "unavailable",
    textLength: ref.textLength || 0,
    segmentCount: ref.segmentCount || 0,
    promptEnabled: Boolean(ref.prompt)
  };
}

function sanitizePublicLabel(label = {}) {
  return {
    name: label.name || "",
    confidence: label.confidence || 0,
    source: label.source || "",
    evidence: snippet(label.evidence, 180),
    matchedRoster: Boolean(label.matchedRoster),
    methodVersion: label.methodVersion || ""
  };
}

function summarizeRoster(roster) {
  const teams = new Map();
  for (const racer of roster) {
    const key = racer.team || "Unknown";
    teams.set(key, (teams.get(key) || 0) + 1);
  }
  return {
    racers: roster.length,
    tptRacers: roster.filter((racer) => /^(TPT|TPTA)$/i.test(racer.team || "")).length,
    teams: [...teams.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([team, count]) => ({ team, count }))
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
