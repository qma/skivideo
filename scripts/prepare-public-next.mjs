#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const sourcePath = path.resolve("data/exports/public/lean-index.json");
const targetPath = path.resolve("apps/public-next/public/data/lean-index.json");

await fs.mkdir(path.dirname(targetPath), { recursive: true });
await fs.copyFile(sourcePath, targetPath);

const stat = await fs.stat(targetPath);
console.log(JSON.stringify({
  copied: true,
  sourcePath,
  targetPath,
  bytes: stat.size
}, null, 2));
