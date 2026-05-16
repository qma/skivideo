#!/usr/bin/env bash
set -euo pipefail

MODEL_DIR="data/models"
MODEL_FILE="ggml-large-v3.bin"
MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin"

mkdir -p "$MODEL_DIR"

if [ -f "$MODEL_DIR/$MODEL_FILE" ]; then
    echo "Model $MODEL_FILE already exists."
else
    echo "Downloading $MODEL_FILE..."
    curl -L "$MODEL_URL" -o "$MODEL_DIR/$MODEL_FILE"
    echo "Done."
fi
