# Krida

Open Krida is the public, open-source Krida, a streaming app like Stremio and Nuvio. Anyone signs in with Google,
makes profiles, brings their own TMDB and debrid keys and Stremio addons, and presses Play; or watches together in a
party with synced playback, a shared queue, chat and reactions. Vite + React 19 + TypeScript + Tailwind v4 on the
front, Convex for what has to sync, Clerk for sign-in, Vercel functions for public data. Live at
https://krida-open.vercel.app.

It started as a copy of the owner's private Krida (`~/dev/krida` on the owner's machine). Never read keys from, push
to, or deploy anything of private Krida: its repo, its Convex deployments and its Vercel project are off limits from here. What open Krida is
and how it differs: `.agents/plans/open-krida-spec.md`. Read it before any task.

## Words we use

- **you**: the agent reading this file. **me**: the developer you work for (Kausthubh). **user**: someone who uses Krida.
- **account**: one Clerk sign-in; it holds keys and up to 8 profiles. **profile**: one person's space in an account. **title**: a movie, show or anime. **party**: a room watching one thing together.
- **Plan to watch**: the list of titles a profile saved to watch later. Use this name in copy and docs.
- **dev backend**: Convex `fastidious-oyster-35`. **prod**: Convex `industrious-axolotl-949` plus Vercel.
- **one title, two ids**: an anime has an IMDb id and a Kitsu id. See `convex/lib/titleIds.ts`.

## Map

| Where | What lives there |
| --- | --- |
| `convex/` | Backend: profiles, rooms, stream pipeline (`engine.ts`, `sources.ts`, `http.ts`), Simkl (`simkl.ts`), Library, ratings, `sync.ts` |
| `convex/functions.ts` | The only place mutations are built from |
| `api/`, `server/` | Vercel functions for public data (search, ratings, artwork, rows, recommender); `api/` is one file per endpoint |
| `workers/frames/` | The Cloudflare Worker that serves the timeline's keyframes (`docs/ops.md`) |
| `android/` | The Android app: the live site in a WebView plus a bridge to the phone (`src/ui/android.ts`). Building, signing, testing: `android/README.md` |
| `desktop/` | Krida for Windows: a Tauri shell around the live site, with mpv playing the picture (`docs/desktop.md`) |
| `shared/` | Plain TypeScript used by the browser, Convex and Vercel (TMDB, MDBList, IMDb, tags, taste) |
| `src/features/<name>/` | One folder per thing a person does: `landing`, `onboarding`, `home`, `title`, `person`, `search`, `library`, `play`, `player`, `party`, `trailers`, `settings`. Each has an `index.ts`; other features import only that |
| `src/app/` | The shell: the app's entry and Gate (`main.tsx`; `src/main.tsx` picks it or the landing page alone), nav and dock, kept pages (`Pages.tsx`), scroll memory, not-found |
| `src/ui/` | The design system on bubli: `bubbles.tsx` (its fit to Krida), `ui.tsx` (Button, IconButton…), `grow.tsx` (menus), `lens.tsx`, artwork, rails, sheets, scores, sounds |
| `vendor/` | The bubli release Krida installs. To update: `gh release download -R kausthubh-coder/bubli -p 'bubli-*.tgz' -D vendor`, remove the old one, `npm install ./vendor/bubli-<version>.tgz` |
| `src/data/` | What every feature reads: session, backend URL, `/api` client (`api.ts`), the synced copy of a profile's tables (`sync.tsx`, `mine.ts`, `rows.ts`) |
| `src/styles.css` | Tokens (oklch), `--bubli-*` tokens, frosted CSS, card sizes |
| `tests/` | vitest with convex-test, `tests/*.test.ts` |
| `scripts/` | Playwright e2e and screenshot scripts, `doctor.mjs`, `perf.mjs`, `usage.mjs` |

Deeper docs, read the one that matches your task:

- `docs/how-krida-works.html`: one evening through the code, with screenshots and state charts of a room (for a person new to it). Update it when the stream pipeline changes.
- `docs/architecture.md`: stack, what runs where, the full file map, API limits.
- `docs/product-feel.md`: who uses Krida and how it should feel. Read it before any UI work.
- `docs/recommendations.md`: how picks are scored and when they refresh.
- `docs/simkl.md`: Simkl sync both ways, the outbox, ratings, redirect URLs.
- `docs/database-reads.md`: Convex bandwidth rules. Read before adding a query.
- `docs/performance.md`: speed notes, perf measurements, what bubbles cost.
- `docs/e2e-scripts.md`: what each e2e script checks and which profile it needs.
- `docs/desktop.md`: Krida for Windows: the player under the page, building and releasing it, testing it quietly.
- `docs/ops.md`: production commands, secrets, deploys. Needs my explicit go.

Feature notes and deep explanations go in `docs/` or code comments, not in this file.

## Worktrees and shipping

- Every task in a new worktree starts with `worktree-krida` (`.agents/skills/worktree-krida/`): `npm run setup`, then
  `npm run doctor` whenever something looks off.
- `npm run dev` runs this checkout on its own port and its own local Convex backend, with QA profiles. Use it
  instead of `npx convex dev`, which pushes to the shared dev.
- Ship only with `ship-krida` (`.agents/skills/ship-krida/`), when I say so. It releases the apps too
  (`npm run release`, on the Mac mini) when `desktop/` or `android/` changed.

## Cloud sessions

A cloud VM (Claude Code on the web, Codex Cloud) is Linux with a bare clone of this repo. The SessionStart hook in
`.claude/settings.json` runs `node scripts/cloud.mjs` (Codex: set the environment's setup script to
`CLOUD=1 node scripts/cloud.mjs`). It loads my global skills and rules, then `npm run setup`: with no main checkout to
copy from, setup writes an `.env.local` naming the dev URLs and no keys, installs, and creates this checkout's own
local Convex backend with the QA profiles. It also sets the repo's git author to mine, because Vercel doesn't deploy
commits by other authors. It does nothing outside the cloud. Its last line says ready or what failed;
rerun it if you're unsure.

- Works here: setup and the doctor, `npm run check`, `npm run qa -- up`, the e2e scripts that need only the local
  backend, headless (`scripts/lib/browser.ts` launches Chrome where it's installed, else the VM's Playwright
  Chromium), and shipping with `ship-krida`.
- `npm run regress` stops at the anime title page: Kitsu's addon (`anime-kitsu.strem.fun`) answers 403 to the VM, so
  a fresh network store can't record it. Run the gate on my machine.
- GitHub's status, checks and Actions APIs answer 403 here, through `gh api` and the GitHub tools alike, so
  `ship-krida` watches the deploy through `https://krida-open.vercel.app/version.json` instead.
- Env vars the cloud environment needs for the rest (names only; Vite reads them before `.env.local`): `TMDB_API_KEY`
  and `MDBLIST_API_KEY` (catalog rows, Search, title pages through `/api`), `TORBOX_API_KEY` (`/api/frames` in dev;
  sources and catalogs come from each profile's addons, Settings → Addons), and for scripts that use
  the shared dev, a dev `CONVEX_DEPLOY_KEY` and `KRIDA_QA_PASSWORD`. Without them the doctor warns and those parts load
  empty; nothing else breaks.
- Only on my machine: T3 tools, `npm run regress`, the main checkout (`ship-krida` steps 5 and 6), the two-browser
  party scripts in Chrome and Edge (here both are the same Chromium), Vercel's dashboard and Instant Rollback, and
  anything signed in on production.

## Commands

- Install: `npm install`
- Backend on dev: `npx convex dev` (writes `.env.local`); push once with `npx convex dev --once --typecheck enable`
  Every worktree shares dev, so a push replaces the functions another branch pushed. Push only for backend changes.
- Doctor: `npm run doctor` (deps match the lockfile, `.env.local` points at dev, `/api` keys, port, a browser, how
  far behind `origin/main`). Run it first in a new worktree and whenever anything looks off; `-- --fix` copies a
  missing `.env.local` from the main checkout.
- Dev: `PORT=5174 npm run dev` (port from `PORT`, default 5173, fails if taken).
- QA app: `npm run qa -- up` runs this checkout on a throwaway local Convex backend with two seeded QA profiles and
  prints the URL; `npm run qa -- down` stops it. Scripts in `scripts/` find it through `.qa/session.json`.
- Regression gate: `npm run regress` walks every screen on `HEAD` and on your working tree and fails if anything a
  person sees differs. Report: `.artifacts/regress/report.html`. `-- --base <ref>` compares with another commit.
  Recording outside data it hasn't seen needs `TMDB_API_KEY` and `MDBLIST_API_KEY` (`.env.test.local` works).
- Test one file: `npx vitest run tests/simkl.test.ts`. All tests: `npm test`.
- Typecheck and lint: `npm run typecheck` (all four tsconfigs) and `npm run lint` (oxlint with a warning cap).
- Full check: `npm run check`. It runs the same steps as CI (`npm ci`, then `check:ci`: build, typecheck, lint,
  tests). It reinstalls dependencies and is slow. Run it before you merge.
- Git Bash: set `MSYS_NO_PATHCONV=1` when passing `/title/...` paths. `npx convex logs` never exits; give it a timeout.
- What failed for a user: `node scripts/logs.mjs --prod` (failures browsers reported, last 24 h; `--qa`, `--dev`,
  `--hours`, `--kind meta`). Start here when I report a bug I saw once. To log a new failure, call `logProblem` from
  `src/data/log.ts`.
- Everything else people did, saw or waited on (errors with stacks, session replays, Play's steps, stalls, load times):
  PostHog, read through its MCP or API from the Mac mini (`docs/ops.md`, "PostHog"; events in `docs/performance.md`).

## Proving a change works

- Done means you saw it work, not that it compiles. Run the feature the way a user would and look at the result.
  The `verify-krida` skill (`.agents/skills/verify-krida/`) is the recipe: QA app, driving each feature, evidence.
- A refactor or move must leave `npm run regress` green. A visible change shows up there as CHANGED; check that the
  report shows only what you meant to change.
- Playback, Simkl and anything else needing provider keys can't run on the local backend: make a disposable QA
  profile on dev (`npx convex run profiles:add`, name like `Ratings-QA-x`), run the matching script from `scripts/`,
  then remove the profile. `docs/e2e-scripts.md` lists the scripts.
- For UI changes, take a screenshot of the result. For speed changes, compare with a `main` build using `scripts/perf.mjs`.
- Tests assert exact results. Never edit or delete a test to make it pass; if the test is wrong, say so and why.
- A skipped check is not a pass. Report what you ran, what you saw and what you did not check.

## Working with me

- A question gets an answer, not an action. When I ask for a plan, plan, and wait for my go.
- Extend what exists. Propose a rewrite only in a plan.
- Edit files with your edit tool, not shell one-liners (Windows quoting breaks them).
- Sentence case for copy. Buttons say what they do.
- Answers are short: what happens now, why, and the fix, in at most 8 lines. Show UI as screenshots, before and after.
- Reproduce the exact case before fixing a bug, and leave a test or a regress step that would have caught it.
- One change per request. Ideas for later go in the plan, not the diff.
- Check live state before calling something blocked or down, and never ask me to sign in: the QA app has profiles.
- A change isn't done until it's deployed and the live site shows it, once I've said to ship.

## Code rules

Most rules fail a check when broken. The rest are judgment, so they're written here.

| Rule | What enforces it |
| --- | --- |
| Every mutation comes from `convex/functions.ts`; queries use the cached `useQuery` | oxlint `no-restricted-imports` |
| Every public Convex function has validators; none is removed or changes its arguments (the live frontend calls them) | `tests/apiSnapshot.test.ts` (update with `UPDATE_API_SNAPSHOT=1` only on purpose) |
| No cron calls Simkl | `tests/apiSnapshot.test.ts` |
| Relative imports in `shared/`, `server/`, `api/` name their `.js` file | `tsc` with Node resolution (`tsconfig.api.json`) |
| A feature imports another only through its `index.ts`; `src/ui` and `src/data` never import a feature; `shared/` and `convex/lib/` never import React or the web app | `scripts/check-boundaries.ts` (`--fix` rewrites imports and rebuilds each `index.ts`) |
| Only the Simkl outbox (`convex/lib/simklOutbox.ts`) builds a request that removes Simkl history | `scripts/check-boundaries.ts` |
| At most 12 endpoints in `api/` (Vercel's free plan deploys no more; a 13th fails the deploy) | `scripts/check-boundaries.ts` |
| Colors come from the tokens in `src/styles.css`; the brand has no hue | `scripts/check-colors.ts` |
| Tests assert exact values | oxlint jest rules on `tests/` (no `toBeDefined`, `toBeTruthy`, bare `toThrow()`…) |
| What people see doesn't change unless you meant it to | `npm run regress` |
| Functions that wipe data refuse production | `convex/lib/deployment.ts` and its tests |
| QA sign-in (a QA profile's name and password, no Clerk) answers only on local backends and dev | `qaSignInAllowed` in `convex/lib/deployment.ts`, `tests/deployment.test.ts` |
| A room's reads and writes are for its members; joining another account's party takes its link | `tests/partyInvites.test.ts`, `tests/accounts.test.ts` (the invariants of `docs/models/`) |
| Scripts drive only a local app, as QA profiles | `scripts/lib/qa.ts` (`baseUrl`, `assertQaProfile`) |
| Lint warnings don't grow | `--max-warnings` in `npm run lint`; lower the cap when you remove some |

Judgment, not checked:
- Secrets stay on the server (Convex env or Vercel env). Only `VITE_` variables reach the browser.
- Keep backend changes compatible with the live frontend: add optional fields, keep old signatures.
- Never poll Simkl on a timer. Before adding a query that reads a whole table, read `docs/database-reads.md`.
- New code goes in the feature it belongs to. Logic in `.ts`, components in `.tsx`. Move files with
  `node scripts/move.ts` and split big ones with `node scripts/split.ts`; both rewrite imports.
- UI work: use the `critly` skill (installed globally), reuse tokens and components, check empty, loading, error and
  long-content states.
- Match the surrounding code. Comments say why. No dead code.

## Safety

- No writes to production, no exports of production data, no password resets.
- No `--prod` command, deploy command or secret change without my explicit go. They live in `docs/ops.md`.
- Each worktree uses its own local backend or the shared dev one, never prod. `npm run doctor` checks both.
- Never remove a worktree you didn't create, and don't touch other threads' worktrees.
- Stop only dev servers you started, by the PID you captured.
- No secrets in code, logs, screenshots or commits.

## Git

Personal project. Once a change is verified, commit it and merge it into `main`. Pushing to `main` deploys the frontend
on Vercel and Convex with it, so run `npm run check` first and read the deploy notes in `docs/ops.md` for backend changes.
