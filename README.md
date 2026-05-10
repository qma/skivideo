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
- Local Apple Silicon optimized MLX Whisper transcription hook.
- OpenAI transcription and labeler hooks as optional fallbacks when `OPENAI_API_KEY` is available.
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
npm run cli -- process-folder sample-folder-palisades-u14-gs
npm run cli -- process-video <videoId>
npm run cli -- export-lean
npm run cli -- search "Jane"
```

For the provided Team Palisades shared link, `list-sharepoint-rest` works without Graph credentials by establishing the anonymous shared-link SharePoint session and calling SharePoint REST endpoints. The current real validation folder is `GS Race Jan 9. Northstar. Day 1`, correlated to Live-Timing races `297661` (men) and `297652` (women).

## Data Layout

- `data/index/store.json`: working local index.
- `data/raw/`: downloaded public race assets and source snapshots.
- `data/media/`: mirrored videos, excluded from git.
- `data/audio/`: extracted or downloaded audio, excluded from git.
- `data/transcripts/`: generated transcripts, excluded from git.
- `data/exports/lean-index.json`: publishable metadata export.

## Credential Notes

SharePoint listing prefers Microsoft Graph. Configure either:

- `GRAPH_ACCESS_TOKEN`, or
- `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, and `AZURE_CLIENT_SECRET`.

Audio transcription defaults to local MLX Whisper on Apple Silicon. Install it with `scripts/install-whisper.sh`. OpenAI is optional fallback only when `OPENAI_API_KEY` is present. Without any transcription backend, the app still runs deterministic matching against existing transcripts, filenames, and event rosters.

The installer also installs `imageio-ffmpeg`, which provides a static Apple Silicon `ffmpeg` fallback. This avoids depending on the local Homebrew `ffmpeg` install.

Transcripts and labels are intentionally decoupled. Full transcript artifacts are kept under `data/transcripts/` and referenced from video records through `transcriptRef`; athlete labels are derived evidence that can be rerun with better rosters, fuzzy matching, or an LLM without retranscribing the media.
