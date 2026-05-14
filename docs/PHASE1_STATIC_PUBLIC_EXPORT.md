# Phase 1 Static Public Export

## Scope

Phase 1 publishes a read-only family-facing search app. It does not expose admin controls, local media files, local transcript artifacts, processing jobs, credentials, or proxy video bytes.

The static app is implemented in `apps/public-next/` and reads one generated JSON file:

```text
apps/public-next/public/data/lean-index.json
```

That file is generated from the local working store by a public-only export path. Playback links point directly to the original SharePoint source URL. The hosted app should not serve or proxy videos.

## Data Flow

```text
data/index/store.json
  -> npm run public:export
  -> data/exports/public/lean-index.json
  -> apps/public-next/public/data/lean-index.json
  -> npm run public:build
  -> apps/public-next/out/
```

`export-public` is intentionally separate from `export-lean`. The internal lean export can include operational fields useful to the local/admin app; the public export strips private or worker-only data.

## Public Export Contract

The public JSON includes:

- `teams`: current team metadata for TPT U14.
- `folders`: event/folder metadata, event match summaries, public Live-Timing asset links, roster counts, and publish stats.
- `videos`: publishable videos with SharePoint playback links, transcript snippets, athlete labels, and processing status.
- `events`: public event calendar records when available.

The public JSON excludes:

- local video/audio/transcript/model/raw/index paths
- SharePoint download URLs
- server-relative SharePoint paths
- processing job history
- credentials, tokens, cookies, and auth headers
- hosted media bytes

The CLI audit checks these exclusions:

```sh
npm run public:audit
```

## Commands

Generate and audit the public JSON:

```sh
npm run public:export
```

Build the static app:

```sh
npm run public:build
```

Run the static public app locally in Next dev mode:

```sh
npm run public:dev
```

The production artifact to deploy is:

```text
apps/public-next/out/
```

## Vercel

Recommended static-only configuration:

- Root Directory: repository root
- Framework Preset: Other
- Install Command: `npm install`
- Build Command: `npm run public:build`
- Output Directory: `apps/public-next/out`
- Node.js: 20 or newer

Vercel supports custom build commands and output directories. Its docs note that only the contents of the configured Output Directory are served statically after the build.

Optional `vercel.json`:

```json
{
  "buildCommand": "npm run public:build",
  "outputDirectory": "apps/public-next/out"
}
```

Use the static configuration above instead of a Next.js server deployment for Phase 1. This keeps the public app as CDN-hosted HTML, CSS, JS, and JSON.

## Firebase Hosting

Firebase Hosting is suitable for this phase because it serves static assets over its CDN.

One-time setup:

```sh
npm run public:build
firebase init hosting
```

When prompted for the public root directory, use:

```text
apps/public-next/out
```

Use this minimal `firebase.json` if configuring manually:

```json
{
  "hosting": {
    "public": "apps/public-next/out",
    "ignore": ["firebase.json", "**/.*", "**/node_modules/**"],
    "cleanUrls": true
  }
}
```

Deploy:

```sh
npm run public:build
firebase deploy --only hosting
```

Do not enable Firebase App Hosting for Phase 1. Firebase App Hosting is the better fit later for a full-stack/admin Next.js app, but this phase is static-only.

## Cloudflare Pages

Git-connected Pages configuration:

- Framework preset: Next.js Static HTML Export, or None with manual settings
- Build command: `npm run public:build`
- Build output directory: `apps/public-next/out`
- Root directory: repository root
- Node.js: 20 or newer

Direct upload:

```sh
npm run public:build
npx wrangler pages deploy apps/public-next/out
```

Cloudflare's Pages docs list `out` as the build directory for Next.js Static HTML Export. This repo uses `apps/public-next/out` because the app lives in a subdirectory.

## Release Checklist

1. Run `npm run public:export`.
2. Confirm the audit reports `ok: true`.
3. Run `npm run public:build`.
4. Smoke-test athlete search locally.
5. Deploy `apps/public-next/out/` to the chosen host.
6. Spot-check that `Open Video` links go to SharePoint and that no hosted URL serves video bytes.

## References

- Next.js static export: https://nextjs.org/docs/pages/guides/static-exports
- Vercel build and output directory configuration: https://vercel.com/docs/builds/configure-a-build
- Firebase Hosting quickstart: https://firebase.google.com/docs/hosting/quickstart
- Cloudflare Pages build configuration: https://developers.cloudflare.com/pages/configuration/build-configuration/
- Cloudflare Pages direct upload: https://developers.cloudflare.com/pages/get-started/direct-upload/
