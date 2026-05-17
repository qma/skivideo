import { nowIso, stableId } from "../lib/ids.mjs";
import { ensureFolderManifest, ensureLiveTimingCorrelation, needsLiveTimingSelection } from "./eventDependencies.mjs";
import { cacheTranscript, mirrorVideo, extractAudio } from "../adapters/media.mjs";
import { transcribeAudio } from "../adapters/transcription.mjs";
import { labelVideoAthletes } from "./labeler.mjs";
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
  folder = state.folders.find((item) => item.id === folderId);
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

export async function relabelFolder(config, store, folderId) {
  const state = await store.read();
  const folder = state.folders.find((item) => item.id === folderId);
  if (!folder) throw new Error(`Folder not found: ${folderId}`);
  const videos = state.videos.filter((video) => video.folderId === folderId);
  let indexed = 0;
  let needsReview = 0;
  for (const video of videos) {
    const athleteLabels = await labelVideoAthletes(config, video, folder);
    const bestConfidence = Math.max(0, ...athleteLabels.map((label) => Number(label.confidence) || 0));
    const processing = {
      ...(video.processing || {}),
      status: bestConfidence >= 0.65 ? "indexed" : "needs_review",
      relabeledAt: nowIso()
    };
    await store.updateVideo(video.id, { athleteLabels, processing });
    if (processing.status === "indexed") indexed += 1;
    else needsReview += 1;
  }
  return { folderId, videos: videos.length, indexed, needsReview };
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

  next.athleteLabels = await labelVideoAthletes(config, next, folder);
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
