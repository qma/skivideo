import path from "node:path";

export function resolveLocalPath(config, value) {
  if (!value) return "";
  const text = String(value);
  if (path.isAbsolute(text)) return text;
  if (text === "data" || text.startsWith(`data${path.sep}`) || text.startsWith("data/")) {
    return path.join(config.rootDir, text);
  }
  return path.join(config.dataDir, text);
}

export function toStoredPath(config, value) {
  if (!value) return "";
  const text = String(value);
  if (!path.isAbsolute(text)) return normalizeSeparators(text);

  const rootRelative = path.relative(config.rootDir, text);
  if (isInside(rootRelative)) return normalizeSeparators(rootRelative);

  const dataRelative = path.relative(config.dataDir, text);
  if (isInside(dataRelative)) return normalizeSeparators(path.join("data", dataRelative));

  return text;
}

export function normalizeStoredLocalPaths(config, value) {
  return normalizeObject(config, value, "");
}

function normalizeObject(config, value, key) {
  if (Array.isArray(value)) return value.map((item) => normalizeObject(config, item, ""));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      normalizeObject(config, childValue, childKey)
    ]));
  }
  if (typeof value === "string" && shouldNormalizeKey(key)) return toStoredPath(config, value);
  return value;
}

function shouldNormalizeKey(key) {
  return key === "localVideoPath"
    || key === "localAudioPath"
    || key === "localPath"
    || key === "rawPath"
    || key === "model";
}

function isInside(relativePath) {
  return Boolean(relativePath && relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath));
}

function normalizeSeparators(value) {
  return String(value).split(path.sep).join("/");
}
