# Ski Video Companion

Local-first companion app for indexing SharePoint skiing videos by athlete name, with event context from Far West U14 schedules and Live-Timing race assets.

Start here:

```sh
npm run smoke
npm start
```

Then open `http://localhost:4173`.

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
- Local Apple Silicon optimized MLX Whisper transcription hook.
- Local whisper.cpp transcription fallback using `/opt/homebrew/bin/whisper-cli` and `data/models/ggml-base.en.bin`. GPU/Metal is the default when the installed whisper.cpp binary supports it; set `WHISPER_CPP_NO_GPU=1` or pass `--whisper-cpp-no-gpu` to force CPU-only `-ng` mode.
- Optional event-aware transcription prompts for Whisper. Use `TRANSCRIPTION_PROMPT=1` or CLI `--transcription-prompt` to bias decoding toward ski phrases such as `run two` and Live-Timing roster names while preserving prompt metadata on transcript refs.
- OpenAI transcription and labeler hooks as optional fallbacks when `OPENAI_API_KEY` is available.
- Event detail view with status/confidence filters, event-local search, Live-Timing assets, app playback links, source SharePoint links, and embedded local video players.
- Event list actions are ordered by dependency with mouse-over tooltips: `View` ensures the SharePoint video list and opens the event table, `Live` refreshes race correlation, `Prepare` runs View/Live dependencies plus metadata relabeling, `Process` runs all dependencies before download/transcription/indexing with four workers by default, and `Re-Process` confirms before forced retranscription/relabeling from local media only.
- Event review controls for manual athlete correction and label clearing without media downloads.
- Lazy web loading: startup reads `/api/summary`, selected events read `/api/event?folderId=...`, and global search reads `/api/search` instead of loading the full store into the browser.
- Background processing from the web UI returns immediately and the Jobs panel refreshes while processing is running, so progress is visible without waiting on a single long HTTP response.
- Jobs are color-coded by status and each job has an Inspect link backed by `/api/job`, with persisted progress logs available during and after processing.
- Optional Firestore metadata sync through Firebase service-account credentials.
- App playback links in search results. Local videos use `/media/:videoId`; non-local videos link directly to the SharePoint source URL so the app server does not proxy video bytes.
- Static read-only Next.js public app in `apps/public-next/`, generated from an audited public export with no local media paths, download URLs, credentials, or job history.

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
npm run cli -- sync-metadata
npm run cli -- search "Jane"
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

Audio transcription uses local MLX Whisper on Apple Silicon when available. Install it with `scripts/install-whisper.sh`. If MLX cannot access Metal from the current runner, the app falls back to Homebrew `whisper-cli` with a local ggml model at `data/models/ggml-base.en.bin`. whisper.cpp now uses GPU/Metal by default; use `WHISPER_CPP_NO_GPU=1` or CLI `--whisper-cpp-no-gpu` only when you need to disable GPU acceleration. OpenAI is optional fallback only when `OPENAI_API_KEY` is present. Without any transcription backend, the app still runs deterministic matching against existing transcripts, filenames, and event rosters.

The installer also installs `imageio-ffmpeg`, which provides a static Apple Silicon `ffmpeg` fallback. This avoids depending on the local Homebrew `ffmpeg` install.

Transcripts and labels are intentionally decoupled. Full transcript artifacts are kept under `data/transcripts/` and referenced from video records through `transcriptRef`; athlete labels are derived evidence that can be rerun with better rosters, fuzzy matching, or an LLM without retranscribing the media.
