import { buildRestFolderManifest } from "../adapters/sharepointRest.mjs";
import { ensureFolderManifest, ensureLiveTimingCorrelation, needsLiveTimingSelection } from "./eventDependencies.mjs";
import { relabelFolder } from "./processFolder.mjs";

export async function prepareEventFolder(config, store, input = {}) {
  let folderId = input.folderId || "";
  let manifestSummary = null;

  if (input.serverRelativeUrl) {
    const rootUrl = await lookupSharePointRootUrl(config, store, input);
    const manifest = await buildRestFolderManifest(config, input.serverRelativeUrl, rootUrl);
    await store.upsertFolders(manifest.folders || []);
    await store.upsertVideos(manifest.videos || []);
    folderId = manifest.folders?.[0]?.id || folderId;
    manifestSummary = {
      folder: manifest.folders?.[0] || null,
      videos: manifest.videos?.length || 0
    };
  }

  if (!folderId) throw new Error("prepareEventFolder requires folderId or serverRelativeUrl.");

  const manifest = await ensureFolderManifest(config, store, folderId);
  const state = await store.read();
  const folder = state.folders.find((item) => item.id === folderId);
  if (!folder) throw new Error(`Folder not found: ${folderId}`);

  const correlation = await ensureLiveTimingCorrelation(config, store, folderId);
  const afterCorrelation = await store.read();
  const correlatedFolder = afterCorrelation.folders.find((item) => item.id === folderId);
  if (needsLiveTimingSelection(correlatedFolder)) {
    return {
      ok: true,
      folderId,
      manifest: manifestSummary || manifest,
      query: correlation.query || "",
      races: correlation.races || [],
      candidates: correlation.candidates || correlatedFolder?.eventMatch?.liveTimingCandidates || [],
      selection: correlation.selection || correlatedFolder?.eventMatch?.liveTimingSelection,
      candidateRoster: 0,
      tptRoster: 0,
      assets: correlation.assets,
      liveTimingSkipped: Boolean(correlation.skipped),
      relabel: null,
      message: "Live-Timing candidate races require admin confirmation before relabeling."
    };
  }
  const relabel = await relabelFolder(config, store, folderId);

  return {
    ok: true,
    folderId,
    manifest: manifestSummary || manifest,
    query: correlation.query || "",
    races: correlation.races || [],
    candidateRoster: correlation.candidateRoster,
    tptRoster: correlation.tptRoster,
    assets: correlation.assets,
    liveTimingSkipped: Boolean(correlation.skipped),
    relabel
  };
}

async function lookupSharePointRootUrl(config, store, input) {
  if (config.sharepointRootUrl && !config.sharepointRootUrl.includes("<tenant>")) {
    return config.sharepointRootUrl;
  }
  const state = await store.read();
  const teamId = input.teamId || state.teams[0]?.id;
  const team = state.teams.find((t) => t.id === teamId);
  if (team?.sharepointRootUrl) return team.sharepointRootUrl;
  return config.sharepointRootUrl;
}
