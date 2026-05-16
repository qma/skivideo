import path from "node:path";

const defaultCacheRootName = "TPT U14 2025-2026";

export function mediaCacheRootName(config = {}) {
  return safeLocalSegment(config.mediaCacheRootName || defaultCacheRootName);
}

export function mirroredVideoPath(config, video, folder = {}) {
  const relativeParts = sharePointMirrorParts(video?.serverRelativeUrl, config);
  if (!relativeParts.length) {
    relativeParts.push(safeLocalSegment(folder?.name || video?.folderId || "unknown-event"));
    relativeParts.push(safeLocalSegment(video?.filename || "video"));
  }
  return path.join(config.mediaDir, mediaCacheRootName(config), ...relativeParts.map(safeLocalSegment));
}

export function mirroredAudioPath(config, video, folder = {}, extension = ".m4a") {
  const parts = sharePointMirrorParts(video?.serverRelativeUrl, config);
  if (!parts.length) {
    parts.push(safeLocalSegment(folder?.name || video?.folderId || "unknown-event"));
    parts.push(safeLocalSegment(video?.filename || "audio"));
  }
  parts[parts.length - 1] = replaceExtension(parts[parts.length - 1], extension);
  return path.join(config.audioDir, mediaCacheRootName(config), ...parts.map(safeLocalSegment));
}

export function mirroredAudioPathForVideoPath(config, videoPath, extension = ".m4a") {
  const relativeParts = relativePartsUnder(config.mediaDir, videoPath);
  if (relativeParts.length) {
    relativeParts[relativeParts.length - 1] = replaceExtension(relativeParts[relativeParts.length - 1], extension);
    return path.join(config.audioDir, ...relativeParts.map(safeLocalSegment));
  }
  return path.join(config.audioDir, mediaCacheRootName(config), replaceExtension(path.basename(videoPath), extension));
}

export function transcriptOutputPathForAudio(config, audioPath, filename) {
  const relativeParts = relativePartsUnder(config.audioDir, audioPath);
  if (relativeParts.length) {
    relativeParts[relativeParts.length - 1] = stripExtension(relativeParts[relativeParts.length - 1]);
    return path.join(config.transcriptDir, ...relativeParts.map(safeLocalSegment), filename);
  }
  return path.join(config.transcriptDir, mediaCacheRootName(config), stripExtension(path.basename(audioPath)), filename);
}

export function transcriptCachePath(config, video, folder = {}, filename = "transcript.txt") {
  const parts = sharePointMirrorParts(video?.serverRelativeUrl, config);
  if (!parts.length) {
    parts.push(safeLocalSegment(folder?.name || video?.folderId || "unknown-event"));
    parts.push(safeLocalSegment(video?.filename || video?.id || "transcript"));
  }
  parts[parts.length - 1] = stripExtension(parts[parts.length - 1]);
  return path.join(config.transcriptDir, mediaCacheRootName(config), ...parts.map(safeLocalSegment), filename);
}

export function sharePointMirrorParts(serverRelativeUrl, config = {}) {
  const parts = String(serverRelativeUrl || "")
    .split("/")
    .filter(Boolean)
    .map(decodeSharePointSegment);
  if (!parts.length) return [];

  const rootSegment = config.mediaCacheSharePointRootSegment || config.mediaCacheSeason || "2025-2026";
  const rootIndex = parts.findIndex((part) => part === rootSegment);
  if (rootIndex >= 0 && rootIndex + 1 < parts.length) return parts.slice(rootIndex + 1);

  const libraryIndex = parts.findIndex((part) => /^shared documents$/i.test(part) || /^documents$/i.test(part));
  if (libraryIndex >= 0 && libraryIndex + 1 < parts.length) return parts.slice(libraryIndex + 1);

  return parts.slice(-1);
}

function relativePartsUnder(baseDir, filePath) {
  const relative = path.relative(baseDir, filePath || "");
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return [];
  return relative.split(path.sep).filter(Boolean);
}

function replaceExtension(filename, extension) {
  return `${stripExtension(filename)}${extension.startsWith(".") ? extension : `.${extension}`}`;
}

function stripExtension(filename) {
  return String(filename || "unknown").replace(/\.[^.]+$/, "");
}

function decodeSharePointSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function safeLocalSegment(segment) {
  return String(segment || "unknown")
    .replace(/[/:]/g, " - ")
    .replace(/\0/g, "")
    .replace(/\s+/g, " ")
    .trim() || "unknown";
}
