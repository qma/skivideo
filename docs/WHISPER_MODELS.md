# Whisper Models and Configuration

This project supports automated transcription using OpenAI's Whisper model through several backends. Accuracy and performance vary significantly between model sizes and backends.

## Default Configuration

- **Default Model Size:** `medium`
- **Default Backend:** `whisper.cpp`
- **GPU Acceleration:** Enabled by default (Metal on Apple Silicon).

## Available Backends

### 1. `whisper.cpp` (Default)
Highly optimized C++ implementation. Recommended for local processing.
- **Environment Variable:** `WHISPER_BACKEND=whisper.cpp`
- **Model Requirements:** Requires a GGML-formatted model in `data/models/`.
- **Naming Convention:** `ggml-${size}.bin` or `ggml-${size}.en.bin`.
- **GPU Support:** Uses Metal/GPU by default. Can be disabled with `WHISPER_CPP_NO_GPU=1`.

### 2. `mlx-whisper`
Optimized for Apple Silicon using the MLX framework.
- **Environment Variable:** `WHISPER_BACKEND=mlx`
- **Model Requirements:** Automatically downloads models from Hugging Face if not present.
- **Naming Convention:** `mlx-community/whisper-${size}-mlx`.

### 3. `openai`
Uses the official OpenAI API. Requires an internet connection and API key.
- **Environment Variable:** `WHISPER_BACKEND=openai`
- **Requirement:** `OPENAI_API_KEY` must be set in `.env`.
- **Model:** Defaults to `gpt-4o-mini-transcribe` (as configured in `src/config.mjs`).

## Available Model Sizes

| Size | Parameters | English-only | Multilingual | VRAM/RAM (Approx) | Note |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `tiny` | 39 M | `tiny.en` | `tiny` | ~1 GB | Fastest, lowest accuracy. |
| `base` | 74 M | `base.en` | `base` | ~1 GB | Good for quick tests. |
| `small` | 244 M | `small.en` | `small` | ~2 GB | Good balance of speed/accuracy. |
| `medium` | 769 M | `medium.en` | `medium` | ~5 GB | High accuracy, slower. |
| `large-v1` | 1550 M | N/A | `large-v1` | ~10 GB | Legacy large model. |
| `large-v2` | 1550 M | N/A | `large-v2` | ~10 GB | Previous state-of-the-art. |
| `large-v3` | 1550 M | N/A | `large-v3` | ~10 GB | **Recommended** - Highest accuracy. |

## Changing the Model Size

You can change the model size used by the local backends by setting the `WHISPER_MODEL_SIZE` environment variable in your `.env` file:

```env
WHISPER_MODEL_SIZE=base
```

If using `whisper.cpp`, ensure the corresponding `.bin` file exists in `data/models/`. For example, for `base`, you should have `data/models/ggml-base.bin` or `data/models/ggml-base.en.bin`.
bin`.
