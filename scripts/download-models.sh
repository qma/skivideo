#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

eval "$(
  node -e '
    import("./src/config.mjs").then(({ loadConfig }) => {
      const config = loadConfig();
      const explicit = process.env.WHISPER_CPP_MODEL || "";
      const size = config.whisperModelSize || "medium";
      const dataDir = config.dataDir;
      const modelPath = explicit || `${dataDir}/models/ggml-${size}.bin`;
      const escaped = (value) => String(value).replace(/'\''/g, "'\''\"'\''\"'\''");
      console.log(`MODEL_SIZE='\''${escaped(size)}'\''`);
      console.log(`MODEL_PATH='\''${escaped(modelPath)}'\''`);
      console.log(`EXPLICIT_MODEL='\''${escaped(explicit)}'\''`);
    });
  '
)"

if [ -n "$EXPLICIT_MODEL" ]; then
  if [ -f "$MODEL_PATH" ]; then
    echo "Configured WHISPER_CPP_MODEL already exists: $MODEL_PATH"
    exit 0
  fi
  echo "WHISPER_CPP_MODEL points to a custom path that this script cannot infer a download URL for:"
  echo "  $MODEL_PATH"
  echo "Unset WHISPER_CPP_MODEL to download by WHISPER_MODEL_SIZE, or place the model at that path manually."
  exit 1
fi

MODEL_DIR="$(dirname "$MODEL_PATH")"
MODEL_FILE="$(basename "$MODEL_PATH")"
MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$MODEL_FILE"

mkdir -p "$MODEL_DIR"

if [ -f "$MODEL_PATH" ]; then
  echo "Configured Whisper model already exists: $MODEL_PATH"
else
  echo "Downloading configured Whisper model ($MODEL_SIZE): $MODEL_FILE"
  echo "Source: $MODEL_URL"
  curl -L --fail --progress-bar "$MODEL_URL" -o "$MODEL_PATH"
  echo "Done: $MODEL_PATH"
fi
