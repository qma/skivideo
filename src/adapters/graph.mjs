import { stableId, nowIso } from "../lib/ids.mjs";

const graphBase = "https://graph.microsoft.com/v1.0";

export function encodeSharingUrl(url) {
  const base64 = Buffer.from(url).toString("base64");
  return `u!${base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")}`;
}

export async function getGraphToken(config) {
  if (config.graphAccessToken) return config.graphAccessToken;
  if (!(config.azureTenantId && config.azureClientId && config.azureClientSecret)) return "";

  const body = new URLSearchParams({
    client_id: config.azureClientId,
    client_secret: config.azureClientSecret,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials"
  });
  const response = await fetch(`https://login.microsoftonline.com/${config.azureTenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
  if (!response.ok) {
    throw new Error(`Microsoft token request failed: ${response.status} ${await response.text()}`);
  }
  const json = await response.json();
  return json.access_token || "";
}

export async function graphFetch(config, path) {
  const token = await getGraphToken(config);
  if (!token) throw new Error("Microsoft Graph credentials are not configured.");
  const response = await fetch(`${graphBase}${path}`, {
    headers: { authorization: `Bearer ${token}` }
  });
  if (!response.ok) {
    throw new Error(`Graph request failed ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

export async function resolveSharedFolder(config, sharepointUrl = config.sharepointRootUrl) {
  if (!sharepointUrl) throw new Error("SharePoint root URL is not configured.");
  const shareId = encodeSharingUrl(sharepointUrl);
  return graphFetch(config, `/shares/${shareId}/driveItem`);
}

export async function listDriveItemChildren(config, driveId, itemId) {
  const json = await graphFetch(config, `/drives/${driveId}/items/${itemId}/children?$top=200`);
  return json.value || [];
}

export async function listRootEventFolders(config, rootUrl = config.sharepointRootUrl) {
  const root = await resolveSharedFolder(config, rootUrl);
  const children = await listDriveItemChildren(config, root.parentReference.driveId, root.id);
  return children
    .filter((item) => item.folder)
    .map((item) => graphItemToFolder(item, rootUrl));
}

export async function buildFolderManifest(config, folderUrlOrId) {
  const folderItem = folderUrlOrId.startsWith("http")
    ? await resolveSharedFolder(config, folderUrlOrId)
    : null;
  if (!folderItem) throw new Error("Folder manifest currently requires a SharePoint folder URL.");
  const driveId = folderItem.parentReference.driveId;
  const children = await listDriveItemChildren(config, driveId, folderItem.id);
  const folder = graphItemToFolder(folderItem, folderItem.webUrl);
  const videos = [];
  const transcripts = new Map();

  for (const item of children) {
    if (isTranscript(item.name)) {
      transcripts.set(baseName(item.name), item);
    }
  }

  for (const item of children) {
    if (!isVideo(item.name)) continue;
    const transcriptItem = transcripts.get(baseName(item.name));
    videos.push(graphItemToVideo(item, folder.id, transcriptItem));
  }

  return { folders: [folder], videos };
}

function graphItemToFolder(item, fallbackUrl) {
  const path = item.parentReference?.path || "";
  return {
    id: stableId("folder", item.id || item.webUrl || item.name),
    source: "sharepoint_graph",
    graphItemId: item.id,
    graphDriveId: item.parentReference?.driveId || "",
    name: item.name,
    path,
    sharepointUrl: item.webUrl || fallbackUrl,
    discoveredAt: nowIso(),
    eventMatch: null,
    raceAssets: [],
    candidateRoster: []
  };
}

function graphItemToVideo(item, folderId, transcriptItem) {
  return {
    id: stableId("video", item.id || item.webUrl || item.name),
    folderId,
    graphItemId: item.id,
    filename: item.name,
    sharepointUrl: item.webUrl,
    downloadUrl: item["@microsoft.graph.downloadUrl"] || "",
    localVideoPath: "",
    localAudioPath: "",
    transcript: transcriptItem ? {
      source: "microsoft_transcript",
      text: "",
      segments: [],
      localPath: "",
      sourceUrl: transcriptItem.webUrl,
      downloadUrl: transcriptItem["@microsoft.graph.downloadUrl"] || ""
    } : {
      source: "unavailable",
      text: "",
      segments: [],
      localPath: ""
    },
    athleteLabels: [],
    processing: {
      status: "pending",
      errors: [],
      processedAt: ""
    }
  };
}

function isVideo(name) {
  return /\.(mp4|mov|m4v|webm|avi)$/i.test(name || "");
}

function isTranscript(name) {
  return /\.(vtt|srt|txt|json)$/i.test(name || "");
}

function baseName(name) {
  return String(name || "").replace(/\.[^.]+$/, "").toLowerCase();
}
