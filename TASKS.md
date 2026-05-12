# Ski Video Companion Tasks

## Current Focus

- Verify the completed Jan 9 Northstar Day 1 processing run using local metadata only.
- Improve the web app UI for searching and finding athletes inside the Jan 9 event.
- Avoid downloading additional media while internet is slow; prefer local index, cached transcripts, cached videos, and code changes.

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

## In Progress

- Commit the Jan 9 UI/search/backend milestone.

## Next

- Start Jan 10 from scratch only after the Jan 9 UI/search workflow is usable.
- Add richer review workflows for low-confidence or unlabeled videos.
