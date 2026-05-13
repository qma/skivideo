# Ski Video Companion

Local-first companion app for indexing SharePoint skiing videos by athlete name, with event context from Far West U14 schedules and Live-Timing race assets.

Start here:

```sh
npm run smoke
npm start
```

Then open `http://localhost:4173`.

The design and execution plan lives in [docs/DESIGN_AND_IMPLEMENTATION_PLAN.md](docs/DESIGN_AND_IMPLEMENTATION_PLAN.md).

## Current Capabilities

- Dependency-light Node web app and CLI.
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
- OpenAI transcription and labeler hooks as optional fallbacks when `OPENAI_API_KEY` is available.
- Event detail view with status/confidence filters, event-local search, Live-Timing assets, SharePoint links, and embedded local video players.
- Event review controls for manual athlete correction and label clearing without media downloads.
- Lazy web loading: startup reads `/api/summary`, selected events read `/api/event?folderId=...`, and global search reads `/api/search` instead of loading the full store into the browser.
- Optional Firestore metadata sync through Firebase service-account credentials.
- SharePoint playback links in search results.

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
npm run cli -- relabel-folder <folderId>
npm run cli -- process-video <videoId>
npm run cli -- export-lean
npm run cli -- sync-metadata
npm run cli -- search "Jane"
```

For the provided Team Palisades shared link, `list-sharepoint-rest` works without Graph credentials by establishing the anonymous shared-link SharePoint session and calling SharePoint REST endpoints. The current real validation folder is `GS Race Jan 9. Northstar. Day 1`, correlated to Live-Timing races `297661` (men) and `297652` (women).

Use `prepare-folder` in low-data mode. It is the repeatable, codified event-prep workflow: ingest/refresh the manifest when needed, match Live-Timing daily races by folder date/venue/discipline, parse racer rosters, attach race assets, and relabel videos from metadata/filenames without downloading media. Use `process-folder` only when you are ready to mirror/transcribe video files.

## Data Layout

- `data/index/store.json`: working local index.
- `data/raw/`: downloaded public race assets and source snapshots.
- `data/media/`: mirrored videos, excluded from git.
- `data/audio/`: extracted or downloaded audio, excluded from git.
- `data/transcripts/`: generated transcripts, excluded from git.
- `data/exports/lean-index.json`: publishable metadata export.

The web app no longer loads `data/index/store.json` wholesale at startup. Folder cards are backed by a compact summary endpoint, while event video rows are fetched only when an event is opened.

## Metadata Backend

The authoritative local working store is `data/index/store.json`. It keeps folder, event, video, transcript references, athlete labels, processing jobs, and race assets together so local processing can resume incrementally.

For a hosted/search-only app, use `npm run cli -- export-lean` to produce `data/exports/lean-index.json`. This lean export keeps metadata and SharePoint playback links, but not hosted media.

Firebase Firestore sync is implemented as an optional backend:

```sh
METADATA_BACKEND=firebase
FIREBASE_PROJECT_ID=your-project
FIREBASE_SERVICE_ACCOUNT_PATH=/path/to/service-account.json
npm run cli -- sync-metadata
```

The sync writes prefixed Firestore collections for folders, videos, events, jobs, and store metadata. This keeps local media/transcripts out of the hosted database while making the searchable index publishable.

## Credential Notes

SharePoint listing prefers Microsoft Graph. Configure either:

- `GRAPH_ACCESS_TOKEN`, or
- `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, and `AZURE_CLIENT_SECRET`.

Audio transcription defaults to local MLX Whisper on Apple Silicon. Install it with `scripts/install-whisper.sh`. OpenAI is optional fallback only when `OPENAI_API_KEY` is present. Without any transcription backend, the app still runs deterministic matching against existing transcripts, filenames, and event rosters.

The installer also installs `imageio-ffmpeg`, which provides a static Apple Silicon `ffmpeg` fallback. This avoids depending on the local Homebrew `ffmpeg` install.

Transcripts and labels are intentionally decoupled. Full transcript artifacts are kept under `data/transcripts/` and referenced from video records through `transcriptRef`; athlete labels are derived evidence that can be rerun with better rosters, fuzzy matching, or an LLM without retranscribing the media.
