# Ski Video Companion Tasks

## Current Focus

- Execute queued tasks to completion, using this file as the resumable work ledger.
- Low-data mode is lifted; resume full media mirroring/transcription/indexing where needed.
- Fully process Jan 10 Northstar Day 2 now that downloads are allowed, then relabel/export/verify the searchable UI.

## Completed

- Design doc and implementation plan created.
- Local Node web app and CLI scaffolded.
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

## In Progress

- Full Jan 10 media processing from the existing prepared folder.

## Next

- After Jan 10 processing completes, refresh the lean export, verify event search/browser behavior, and commit the finished checkpoint.
