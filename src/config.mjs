import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultSharePointRootUrl = "https://<tenant>.sharepoint.com/:f:/s/<site>/<folder-id>";

export function loadConfig() {
  loadDotEnv(path.join(rootDir, ".env"));
  const dataDir = path.resolve(rootDir, process.env.DATA_DIR || "data");
  return {
    rootDir,
    port: Number(process.env.PORT || 4173),
    host: process.env.HOST || "127.0.0.1",
    dataDir,
    indexDir: path.join(dataDir, "index"),
    rawDir: path.join(dataDir, "raw"),
    mediaDir: path.join(dataDir, "media"),
    audioDir: path.join(dataDir, "audio"),
    transcriptDir: path.join(dataDir, "transcripts"),
    mediaCacheRootName: process.env.MEDIA_CACHE_ROOT_NAME || "TPT U14 2025-2026",
    mediaCacheSharePointRootSegment: process.env.MEDIA_CACHE_SHAREPOINT_ROOT_SEGMENT || "2025-2026",
    exportDir: path.join(dataDir, "exports"),
    sharepointRootUrl: process.env.SHAREPOINT_ROOT_URL || defaultSharePointRootUrl,
    graphAccessToken: process.env.GRAPH_ACCESS_TOKEN || "",
    azureTenantId: process.env.AZURE_TENANT_ID || "",
    azureClientId: process.env.AZURE_CLIENT_ID || "",
    azureClientSecret: process.env.AZURE_CLIENT_SECRET || "",
    openaiApiKey: process.env.OPENAI_API_KEY || "",
    openaiTranscribeModel: process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe",
    openaiLabelModel: process.env.OPENAI_LABEL_MODEL || "gpt-4o-mini",
    geminiApiKey: process.env.GEMINI_API_KEY || "",
    geminiLabelModel: process.env.GEMINI_LABEL_MODEL || "gemini-2.0-flash",
    transcriptionPromptEnabled: /^(1|true|yes)$/i.test(process.env.TRANSCRIPTION_PROMPT || ""),
    transcriptionPromptMaxNames: Number(process.env.TRANSCRIPTION_PROMPT_MAX_NAMES || 80),
    // Whisper model size: tiny, base, small, medium, large-v1, large-v2, large-v3.
    // See docs/WHISPER_MODELS.md for details.
    whisperModelSize: process.env.WHISPER_MODEL_SIZE || "medium",
    // Whisper backend: whisper.cpp, mlx, openai.
    whisperBackend: process.env.WHISPER_BACKEND || "whisper.cpp",
    whisperCppNoGpu: /^(1|true|yes)$/i.test(process.env.WHISPER_CPP_NO_GPU || ""),
    metadataBackend: process.env.METADATA_BACKEND || "local",
    firebaseProjectId: process.env.FIREBASE_PROJECT_ID || "",
    firebaseDatabaseId: process.env.FIREBASE_DATABASE_ID || "(default)",
    firebaseCollectionPrefix: process.env.FIREBASE_COLLECTION_PREFIX || "skiVideoCompanion",
    firebaseServiceAccountJson: process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "",
    firebaseServiceAccountPath: process.env.FIREBASE_SERVICE_ACCOUNT_PATH || ""
  };
}

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index < 0) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    if (!(key in process.env)) process.env[key] = value;
  }
}

export function publicConfig(config = loadConfig()) {
  return {
    hasGraphAccessToken: Boolean(config.graphAccessToken),
    hasAzureClientCredentials: Boolean(config.azureTenantId && config.azureClientId && config.azureClientSecret),
    hasOpenAiKey: Boolean(config.openaiApiKey),
    metadataBackend: config.metadataBackend,
    whisperCppNoGpu: config.whisperCppNoGpu,
    hasFirebaseConfig: Boolean(config.firebaseProjectId && (config.firebaseServiceAccountJson || config.firebaseServiceAccountPath)),
    sharepointRootUrl: config.sharepointRootUrl,
    dataDir: config.dataDir
  };
}
