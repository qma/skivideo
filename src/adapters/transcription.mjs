import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { slugify } from "../lib/ids.mjs";

export async function detectTranscriptionBackends(config) {
  const mlxPython = path.join(config.rootDir, ".venv", "bin", "python");
  return {
    mlxWhisper: await executableWorks(mlxPython, ["-c", "import mlx_whisper; print('ok')"]),
    openai: Boolean(config.openaiApiKey)
  };
}

export async function transcribeAudio(config, audioPath, options = {}) {
  const backends = await detectTranscriptionBackends(config);
  if (backends.mlxWhisper) return transcribeWithMlxWhisper(config, audioPath, options);
  if (backends.openai) return transcribeWithOpenAi(config, audioPath);
  throw new Error("No transcription backend is available. Run scripts/install-whisper.sh for local MLX Whisper.");
}

export async function transcribeWithMlxWhisper(config, audioPath, options = {}) {
  const model = options.model || process.env.MLX_WHISPER_MODEL || "mlx-community/whisper-small-mlx";
  const python = path.join(config.rootDir, ".venv", "bin", "python");
  const outDir = path.join(config.transcriptDir, slugify(path.basename(audioPath)));
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, "transcript.json");
  const script = [
    "import json, pathlib, sys",
    "import mlx_whisper",
    "audio_path = sys.argv[1]",
    "out_path = pathlib.Path(sys.argv[2])",
    "model = sys.argv[3]",
    "result = mlx_whisper.transcribe(audio_path, path_or_hf_repo=model)",
    "out_path.write_text(json.dumps(result, indent=2), encoding='utf-8')",
    "print(out_path)"
  ].join("\n");
  await run(python, ["-c", script, audioPath, outPath, model], { cwd: config.rootDir });
  const raw = JSON.parse(await fs.readFile(outPath, "utf8"));
  return {
    source: "local_mlx_whisper",
    text: raw.text || "",
    segments: raw.segments || [],
    localPath: outPath,
    model
  };
}

export async function transcribeWithOpenAi(config, audioPath) {
  const file = await fs.readFile(audioPath);
  const form = new FormData();
  form.set("model", config.openaiTranscribeModel);
  form.set("file", new Blob([file]), path.basename(audioPath));
  form.set("response_format", "json");
  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { authorization: `Bearer ${config.openaiApiKey}` },
    body: form
  });
  if (!response.ok) {
    throw new Error(`OpenAI transcription failed: ${response.status} ${await response.text()}`);
  }
  const json = await response.json();
  return {
    source: "openai_transcription",
    text: json.text || "",
    segments: json.segments || [],
    localPath: "",
    model: config.openaiTranscribeModel
  };
}

async function executableWorks(command, args) {
  try {
    await fs.access(command);
    await run(command, args, { timeoutMs: 10000 });
    return true;
  } catch {
    return false;
  }
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timeout = options.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGTERM");
          reject(new Error(`${command} timed out`));
        }, options.timeoutMs)
      : null;
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (timeout) clearTimeout(timeout);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited ${code}: ${stderr || stdout}`));
    });
  });
}
