import fs from "node:fs/promises";
import path from "node:path";
import { stableId, nowIso, slugify } from "../lib/ids.mjs";
import { normalizeText, scoreFolderEventMatch } from "../lib/text.mjs";

export const farWestU14Url = "https://fwskiing.org/events/u14-schedule-results/";
export const liveTimingRacesUrl = "https://live-timing.com/races.php";

export async function fetchFarWestU14Events(config) {
  const response = await fetch(farWestU14Url, {
    headers: { "user-agent": "ski-video-companion/0.1" }
  });
  if (!response.ok) throw new Error(`Far West schedule fetch failed: ${response.status}`);
  const html = await response.text();
  const rawPath = path.join(config.rawDir, "far-west-u14-schedule.html");
  await fs.mkdir(path.dirname(rawPath), { recursive: true });
  await fs.writeFile(rawPath, html);
  return parseFarWestEvents(html).map((event) => ({ ...event, rawPath }));
}

export function parseFarWestEvents(html) {
  const text = String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

  const datePattern = /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:\s*[-/]\s*\d{1,2})?(?:,\s*\d{4})?\b/gi;
  const matches = [...text.matchAll(datePattern)];
  const events = [];
  for (let i = 0; i < matches.length; i += 1) {
    const start = Math.max(0, matches[i].index - 120);
    const end = Math.min(text.length, matches[i].index + 220);
    const context = text.slice(start, end).trim();
    const dateText = matches[i][0];
    const name = cleanupEventName(context, dateText);
    events.push({
      id: stableId("event", `${dateText}:${name}`),
      source: "far_west_u14",
      name,
      title: name,
      dateText,
      date: normalizeDate(dateText),
      venue: inferVenue(context),
      discipline: inferDiscipline(context),
      sourceUrl: farWestU14Url,
      fetchedAt: nowIso()
    });
  }
  return dedupeEvents(events);
}

export async function fetchLiveTimingSearch(config, query = "") {
  const url = query ? `${liveTimingRacesUrl}?${new URLSearchParams({ search: query })}` : liveTimingRacesUrl;
  const response = await fetch(url, {
    headers: { "user-agent": "ski-video-companion/0.1" }
  });
  if (!response.ok) throw new Error(`Live-Timing fetch failed: ${response.status}`);
  const html = await response.text();
  const rawPath = path.join(config.rawDir, "live-timing", `${slugify(query || "races")}.html`);
  await fs.mkdir(path.dirname(rawPath), { recursive: true });
  await fs.writeFile(rawPath, html);
  return {
    sourceUrl: url,
    rawPath,
    assets: parseLiveTimingAssets(html, url)
  };
}

export function parseLiveTimingAssets(html, sourceUrl = liveTimingRacesUrl) {
  const assets = [];
  const linkPattern = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = linkPattern.exec(String(html || "")))) {
    const href = new URL(match[1], sourceUrl).toString();
    const label = match[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (!label) continue;
    if (/start|result|race|u14|gs|sl|sg|dh/i.test(label + href)) {
      assets.push({
        type: inferAssetType(label, href),
        label,
        sourceUrl: href,
        localPath: ""
      });
    }
  }
  return assets.slice(0, 100);
}

export function matchFoldersToEvents(folders, events) {
  return folders.map((folder) => {
    let best = null;
    for (const event of events) {
      const score = scoreFolderEventMatch(`${folder.name} ${folder.path}`, event);
      if (!best || score > best.confidence) {
        best = {
          canonicalName: event.name || event.title,
          date: event.date,
          venue: event.venue,
          discipline: event.discipline,
          confidence: Number(score.toFixed(2)),
          reasons: buildMatchReasons(folder, event, score),
          sources: [event.sourceUrl].filter(Boolean),
          eventId: event.id
        };
      }
    }
    return { ...folder, eventMatch: best && best.confidence > 0.15 ? best : folder.eventMatch };
  });
}

export function parseRosterFromText(text, sourceUrl = "") {
  const rows = String(text || "").split(/\r?\n/);
  const roster = [];
  for (const row of rows) {
    const clean = row.replace(/\s+/g, " ").trim();
    const match = clean.match(/\b(\d{1,3})\b\s+([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+)+)(?:\s+([A-Z]{2,5}))?/);
    if (!match) continue;
    roster.push({
      name: match[2],
      bib: match[1],
      club: match[3] || "",
      category: "U14",
      sourceUrl
    });
  }
  return roster;
}

function cleanupEventName(context, dateText) {
  return context
    .replace(dateText, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140) || dateText;
}

function normalizeDate(dateText) {
  const parsed = Date.parse(dateText);
  return Number.isNaN(parsed) ? "" : new Date(parsed).toISOString().slice(0, 10);
}

function inferVenue(context) {
  const venues = ["Palisades", "Mammoth", "Sugar Bowl", "Northstar", "Heavenly", "Kirkwood", "Diamond Peak", "Mt Rose", "Boreal"];
  const normalized = normalizeText(context);
  return venues.find((venue) => normalized.includes(normalizeText(venue))) || "";
}

function inferDiscipline(context) {
  const normalized = normalizeText(context);
  if (/\bgs\b|giant slalom/.test(normalized)) return "GS";
  if (/\bsl\b|slalom/.test(normalized)) return "SL";
  if (/\bsg\b|super g/.test(normalized)) return "SG";
  if (/\bdh\b|downhill/.test(normalized)) return "DH";
  return "";
}

function inferAssetType(label, href) {
  const text = normalizeText(`${label} ${href}`);
  if (text.includes("start")) return "start_list";
  if (text.includes("result")) return "result";
  return "race_page";
}

function buildMatchReasons(folder, event, score) {
  const reasons = [];
  const text = normalizeText(`${folder.name} ${folder.path}`);
  if (event.date && text.includes(normalizeText(event.date))) reasons.push("date matched");
  if (event.venue && text.includes(normalizeText(event.venue))) reasons.push("venue matched");
  if (event.discipline && text.includes(normalizeText(event.discipline))) reasons.push("discipline matched");
  if (score > 0.15 && reasons.length === 0) reasons.push("folder tokens overlap event text");
  return reasons;
}

function dedupeEvents(events) {
  const seen = new Map();
  for (const event of events) {
    const key = `${event.dateText}:${normalizeText(event.name).slice(0, 50)}`;
    if (!seen.has(key)) seen.set(key, event);
  }
  return [...seen.values()];
}
