import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";
import { slugify } from "../lib/ids.mjs";
import { resolveFfmpeg } from "./media.mjs";

export async function detectTranscriptionBackends(config) {
  const whisperCpp = await whisperCppWorks(config);
  const preferred = config.whisperBackend || "whisper.cpp";

  if (preferred === "whisper.cpp" && whisperCpp) {
    return {
      mlxWhisper: false,
      whisperCpp: true,
      openai: Boolean(config.openaiApiKey)
    };
  }

  const mlxPython = path.join(config.rootDir, ".venv", "bin", "python");
  const mlxWhisper = await executableWorks(mlxPython, ["-c", "import mlx_whisper; print('ok')"], { timeoutMs: 60000 });

  if (mlxWhisper) {
    return {
      mlxWhisper: true,
      whisperCpp: preferred === "whisper.cpp" ? whisperCpp : false,
      openai: Boolean(config.openaiApiKey)
    };
  }

  return {
    mlxWhisper: false,
    whisperCpp,
    openai: Boolean(config.openaiApiKey)
  };
}

export async function transcribeAudio(config, audioPath, options = {}) {
  const backends = await detectTranscriptionBackends(config);
  if (backends.mlxWhisper) return transcribeWithMlxWhisper(config, audioPath, options);
  if (backends.whisperCpp) return transcribeWithWhisperCpp(config, audioPath, options);
  if (backends.openai) return transcribeWithOpenAi(config, audioPath, options);
  throw new Error("No transcription backend is available. Run scripts/install-whisper.sh or install whisper.cpp with a ggml model.");
}

export async function transcribeWithMlxWhisper(config, audioPath, options = {}) {
  const size = options.modelSize || config.whisperModelSize || "large-v3";
  const model = options.model || process.env.MLX_WHISPER_MODEL || `mlx-community/whisper-${size}-mlx`;
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
  const ffmpeg = await resolveFfmpeg(config);
  const ffmpegBinDir = await ensureFfmpegCommandShim(config, ffmpeg);
  await run(python, ["-c", script, audioPath, outPath, model], {
    cwd: config.rootDir,
    env: {
      ...process.env,
      PATH: `${ffmpegBinDir}:${path.dirname(ffmpeg)}:${process.env.PATH || ""}`
    }
  });
  const raw = JSON.parse(await fs.readFile(outPath, "utf8"));
  return {
    source: "local_mlx_whisper",
    text: raw.text || "",
    segments: raw.segments || [],
    localPath: outPath,
    model,
    prompt: promptMetadata(options)
  };
}

async function ensureFfmpegCommandShim(config, ffmpegPath) {
  const binDir = path.join(config.dataDir, "tools", "bin");
  const shim = path.join(binDir, "ffmpeg");
  await fs.mkdir(binDir, { recursive: true });
  try {
    await fs.lstat(shim);
  } catch {
    await fs.symlink(ffmpegPath, shim);
  }
  return binDir;
}

export async function transcribeWithOpenAi(config, audioPath, options = {}) {
  const file = await fs.readFile(audioPath);
  const form = new FormData();
  form.set("model", config.openaiTranscribeModel);
  form.set("file", new Blob([file]), path.basename(audioPath));
  form.set("response_format", "json");
  if (options.prompt) form.set("prompt", options.prompt);
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
    model: config.openaiTranscribeModel,
    prompt: promptMetadata(options)
  };
}

export async function transcribeWithWhisperCpp(config, audioPath, options = {}) {
  const command = process.env.WHISPER_CPP_BIN || "/opt/homebrew/bin/whisper-cli";
  const model = options.model || process.env.WHISPER_CPP_MODEL || await getWhisperCppModelPath(config, options.modelSize || config.whisperModelSize);
  const noGpu = shouldDisableWhisperCppGpu(config, options);
  const inputPath = await ensureWhisperCppAudio(config, audioPath);
  const outDir = path.join(config.transcriptDir, slugify(path.basename(audioPath)));
  await fs.mkdir(outDir, { recursive: true });
  const outputBase = path.join(outDir, options.prompt ? `whisper-cpp-prompted-${promptHash(options.prompt)}` : "whisper-cpp");
  const args = [
    "-m", model,
    "-f", inputPath,
    "-oj",
    "-ojf",
    "-of", outputBase,
    "-np",
    "-l", "en"
  ];
  if (noGpu) args.unshift("-ng");
  if (options.prompt) {
    args.push("--prompt", options.prompt);
    if (options.carryInitialPrompt !== false) args.push("--carry-initial-prompt");
  }
  console.log(`[transcribeWithWhisperCpp] Running: ${command} ${args.join(" ")}`);
  await run(command, args, { timeoutMs: options.timeoutMs || 20 * 60 * 1000 });
  const raw = JSON.parse(await fs.readFile(outPath, "utf8"));
  const segments = (raw.transcription || []).map((segment) => ({
    start: whisperTimeToSeconds(segment.offsets?.from),
    end: whisperTimeToSeconds(segment.offsets?.to),
    text: segment.text || ""
  }));
  return {
    source: "local_whisper_cpp",
    text: segments.map((segment) => segment.text).join(" ").replace(/\s+/g, " ").trim(),
    segments,
    localPath: outPath,
    model,
    acceleration: {
      backend: "whisper.cpp",
      gpu: !noGpu
    },
    prompt: promptMetadata(options)
  };
}

function shouldDisableWhisperCppGpu(config, options = {}) {
  if (options.whisperCppNoGpu === true) return true;
  if (options.whisperCppNoGpu === false) return false;
  return Boolean(config.whisperCppNoGpu);
}

function promptMetadata(options = {}) {
  if (!options.prompt) return null;
  return {
    hash: options.promptHash || promptHash(options.prompt),
    text: options.prompt,
    nameCount: options.promptNameCount || 0,
    phraseVersion: options.promptPhraseVersion || "",
    carryInitialPrompt: options.carryInitialPrompt !== false
  };
}

function promptHash(prompt) {
  return createHash("sha1").update(prompt).digest("hex").slice(0, 10);
}

async function whisperCppWorks(config) {
  const command = process.env.WHISPER_CPP_BIN || "/opt/homebrew/bin/whisper-cli";
  try {
    await fs.access(command);
    const model = process.env.WHISPER_CPP_MODEL || await getWhisperCppModelPath(config, config.whisperModelSize);
    await fs.access(model);
    return true;
  } catch {
    return false;
  }
}

async function getWhisperCppModelPath(config, size = "large-v3") {
  const baseDir = path.join(config.dataDir, "models");
  const candidates = [
    path.join(baseDir, `ggml-${size}.bin`),
    path.join(baseDir, `ggml-${size}.en.bin`)
  ];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Continue
    }
  }
  return candidates[0];
}

async function ensureWhisperCppAudio(config, audioPath) {
  if (/\.(wav|mp3|flac|ogg)$/i.test(audioPath)) return audioPath;
  const ffmpeg = await resolveFfmpeg(config);
  const outPath = path.join(config.audioDir, `${slugify(path.basename(audioPath))}.wav`);
  try {
    await fs.access(outPath);
    return outPath;
  } catch {
    await fs.mkdir(path.dirname(outPath), { recursive: true });
  }
  await run(ffmpeg, [
    "-y",
    "-i", audioPath,
    "-vn",
    "-ac", "1",
    "-ar", "16000",
    "-c:a", "pcm_s16le",
    outPath
  ]);
  return outPath;
}

function whisperTimeToSeconds(value) {
  if (typeof value === "number") return value / 1000;
  const match = String(value || "").match(/(\d+):(\d+):(\d+)[.,](\d+)/);
  if (!match) return 0;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(`0.${match[4]}`);
}

async function executableWorks(command, args, options = {}) {
  try {
    await fs.access(command);
    await run(command, args, { timeoutMs: options.timeoutMs || 10000 });
    return true;
  } catch {
    return false;
  }
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
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
