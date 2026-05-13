import { buildRestFolderManifest } from "../adapters/sharepointRest.mjs";
import { correlateFolderWithLiveTiming } from "../adapters/events.mjs";
import { relabelFolder } from "./processFolder.mjs";

export async function prepareEventFolder(config, store, input = {}) {
  let folderId = input.folderId || "";
  let manifestSummary = null;

  if (input.serverRelativeUrl) {
    const manifest = await buildRestFolderManifest(config, input.serverRelativeUrl);
    await store.upsertFolders(manifest.folders || []);
    await store.upsertVideos(manifest.videos || []);
    folderId = manifest.folders?.[0]?.id || folderId;
    manifestSummary = {
      folder: manifest.folders?.[0] || null,
      videos: manifest.videos?.length || 0
    };
  }

  if (!folderId) throw new Error("prepareEventFolder requires folderId or serverRelativeUrl.");

  const state = await store.read();
  const folder = state.folders.find((item) => item.id === folderId);
  if (!folder) throw new Error(`Folder not found: ${folderId}`);

  const correlation = await correlateFolderWithLiveTiming(config, folder);
  await store.updateFolder(folderId, {
    candidateRoster: correlation.candidateRoster,
    raceAssets: correlation.assets,
    eventMatch: {
      ...(folder.eventMatch || {}),
      liveTimingMatch: correlation.liveTimingMatches[0] ? serializeLiveTimingMatch(correlation.liveTimingMatches[0]) : null,
      liveTimingMatches: correlation.liveTimingMatches.map(serializeLiveTimingMatch),
      liveTimingCorrelation: {
        method: "daily_archive_folder_score_v1",
        query: correlation.query,
        matchedAt: new Date().toISOString(),
        matchCount: correlation.liveTimingMatches.length
      },
      sources: [...new Set([...(folder.eventMatch?.sources || []), correlation.search.sourceUrl])]
    }
  });

  const relabel = await relabelFolder(config, store, folderId);

  return {
    ok: true,
    folderId,
    manifest: manifestSummary,
    query: correlation.query,
    races: correlation.liveTimingMatches.map(serializeLiveTimingMatch),
    candidateRoster: correlation.candidateRoster.length,
    tptRoster: correlation.candidateRoster.filter((racer) => /^(TPT|TPTA)$/i.test(racer.team || "")).length,
    assets: correlation.assets.length,
    relabel
  };
}

function serializeLiveTimingMatch(match) {
  return {
    raceId: match.race.raceId,
    name: match.race.name,
    gender: match.race.gender,
    type: match.race.type,
    resort: match.race.resort,
    date: match.race.date,
    confidence: match.confidence,
    sourceUrl: match.race.sourceUrl
  };
}
