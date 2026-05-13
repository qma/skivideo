import { buildRestFolderManifest } from "../adapters/sharepointRest.mjs";
import { ensureFolderManifest, ensureLiveTimingCorrelation } from "./eventDependencies.mjs";
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

  const manifest = await ensureFolderManifest(config, store, folderId);
  const state = await store.read();
  const folder = state.folders.find((item) => item.id === folderId);
  if (!folder) throw new Error(`Folder not found: ${folderId}`);

  const correlation = await ensureLiveTimingCorrelation(config, store, folderId);
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
