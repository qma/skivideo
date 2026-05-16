# Phase 1 Static Public Export

## Scope

Phase 1 publishes a read-only family-facing search app. It does not expose admin controls, local media files, local transcript artifacts, processing jobs, credentials, or proxy video bytes.

The static app is implemented in `apps/public-next/` and reads one generated JSON file:

```text
apps/public-next/public/data/lean-index.json
```

That file is generated from the local working store by a public-only export path. Playback links point directly to SharePoint item view URLs derived from the original source. The hosted app should not serve or proxy videos.

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

## SharePoint Link Behavior

The source team folder is an anonymous SharePoint folder share. A fresh browser can open the root shared folder URL, but direct file URLs inside that folder are not necessarily anonymous until SharePoint has established an anonymous browser session for the share.

Observed behavior for `P1000316.MP4`:

- The root folder share opens anonymously from a fresh state.
- Raw tenant file URLs such as `/sites/.../P1000316.MP4`, `?web=1`, and SharePoint's own `:v:/r/...` `directUrl` return `403` with `x-forms_based_auth_required` from a no-cookie state.
- `GetSharingInformation` for the file reports no existing per-file anonymous link: `anonymousLinkAbilities.canGetReadLink.enabled=false`, `anyoneLinkAbilities.canGetReadLink.enabled=false`, and `mainLinkAbilities=null`.
- SharePoint `guestaccess.aspx` candidate URLs can return HTTP 200 while still rendering an error page, so status code alone is not a reliable proof of public playback.

The public app therefore shows a note prompting viewers to open the public team folder once. `Open Video` and `Event Folder` remain normal direct links to the generated SharePoint item/folder view URLs; the app does not perform a hidden folder-open redirect and does not proxy video bytes.

If authenticated Microsoft Graph access is added later, the admin pipeline may generate true per-file anonymous links with Graph `driveItem:createLink` (`type: view`, `scope: anonymous`) when tenant policy allows it. Those links should be stored as provider link metadata and verified in an incognito/no-cookie browser before publishing.

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

## Selected Phase 1 Host: Vercel

Vercel is the first configured static host for Phase 1 because the public app is already a static Next export and can deploy `apps/public-next/out/` without running a media proxy or server runtime.

Committed repo config:

- `vercel.json`: runs `npm run public:build`, serves `apps/public-next/out`, and uses `npm ci`.
- `.vercelignore`: excludes local media, audio, transcripts, raw source snapshots, private index data, generated exports, models, tool caches, `.env`, and build outputs from upload.

Vercel CLI deploy path:

```sh
npm run public:audit
npm run public:build
npx vercel deploy apps/public-next/out --prod --yes
npx vercel alias set <deployment-url> ski-video-companion-public.vercel.app
```

Or use the project script, which runs the build, deploys `apps/public-next/out`, and points the public alias at the new deployment:

```sh
npm run public:deploy:vercel
```

Important: do not rely on Vercel remote build to regenerate the public export unless the build environment has access to the local `data/index/store.json` equivalent. The working index, media, transcripts, and raw data are intentionally excluded from upload. The reliable Phase 1 flow is to generate and audit the static export locally, then deploy the prebuilt `apps/public-next/out/` directory.

Git-connected deploy settings should match:

- Root Directory: repository root
- Framework Preset: Other
- Install Command: `npm ci`
- Build Command: `npm run public:build`
- Output Directory: `apps/public-next/out`
- Node.js: 20 or newer

## Vercel Reference

Recommended static-only configuration:

- Root Directory: repository root
- Framework Preset: Other
- Install Command: `npm ci`
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

Use the static configuration above instead of a Next.js server deployment for Phase 1. This keeps the public app as CDN-hosted HTML, CSS, JS, and JSON. For Git-connected CI later, the CI job must either receive a generated public export artifact or pull metadata from a hosted metadata backend instead of depending on local ignored data files.

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
