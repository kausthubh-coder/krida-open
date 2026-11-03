# Production and ops

**Stop. Everything on this page touches production, or sets it up. Do not run any of it without the owner's explicit
go for that command, in this conversation.** That includes `--prod` commands, deploys, password changes and exports.
Some of these functions (`admin:resetActivity`, `profiles:remove`, `profiles:resetPassword`) wipe or change real data.
On production they refuse to run without `"confirmProd": true` (`convex/lib/deployment.ts`). Worktrees and tests use
the dev backend (`fastidious-oyster-35`), never these.

## Commands

```sh
npx convex deploy -y                 # backend to prod
git push origin main                 # frontend to prod (Vercel)
node scripts/usage.mjs --prod        # which functions read the most, and the month so far
npx convex run --prod profiles:add '{"name":"…","hue":145,"password":"…"}'
npx convex run --prod profiles:resetPassword '{"name":"…","password":"…","confirmProd":true}'
npx convex run --prod simkl:resetImport '{"profileId":"…"}'   # next Simkl sync re-imports everything
npx convex run --prod simkl:queue '{"profileId":"…","op":"plan","item":{…}}'   # queue a change as if made in Krida
npx convex run --prod simkl:inspect '{"profileId":"…","path":"/sync/activities"}'   # raw Simkl rows, no tokens
node scripts/logs.mjs --prod         # what failed in people's browsers and apps, last 24 h (--hours, --kind, --json)
```

`scripts/logs.mjs --prod` is the one exception to the rule above: it only reads the `clientLogs` table, and the owner
gave a standing go (2026-10-23) to run it whenever a bug someone saw needs looking into. Rows are written by
`src/data/log.ts` when something fails (Cinemeta, `/api`, Play, the player, uncaught errors) and kept 14 days.

## PostHog

Production and previews send everything to PostHog's US cloud, project "Krida" in the "Krida" organization, free plan
with no card (going over the free allowance drops data, never bills): errors with source-mapped stacks, a replay of
every session with its console and network, clicks, web vitals, and Krida's own timings. The browser sends through
`/relay` (`vercel.json`), `/api` from `server/telemetry.ts`, Convex actions from `convex/lib/telemetry.ts`; every
string goes through `scrub()` first. Nothing is sent without a project key: `VITE_POSTHOG_KEY` (browser, Vercel build
env), `POSTHOG_KEY` (`/api` in Vercel's env, and Convex actions in Convex's env). Dev, QA and the regression gate send
nothing unless `VITE_KRIDA_TELEMETRY` (browser) or `KRIDA_TELEMETRY` (`/api`) names an environment too. The events, and what to ask of them, are in `docs/performance.md`.

- Read it at https://us.posthog.com, with the PostHog MCP (`mcp.posthog.com/mcp`), or with the API and a personal
  API key: `curl -H "Authorization: Bearer $POSTHOG_PERSONAL_API_KEY" https://us.posthog.com/api/projects/<id>/query/
  -d '{"query":{"kind":"HogQLQuery","query":"select …"}}'`. The project id is the `POSTHOG_PROJECT_ID` env var that
  `scripts/e2e-telemetry.ts` reads. Reading is a standing go, like `scripts/logs.mjs --prod`.
- Keys: the project key (`VITE_POSTHOG_KEY` / `POSTHOG_KEY`) is public once shipped (it only sends). Personal API keys
  stay out of the repo, in the environment of whoever reads: one with error tracking write goes in Vercel's Production
  and Preview env as `POSTHOG_CLI_API_KEY` with `POSTHOG_CLI_PROJECT_ID`, which `scripts/build-frontend.mjs` uses to
  upload source maps and then delete them.

## Secrets

TorBox key, playback URLs, API keys and Simkl tokens live in Convex env or tables, or Vercel's env, and never reach
the browser or the repo (an addon's link, which may hold the account's own debrid key, goes only to that profile's
sessions). Sources and catalogs come from each profile's addons, so no AIOStreams variables are read any more. Convex
env: `TORBOX_API_KEY`, `TMDB_API_KEY`, `MDBLIST_API_KEY`, `SIMKL_CLIENT_ID`, `SIMKL_CLIENT_SECRET` (set on both dev and
prod). Vercel env (Production and Preview): `TMDB_API_KEY`, `MDBLIST_API_KEY`; for local dev put the same in
`.env.local` (only `VITE_` variables reach the browser). `TORBOX_API_KEY` is in Vercel's Production env only, for
`/api/frame` (the timeline's pictures, read from the film's own file): a preview trusts any Convex deployment's
sessions (`server/session.ts`), so previews must not hold it, and fall back to TorBox's HLS for pictures. Vercel's
Production env also holds `FRAMES_URL` and `FRAMES_SECRET` for the frames Worker (below); without them the player
reads pictures through `/api/frame` at one every 90 s.

## The frames Worker

`workers/frames` (`krida-open-frames` on the owner's Cloudflare account, free plan; not deployed yet) reads the
timeline's keyframes out of the asking account's TorBox, so a picture every 10 s costs Vercel nothing. Cloudflare
doesn't bill bandwidth, and the free plan can't charge: past 100,000 requests a day it fails and the player falls back
to `/api/frame`. Its one secret is `FRAMES_SECRET`, which must match Vercel's: `/api/frames?ticket` seals the account's
TorBox key into a day's ticket for one file with it (`server/frameTicket.ts`) and the Worker opens it, so it never calls
Convex and holds no TorBox key of its own.

```sh
cd workers/frames && npx -y wrangler@4 deploy                  # after changing it, or server/mkv.ts or server/torbox.ts
npx -y wrangler@4 secret put FRAMES_SECRET    # from stdin; then the same value in Vercel Production, and redeploy
```

## Deploying

- **People may be watching while you deploy.** Keep backend changes compatible with the frontend that's live (add
  optional fields, keep old function signatures) and deploy Convex before pushing the frontend.
- **Deployments:** Vercel's build command runs `scripts/vercel-build.mjs`. Merges into `main` deploy Convex and the
  frontend together. PR branches use isolated Convex previews with separate profiles and data. On a preview, the
  profile screen can switch to "My real account", which runs the branch's frontend against production
  (`src/data/backend.ts`); writes are real, so use it only for branches without backend changes. Never give a preview
  build the production deploy key. Previews count toward the Convex team's 40 deployments (shared with its other
  projects) and live 5 days; closing a PR deletes its preview (`.github/workflows/convex-preview-cleanup.yml`, needs
  the `CONVEX_TEAM_TOKEN` repo secret). A preview failing with `DeploymentQuotaReached` means that limit is full.
  Branches named `rebuild/*` build no preview (`ignoreCommand` in `vercel.json`): cloud agents check those with
  `npm run regress` on a local backend instead. T3 usually copies the main checkout's `.env.local` into new
  worktrees; when it didn't, `npm run doctor -- --fix` copies it (only if it points at dev).

## One-off repairs

Older versions wrote a watch-status override alongside each rating. To review them, run
`npx convex run --prod library:dropRatingOnlyViewing '{"dryRun":true}'`. It scans in pages and logs matching rows,
skipping accepted writes, pending status changes, rewatches and completed movies. Equal rating and status timestamps
mark candidates, not proof of intent, so read the dry run before running it with `{"dryRun":false}`. Nothing runs it
automatically.
