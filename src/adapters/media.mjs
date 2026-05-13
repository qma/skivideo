import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { slugify } from "../lib/ids.mjs";
import { establishSharePointSession } from "./sharepointRest.mjs";

export async function downloadToCache(url, targetPath, options = {}) {
  if (!url) throw new Error("Download URL is empty.");
  if (await usableCachedFile(targetPath)) {
    return { path: targetPath, skipped: true };
  }
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const headers = {};
  if (options.cookie) headers.cookie = options.cookie;
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`Download failed ${response.status}: ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(targetPath, bytes);
  return { path: targetPath, skipped: false };
}

export async function cacheTranscript(video, config) {
  const source = video.transcript || {};
  if (source.text) return source;
  if (!(source.downloadUrl || source.sourceUrl)) return source;
  const url = source.downloadUrl || source.sourceUrl;
  const target = path.join(config.transcriptDir, `${slugify(video.id)}.txt`);
  const downloaded = await downloadToCache(url, target, await sharePointDownloadOptions(config, url));
  const text = await fs.readFile(downloaded.path, "utf8");
  return {
    ...source,
    text: stripTranscriptMarkup(text),
    localPath: downloaded.path
  };
}

export async function mirrorVideo(video, folder, config) {
  if (video.localVideoPath) return video.localVideoPath;
  if (!video.downloadUrl) throw new Error(`No download URL for ${video.filename}`);
  const folderSlug = slugify(folder?.name || video.folderId);
  const target = path.join(config.mediaDir, folderSlug, video.filename);
  const downloaded = await downloadToCache(video.downloadUrl, target, await sharePointDownloadOptions(config, video.downloadUrl));
  return downloaded.path;
}

export async function extractAudio(videoPath, config) {
  const outPath = path.join(config.audioDir, `${slugify(path.basename(videoPath))}.m4a`);
  try {
    await fs.access(outPath);
    return outPath;
  } catch {
    await fs.mkdir(path.dirname(outPath), { recursive: true });
  }
  const ffmpeg = await resolveFfmpeg(config);
  await run(ffmpeg, [
    "-y",
    "-i",
    videoPath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "aac",
    outPath
  ]);
  return outPath;
}

export async function resolveFfmpeg(config) {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  const bundled = await imageioFfmpegPath(config);
  if (bundled) return bundled;
  return "ffmpeg";
}

export function stripTranscriptMarkup(text) {
  return String(text || "")
    .replace(/WEBVTT[\s\S]*?\n/i, "")
    .replace(/\d\d:\d\d:\d\d[.,]\d\d\d\s+-->\s+\d\d:\d\d:\d\d[.,]\d\d\d/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited ${code}: ${stderr || stdout}`));
    });
  });
}

async function sharePointDownloadOptions(config, url) {
  if (!/sharepoint\.com/i.test(url)) return {};
  const session = await establishSharePointSession(config.sharepointRootUrl);
  return { cookie: session.cookies };
}

async function imageioFfmpegPath(config) {
  const python = path.join(config.rootDir, ".venv", "bin", "python");
  try {
    await fs.access(python);
    return (await run(python, ["-c", "import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())"])).trim();
  } catch {
    return "";
  }
}

async function usableCachedFile(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() && stat.size > 0 && Number(stat.blocks) !== 0;
  } catch {
    return false;
  }
}
