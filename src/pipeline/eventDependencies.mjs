import { buildRestFolderManifest } from "../adapters/sharepointRest.mjs";
import { correlateFolderWithLiveTiming, finalizeLiveTimingCorrelation, resolveLiveTimingSelection } from "../adapters/events.mjs";

export async function ensureFolderManifest(config, store, folderId) {
  if (!folderId) throw new Error("folderId is required.");
  const state = await store.read();
  const folder = state.folders.find((item) => item.id === folderId);
  if (!folder) throw new Error(`Folder not found: ${folderId}`);
  const existingVideos = state.videos.filter((video) => video.folderId === folderId);
  if (existingVideos.length) {
    return {
      ok: true,
      folderId,
      imported: false,
      videos: existingVideos.length,
      message: `Folder already has ${existingVideos.length} video record${existingVideos.length === 1 ? "" : "s"}`
    };
  }
  if (!folder.serverRelativeUrl) {
    return {
      ok: true,
      folderId,
      imported: false,
      videos: 0,
      message: "Folder has no SharePoint server-relative path to import"
    };
  }

  const rootUrl = await lookupSharePointRootUrl(config, store, folder);
  const manifest = await buildRestFolderManifest(config, folder.serverRelativeUrl, rootUrl);
  await store.upsertFolders(manifest.folders || []);
  await store.upsertVideos(manifest.videos || []);
  return {
    ok: true,
    folderId,
    imported: true,
    folder: manifest.folders?.[0] || null,
    videos: manifest.videos?.length || 0,
    message: `Imported ${manifest.videos?.length || 0} video record${manifest.videos?.length === 1 ? "" : "s"} from SharePoint`
  };
}

export async function ensureLiveTimingCorrelation(config, store, folderId, options = {}) {
  if (!folderId) throw new Error("folderId is required.");
  const state = await store.read();
  const folder = state.folders.find((item) => item.id === folderId);
  if (!folder) throw new Error(`Folder not found: ${folderId}`);
  if (!options.force && hasLiveTimingCorrelation(folder)) {
    return {
      ok: true,
      folderId,
      skipped: true,
      races: folder.eventMatch?.liveTimingMatches || [],
      candidateRoster: folder.candidateRoster?.length || 0,
      tptRoster: (folder.candidateRoster || []).filter((racer) => /^(TPT|TPTA)$/i.test(racer.team || "")).length,
      assets: folder.raceAssets?.length || 0,
      message: "Live-Timing correlation already exists"
    };
  }

  const correlation = await correlateFolderWithLiveTiming(config, folder);
  await store.updateFolder(folderId, liveTimingPatch(folder, correlation));
  return {
    ok: true,
    folderId,
    skipped: false,
    query: correlation.query,
    races: correlation.liveTimingMatches.map(serializeLiveTimingMatch),
    candidates: (correlation.liveTimingCandidates || []).map(serializeLiveTimingMatch),
    selection: correlation.selection,
    candidateRoster: correlation.candidateRoster.length,
    tptRoster: correlation.candidateRoster.filter((racer) => /^(TPT|TPTA)$/i.test(racer.team || "")).length,
    assets: correlation.assets.length,
    search: correlation.search,
    message: liveTimingMessage(correlation)
  };
}

export async function confirmLiveTimingSelection(config, store, folderId, raceIds = []) {
  if (!folderId) throw new Error("folderId is required.");
  if (!Array.isArray(raceIds) || !raceIds.length) throw new Error("raceIds are required.");
  if (raceIds.length > 2) throw new Error("Select at most two Live-Timing races.");
  const state = await store.read();
  const folder = state.folders.find((item) => item.id === folderId);
  if (!folder) throw new Error(`Folder not found: ${folderId}`);
  const candidates = folder.eventMatch?.liveTimingCandidates || [];
  const selected = raceIds.map((raceId) => {
    const candidate = candidates.find((match) => String(match.raceId) === String(raceId));
    if (!candidate) throw new Error(`Selected race is not a current candidate: ${raceId}`);
    return { race: candidate, confidence: candidate.confidence || 1 };
  });
  const selection = resolveLiveTimingSelection(selected);
  if (selection.status !== "auto_confirmed") throw new Error(selection.reason || "Selected races must include at most one Men and one Women race.");
  const correlation = await finalizeLiveTimingCorrelation(config, folder, {
    query: folder.eventMatch?.liveTimingCorrelation?.query || "",
    search: liveTimingSearchFromFolder(folder),
    daily: null,
    liveTimingMatches: selected,
    liveTimingCandidates: candidates.map((candidate) => ({ race: candidate, confidence: candidate.confidence || 0 })),
    selection: {
      status: "admin_confirmed",
      reason: "Admin selected Live-Timing races",
      matches: selected,
      candidates
    }
  });
  await store.updateFolder(folderId, liveTimingPatch(folder, correlation));
  return {
    ok: true,
    folderId,
    races: correlation.liveTimingMatches.map(serializeLiveTimingMatch),
    candidateRoster: correlation.candidateRoster.length,
    tptRoster: correlation.candidateRoster.filter((racer) => /^(TPT|TPTA)$/i.test(racer.team || "")).length,
    assets: correlation.assets.length,
    selection: correlation.selection,
    message: `Confirmed ${correlation.liveTimingMatches.length} Live-Timing race${correlation.liveTimingMatches.length === 1 ? "" : "s"}`
  };
}

export function hasLiveTimingCorrelation(folder) {
  return Boolean(
    folder?.eventMatch?.liveTimingMatches?.length
    || folder?.eventMatch?.liveTimingMatch
    || folder?.candidateRoster?.length
    || folder?.raceAssets?.length
  );
}

export function needsLiveTimingSelection(folder) {
  return folder?.eventMatch?.liveTimingSelection?.status === "needs_admin_selection";
}

export function serializeLiveTimingMatch(match) {
  return {
    raceId: match.race?.raceId || match.raceId,
    name: match.race?.name || match.name,
    gender: match.race?.gender || match.gender,
    type: match.race?.type || match.type,
    resort: match.race?.resort || match.resort,
    date: match.race?.date || match.date,
    confidence: match.confidence,
    sourceUrl: match.race?.sourceUrl || match.sourceUrl
  };
}

function liveTimingPatch(folder, correlation) {
  const serializedCandidates = (correlation.liveTimingCandidates || []).map(serializeLiveTimingMatch);
  const selection = correlation.selection || {};
  return {
    candidateRoster: correlation.candidateRoster,
    raceAssets: correlation.assets,
    eventMatch: {
      ...(folder.eventMatch || {}),
      liveTimingMatch: correlation.liveTimingMatches[0] ? serializeLiveTimingMatch(correlation.liveTimingMatches[0]) : null,
      liveTimingMatches: correlation.liveTimingMatches.map(serializeLiveTimingMatch),
      liveTimingCandidates: serializedCandidates,
      liveTimingCorrelation: {
        method: "daily_archive_folder_score_v1",
        query: correlation.query,
        matchedAt: new Date().toISOString(),
        matchCount: correlation.liveTimingMatches.length,
        candidateCount: serializedCandidates.length,
        selectionStatus: selection.status || "",
        selectionReason: selection.reason || ""
      },
      liveTimingSelection: {
        status: selection.status || "",
        reason: selection.reason || "",
        candidates: serializedCandidates
      },
      sources: [...new Set([...(folder.eventMatch?.sources || []), correlation.search?.sourceUrl].filter(Boolean))]
    }
  };
}

function liveTimingMessage(correlation) {
  if (correlation.selection?.status === "needs_admin_selection") {
    return `Needs admin selection: ${correlation.liveTimingCandidates.length} Live-Timing candidate races`;
  }
  return `Matched ${correlation.liveTimingMatches.length} Live-Timing race${correlation.liveTimingMatches.length === 1 ? "" : "s"}`;
}

function liveTimingSearchFromFolder(folder) {
  const asset = (folder.raceAssets || []).find((item) => item.type === "live_timing_search");
  return {
    sourceUrl: asset?.sourceUrl || "",
    rawPath: asset?.localPath || "",
    assets: []
  };
}

async function lookupSharePointRootUrl(config, store, folder) {
  if (config.sharepointRootUrl && !config.sharepointRootUrl.includes("<tenant>")) {
    return config.sharepointRootUrl;
  }
  const state = await store.read();
  const teamId = folder.teamId || state.teams[0]?.id;
  const team = state.teams.find((t) => t.id === teamId);
  if (team?.sharepointRootUrl) return team.sharepointRootUrl;
  return config.sharepointRootUrl;
}
