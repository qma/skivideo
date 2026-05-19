import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const rootDir = process.cwd();
const watchRoots = ["src", "public"]
  .map((entry) => path.join(rootDir, entry));
const watchExtensions = new Set([".js", ".mjs", ".json", ".html", ".css"]);
const pollMs = 1000;

let child = null;
let restarting = false;
let snapshot = new Map();

start();
snapshot = await scan();
setInterval(checkForChanges, pollMs);

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

function start() {
  child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: rootDir,
    env: process.env,
    stdio: "inherit"
  });
  child.on("exit", (code, signal) => {
    if (!restarting && code !== 0 && signal !== "SIGTERM") {
      console.log(`Server exited with code ${code ?? signal}. Waiting for edits before restart.`);
    }
  });
}

async function checkForChanges() {
  if (restarting) return;
  const next = await scan();
  if (!changed(snapshot, next)) return;
  snapshot = next;
  restart();
}

function restart() {
  restarting = true;
  console.log("Change detected. Restarting server...");
  const previous = child;
  let started = false;
  const startNext = () => {
    if (started) return;
    started = true;
    restarting = false;
    start();
  };
  if (!previous || previous.exitCode !== null || previous.signalCode !== null) {
    startNext();
    return;
  }
  previous.once("exit", startNext);
  previous.kill("SIGTERM");
  setTimeout(() => {
    if (!started) {
      previous.kill("SIGKILL");
      startNext();
    }
  }, 5000).unref();
}

async function scan() {
  const files = new Map();
  for (const root of watchRoots) {
    await scanDir(root, files);
  }
  return files;
}

async function scanDir(dir, files) {
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      await scanDir(fullPath, files);
      continue;
    }
    if (!entry.isFile() || !watchExtensions.has(path.extname(entry.name))) continue;
    const stat = await fs.stat(fullPath);
    files.set(path.relative(rootDir, fullPath), stat.mtimeMs);
  }
}

function changed(previous, next) {
  if (previous.size !== next.size) return true;
  for (const [file, mtime] of next) {
    if (previous.get(file) !== mtime) return true;
  }
  return false;
}

function shutdown(signal) {
  child?.kill(signal);
  process.exit(0);
}
