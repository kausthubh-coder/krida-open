# Architecture

## What it is

Open Krida is a streaming site anyone can use with their own keys: an account holds profiles and the TMDB, MDBList
and debrid keys they share (`convex/accounts.ts`). They search any movie, show or anime, press Play, and it streams in
the browser from the account's TorBox. Or they
watch together in a watch party with synced playback, a shared queue, chat and reactions.

It is a Netflix-style app on top of Stremio-style sources:

- **Sources:** each profile's Stremio stream addons (`convex/addons.ts`, asked in parallel, merged and ranked) → TorBox
  `createstream` → HLS in the browser. Home's catalogs come from the same addons, read by the browser
  (`src/data/addons.ts`; `/api/rows?addon=` for addons without CORS).
- **Metadata:** Cinemeta (IMDb ids) and the Kitsu addon (anime, `kitsu:` ids).
- **Discovery:** TMDB (search, people, trending, "fans also liked", genre browsing), MDBList (ratings from IMDb,
  Rotten Tomatoes, Metacritic and Letterboxd), and Simkl (each profile's own watch history).
- **Live:** https://krida-open.vercel.app. Repo `kausthubh-coder/krida`; pushing to `main` deploys the frontend on Vercel.
  Convex prod is `industrious-axolotl-949`, dev is `fastidious-oyster-35`.

## Stack

Vite 8 + React 19 + TypeScript + Tailwind v4 (tokens in `src/styles.css`, oklch), react-router 8, motion,
sonner, Phosphor icons (`*Icon` names), hls.js. Backend is Convex (queries, mutations, actions, HTTP actions, crons)
and Vercel functions (`api/`). Playwright scripts in `scripts/` drive real Chrome (Playwright's Chromium on a cloud VM, `scripts/lib/browser.ts`) for end-to-end checks and screenshots.

## What runs where

Convex holds what's yours and what has to sync: profiles, each profile's own tables, picks, parties and chat, and
the stream pipeline (it holds the TorBox key). Everything that's the same for everyone runs on Vercel, so it never
reads the database.

- **Cloudflare Worker (`workers/frames`):** the timeline's keyframes, read out of TorBox with the same code as
  `/api/frame` (`server/mkv.ts`, `server/torbox.ts`), on a free plan that doesn't bill bandwidth. A ticket from
  `/api/frames?ticket` lets a browser in for a day per file. Deploy and secrets: `docs/ops.md`.
- **Vercel functions (`api/*.ts`, code in `server/`):** search, title ratings, artwork, IMDb trailers, More like this,
  Home's catalog rows (`/api/rows`), the starter titles, and the recommender (`POST /api/recs`). Answers are cached by
  Vercel's CDN (`Vercel-CDN-Cache-Control`, per deployment) and what they ask TMDB, MDBList, Cinemeta and addons
  is kept in Vercel's runtime cache (`server/cache.ts`, per region, kept across deploys). `/api/recs` checks the
  Krida session against the deployment's Convex (prod only trusts prod). In dev, Vite runs the same functions
  (`vite.config.ts`) with keys from `.env.local`.
- **`shared/`:** plain TypeScript that the browser, Convex and Vercel all use (TMDB, MDBList, IMDb, tags, taste).
  Relative imports there and in `server/` name their `.js` file, which Vercel's Node runtime needs.
- **The browser's copy of a profile's tables** (`tracked`, `viewing`, `library`, `feedback`, `partRatings`,
  `unwatched`, `progress`): every mutation is built with `convex/functions.ts`, whose triggers note each changed row
  in `changes`; `convex/sync.ts` pulls only rows changed since a cursor, and `src/data/sync.tsx` keeps the copy in
  IndexedDB. The Library, poster statuses, Home's Simkl rows, Continue watching, Plan to watch, Settings' counts, the
  starter sheet and the recommender's taste are built from it (`src/data/rows.ts`). Optimistic changes are patches on
  the copy (`SyncStore.optimistic`) until the server's rows arrive. A title page's own queries (`progress.forTitle`,
  `simkl.forTitle`, `ratings.details`) stay Convex queries: they read one title. Changes are kept 30 days; a copy from
  before one of its profile's forgotten changes (`syncFloors`) fetches everything again.

## Where things are

| Area | Files |
| --- | --- |
| Accounts (Clerk), profiles, PINs, sessions | `convex/auth.config.ts` (the Clerk issuer), `convex/profiles.ts`, `convex/lib/auth.ts`, `convex/lib/profiles.ts`, `convex/lib/accounts.ts`, `src/data/account.ts`, `src/data/accountProviders.tsx`, `src/features/settings/ProfileGate.tsx` (sign-in and the picker), `src/data/session.tsx`; QA sign-in for scripts: `profiles.qaSignIn`, `src/features/settings/QaSignIn.tsx` |
| Stream pipeline | `convex/engine.ts`, `convex/sources.ts`, `convex/lib/providers.ts`, `convex/lib/parse.ts`, `convex/http.ts` (HLS playlist proxy) |
| Landing page (signed out at `/`) and onboarding | `src/main.tsx` (a visitor who never signed in here, `src/data/hint.ts`, gets `src/app/landingOnly.tsx` alone: no Convex, Clerk or bubli), `src/features/landing/` (pictures in `shots/`, retaken by `scripts/shots-landing.ts`; app downloads from `releases.ts`), `index.html` (description, Open Graph, `public/og.png`), `vercel.json` (`noindex` on every path but `/`). Onboarding: `convex/onboarding.ts` (`status`, `pass`, `recheck`), `src/features/onboarding/route.ts` (where to send someone, `docs/models/Onboarding.tla`'s `Route`), `src/features/onboarding/Onboarding.tsx`, the Gate in `src/app/main.tsx`; TorBox gates: `usePlayNeedsTorBox` (`src/features/play/play.ts`), `PlayNeedsTorBox` (`src/ui/needsKey.tsx`), `rooms.create` refusing `NEEDS_TORBOX` |
| Rooms and watch parties | `convex/rooms.ts` (registered functions), `convex/lib/rooms.ts` (helpers), `convex/invites.ts`, `convex/messages.ts`, `src/features/player/Watch.tsx`, `src/features/party/*`, `src/features/player/playbackSync.ts` |
| Episodes in the player (capsule button or More → a panel over the picture that opens from that button, as Party's does; E, Shift+N for next) | `EpisodesPanel` / `EpisodesView` in `src/features/party/episodes.tsx`, `SidePanel` placing it in `src/features/party/panels.tsx`, the capsule in `src/features/player/PlayerControls.tsx` and `FOLD` in `chrome.ts`, `panel` in `src/features/player/Watch.tsx` |
| The player | `src/features/player/Player.tsx` calls one hook per job, in order: `useVideo.ts` (the stream, the element, starting), `useProgress.ts` (presence, saving), `useSubtitles.ts`, `automatic.ts`, `upNext.ts`, `notes.ts` (others' actions, chat over the picture), `keys.ts` (keyboard, auto-hide), `together.ts` (holding for buffering, auto-skip). What it shows: `overlays.tsx`, `endCards.tsx`, `PlayerControls.tsx` |
| Party reactions (meme sounds, played on every device in the party) | `src/features/party/soundboard.tsx`, clips in `src/features/party/sounds/` (trimmed, normalized to -16 LUFS) |
| Public data on Vercel | `api/*.ts` (one file per endpoint), `server/` (`titles.ts` ids, ratings, similar, artwork; `search.ts`; `people.ts`; `catalogs.ts`; `moreLike.ts`; `cache.ts`; `http.ts`), `src/data/api.ts` (the browser's client) |
| A profile's tables in the browser | `convex/functions.ts` (wrapped mutations, change triggers), `convex/sync.ts`, `src/data/sync.tsx`, `src/data/rows.ts` |
| Home rows and catalogs | `server/catalogs.ts` (`/api/rows`, each row fetched at most every 6 h), `convex/recs.ts` (`rows`: this profile's picks), `convex/catalogs.ts` (`friends`), `src/features/home/Home.tsx`, `src/features/home/homeRows.ts`, `src/features/home/useHome.ts` |
| Recommendations | `shared/taste.ts` (seeds, in the browser), `server/recs.ts` and `server/score.ts` (scoring, rows), `src/features/home/recsRefresh.ts` (when to recompute), `convex/recs.ts` (`save`, `others`) |
| Search and genre browsing | `server/search.ts` (`/api/search`, `/api/search-page`), `src/features/search/Search.tsx` (Browse and results), `src/features/search/components/NavSearch.tsx` (the field in the dock on every page from 768px: suggestions with your Library first, `/` and Ctrl+K; on the Search page it hands over to the page's own field), `src/features/search/components/useSearch.ts` (shared query cache) |
| Person pages (directors, cast, crew) | `server/people.ts` (`/api/search?person=`, a name found among a title's credits first), `src/features/person/Person.tsx`; linked from a title's credits (`src/features/title/details.tsx`) and Search's person row |
| Ratings (1-10, whole title / season / episode) | `convex/ratings.ts`, `convex/feedback.ts` (legacy thumbs), `src/features/title/taste.tsx` |
| Simkl | `convex/simkl.ts` (registered functions), `convex/lib/simklApi.ts` (sessions, tokens, budget), `convex/lib/simklPull.ts` (import), `convex/lib/simklOutbox.ts` (the only place that builds requests to Simkl, removals included), `convex/lib/simkl.ts` (parsing), `src/features/settings/ConnectSimkl.tsx`, Settings → Connections |
| One title, two ids (an anime's IMDb and Kitsu ids) | `convex/lib/titleIds.ts` (the rule, used by the server and the browser), `convex/lib/mergeTitle.ts` |
| Library: collections (Plan to watch incl. the Simkl watchlist, Watching, Watched, To rate, On hold, Dropped) with one Filter button (type, genre, decade, score) that follows you between them; genres come from `library.genres` (cached `titleFacts`, read only once the filter is reached for) and missing ones are looked up via `library.fillGenres`, Stats, Wrapped | `convex/library.ts` (`simklRows`, `ownRows`, `progressRows`, `fromSimkl`), `convex/lib/libraryViews.ts`, `src/features/library/libraryData.ts`, `convex/wrapped.ts` + `convex/lib/stats.ts`, `src/features/library/Library.tsx`, `src/features/library/components/*` |
| Title page | `src/features/title/Title.tsx` |
| Private mode (the others don't see what you watch: no "has been watching" row on their Home, no solo room to join; parties still show) | `prefs.private`, `progress.private` (set per play, so it stays hidden after you turn it off), `friendRowsFor` in `convex/catalogs.ts`, `rooms.live`, Settings → Privacy, the profile menu in `src/app/nav.tsx` |
| Trailers (YouTube, just for the viewer) | `src/features/trailers/trailers.ts`, `src/features/trailers/youtube.ts`, `src/features/trailers/trailer.tsx` |
| Muted trailers on Home (behind the banner; a poster you rest on widens into its own) | `src/features/trailers/ambientTrailer.tsx`, `src/features/trailers/expandingPoster.tsx`, `src/features/trailers/trailerPlayer.ts` (IMDb files, shared YouTube players), `src/features/trailers/trailerSources.ts`, `server/trailers.ts` + `shared/imdb.ts`, `src/features/trailers/warmRow.ts`, `src/features/trailers/ambient.ts`, Settings → Play trailers on Home |
| Nav (bubble dock of icons with tooltips on wide screens, the same on phones with search beside it, back + wordmark on top) | `src/app/nav.tsx`, `src/ui/dockTip.tsx`, `src/features/search/components/NavSearch.tsx` (search inside the dock), `src/ui/lens.tsx` (the sliding lens) |
| Pages kept between visits (Home and Library stay mounted, hidden with `<Activity>`) | `src/app/Pages.tsx`, `src/app/places.ts` |
| Pages loaded after start-up (Title, Person, Search, Library, Settings) | `src/ui/lazyPage.ts`, `src/features/<name>/page.ts` |
| Shared UI | `src/ui/ui.tsx` (Button, IconButton, Segmented, EmptyState…), `artwork.tsx`, `rail.tsx`, `sheet.tsx` |
| Bubbles | bubli (`vendor/bubli-*.tgz`, from `~/dev/bubli`, whose `use-bubli` skill says how it fits an app). Krida's fit: `src/ui/bubbles.tsx` (numbers per family, `Pane`), `--bubli-*` tokens in `src/styles.css`. On it: `src/ui/ui.tsx` (Button, IconButton, Toggle), `src/ui/lens.tsx`, `src/ui/grow.tsx` (menus), `src/ui/dismiss.ts`, `src/ui/sheet.tsx`, `src/ui/toast.tsx` (Sonner holding bubbles). `glass`, `glass-thick`, `lens`, `fold` and `--ease-spring` in `styles.css` are the frosted CSS for what's too small for a bubble. |

## How a stream starts

1. `rooms.create` makes a room and schedules `engine.prepare`.
2. `prepare` asks the host profile's enabled stream addons for sources (only those whose types and id prefixes fit),
   follows the chosen source's redirects until it reaches TorBox (torrent id and
   file id), then calls TorBox `createstream`.
3. Clients load `GET <convex-site>/hls/playlist.m3u8?s=<stream>&a=<audio>&t=<session>`. The HTTP action fetches the
   playlist with the TorBox key, rewrites segment paths to absolute CDN URLs, and refreshes expired stream sessions.
   Video segments load straight from TorBox's CDN, so the key never reaches the browser.
4. Each room stores one playback anchor (position, playing, server time). Clients measure their clock offset, seek
   when more than 1 s off, and nudge the playback rate for small drift.

## API limits

- Simkl: see `docs/simkl.md`. Never poll on a timer, or the client id gets suspended.
- MDBList: free plan is 1000 requests a day; batch up to 200 ids per POST, and ratings are cached for 7 days.
- TMDB: no daily cap, but cache id mappings (`server/titles.ts` keeps them in the runtime cache).
