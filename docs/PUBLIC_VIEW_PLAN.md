# Public View & Tiered-Login Plan

Status: design (forward-looking). The transitional pieces that exist today are noted inline; the auth/role work described here is **not yet implemented**.

## Why
We want to publish the webapp so non-admins can browse the athlete video index, while admins keep full management access. Today the public surface is a **static Next.js export** (`apps/public-next/`, deployed to Vercel) plus two in-admin previews:

- `/public/` — **live** public view rendered by the Express server from the audited public projection (no build step). Added this session; it is the seed of the future live public mode.
- `/public-preview/` — the **static** Next export served with live data (needs `npm run public:build`).

Both consume the same sanitized projection, so the data contract is already settled. What's missing is **authentication and per-role data visibility** so the whole app can be published as one live server.

## Target roles
| Role | Who | Sees |
| --- | --- | --- |
| `anonymous` | public / parents | Published videos only (`indexed` + `needs_review`), names/labels, transcript snippets, SharePoint source links. No local paths, no job history, no costs. |
| `member` | team staff / coaches | Everything anonymous sees **plus** review status detail, fuller roster/Live-Timing context, label-debug evidence, and per-video confidence. Still no local filesystem paths, credentials, or LLM cost/token internals. |
| `admin` | operators | The full store + all management actions (import, process, relabel, reset, settings, sync). |

## Data projections (the key seam)
The projection layer already exists and is the natural place to enforce visibility. One pure function per role, each run through the security audit:

- `anonymous` → **`buildPublicLeanStore(store)`** (`src/lib/fsStore.mjs:323`) — already strips local paths/download URLs/jobs/credentials and is verified by **`auditPublicLeanStore`** (`src/lib/fsStore.mjs:363`).
- `member` → **new `buildMemberLeanStore(store)`** — start from the public projection and add the extra member fields above. Must pass the same audit (no local paths/credentials), with a relaxed allowance only for review metadata.
- `admin` → the raw store (existing `/api/*` routes).

Rule: **read endpoints return the projection for the caller's role; never branch field-by-field in the UI.** Keep `auditPublicLeanStore` as a CI/startup gate for the anonymous and member projections so a regression can never leak local data.

## Auth
Cookie-based session, intentionally minimal first, pluggable later:

1. **v1 (env credentials):** `ADMIN_PASSWORD` / `MEMBER_PASSWORD` (or a small `teams[].accessKeys` map) in `.env`. `POST /api/login` verifies and sets a signed, httpOnly session cookie carrying `{ role }`. `POST /api/logout` clears it. No password ⇒ role falls back to `anonymous`.
2. **Middleware:** `attachRole` reads the cookie → `req.role` (default `anonymous`); `requireRole("admin")` / `requireRole("member")` gate routes.
3. **v2 (pluggable):** swap the credential check for an IdP/SSO (Google Workspace, magic links) behind the same `req.role` contract — no route changes needed.

Use a vetted, dependency-light session lib (e.g. `cookie-session` / signed cookies) consistent with the app's lean-dependency style. Add CSRF protection for mutating routes and rate-limit `/api/login`.

## Enforcement map (server.mjs)
- **Gate all mutations/admin reads** behind `requireRole("admin")`: every `POST /api/*` (ingest, process, relabel, reset, settings, sync, live-timing, review) plus `/api/store`, `/api/job`, `/api/settings`, and `/media/:videoId` (raw local media must never be public).
- **Role-aware reads:** `/api/summary`, `/api/event`, `/api/search`, and `/data/lean-index.json` return the projection for `req.role`.
- **Views by role:** `/` (admin SPA) requires `admin`; `/public/` stays anonymous; a future `/member/` (or the same `/public/` enriched when `req.role==="member"`) serves the member projection.

## Deployment model
- **One live server** serving role-based views is the target — the live `/public/` view added this session is the foundation; layering auth + the member projection on top completes it. Deploy on any Node host (Cloud Run / Render / Fly / Railway).
- **Static export stays optional** for a pure-anonymous, zero-backend deployment (Vercel via `npm run public:build`); it can only ever serve the anonymous projection. If maintaining both UIs becomes a burden, generate the static site from `public-view/` (vanilla, no React build) and retire `apps/public-next/`.
- Media is never hosted; playback always links to SharePoint source URLs (`createPublicSharePointLinks`, `src/lib/fsStore.mjs`).

## Migration path
1. **Now:** live `/public/` (done) + audited anonymous projection (done).
2. Add `attachRole` + `/api/login` + `requireRole`; gate admin routes and `/media`. App still works for admins; anonymous gets `/public/`.
3. Add `buildMemberLeanStore` + member view; add member login.
4. Make read endpoints role-aware; add the audit gate to CI.
5. Deploy the single live server; keep the static export as the anonymous fallback.

## Out of scope here
Per-athlete/per-family granular permissions, comment/annotation features, and analytics — revisit once the three-tier model is live.
