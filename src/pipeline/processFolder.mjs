import { nowIso, stableId } from "../lib/ids.mjs";
import { normalizeText } from "../lib/text.mjs";
import { ensureFolderManifest, ensureLiveTimingCorrelation, needsLiveTimingSelection } from "./eventDependencies.mjs";
import { cacheTranscript, mirrorVideo, extractAudio } from "../adapters/media.mjs";
import { transcribeAudio } from "../adapters/transcription.mjs";
import { labelVideoAthletesWithDebug } from "./labeler.mjs";
import { buildTranscriptionPrompt, shouldUseTranscriptionPrompt } from "./transcriptionPrompt.mjs";

export async function processFolder(config, store, folderId, options = {}) {
  const requestedParallel = Number(options.parallel || 1);
  const parallel = Number.isFinite(requestedParallel) ? Math.max(1, Math.min(16, Math.floor(requestedParallel))) : 1;
  const startedAt = nowIso();
  const jobId = stableId("job", `${folderId}:${startedAt}`);
  const jobType = options.reprocess ? "reprocess_folder" : "process_folder";
  const actionLabel = options.reprocess ? "Re-processing" : "Processing";
  await store.addJob({
    id: jobId,
    type: jobType,
    folderId,
    status: "running",
    startedAt,
    updatedAt: startedAt,
    parallel,
    message: `${actionLabel} started with ${parallel} worker${parallel === 1 ? "" : "s"}`
  });

  let state = await store.read();
  let folder = state.folders.find((item) => item.id === folderId);
  if (!folder) throw new Error(`Folder not found: ${folderId}`);
  await store.updateJob(jobId, {
    message: "Ensuring SharePoint manifest dependency",
    parallel
  });
  const manifest = await ensureFolderManifest(config, store, folderId);
  if (manifest.imported) {
    await store.updateJob(jobId, {
      message: `${manifest.message}; ensuring Live-Timing dependency`,
      parallel
    });
  }
  const liveTiming = await ensureLiveTimingCorrelation(config, store, folderId);

  // Check if admin selection is required before proceeding to media processing
  state = await store.read();
  folder = state.folders.find((item) => item.id === folderId);
  if (needsLiveTimingSelection(folder)) {
    await store.updateJob(jobId, {
      status: "completed_with_errors",
      message: "Live-Timing candidate races require admin confirmation before media processing.",
      completedAt: nowIso(),
      indexed: 0,
      needsReview: 0,
      failed: 0,
      parallel
    });
    return { jobId, indexed: 0, needsReview: 0, failed: 0, parallel, videos: 0, needsLiveTimingSelection: true };
  }

  if (!liveTiming.skipped) {
    await store.updateJob(jobId, {
      message: `${liveTiming.message}; starting media processing`,
      parallel
    });
  } else {
    await store.updateJob(jobId, {
      message: "Dependencies ready; starting media processing",
      parallel
    });
  }

  state = await store.read();
  folder = withFallbackRoster(state, state.folders.find((item) => item.id === folderId));
  let videos = state.videos.filter((video) => video.folderId === folderId);
  if (!videos.length) {
    await store.updateJob(jobId, {
      status: "completed_with_errors",
      message: "No videos found for this folder. Import the SharePoint folder manifest or choose a folder that contains video files.",
      completedAt: nowIso(),
      indexed: 0,
      needsReview: 0,
      failed: 0,
      parallel
    });
    return { jobId, indexed: 0, needsReview: 0, failed: 0, parallel, videos: 0 };
  }
  let indexed = 0;
  let needsReview = 0;
  let failed = 0;
  let cursor = 0;
  let writeQueue = Promise.resolve();

  const enqueueWrite = (fn) => {
    const next = writeQueue.then(fn, fn);
    writeQueue = next.catch(() => {});
    return next;
  };

  const rootUrl = await lookupSharePointRootUrl(config, store, folder);

  async function processNext() {
    const video = videos[cursor];
    cursor += 1;
    if (!video) return;
    try {
      const processed = await processVideo(config, video, folder, options, rootUrl);
      await enqueueWrite(() => store.updateVideo(video.id, processed));
      if (processed.processing.status === "indexed") indexed += 1;
      else needsReview += 1;
      await enqueueWrite(() => store.updateJob(jobId, {
        message: `Processed ${indexed + needsReview + failed}/${videos.length}`,
        details: "",
        indexed,
        needsReview,
        failed,
        parallel
      }));
    } catch (error) {
      failed += 1;
      await enqueueWrite(() => store.updateVideo(video.id, {
        processing: {
          status: "failed",
          errors: [error.message],
          processedAt: nowIso()
        }
      }));
      await enqueueWrite(() => store.updateJob(jobId, {
        message: `Failed: ${video.filename}`,
        details: error.message,
        indexed,
        needsReview,
        failed,
        parallel
      }));
    }
    return processNext();
  }

  await Promise.all(Array.from({ length: Math.min(parallel, videos.length) }, () => processNext()));
  await writeQueue;

  await store.updateJob(jobId, {
    status: failed ? "completed_with_errors" : "completed",
    message: `Done: ${indexed} indexed, ${needsReview} review, ${failed} failed`,
    completedAt: nowIso(),
    indexed,
    needsReview,
    failed,
    parallel
  });
  return { jobId, indexed, needsReview, failed, parallel };
}

export async function relabelFolder(config, store, folderId, options = {}) {
  const startedAt = nowIso();
  const jobId = options.jobId || stableId("job", `relabel:${folderId}:${startedAt}`);
  if (!options.jobId) {
    await store.addJob({
      id: jobId,
      type: "relabel_folder",
      folderId,
      status: "running",
      startedAt,
      updatedAt: startedAt,
      parallel: 1,
      message: "Relabeling started"
    });
  }

  try {
    let state = await store.read();
    const folder = withFallbackRoster(state, state.folders.find((item) => item.id === folderId));
    if (!folder) throw new Error(`Folder not found: ${folderId}`);
    const videos = state.videos.filter((video) => video.folderId === folderId);
    let indexed = 0;
    let needsReview = 0;

    for (let i = 0; i < videos.length; i++) {
      const video = videos[i];
      const { labels: athleteLabels, debug: labelDebug } = await labelVideoAthletesWithDebug(config, video, folder);
      const bestConfidence = Math.max(0, ...athleteLabels.map((label) => Number(label.confidence) || 0));
      const processing = {
        ...(video.processing || {}),
        status: bestConfidence >= 0.65 ? "indexed" : "needs_review",
        relabeledAt: nowIso()
      };
      await store.updateVideo(video.id, { athleteLabels, labelDebug, processing });
      if (processing.status === "indexed") indexed += 1;
      else needsReview += 1;

      if ((i + 1) % 10 === 0 || i === videos.length - 1) {
        await store.updateJob(jobId, {
          message: `Relabeled ${i + 1}/${videos.length}`,
          indexed,
          needsReview,
          updatedAt: nowIso()
        });
      }
    }

    const message = `Done: ${indexed} indexed, ${needsReview} review`;
    await store.updateJob(jobId, {
      status: "completed",
      message,
      completedAt: nowIso(),
      indexed,
      needsReview
    });
    return { folderId, videos: videos.length, indexed, needsReview, message };
  } catch (error) {
    await store.updateJob(jobId, {
      status: "failed",
      message: `Relabel failed: ${error.message}`,
      details: error.stack,
      completedAt: nowIso()
    });
    throw error;
  }
}

export async function processVideo(config, video, folder, options = {}, rootUrl = config.sharepointRootUrl) {
  const next = structuredClone(video);
  const errors = [];
  const forceTranscribe = Boolean(options.forceTranscribe);
  const allowDownload = options.noDownload !== true;
  let transcribedThisRun = false;
  const promptInfo = shouldUseTranscriptionPrompt(config, options)
    ? buildTranscriptionPrompt(config, folder, options)
    : null;
  const transcriptionOptions = {
    whisperCppNoGpu: options.whisperCppNoGpu
  };
  if (promptInfo) {
    Object.assign(transcriptionOptions, {
      prompt: promptInfo.prompt,
      promptHash: promptInfo.hash,
      promptNameCount: promptInfo.nameCount,
      promptPhraseVersion: promptInfo.phraseVersion,
      carryInitialPrompt: options.carryInitialPrompt !== false
    });
  }

  if (!forceTranscribe && next.transcript?.source === "microsoft_transcript" && !next.transcript.text) {
    try {
      next.transcript = await cacheTranscript(next, config, rootUrl);
    } catch (error) {
      errors.push(`Transcript cache failed: ${error.message}`);
    }
  }

  if ((forceTranscribe || !next.transcript?.text) && next.localAudioPath) {
    next.transcript = await transcribeAudio(config, next.localAudioPath, transcriptionOptions);
    transcribedThisRun = true;
  }

  if (((forceTranscribe && !transcribedThisRun) || !next.transcript?.text) && next.localVideoPath) {
    try {
      next.localAudioPath = await extractAudio(next.localVideoPath, config);
      next.transcript = await transcribeAudio(config, next.localAudioPath, transcriptionOptions);
      transcribedThisRun = true;
    } catch (error) {
      errors.push(`Media transcription failed: ${error.message}`);
    }
  }

  if (((forceTranscribe && !transcribedThisRun) || !next.transcript?.text) && !next.localVideoPath && next.downloadUrl) {
    if (allowDownload) {
      try {
        next.localVideoPath = await mirrorVideo(next, folder, config, rootUrl);
        next.localAudioPath = await extractAudio(next.localVideoPath, config);
        next.transcript = await transcribeAudio(config, next.localAudioPath, transcriptionOptions);
        transcribedThisRun = true;
      } catch (error) {
        errors.push(`Media transcription failed: ${error.message}`);
      }
    } else {
      errors.push("Media transcription skipped: local audio/video unavailable and downloads disabled.");
    }
  }

  const { labels: athleteLabels, debug: labelDebug } = await labelVideoAthletesWithDebug(config, next, folder);
  next.athleteLabels = athleteLabels;
  next.labelDebug = labelDebug;
  if (next.transcript) {
    next.transcriptRef = {
      source: next.transcript.source,
      localPath: next.transcript.localPath || "",
      model: next.transcript.model || "",
      acceleration: next.transcript.acceleration || null,
      textLength: String(next.transcript.text || "").length,
      segmentCount: Array.isArray(next.transcript.segments) ? next.transcript.segments.length : 0,
      prompt: next.transcript.prompt ? {
        hash: next.transcript.prompt.hash,
        nameCount: next.transcript.prompt.nameCount,
        phraseVersion: next.transcript.prompt.phraseVersion,
        carryInitialPrompt: next.transcript.prompt.carryInitialPrompt
      } : null
    };
  }
  const bestConfidence = Math.max(0, ...next.athleteLabels.map((label) => Number(label.confidence) || 0));
  next.processing = {
    status: bestConfidence >= 0.65 ? "indexed" : "needs_review",
    errors,
    processedAt: nowIso()
  };
  return next;
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

function withFallbackRoster(state, folder) {
  if (!folder || folder.candidateRoster?.length) return folder;
  const teamId = folder.teamId || state.teams?.[0]?.id || "";
  const roster = buildKnownTeamRoster(state, teamId);
  if (!roster.length) return folder;
  return {
    ...folder,
    candidateRoster: roster,
    candidateRosterSource: "known_team_roster_fallback"
  };
}

function buildKnownTeamRoster(state, teamId) {
  const byName = new Map();
  for (const folder of state.folders || []) {
    if (teamId && folder.teamId && folder.teamId !== teamId) continue;
    for (const racer of folder.candidateRoster || []) {
      if (!isKnownTeamRacer(racer)) continue;
      const key = normalizeText(racer.name);
      if (!key || byName.has(key)) continue;
      byName.set(key, {
        ...racer,
        source: racer.source || "known_team_roster_fallback"
      });
    }
  }
  return [...byName.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function isKnownTeamRacer(racer) {
  const team = String(racer.team || "").trim();
  const club = String(racer.club || "").trim();
  return [team, club].some((value) => /^(TPT|TPTA|PT)$/i.test(value) || /Team Palis/i.test(value));
}
