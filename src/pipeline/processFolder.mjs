import { nowIso, stableId } from "../lib/ids.mjs";
import { cacheTranscript, mirrorVideo, extractAudio } from "../adapters/media.mjs";
import { transcribeAudio } from "../adapters/transcription.mjs";
import { labelVideoAthletes } from "./labeler.mjs";

export async function processFolder(config, store, folderId) {
  const startedAt = nowIso();
  const jobId = stableId("job", `${folderId}:${startedAt}`);
  await store.addJob({
    id: jobId,
    type: "process_folder",
    folderId,
    status: "running",
    startedAt,
    updatedAt: startedAt,
    message: "Processing started"
  });

  const state = await store.read();
  const folder = state.folders.find((item) => item.id === folderId);
  if (!folder) throw new Error(`Folder not found: ${folderId}`);
  const videos = state.videos.filter((video) => video.folderId === folderId);
  let indexed = 0;
  let needsReview = 0;
  let failed = 0;

  for (const video of videos) {
    try {
      const processed = await processVideo(config, video, folder);
      await store.updateVideo(video.id, processed);
      if (processed.processing.status === "indexed") indexed += 1;
      else needsReview += 1;
    } catch (error) {
      failed += 1;
      await store.updateVideo(video.id, {
        processing: {
          status: "failed",
          errors: [error.message],
          processedAt: nowIso()
        }
      });
    }
    await store.updateJob(jobId, {
      message: `Processed ${indexed + needsReview + failed}/${videos.length}`,
      indexed,
      needsReview,
      failed
    });
  }

  await store.updateJob(jobId, {
    status: failed ? "completed_with_errors" : "completed",
    message: `Done: ${indexed} indexed, ${needsReview} review, ${failed} failed`,
    completedAt: nowIso(),
    indexed,
    needsReview,
    failed
  });
  return { jobId, indexed, needsReview, failed };
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
  const bestConfidence = Math.max(0, ...next.athleteLabels.map((label) => Number(label.confidence) || 0));
  next.processing = {
    status: bestConfidence >= 0.65 ? "indexed" : "needs_review",
    errors,
    processedAt: nowIso()
  };
  return next;
}
