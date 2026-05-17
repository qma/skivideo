import fs from "node:fs/promises";
import path from "node:path";
import { stableId, nowIso, slugify } from "../lib/ids.mjs";
import { normalizeText, scoreFolderEventMatch } from "../lib/text.mjs";

export const farWestU14Url = "https://fwskiing.org/events/u14-schedule-results/";
export const liveTimingRacesUrl = "https://live-timing.com/races.php";
export const liveTimingOrigin = "https://www.live-timing.com";

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

export async function fetchLiveTimingDailyRaces(config, date) {
  const normalized = normalizeIsoDate(date);
  if (!normalized) throw new Error(`Invalid Live-Timing date: ${date}`);
  const url = `${liveTimingOrigin}/dailyRaces/${normalized.slice(0, 4)}/races_${normalized}.txt`;
  const response = await fetch(url, {
    headers: { "user-agent": "ski-video-companion/0.1" }
  });
  if (!response.ok) throw new Error(`Live-Timing daily race fetch failed: ${response.status}`);
  const text = await response.text();
  const rawPath = path.join(config.rawDir, "live-timing", `daily-races-${normalized}.txt`);
  await fs.mkdir(path.dirname(rawPath), { recursive: true });
  await fs.writeFile(rawPath, text);
  return {
    sourceUrl: url,
    rawPath,
    races: parseLiveTimingDailyRaces(text, url)
  };
}

export async function fetchLiveTimingRaceData(config, raceId) {
  if (!raceId) throw new Error("Live-Timing race id is required.");
  const url = `${liveTimingOrigin}/includes/aj_race.php?${new URLSearchParams({ r: raceId, m: "0", u: "60" })}`;
  const response = await fetch(url, {
    headers: { "user-agent": "ski-video-companion/0.1" }
  });
  if (!response.ok) throw new Error(`Live-Timing race data fetch failed: ${response.status}`);
  const text = await response.text();
  const rawPath = path.join(config.rawDir, "live-timing", `race-${raceId}.txt`);
  await fs.mkdir(path.dirname(rawPath), { recursive: true });
  await fs.writeFile(rawPath, text);
  return {
    sourceUrl: url,
    rawPath,
    ...parseLiveTimingRacePayload(text, url)
  };
}

export async function correlateFolderWithLiveTiming(config, folder) {
  const query = [
    folder.eventMatch?.date,
    folder.eventMatch?.venue,
    folder.eventMatch?.discipline,
    folder.name
  ].filter(Boolean).join(" ");
  const search = await fetchLiveTimingSearch(config, query);
  const daily = folder.eventMatch?.date ? await fetchLiveTimingDailyRaces(config, folder.eventMatch.date) : null;
  const liveTimingCandidates = daily ? matchFolderToLiveTimingRaceCandidates(folder, daily.races) : [];
  const selection = resolveLiveTimingSelection(liveTimingCandidates);
  const liveTimingMatches = selection.status === "auto_confirmed" ? selection.matches : [];
  return finalizeLiveTimingCorrelation(config, folder, {
    query,
    search,
    daily,
    liveTimingMatches,
    liveTimingCandidates,
    selection
  });
}

export async function finalizeLiveTimingCorrelation(config, folder, input) {
  const {
    query = "",
    search,
    daily = null,
    liveTimingMatches = [],
    liveTimingCandidates = liveTimingMatches,
    selection = { status: "auto_confirmed", matches: liveTimingMatches, reason: "" }
  } = input;
  const raceData = [];
  for (const match of liveTimingMatches) {
    try {
      raceData.push({ match, data: await fetchLiveTimingRaceData(config, match.race.raceId) });
    } catch (error) {
      raceData.push({ match, error: error.message });
    }
  }
  const candidateRoster = dedupeRoster(raceData.flatMap(({ match, data }) => (data?.roster || []).map((racer) => ({
    ...racer,
    raceId: match.race.raceId,
    raceGender: match.race.gender,
    raceName: match.race.name,
    raceSourceUrl: match.race.sourceUrl
  }))));
  const raceAssets = raceData.flatMap(({ match, data, error }) => [
    {
      type: "race_page",
      label: `${match.race.resort} - ${match.race.gender} - ${match.race.name}`,
      sourceUrl: match.race.sourceUrl,
      localPath: ""
    },
    {
      type: "live_timing_race_data",
      label: `Live-Timing race data: ${match.race.raceId}`,
      sourceUrl: data?.sourceUrl || `${liveTimingOrigin}/includes/aj_race.php?r=${match.race.raceId}`,
      localPath: data?.rawPath || "",
      error: error || undefined
    },
    ...(match.race.reports || [])
  ]);
  const assets = [
    {
      type: "live_timing_search",
      label: `Live-Timing search: ${query}`,
      sourceUrl: search?.sourceUrl || "",
      localPath: search?.rawPath || ""
    },
    ...(daily ? [{
      type: "live_timing_daily_archive",
      label: `Live-Timing daily archive: ${folder.eventMatch.date}`,
      sourceUrl: daily.sourceUrl,
      localPath: daily.rawPath
    }] : []),
    ...raceAssets,
    ...(search?.assets || []).filter((asset) => !/^Races$|^Split Second$/i.test(asset.label))
  ];
  return {
    query,
    assets,
    candidateRoster,
    liveTimingMatches,
    liveTimingCandidates,
    selection,
    daily,
    search
  };
}

export function parseLiveTimingDailyRaces(text, sourceUrl = liveTimingOrigin) {
  return String(text || "")
    .split("~")
    .map((chunk) => parseLiveTimingRaceRecord(chunk, sourceUrl))
    .filter(Boolean);
}

export function parseLiveTimingRacePayload(text, sourceUrl = liveTimingOrigin) {
  const fields = {};
  const roster = [];
  let current = null;
  for (const part of String(text || "").split("|")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index);
    const value = part.slice(index + 1);
    if (key.startsWith("h")) {
      fields[key] = value;
      continue;
    }
    if (key === "b") {
      if (current) roster.push(current);
      current = {
        bib: value,
        name: "",
        rawName: "",
        team: "",
        club: "",
        category: "",
        ussaNumber: "",
        sourceUrl
      };
      continue;
    }
    if (!current) continue;
    if (key === "m") {
      current.rawName = value;
      current.name = canonicalLiveTimingName(value);
    } else if (key === "t") current.team = value;
    else if (key === "c") current.club = value.trim();
    else if (key === "s") current.category = value;
    else if (key === "un") current.ussaNumber = value;
    else if (key === "ltID") current.liveTimingMemberId = value;
  }
  if (current) roster.push(current);
  const raceRecord = parseLiveTimingRaceRecord(Object.entries(fields).map(([key, value]) => `${key}=${value}`).join("|"), sourceUrl);
  return {
    race: raceRecord,
    roster: roster.filter((racer) => racer.name || racer.rawName)
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

export function matchFolderToLiveTimingRace(folder, races) {
  const [best] = matchFolderToLiveTimingRaces(folder, races, { includeSiblingGenders: false });
  return best && best.confidence >= 0.2 ? best : null;
}

export function matchFolderToLiveTimingRaces(folder, races, options = {}) {
  const candidates = matchFolderToLiveTimingRaceCandidates(folder, races);
  const includeSiblingGenders = options.includeSiblingGenders !== false;
  if (!candidates.length) return [];
  if (includeSiblingGenders) {
    const selection = resolveLiveTimingSelection(candidates);
    return selection.status === "auto_confirmed" ? selection.matches : candidates;
  }
  return [candidates[0]];
}

export function matchFolderToLiveTimingRaceCandidates(folder, races) {
  const scored = races
    .map((race) => ({ race, confidence: Number(scoreFolderLiveTimingRace(folder, race).toFixed(2)) }))
    .filter((match) => match.confidence >= 0.55)
    .sort(compareLiveTimingMatches);
  if (!scored.length) return [];
  const best = scored[0].confidence;
  return scored.filter((match) => best - match.confidence <= 0.12);
}

export function resolveLiveTimingSelection(candidates = []) {
  const matches = [];
  const genders = new Set();
  for (const candidate of candidates) {
    const gender = normalizedRaceGender(candidate.race?.gender || candidate.gender);
    if (!gender || genders.has(gender)) {
      return {
        status: candidates.length ? "needs_admin_selection" : "no_candidates",
        reason: gender ? `Multiple ${gender} candidates matched` : "Candidate race has no gender",
        matches: [],
        candidates
      };
    }
    genders.add(gender);
    matches.push(candidate);
  }
  if (matches.length > 2) {
    return {
      status: "needs_admin_selection",
      reason: "More than two Live-Timing races matched",
      matches: [],
      candidates
    };
  }
  return {
    status: "auto_confirmed",
    reason: matches.length ? "At most one Men race and one Women race matched" : "No Live-Timing candidates matched",
    matches,
    candidates
  };
}

function compareLiveTimingMatches(a, b) {
  return b.confidence - a.confidence
    || String(a.race.gender).localeCompare(String(b.race.gender))
    || String(a.race.raceId).localeCompare(String(b.race.raceId));
}

function normalizedRaceGender(value) {
  const text = String(value || "").toLowerCase();
  if (text.startsWith("men") || text === "m") return "Men";
  if (text.startsWith("women") || text === "w" || text.startsWith("lad")) return "Women";
  return String(value || "").trim();
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

function scoreFolderLiveTimingRace(folder, race) {
  const folderText = normalizeText(`${folder.name} ${folder.path}`);
  const eventMatch = folder.eventMatch || {};
  const base = scoreFolderEventMatch(`${folder.name} ${folder.path}`, {
    name: race.name,
    venue: race.resort,
    date: race.date,
    discipline: race.type
  });
  const venueScore = eventMatch.venue && normalizeText(race.resort).includes(normalizeText(eventMatch.venue)) ? 0.28 : 0;
  const dateScore = eventMatch.date && race.date === eventMatch.date ? 0.3 : 0;
  const disciplineScore = disciplineMatches(eventMatch.discipline || folderText, race.type) ? 0.24 : 0;
  const nameScore = normalizeText(race.name).split(" ").some((token) => token.length > 3 && folderText.includes(token)) ? 0.08 : 0;
  return Math.min(1, base + venueScore + dateScore + disciplineScore + nameScore);
}

function disciplineMatches(folderDiscipline, raceType) {
  const folder = normalizeText(folderDiscipline);
  const race = normalizeText(raceType);
  if (!folder || !race) return false;
  if (folder.includes("giant slalom") || /\bgs\b/.test(folder)) return race.includes("giant slalom");
  if (folder.includes("slalom") || /\bsl\b/.test(folder)) return race.includes("slalom") && !race.includes("giant");
  if (folder.includes("super g") || /\bsg\b/.test(folder)) return race.includes("super g");
  return folder.split(" ").some((token) => token.length > 2 && race.includes(token));
}

function canonicalLiveTimingName(name) {
  const value = String(name || "").trim();
  const [last, first] = value.split(",").map((part) => part.trim());
  return first && last ? `${first} ${last}` : value;
}

function dedupeRoster(roster) {
  const byKey = new Map();
  for (const racer of roster) {
    const key = racer.ussaNumber || `${normalizeText(racer.name)}:${racer.bib}:${racer.raceId}`;
    if (!byKey.has(key)) byKey.set(key, racer);
  }
  return [...byKey.values()].sort((a, b) => {
    const aTpt = isTptRacer(a) ? 0 : 1;
    const bTpt = isTptRacer(b) ? 0 : 1;
    return aTpt - bTpt || String(a.name).localeCompare(String(b.name));
  });
}

function isTptRacer(racer) {
  return /^(TPT|TPTA)$/i.test(String(racer.team || "").trim())
    || /team palis/i.test(String(racer.club || ""));
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

function parseLiveTimingRaceRecord(chunk, sourceUrl) {
  if (!chunk.includes("hID=")) return null;
  const fields = {};
  const reports = [];
  for (const part of chunk.split("|")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index);
    const value = part.slice(index + 1);
    if (key === "hP") {
      const [id, ...labelParts] = value.split("=");
      reports.push({ id, label: labelParts.join("=") });
    } else {
      fields[key] = value;
    }
  }
  const [source, name] = String(fields.hN || "").split("=").slice(-2);
  const [type, gender] = String(fields.hT || "").split("=");
  const [country, state] = String(fields.hC || "").split("=");
  const raceId = fields.hID;
  return {
    id: `live_timing_${raceId}`,
    raceId,
    source,
    name,
    type,
    gender,
    country,
    state,
    resort: fields.hR || "",
    start: fields.hST || "",
    date: normalizeLiveTimingDate(fields.hST),
    status: fields.hZ || "",
    sourceUrl: `${liveTimingOrigin}/race2.php?r=${raceId}`,
    reports: reports.map((report) => ({
      ...report,
      type: inferAssetType(report.label, report.id),
      sourceUrl: report.id === "pdf"
        ? `${liveTimingOrigin}/report/${raceId} ${encodeURIComponent(report.label)}.pdf`
        : `${liveTimingOrigin}/report.php?r=${raceId}&rp=${encodeURIComponent(report.id)}`
    })),
    rawSourceUrl: sourceUrl
  };
}

function normalizeIsoDate(date) {
  const parsed = Date.parse(date);
  return Number.isNaN(parsed) ? "" : new Date(parsed).toISOString().slice(0, 10);
}

function normalizeLiveTimingDate(value) {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? "" : new Date(parsed).toISOString().slice(0, 10);
}
