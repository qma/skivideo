import { stableId, nowIso } from "../lib/ids.mjs";

const defaultSiteOrigin = "https://alterramtnco.sharepoint.com";
const videoPattern = /\.(mp4|mov|m4v|webm|avi)$/i;
const transcriptPattern = /\.(vtt|srt|txt|json)$/i;

export async function establishSharePointSession(rootUrl) {
  const first = await fetch(rootUrl, { redirect: "manual" });
  const cookies = collectCookies(first.headers);
  const location = first.headers.get("location");
  if (!location) throw new Error(`SharePoint shared link did not redirect. Status ${first.status}`);
  const resolvedUrl = new URL(location, rootUrl).toString();
  const folderServerRelativeUrl = new URL(resolvedUrl).searchParams.get("id");
  if (!folderServerRelativeUrl) {
    throw new Error("SharePoint redirect did not include a folder id parameter.");
  }
  return {
    cookies,
    resolvedUrl,
    siteOrigin: new URL(resolvedUrl).origin,
    sitePath: "/sites/TeamPalisadesTahoeShared",
    folderServerRelativeUrl
  };
}

export async function listRootEventFoldersRest(config, rootUrl = config.sharepointRootUrl) {
  const session = await establishSharePointSession(rootUrl);
  const folders = await listFoldersByServerRelativeUrl(session, session.folderServerRelativeUrl);
  return folders
    .filter((folder) => folder.Name !== "Forms")
    .map((folder) => restFolderToFolder(session, folder));
}

export async function buildRestFolderManifest(config, folderServerRelativeUrl, rootUrl = config.sharepointRootUrl) {
  const session = await establishSharePointSession(rootUrl);
  const folder = await getFolderByServerRelativeUrl(session, folderServerRelativeUrl);
  const files = await listFilesByServerRelativeUrl(session, folderServerRelativeUrl);
  const folderRecord = restFolderToFolder(session, folder);
  const transcripts = new Map();
  for (const file of files) {
    if (transcriptPattern.test(file.Name)) transcripts.set(baseName(file.Name), file);
  }
  const videos = files
    .filter((file) => videoPattern.test(file.Name))
    .map((file) => restFileToVideo(session, folderRecord.id, file, transcripts.get(baseName(file.Name))));
  return { folders: [folderRecord], videos };
}

export async function pickOldestFolder(config) {
  const folders = await listRootEventFoldersRest(config);
  return folders
    .slice()
    .sort((a, b) => String(a.timeCreated).localeCompare(String(b.timeCreated)))[0];
}

export async function getFolderByServerRelativeUrl(session, serverRelativeUrl) {
  return spRest(session, `/_api/web/GetFolderByServerRelativeUrl('${encodeSharePointPath(serverRelativeUrl)}')`);
}

export async function listFoldersByServerRelativeUrl(session, serverRelativeUrl) {
  const json = await spRest(session, `/_api/web/GetFolderByServerRelativeUrl('${encodeSharePointPath(serverRelativeUrl)}')/Folders`);
  return json.value || [];
}

export async function listFilesByServerRelativeUrl(session, serverRelativeUrl) {
  const json = await spRest(session, `/_api/web/GetFolderByServerRelativeUrl('${encodeSharePointPath(serverRelativeUrl)}')/Files`);
  return json.value || [];
}

export function downloadUrlForServerRelativeUrl(siteOrigin, serverRelativeUrl) {
  return `${siteOrigin || defaultSiteOrigin}/sites/TeamPalisadesTahoeShared/_api/web/GetFileByServerRelativeUrl('${encodeSharePointPath(serverRelativeUrl)}')/$value`;
}

export function playbackUrlForServerRelativeUrl(siteOrigin, serverRelativeUrl) {
  return `${siteOrigin || defaultSiteOrigin}${encodeURI(serverRelativeUrl)}`;
}

async function spRest(session, apiPath) {
  const response = await fetch(`${session.siteOrigin}${session.sitePath}${apiPath}`, {
    headers: {
      accept: "application/json;odata=nometadata",
      cookie: session.cookies
    }
  });
  if (!response.ok) {
    throw new Error(`SharePoint REST request failed ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

function restFolderToFolder(session, folder) {
  const sharepointUrl = playbackUrlForServerRelativeUrl(session.siteOrigin, folder.ServerRelativeUrl);
  return {
    id: stableId("folder", folder.UniqueId || folder.ServerRelativeUrl),
    source: "sharepoint_rest",
    name: folder.Name,
    path: folder.ServerRelativeUrl,
    serverRelativeUrl: folder.ServerRelativeUrl,
    sharepointUrl,
    itemCount: Number(folder.ItemCount || 0),
    timeCreated: folder.TimeCreated || "",
    timeLastModified: folder.TimeLastModified || "",
    discoveredAt: nowIso(),
    eventMatch: inferEventMatchFromFolder(folder),
    raceAssets: [],
    candidateRoster: []
  };
}

function inferEventMatchFromFolder(folder) {
  const name = folder.Name || "";
  const discipline = /\bGS\b|giant/i.test(name) ? "GS"
    : /\bSL\b|slalom/i.test(name) ? "SL"
    : /super\s*g|\bSG\b/i.test(name) ? "SG"
    : "";
  const date = inferDateFromFolderName(name);
  if (!discipline && !date) return null;
  return {
    canonicalName: name,
    date,
    venue: inferVenueFromFolderName(name),
    discipline,
    confidence: date ? 0.45 : 0.3,
    reasons: ["inferred from SharePoint folder name"],
    sources: ["sharepoint_folder_name"]
  };
}

function inferDateFromFolderName(name) {
  const year = (String(name).match(/\b20\d{2}\b/) || [])[0] || "2026";
  const months = {
    jan: "01", january: "01",
    feb: "02", february: "02",
    mar: "03", march: "03",
    apr: "04", april: "04",
    may: "05",
    jun: "06", june: "06",
    jul: "07", july: "07",
    aug: "08", august: "08",
    sep: "09", sept: "09", september: "09",
    oct: "10", october: "10",
    nov: "11", november: "11",
    dec: "12", december: "12"
  };
  const match = String(name).toLowerCase().match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/);
  if (!match) return "";
  return `${year}-${months[match[1]]}-${String(match[2]).padStart(2, "0")}`;
}

function inferVenueFromFolderName(name) {
  const text = String(name).toLowerCase();
  if (text.includes("northstar")) return "Northstar";
  if (text.includes("china peak")) return "China Peak";
  if (text.includes("diamond") || /\bdp\b/i.test(name)) return "Diamond Peak";
  if (text.includes("sully") || text.includes("4th tree") || text.includes("lakeview")) return "Palisades Tahoe";
  return "";
}

function restFileToVideo(session, folderId, file, transcriptFile) {
  const sharepointUrl = playbackUrlForServerRelativeUrl(session.siteOrigin, file.ServerRelativeUrl);
  return {
    id: stableId("video", file.UniqueId || file.ServerRelativeUrl),
    folderId,
    filename: file.Name,
    serverRelativeUrl: file.ServerRelativeUrl,
    sharepointUrl,
    downloadUrl: downloadUrlForServerRelativeUrl(session.siteOrigin, file.ServerRelativeUrl),
    localVideoPath: "",
    localAudioPath: "",
    sizeBytes: Number(file.Length || 0),
    timeCreated: file.TimeCreated || "",
    timeLastModified: file.TimeLastModified || "",
    transcript: transcriptFile ? {
      source: "microsoft_transcript",
      text: "",
      segments: [],
      localPath: "",
      sourceUrl: playbackUrlForServerRelativeUrl(session.siteOrigin, transcriptFile.ServerRelativeUrl),
      downloadUrl: downloadUrlForServerRelativeUrl(session.siteOrigin, transcriptFile.ServerRelativeUrl)
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

function collectCookies(headers) {
  const values = typeof headers.getSetCookie === "function"
    ? headers.getSetCookie()
    : [headers.get("set-cookie")].filter(Boolean);
  return values.map((cookie) => cookie.split(";")[0]).join("; ");
}

function encodeSharePointPath(value) {
  return String(value).replace(/'/g, "''").split("/").map((part) => encodeURIComponent(part)).join("/");
}

function baseName(name) {
  return String(name || "").replace(/\.[^.]+$/, "").toLowerCase();
}
