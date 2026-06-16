# Ski Video Companion

Local-first companion app for indexing SharePoint skiing videos by athlete name, with event context from Far West U14 schedules and Live-Timing race assets.

Start here:

```sh
npm run smoke
npm start
```

Then open `http://localhost:4173`.

For backend development with automatic restart on source edits, use `npm run dev`.

The original design and execution plan lives in [docs/DESIGN_AND_IMPLEMENTATION_PLAN.md](docs/DESIGN_AND_IMPLEMENTATION_PLAN.md). The publishing, admin, auth, and multi-team roadmap lives in [docs/PUBLISHING_AND_MULTI_TEAM_ROADMAP.md](docs/PUBLISHING_AND_MULTI_TEAM_ROADMAP.md). The Phase 1 static public export and deployment guide lives in [docs/PHASE1_STATIC_PUBLIC_EXPORT.md](docs/PHASE1_STATIC_PUBLIC_EXPORT.md).

## Current Capabilities

- Dependency-light Node web app and CLI.
- Express backend for API routes, static files, JSON parsing, 404s, error handling, and media range streaming.
- Local JSON index with lean export.
- Manual/sample manifest import.
- Microsoft Graph adapter for SharePoint listing when credentials are configured.
- Far West U14 calendar fetch hook and basic parser.
- Live-Timing daily archive and race-data parsing, including men/women sibling race correlation and racer roster import.
- Event-to-folder matching heuristics.
- Transcript source normalization.
- Deterministic roster/transcript/filename athlete labeler.
- Local-only relabeling from cached transcripts for prompt/rule iteration without media downloads.
- Local transcription with whisper.cpp by default (`/opt/homebrew/bin/whisper-cli` plus the configured `data/models/ggml-<size>.bin`, `medium` by default). GPU/Metal is enabled when the installed binary supports it; set `WHISPER_CPP_NO_GPU=1` or pass `--whisper-cpp-no-gpu` to force CPU-only `-ng` mode. The backend and model are configurable through `WHISPER_BACKEND` and `WHISPER_MODEL_SIZE`.
- Apple Silicon optimized MLX Whisper is selected automatically when the `.venv` MLX runtime is importable and the configured whisper.cpp model is unavailable.
- Optional event-aware transcription prompts for Whisper. Use `TRANSCRIPTION_PROMPT=1` or CLI `--transcription-prompt` to bias decoding toward ski phrases such as `run two` and Live-Timing roster names while preserving prompt metadata on transcript refs.
- LLM athlete labeling layered on top of the deterministic labeler. When `GEMINI_API_KEY` is set, Gemini fills in or augments labels (default mode `fallback`, only when heuristics find nothing; set `LLM_LABEL_MODE=always` to call it for every video). OpenAI is a secondary fallback when only `OPENAI_API_KEY` is set. LLM output is merged with high-confidence deterministic labels, and null answers such as "No Skier Identified" are filtered out.
- LLM prompt and model settings are editable in the in-app Settings dialog (and `/api/settings`): the Gemini model, split system/user prompt templates with `{{roster}}`, `{{filename}}`, `{{transcript}}`, `{{venue}}`, `{{discipline}}`, and `{{date}}` macros, max concurrent jobs, and a unified multi-turn chat session mode that labels an event's videos sequentially in one conversation for better cross-video consistency and prompt caching. Each Gemini call records token usage, cache-hit rate, and estimated cost, inspectable per video via the Label Debug column and Inspect LLM button.
- Event detail view with status/confidence filters, event-local search, Live-Timing assets, app playback links, source SharePoint links, and embedded local video players.
- Event list actions are ordered by dependency with mouse-over tooltips: `View` ensures the SharePoint video list and opens the event table, `Live` refreshes race correlation, `Prepare` runs View/Live dependencies plus metadata relabeling, `Relabel` reruns only athlete scoring from existing transcripts/rosters/filenames, `Process` runs all dependencies before download/transcription/indexing with four workers by default, `Re-Process` confirms before forced retranscription/relabeling from local media only, and `Reset` (after confirmation) clears the event's videos, labels, transcripts, jobs, and Live-Timing metadata back to discovered state without deleting local media files on disk.
- Event review controls for roster-autocompleted golden athlete labels without media downloads. Golden labels are stored separately from model predictions and preferred for display/search.
- Lazy web loading: startup reads `/api/summary`, selected events read `/api/event?folderId=...`, and global search reads `/api/search` instead of loading the full store into the browser.
- Background processing from the web UI returns immediately and the Jobs panel refreshes while processing is running, so progress is visible without waiting on a single long HTTP response.
- Jobs are color-coded by status and each job has an Inspect link backed by `/api/job`, with persisted progress logs available during and after processing.
- Background jobs run through an in-process queue with configurable concurrency (`PROCESS_JOB_CONCURRENCY`, also editable in Settings); each job keeps its own worker parallelism (`parallel: 4` by default). Failed or errored jobs show a Rerun button backed by `/api/rerun-job-async`. Queued and interrupted-running jobs are reset and re-enqueued on server startup so in-flight work survives restarts and dev hot-reloads.
- Optional Firestore metadata sync through Firebase service-account credentials.
- App playback links in search results. Local videos use `/media/:videoId`; non-local videos link directly to the SharePoint source URL so the app server does not proxy video bytes.
- SharePoint source links and per-team SharePoint root URLs live in a `teams` collection inside the store rather than hardcoded config, so multiple teams/sources can be registered with `upsert-team`/`list-teams`.
- Static read-only Next.js public app in `apps/public-next/`, generated from an audited public export with no local media paths, download URLs, credentials, or job history.
- Live in-server public view at `/public/` rendered directly by the Express server from the audited public projection (`buildPublicLeanStore`) — no build step, always reflects current data. It is a preview of the public data shape, not yet a security boundary (see [docs/PUBLIC_VIEW_PLAN.md](docs/PUBLIC_VIEW_PLAN.md) for the planned tiered-login model).
- In-admin static preview at `/public-preview/` renders the static Next.js public UI against live local metadata once `npm run public:build` has generated it at least once.
- Forward plan for publishing the whole webapp with tiered logins (anonymous / team member / admin) and per-role data projections is documented in [docs/PUBLIC_VIEW_PLAN.md](docs/PUBLIC_VIEW_PLAN.md).

## Useful Commands

```sh
npm run cli -- sample
npm run cli -- ingest-sample
npm run cli -- fetch-events
npm run cli -- list-sharepoint
npm run cli -- list-sharepoint-rest
npm run cli -- ingest-oldest-sharepoint-folder
npm run cli -- fetch-live-timing-day <YYYY-MM-DD>
npm run cli -- fetch-live-timing-race <raceId>
npm run cli -- correlate-folder-live-timing <folderId>
npm run cli -- prepare-folder <folderId>
npm run cli -- prepare-folder-rest <serverRelativeUrl>
npm run cli -- process-folder <folderId> --parallel 4
npm run cli -- process-folder <folderId> --parallel 4 --force-transcribe --transcription-prompt
npm run cli -- process-folder <folderId> --parallel 4 --force-transcribe --transcription-prompt --transcription-prompt-max-names 20
npm run cli -- process-folder <folderId> --parallel 4 --whisper-cpp-no-gpu
npm run cli -- process-folder <folderId> --parallel 4 --reprocess
npm run cli -- relabel-folder <folderId>
npm run cli -- process-video <videoId>
npm run cli -- export-lean
npm run cli -- export-public
npm run public:export
npm run public:audit
npm run public:build
npm run public:dev
npm run cli -- audit-media-links
npm run cli -- audit-public-export [path]
npm run cli -- sync-metadata
npm run cli -- search "Jane"
npm run cli -- backends
npm run cli -- upsert-team '{"id":"team_tpt_u14_2025_2026","name":"TPT U14","sharepointRootUrl":"https://..."}'
npm run cli -- list-teams
```

For the provided Team Palisades shared link, `list-sharepoint-rest` works without Graph credentials by establishing the anonymous shared-link SharePoint session and calling SharePoint REST endpoints. The current real validation folder is `GS Race Jan 9. Northstar. Day 1`, correlated to Live-Timing races `297661` (men) and `297652` (women).

Use `prepare-folder` in low-data mode. It is the repeatable, codified event-prep workflow: ingest/refresh the manifest when needed, match Live-Timing daily races by folder date/venue/discipline, parse racer rosters, attach race assets, and relabel videos from metadata/filenames without downloading media. Use `process-folder` only when you are ready to mirror/transcribe video files.

## Data Layout

- `data/index/store.json`: working local index.
- `data/raw/`: downloaded public race assets and source snapshots.
- `data/models/`: local Whisper/whisper.cpp model files, excluded from git.
- `data/media/TPT U14 2025-2026/`: mirrored videos, preserving the SharePoint event folder structure; excluded from git.
- `data/audio/TPT U14 2025-2026/`: extracted or downloaded audio, preserving the same event structure; excluded from git.
- `data/transcripts/TPT U14 2025-2026/`: generated transcripts, preserving the same event structure; excluded from git.
- `data/exports/lean-index.json`: internal lean metadata export.
- `data/exports/public/lean-index.json`: audited public metadata export for static publishing.
- `apps/public-next/out/`: generated static public app for Vercel, Firebase Hosting, Cloudflare Pages, or any static host.

The web app no longer loads `data/index/store.json` wholesale at startup. Folder cards are backed by a compact summary endpoint, while event video rows are fetched only when an event is opened.

To migrate older slug-based local cache paths into the mirrored layout, run `node scripts/migrate-cache-layout.mjs` for a dry run, then `node scripts/migrate-cache-layout.mjs --apply`. Add `--cleanup-legacy` after auditing the dry run to remove unreferenced legacy cache files.

## Metadata Backend

The authoritative local working store is `data/index/store.json`. It keeps folder, event, video, transcript references, athlete labels, processing jobs, and race assets together so local processing can resume incrementally.

For a hosted/search-only app, use `npm run public:build`. This runs the public export audit, copies the sanitized metadata into the Next.js public app, and builds static HTML/CSS/JS into `apps/public-next/out/`. This public export keeps metadata and SharePoint playback links, but not hosted media or local worker paths.

Firebase Firestore sync is implemented as an optional backend:

```sh
METADATA_BACKEND=firebase
FIREBASE_PROJECT_ID=your-project
FIREBASE_SERVICE_ACCOUNT_PATH=/path/to/service-account.json
npm run cli -- sync-metadata
```

The sync writes prefixed Firestore collections for folders, videos, events, jobs, and store metadata. This keeps local media/transcripts out of the hosted database while making the searchable index publishable.

## Deployment Notes

Phase 1 public publishing uses the static Next.js app in `apps/public-next/`. Build it with `npm run public:build` and deploy `apps/public-next/out/`. Detailed Vercel, Firebase Hosting, and Cloudflare Pages instructions are in [docs/PHASE1_STATIC_PUBLIC_EXPORT.md](docs/PHASE1_STATIC_PUBLIC_EXPORT.md).

The backend/admin app is still an Express app. That works directly on server runtimes such as Cloud Run, Render, Fly, Railway, or any container host. For Vercel, deploy the Express app through a serverless function or move the route handlers into Vercel API routes. For Firebase, use Firebase Hosting rewrites to Cloud Functions or Cloud Run; Firebase Hosting alone is static and cannot run the API.

The publishable version should avoid storing videos. Use Firestore or `data/exports/public/lean-index.json` for metadata/search. Playback can either link to SharePoint source URLs or use an authenticated/server-side proxy endpoint when public SharePoint folder links do not produce stable anonymous per-file URLs.

## Credential Notes

SharePoint listing prefers Microsoft Graph. Configure either:

- `GRAPH_ACCESS_TOKEN`, or
- `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, and `AZURE_CLIENT_SECRET`.

Audio transcription defaults to local Homebrew `whisper-cli` (whisper.cpp) with the configured ggml model under `data/models/`. `WHISPER_MODEL_SIZE` defaults to `medium`; run `scripts/download-models.sh` after changing it so the matching `ggml-<size>.bin` is present. If the configured whisper.cpp model is missing, the app prefers Apple Silicon MLX Whisper when its `.venv` runtime is importable, and otherwise fails with a direct download instruction instead of silently using an older transcript. Install MLX with `scripts/install-whisper.sh`. The backend can be pinned with `WHISPER_BACKEND` (`whisper.cpp`, `mlx`, or `openai`). whisper.cpp uses GPU/Metal by default; use `WHISPER_CPP_NO_GPU=1` or CLI `--whisper-cpp-no-gpu` only when you need to disable GPU acceleration. OpenAI transcription is used only when `WHISPER_BACKEND=openai` or it is the last available backend and `OPENAI_API_KEY` is present. Without any transcription backend, the app still runs deterministic and LLM matching against existing transcripts, filenames, and event rosters.

Athlete labeling layers an optional LLM on top of the deterministic matcher. Set `GEMINI_API_KEY` to enable Gemini labeling (model `GEMINI_LABEL_MODEL`, editable in Settings; `LLM_LABEL_MODE=fallback` by default, `always` to label every video). `OPENAI_API_KEY` enables an OpenAI labeler as a secondary fallback. With no LLM key configured, labeling uses the deterministic roster/transcript/filename matcher alone.

The installer also installs `imageio-ffmpeg`, which provides a static Apple Silicon `ffmpeg` fallback. This avoids depending on the local Homebrew `ffmpeg` install.

Transcripts and labels are intentionally decoupled. Full transcript artifacts are kept under `data/transcripts/` and referenced from video records through `transcriptRef`; athlete labels are derived evidence that can be rerun with better rosters, fuzzy matching, or an LLM without retranscribing the media.
