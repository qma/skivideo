#!/usr/bin/env node
import { spawn } from "node:child_process";

const alias = process.env.PUBLIC_VERCEL_ALIAS || "ski-video-companion-public.vercel.app";

await run("npm", ["run", "public:build"]);
const deployOutput = await run("npx", ["vercel", "deploy", "apps/public-next/out", "--prod", "--yes"]);
const productionUrl = parseProductionUrl(deployOutput);
if (!productionUrl) {
  throw new Error("Vercel deploy completed but no production URL was found in the output.");
}
await run("npx", ["vercel", "alias", "set", productionUrl, alias]);
console.log(JSON.stringify({ ok: true, productionUrl, alias: `https://${alias}` }, null, 2));

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      output += text;
      process.stdout.write(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      output += text;
      process.stderr.write(text);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}`));
    });
  });
}

function parseProductionUrl(output) {
  const clean = output.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
  const match = clean.match(/Production\s+(https:\/\/\S+)/);
  return match?.[1] || "";
}
