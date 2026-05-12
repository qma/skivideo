import { nowIso, stableId } from "../lib/ids.mjs";
import { cacheTranscript, mirrorVideo, extractAudio } from "../adapters/media.mjs";
import { transcribeAudio } from "../adapters/transcription.mjs";
import { labelVideoAthletes } from "./labeler.mjs";

export async function processFolder(config, store, folderId, options = {}) {
  const requestedParallel = Number(options.parallel || 1);
  const parallel = Number.isFinite(requestedParallel) ? Math.max(1, Math.min(16, Math.floor(requestedParallel))) : 1;
  const startedAt = nowIso();
  const jobId = stableId("job", `${folderId}:${startedAt}`);
  await store.addJob({
    id: jobId,
    type: "process_folder",
    folderId,
    status: "running",
    startedAt,
    updatedAt: startedAt,
    parallel,
    message: `Processing started with ${parallel} worker${parallel === 1 ? "" : "s"}`
  });

  const state = await store.read();
  const folder = state.folders.find((item) => item.id === folderId);
  if (!folder) throw new Error(`Folder not found: ${folderId}`);
  const videos = state.videos.filter((video) => video.folderId === folderId);
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

  async function processNext() {
    const video = videos[cursor];
    cursor += 1;
    if (!video) return;
    try {
      const processed = await processVideo(config, video, folder);
      await enqueueWrite(() => store.updateVideo(video.id, processed));
      if (processed.processing.status === "indexed") indexed += 1;
      else needsReview += 1;
    } catch (error) {
      failed += 1;
      await enqueueWrite(() => store.updateVideo(video.id, {
        processing: {
          status: "failed",
          errors: [error.message],
          processedAt: nowIso()
        }
      }));
    }
    await enqueueWrite(() => store.updateJob(jobId, {
      message: `Processed ${indexed + needsReview + failed}/${videos.length}`,
      indexed,
      needsReview,
      failed,
      parallel
    }));
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

export async function processVideo(config, video, folder) {
  const next = structuredClone(video);
  const errors = [];

  if (next.transcript?.source === "microsoft_transcript" && !next.transcript.text) {
    try {
      next.transcript = await cacheTranscript(next, config);
    } catch (error) {
      errors.push(`Transcript cache failed: ${error.message}`);
    }
  }

  if (!next.transcript?.text && next.localAudioPath) {
    next.transcript = await transcribeAudio(config, next.localAudioPath);
  }

  if (!next.transcript?.text && next.downloadUrl) {
    try {
      next.localVideoPath = await mirrorVideo(next, folder, config);
      next.localAudioPath = await extractAudio(next.localVideoPath, config);
      next.transcript = await transcribeAudio(config, next.localAudioPath);
    } catch (error) {
      errors.push(`Media transcription failed: ${error.message}`);
    }
  }

  next.athleteLabels = await labelVideoAthletes(config, next, folder);
  if (next.transcript) {
    next.transcriptRef = {
      source: next.transcript.source,
      localPath: next.transcript.localPath || "",
      model: next.transcript.model || "",
      textLength: String(next.transcript.text || "").length,
      segmentCount: Array.isArray(next.transcript.segments) ? next.transcript.segments.length : 0
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
