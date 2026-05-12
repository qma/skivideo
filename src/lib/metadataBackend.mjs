import crypto from "node:crypto";
import fs from "node:fs/promises";
import { buildLeanStore } from "./fsStore.mjs";

export async function syncMetadataBackend(config, store) {
  if (config.metadataBackend !== "firebase") {
    return {
      backend: "local",
      ok: true,
      message: "Local JSON metadata store is authoritative.",
      storePath: `${config.indexDir}/store.json`
    };
  }
  const serviceAccount = await loadServiceAccount(config);
  if (!config.firebaseProjectId) throw new Error("FIREBASE_PROJECT_ID is required for Firebase metadata sync.");
  if (!serviceAccount.client_email || !serviceAccount.private_key) {
    throw new Error("Firebase service account must include client_email and private_key.");
  }
  const lean = buildLeanStore(store);
  const token = await getGoogleAccessToken(serviceAccount);
  const client = new FirestoreRestClient(config, token);
  const writes = [
    client.setDocument("meta", "store", {
      version: lean.version,
      exportedAt: lean.exportedAt,
      counts: {
        folders: lean.folders.length,
        videos: lean.videos.length,
        events: lean.events.length,
        jobs: lean.jobs.length
      }
    }),
    ...lean.folders.map((folder) => client.setDocument("folders", folder.id, folder)),
    ...lean.videos.map((video) => client.setDocument("videos", video.id, video)),
    ...lean.events.map((event) => client.setDocument("events", event.id || stableDocId(`${event.date}:${event.name}`), event)),
    ...lean.jobs.map((job) => client.setDocument("jobs", job.id, job))
  ];
  await Promise.all(writes);
  return {
    backend: "firebase",
    ok: true,
    projectId: config.firebaseProjectId,
    collectionPrefix: config.firebaseCollectionPrefix,
    counts: {
      folders: lean.folders.length,
      videos: lean.videos.length,
      events: lean.events.length,
      jobs: lean.jobs.length
    }
  };
}

class FirestoreRestClient {
  constructor(config, token) {
    this.projectId = config.firebaseProjectId;
    this.databaseId = config.firebaseDatabaseId || "(default)";
    this.prefix = config.firebaseCollectionPrefix || "skiVideoCompanion";
    this.token = token;
  }

  async setDocument(collection, id, data) {
    const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(this.projectId)}/databases/${encodeURIComponent(this.databaseId)}/documents/${encodeURIComponent(this.prefix)}_${encodeURIComponent(collection)}/${encodeURIComponent(stableDocId(id))}`;
    const response = await fetch(url, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ fields: toFirestoreFields(data) })
    });
    if (!response.ok) throw new Error(`Firestore write failed ${response.status}: ${await response.text()}`);
  }
}

async function loadServiceAccount(config) {
  if (config.firebaseServiceAccountJson) return JSON.parse(config.firebaseServiceAccountJson);
  if (config.firebaseServiceAccountPath) return JSON.parse(await fs.readFile(config.firebaseServiceAccountPath, "utf8"));
  throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON or FIREBASE_SERVICE_ACCOUNT_PATH is required for Firebase metadata sync.");
}

async function getGoogleAccessToken(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const assertion = signJwt({
    alg: "RS256",
    typ: "JWT"
  }, {
    iss: serviceAccount.client_email,
    scope: "https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600
  }, serviceAccount.private_key);
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    })
  });
  if (!response.ok) throw new Error(`Google OAuth token request failed ${response.status}: ${await response.text()}`);
  const json = await response.json();
  return json.access_token;
}

function signJwt(header, payload, privateKey) {
  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const input = `${encodedHeader}.${encodedPayload}`;
  const signature = crypto.createSign("RSA-SHA256").update(input).sign(privateKey);
  return `${input}.${base64url(signature)}`;
}

function toFirestoreFields(object) {
  return Object.fromEntries(Object.entries(object || {}).map(([key, value]) => [key, toFirestoreValue(value)]));
}

function toFirestoreValue(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(toFirestoreValue) } };
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (typeof value === "object") return { mapValue: { fields: toFirestoreFields(value) } };
  return { stringValue: String(value) };
}

function base64url(value) {
  return Buffer.from(value).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function stableDocId(value) {
  return String(value || "unknown").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120) || "unknown";
}
