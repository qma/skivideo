import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../src/config.mjs";
import {
  mirroredAudioPath,
  mirroredVideoPath,
  mediaCacheRootName,
  sharePointMirrorParts,
  transcriptOutputPathForAudio
} from "../src/lib/cachePaths.mjs";
import { slugify } from "../src/lib/ids.mjs";

const apply = process.argv.includes("--apply");
const cleanupLegacy = process.argv.includes("--cleanup-legacy");
const config = loadConfig();
const storePath = path.join(config.indexDir, "store.json");
const store = JSON.parse(await fs.readFile(storePath, "utf8"));
const foldersById = new Map((store.folders || []).map((folder) => [folder.id, folder]));
const foldersByLegacySlug = new Map((store.folders || []).map((folder) => [slugify(folder.name), folder]));
const moves = [];
let videoRefs = 0;
let audioRefs = 0;
let transcriptRefs = 0;

for (const video of store.videos || []) {
  const folder = foldersById.get(video.folderId) || {};

  if (video.localVideoPath) {
    const nextPath = mirroredVideoPath(config, video, folder);
    if (nextPath !== video.localVideoPath) {
      moves.push({ from: video.localVideoPath, to: nextPath, kind: "video" });
      video.localVideoPath = nextPath;
      videoRefs += 1;
    }
  }

  const previousAudioPath = video.localAudioPath || "";
  if (previousAudioPath) {
    const extension = path.extname(previousAudioPath) || ".m4a";
    const nextPath = mirroredAudioPath(config, video, folder, extension);
    if (nextPath !== previousAudioPath) {
      moves.push({ from: previousAudioPath, to: nextPath, kind: "audio" });
      moveLegacyWhisperWav(previousAudioPath, mirroredAudioPath(config, video, folder, ".wav"));
      video.localAudioPath = nextPath;
      audioRefs += 1;
    }
  }

  const transcriptPath = video.transcript?.localPath || "";
  const nextTranscriptPath = nextTranscriptArtifactPath(config, video, folder, transcriptPath);
  if (transcriptPath && nextTranscriptPath && nextTranscriptPath !== transcriptPath) {
    moves.push({ from: transcriptPath, to: nextTranscriptPath, kind: "transcript" });
    moveSiblingTranscriptArtifacts(transcriptPath, path.dirname(nextTranscriptPath));
    video.transcript.localPath = nextTranscriptPath;
    transcriptRefs += 1;
  }

  const transcriptRefPath = video.transcriptRef?.localPath || "";
  if (transcriptRefPath) {
    const nextRefPath = transcriptPath && transcriptRefPath === transcriptPath
      ? nextTranscriptPath
      : nextTranscriptArtifactPath(config, video, folder, transcriptRefPath);
    if (nextRefPath && nextRefPath !== transcriptRefPath) {
      if (transcriptRefPath !== transcriptPath) moves.push({ from: transcriptRefPath, to: nextRefPath, kind: "transcript-ref" });
      video.transcriptRef.localPath = nextRefPath;
      transcriptRefs += 1;
    }
  }
}

await enqueueLegacyMediaFolderMoves();

const uniqueMoves = dedupeMoves(moves);
const sourceCounts = countSources(uniqueMoves);
const results = [];
for (const move of uniqueMoves) {
  results.push(await moveIfPresent(move, apply, sourceCounts.get(move.from) > 1));
}

if (apply) await writeJsonAtomic(storePath, store);
const cleanup = cleanupLegacy ? await cleanupLegacyCacheFiles(store) : null;

console.log(JSON.stringify({
  apply,
  cleanupLegacy,
  storePath,
  mediaRoot: path.join(config.mediaDir, config.mediaCacheRootName),
  videoRefs,
  audioRefs,
  transcriptRefs,
  moveSummary: summarize(results),
  sampleMoves: uniqueMoves.slice(0, 12),
  cleanup
}, null, 2));

function nextTranscriptArtifactPath(config, video, folder, currentPath) {
  if (!currentPath) return "";
  const filename = path.basename(currentPath);
  const audioPath = video.localAudioPath || mirroredAudioPath(config, video, folder, ".m4a");
  return transcriptOutputPathForAudio(config, audioPath, filename);
}

function moveLegacyWhisperWav(audioPath, newWavPath) {
  const parsed = path.parse(audioPath);
  const legacyWav = path.join(parsed.dir, `${parsed.name}-${parsed.ext.slice(1).toLowerCase()}.wav`);
  if (legacyWav !== audioPath) moves.push({ from: legacyWav, to: newWavPath, kind: "audio-wav" });
}

function moveSiblingTranscriptArtifacts(transcriptPath, newDir) {
  const oldDir = path.dirname(transcriptPath);
  for (const name of [
    "transcript.json",
    "whisper-cpp.json"
  ]) {
    const oldPath = path.join(oldDir, name);
    const newPath = path.join(newDir, name);
    if (oldPath !== transcriptPath) moves.push({ from: oldPath, to: newPath, kind: "transcript-sibling" });
  }
}

function dedupeMoves(items) {
  const byPair = new Map();
  for (const item of items) {
    if (!item.from || !item.to || item.from === item.to) continue;
    byPair.set(`${item.from}\0${item.to}`, item);
  }
  return [...byPair.values()];
}

async function moveIfPresent(move, shouldApply, copySource = false) {
  const source = await fileStat(move.from);
  if (!source) return { ...move, status: "missing_source" };
  const target = await fileStat(move.to);
  if (target) {
    return { ...move, status: target.size === source.size ? "target_exists_same_size" : "target_exists_different_size" };
  }
  const operation = copySource ? "copy" : "move";
  if (!shouldApply) return { ...move, status: `would_${operation}`, size: source.size };
  await fs.mkdir(path.dirname(move.to), { recursive: true });
  if (copySource) await fs.copyFile(move.from, move.to);
  else await fs.rename(move.from, move.to);
  return { ...move, status: operation === "copy" ? "copied" : "moved", size: source.size };
}

async function fileStat(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() && stat.size > 0 ? stat : null;
  } catch {
    return null;
  }
}

function summarize(results) {
  const counts = {};
  for (const result of results) counts[result.status] = (counts[result.status] || 0) + 1;
  return counts;
}

function countSources(items) {
  const counts = new Map();
  for (const item of items) counts.set(item.from, (counts.get(item.from) || 0) + 1);
  return counts;
}

async function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(tempPath, filePath);
}

async function cleanupLegacyCacheFiles(store) {
  const referenced = new Set();
  for (const video of store.videos || []) {
    for (const value of [
      video.localVideoPath,
      video.localAudioPath,
      video.transcript?.localPath,
      video.transcriptRef?.localPath
    ]) {
      if (value) referenced.add(path.resolve(value));
    }
  }

  const roots = [
    { base: config.mediaDir, mirrorRoot: path.join(config.mediaDir, mediaCacheRootName(config)) },
    { base: config.audioDir, mirrorRoot: path.join(config.audioDir, mediaCacheRootName(config)) },
    { base: config.transcriptDir, mirrorRoot: path.join(config.transcriptDir, mediaCacheRootName(config)) }
  ];
  let removedFiles = 0;
  let removedDirs = 0;
  for (const root of roots) {
    const files = await listFiles(root.base);
    for (const file of files) {
      const resolved = path.resolve(file);
      if (resolved.startsWith(path.resolve(root.mirrorRoot) + path.sep)) continue;
      if (referenced.has(resolved)) continue;
      if (apply) await fs.rm(file, { force: true });
      removedFiles += 1;
    }
    removedDirs += await pruneEmptyDirectories(root.base, root.mirrorRoot);
  }
  return { removedFiles, removedDirs };
}

async function listFiles(dir) {
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await listFiles(fullPath));
    else if (entry.isFile()) out.push(fullPath);
  }
  return out;
}

async function pruneEmptyDirectories(baseDir, keepDir) {
  let entries = [];
  try {
    entries = await fs.readdir(baseDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const fullPath = path.join(baseDir, entry.name);
    if (path.resolve(fullPath) === path.resolve(keepDir)) continue;
    removed += await pruneEmptyDirectories(fullPath, keepDir);
    try {
      const remaining = await fs.readdir(fullPath);
      if (remaining.length === 0) {
        if (apply) await fs.rmdir(fullPath);
        removed += 1;
      }
    } catch {
      // Ignore directories that disappeared or are not empty.
    }
  }
  return removed;
}

async function enqueueLegacyMediaFolderMoves() {
  const rootName = mediaCacheRootName(config);
  let entries = [];
  try {
    entries = await fs.readdir(config.mediaDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === rootName) continue;
    const folder = foldersByLegacySlug.get(entry.name);
    if (!folder?.serverRelativeUrl) continue;
    const oldDir = path.join(config.mediaDir, entry.name);
    const newDir = path.join(config.mediaDir, rootName, ...sharePointMirrorParts(folder.serverRelativeUrl, config));
    await enqueueFilesInDirectory(oldDir, newDir, "legacy-media");
  }
}

async function enqueueFilesInDirectory(oldDir, newDir, kind) {
  let entries = [];
  try {
    entries = await fs.readdir(oldDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const oldPath = path.join(oldDir, entry.name);
    const newPath = path.join(newDir, entry.name);
    if (entry.isDirectory()) {
      await enqueueFilesInDirectory(oldPath, newPath, kind);
    } else if (entry.isFile() && entry.name !== ".DS_Store") {
      moves.push({ from: oldPath, to: newPath, kind });
    }
  }
}
