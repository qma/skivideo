# Ski Video Companion Tasks

## Current Focus

- Handover completed. Researching next steps for the local-first web app and indexing pipeline.

## Completed

- Design doc and implementation plan created.
- Local Node web app and CLI scaffolded.
- Express added as the backend framework for API routes, static hosting, JSON parsing, 404s, error handling, and media range streaming.
- Raw Node `http` server replaced with Express, keeping the same API surface and `/media/:videoId` range playback endpoint.
- SharePoint REST shared-link folder listing works against the real Team Palisades link.
- MLX Whisper local transcription path installed and validated on Apple Silicon outside the sandbox.
- Jan 9 Northstar Day 1 folder ingested from SharePoint with 117 videos.
- Live-Timing daily archive flow found Jan 9 Northstar race IDs `297661` men and `297652` women.
- Live-Timing AJAX race data parser imported 160 candidate racers, including 74 TPT/TPTA racers.
- Full transcripts are stored separately from athlete labels through `transcriptRef`.
- Fuzzy roster matching added for noisy/phonetic transcript observations.
- Camera filename false-bib matching fixed for names like `P1000251.MP4`.
- `--parallel n` added to folder processing workflow with serialized metadata writes.
- Work started on event-detail UI with embedded local video player thumbnails and Firestore metadata sync.
- Jan 9 full folder processing completed with `--parallel 4`: 117 videos, 75 initially indexed, 42 review, 0 failed.
- Ambiguous one-word fuzzy roster matches now get lower confidence and stay in review.
- Jan 9 relabel pass completed locally from cached transcripts: 35 indexed, 82 review, 0 failed.
- Event-detail UI now has event-local search, status filter, confidence filter, Live-Timing assets, SharePoint links, and local embedded video players.
- Empty global search now stays quiet instead of rendering every video.
- Optional Firebase/Firestore metadata sync added behind `METADATA_BACKEND=firebase`.
- Lean metadata export refreshed after Jan 9 relabel pass.
- Browser validation passed for Jan 9 event view and event-local `Vivian` search.
- Jan 9 UI/search/backend milestone committed as `c64a945`.
- Event table `Preview` playback verified against local cached media: Jan 9 renders 117 video controls, each using `/media/<videoId>`, and the media endpoint supports byte-range `video/mp4` responses.
- Jan 10 Live-Timing correlation ran through project code, not manual static edits: folder `GS Race Jan 10. Northstar Day 2` matched race `297816` men and `297821` women, with 178 racers and 40 TPT/TPTA racers.
- Jan 10 SharePoint manifest ingested without media downloads: 130 videos.
- Jan 10 local metadata-only relabel pass indexed 7 filename-hinted videos from the Live-Timing roster.
- Live-Timing correlation is now codified as a repeatable project workflow/API: `prepare-folder`, `prepare-folder-rest`, and `/api/prepare-folder` run SharePoint manifest ingestion when needed, Live-Timing race matching, roster/asset parsing, metadata storage, and metadata-only relabeling.
- Event table review workflow added for low-confidence/unlabeled videos: manual athlete labels and clear-labels actions save through `/api/review-video` without downloading media.
- Jan 10 event view verified in low-data mode: 130 SharePoint-only videos render in the event table with Live-Timing assets, roster-backed labels, and manual review controls.
- Web app loading changed to lazy metadata endpoints: startup uses compact `/api/summary`, event view uses `/api/event?folderId=...`, and search uses `/api/search` so the browser does not load every video/transcript record at once.
- whisper.cpp fallback added and validated with `ggml-base.en.bin` because MLX Whisper is installed but cannot access Metal from this runner.
- Jan 10 Northstar Day 2 full processing completed with `--parallel 4`: 130 videos mirrored, 130 videos processed, 45 indexed, 85 review, 0 failed. 118 videos have non-empty whisper.cpp transcripts.
- Lean metadata export refreshed after Jan 10 processing.
- Web app server restarted and verified in the in-app browser at `http://127.0.0.1:4173/`, bound internally to `0.0.0.0:4173`.
- Current index has no Jan 8 event folder. Northstar race folders in the index are Jan 9, Jan 10, and Jan 11; Jan 9 and Jan 10 have processed video rows.
- Browser validation passed for Jan 10 event view and event-local `Hannah Davidson` search after full processing.
- Event list changed to compact chronological layout with color-coded status badges and per-event local media/transcript/index counts.
- Browser validation passed for chronological compact event list; Dec 30 through Jan 11 rows render in date order, and Jan 9/Jan 10 show `Processed + review`.
- Video playback links now point at app `/media/:videoId` routes instead of raw SharePoint tenant file URLs, avoiding login prompts caused by direct site-relative SharePoint links.
- `/media/:videoId` serves cached local media. Non-local playback links use direct SharePoint source URLs so the app server does not proxy video bytes.
- Browser validation passed for global search playback links: `Chloe Fang` results now use `/media/<videoId>` app playback URLs instead of raw SharePoint URLs.
- Event action buttons now have mouse-over tooltips explaining `View`, `Prepare`, `Process`, and `Live`.
- Web UI `Process` now starts a background processing job with `parallel: 4` by default.
- The Jobs panel now refreshes while jobs are running, giving live progress from the existing job records instead of blocking on one long request.
- Browser validation passed for event action tooltips on the compact chronological event list.
- Diagnosed the Jan 10 Northstar Top click: the browser route did start a `parallel: 4` job, but the folder had zero local video records, so processing completed immediately with no media work.
- `process-folder` now imports the SharePoint folder manifest automatically when a folder has zero local video records, then continues into media download/transcription/indexing.
- Event list actions are normal links with `?action=...&folderId=...`, then the app executes the action on load and clears the URL. This avoids click-handler reliability issues in browser validation.
- Jan 10 Northstar Top processing completed through the web processing endpoint: 99 processed, 16 indexed, 83 review, 0 failed, 75 local videos/transcripts.
- Event action order changed to `View`, `Live`, `Prepare`, `Process`.
- `View` now imports the SharePoint video list if the event has no local video records, then opens the event table.
- `Prepare` now ensures the SharePoint video list and Live-Timing correlation before metadata-only relabeling.
- `Process` now ensures SharePoint manifest and Live-Timing dependencies before media download/transcription/indexing.
- Browser validation passed for link-based `View`: Jan 11 opened through `?action=view&folderId=...`, imported 135 SharePoint video records, rendered the event view, and cleared the URL.
- Browser validation passed for link-based `Process`: Jan 11 started `job_06e67edd6e79c2cf` with `parallel: 4` and showed the running job in the Jobs panel.
- Jan 11 Northstar Day 3 processing completed through the browser-triggered process workflow: 135 processed, 34 indexed, 101 review, 0 failed, 135 local videos/transcripts.
- Job records now preserve message history in `logs` as jobs update.
- Added `/api/job?id=...` for inspecting a single job with full log entries.
- Jobs panel now styles running/completed/error/stale jobs distinctly and includes an Inspect link for each job.
- Job inspect view refreshes while the inspected job is still running and remains available after completion.
- Browser validation passed for the Jobs panel Inspect link. Job `job_c71e982689f85184` shows start, progress entries such as `Processed 132/135`, and completion.
- Cached browser-triggered reprocess generated a new full job log with 38 entries.
- Added opt-in event-aware transcription prompts for Whisper via `TRANSCRIPTION_PROMPT=1` or CLI `--transcription-prompt`.
- Prompt context includes ski-race phrases such as `run two`, venue/discipline/date, TPT/TPTA terms, and prioritized Live-Timing roster names.
- Prompt metadata is stored in transcript records and compact `transcriptRef` metadata.
- Added CLI `--transcription-prompt-max-names n` to tune roster prompt size.
- Jan 9 baseline before prompting: 35 indexed, 82 review, 116 transcripts, 25 `run two` mentions, 12 `run to` mentions.
- Jan 9 first prompted run with 80 names: 39 indexed, 78 review, but phrase output regressed with only 2 `run two` mentions and prompt-induced artifacts such as `Rantu`.
- Jan 9 second prompted run with 20 names: 41 indexed, 76 review, 0 failed, 117 prompted transcripts, 48 `run two` mentions, 0 `run to` mentions.
- Triggered `GS Camp April 24` from the web app. Job `job_ce1f0330819e3444` correctly matched 0 Live-Timing races and continued into media processing.
- `GS Camp April 24` web-triggered processing completed: 13 videos, 13 local media/transcripts, 0 indexed, 13 review, 0 failed. Browser list shows `Processed + review`.
- whisper.cpp transcription now omits `-ng` by default so Metal/GPU can be used when available.
- Added explicit CPU-only controls: `WHISPER_CPP_NO_GPU=1`, CLI `--whisper-cpp-no-gpu`/`--no-whisper-gpu`, and API `whisperCppNoGpu: true`.
- whisper.cpp transcript metadata now records whether GPU acceleration was enabled for that run.
- GS Camp April 25 web-triggered processing completed: 19 videos, 19 local media/transcripts, 0 indexed, 19 review, 0 failed.
- Fixed concurrent `store.json` read/write failures by writing JSON atomically through temp-file rename, retrying transient JSON reads, and serializing store mutation methods.
- Web app restarted after the GS Camp April 25 job completed; browser reload confirmed the app renders without the JSON parse error.
- Event preview videos are larger and audible by default. Local previews use `/media/:videoId`; non-local previews use the direct SharePoint source URL.
- Browser validation passed for Apr 25 local previews and Dec 30 mixed local/source fallback previews.
- Added `Re-Process` event action with confirmation. It starts a `reprocess_folder` job with `forceTranscribe`, `noDownload`, and default parallel 4.
- Added CLI `process-folder --reprocess`, which implies `--force-transcribe --no-download`, plus explicit `--no-download`/`--local-only`.
- Reprocess workflow retranscribes from existing local audio/video and relabels; videos without local media are skipped without triggering SharePoint downloads.
- Browser validation confirmed the `Re-Process` action is visible. Backend validation passed with a sample no-download `reprocess_folder` job: 2 indexed, 0 review, 0 failed.
- GS Dec 30, 2025 processing completed: 56 videos, 0 indexed, 56 review, 0 failed.
- Fixed broken playback links caused by macOS dataless local media placeholders. The media route now treats dataless local files as unavailable, and the app links non-local rows directly to SharePoint.
- Local media stats now count only readable local files, and event preview titles distinguish playable local media from source fallback.
- Added `audit-media-links` CLI command. Current audit: 759 checked, 759 OK, 0 broken; 478 readable local, 254 dataless local, and non-local rows use direct SharePoint source fallback.
- Verified the reported `P1000316.MP4` / `GS Race Jan 10. Northstar Day 2` app link now responds through `/media/video_2c543fe6e63efbef` with `content-type: video/mp4`.
- Hardened cache download writes: downloads now stream to a hidden temp file, validate non-empty/readable/non-dataless content and `content-length` when present, then atomically rename into the cache path.
- `mirrorVideo` and `extractAudio` now re-create dataless or unreadable cached files instead of trusting an existing path.
- Download validation test passed: a successful local test download was promoted, while a short/incomplete response left no target file and no temp file.
- "Delete Folder" capability added to the web UI and backend for data management.
- "Search Athletes" results enhanced with video previews, event dates, and larger transcript snippets.
- Bulk review actions added to the event table ("Mark all as Indexed", "Clear all labels").
- Optimized `/media/:videoId` to avoid proxying SharePoint videos; non-local rows use direct SharePoint source URLs and `/media/:videoId` redirects only as a fallback.
- [codex] Cleaned up the old SharePoint proxy server code path and documentation. Verified local media returns `200 video/mp4` from `/media`, dataless/non-local `/media` returns `302` to SharePoint, and search API marks `P1000316.MP4` as `localVideoPlayable: false` so the UI uses its direct SharePoint source URL.
- Project instructions added to `GEMINI.md` (e.g., commit message prefixing).

## In Progress
- Investigating potential UI improvements and data integrity checks.

## Next

- Add mobile-friendly responsive refinements to the event table.
- Implement visual similarity propagation schema and basic UI placeholders.
