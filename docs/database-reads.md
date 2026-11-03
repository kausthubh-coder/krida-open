# Database reads

Convex bills database bandwidth, and the free plan is easy to pass. Every write re-runs each query that read the
written rows, so:

- `scripts/usage.mjs` ranks functions by database reads and writes from recent logs and prints the month so far. The
  budget is about 33 MB a day. Run it with `--prod` only with the owner's go (`docs/ops.md`).
- Public data never touches Convex (see "What runs where" in `docs/architecture.md`). Home is `/api/rows` plus two small queries: `recs.rows`
  (this profile's picks; it reads the Simkl connection only for a profile with no picks yet) and `catalogs.friends`.
- A profile's own tables are pulled by what changed (`sync.pull`), so a rating reads a row or two and a play saving
  its position reads one. A browser starting fresh reads them once, page by page (`sync.snapshot`).
- `catalogs.rows`, `mine` and `home`, `library.simklRows`, `ownRows`, `progressRows`, `mine`, `overview` and `toRate`,
  `progress.started` and `continueWatching`, `simkl.status`, `feedback.starter` and `summary` remain only for tabs on
  an older build, with the `catalogCache`, `catalogRows` and `metaCache` rows they read; the old actions
  (`titles.*`, `trailers.imdb`, `recs.moreLikeThis`) forward to `/api` (`convex/legacy.ts`). Remove them once those
  tabs have reloaded, with the tables nothing uses any more (`titleInfo`, `moreLike`, and `jobs`' recs row).
- `simkl.syncState` is the connection and its sync without the library.
- Stats rebuild (about 1 MB read) only while Stats was opened in the last 15 minutes; otherwise a change hides them
  and they rebuild when Stats is next opened, or overnight (`convex/lib/statsCache.ts`, `wrapped.viewedAt`).
  `wrapped.get` is read only while Stats or Wrapped is shown.
- Source lists (about 120 KB each, mostly playback URLs) are files in Convex storage (`sourceLists.file`), so checking
  and reading one costs no database reads.
- Party housekeeping (`rooms.sweep`) books itself every 2 minutes while a room is open, with a 15-minute cron behind
  it. Every deployment, previews included, pays for each cron run with nobody watching.
- Playback writes progress at most once a minute and sends it every 30 s (`final` saves on pause, hide and exit keep
  the exact spot).
- Simkl syncs skip unchanged entries and unchanged picks aren't rewritten.
- Every `useQuery` goes through convex-helpers' query cache (kept 3 minutes after unmount); cards prefetch their
  title page on hover, and the dock's places their first queries (`src/data/prefetch.ts`).
- Home's queries and catalog rows keep their last result in localStorage (`useStoredQuery`, `useStored`,
  `src/data/stored.ts`), per session and per build, and the profile's tables live in IndexedDB; both are cleared on
  sign-out, so opening Krida shows them at once while the live result loads. Never use either for what decides access.
- Before adding a query that reads a whole table or a profile's whole library, check what writes to it and how often.
