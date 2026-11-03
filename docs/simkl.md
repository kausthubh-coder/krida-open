# Simkl sync (both ways)

The registered functions live in `convex/simkl.ts`; the helpers in `convex/lib/`: `simklApi.ts` (sessions, token refresh, the daily budget), `simklPull.ts` (import), `simklOutbox.ts` (Krida → Simkl, the only place that builds a request, removals included; `scripts/check-boundaries.ts` enforces it) and `simkl.ts` (parsing).

- **Simkl → Krida.** The first import is the full library, one type at a time, with watched episodes
  (`extended=full&include_all_episodes=yes`). If Simkl says `max_items`, it splits by status.
  After that, Krida reads `/sync/activities` and fetches only the buckets that moved (`date_from` deltas,
  ratings delta, ids-only diff for removals).
  - It runs while someone uses Krida: on open and when the tab comes back to the front, at most every 10 minutes
    (`touch`), or on Sync now.
  - Plan to watch titles are mirrored into Plan to watch (`library.source = "simkl"`).
- **Krida → Simkl.** These changes go into the `syncOutbox` table:
  - finishing a movie or episode
  - marking or unmarking episodes in a title's episode list (`progress.mark`; the check on each row, "Mark season
    watched"). Unmarking removes just that play (`/sync/history/remove` with seasons and episodes), and a pull
    before it's sent keeps the episode unmarked. While rewatching, plays and marks stay in Krida and the list
    counts only this time through.
  - adding to Plan to watch
  - removing from Plan to watch, only if the title is just planned on Simkl, so no history is lost

  How the outbox behaves:
  - Changes wait 45 s and are sent as one request per kind (`/sync/history`, `/sync/add-to-list`,
    `/sync/history/remove`), at least 1.2 s apart (Simkl allows one write a second).
  - Opposite list changes before sending cancel out.
  - Failures retry with exponential backoff; a change is dropped after 8 attempts or if Simkl rejects it (4xx).
- **Ratings.** The picker saves exact integer scores from 1 to 10. Whole-title scores sync with Simkl, newest wins.
  - `feedback.rating` stores the exact score; `feedback.value` remains a legacy band for old clients.
    Existing thumbs migrate on read to 3, 7, or 9; imported exact scores keep their original number, including 5.
  - Saving a movie score records it in Watched locally and queues a watch event if it was not already completed.
  - Show rating is separate from show status. Watching preserves episode progress. Explicit Done sends a
    whole-show completion. Season/episode scores live in `partRatings`; the selected watched part syncs to Simkl.
  - Rewatching lives in `viewing` and preserves canonical watched episodes. Krida does not send Simkl rewatch
    sessions, which need PRO/VIP, an opt-in and session ids.
  - Statuses Simkl has no list for keep their name in Krida and send the nearest list (`simklListFor`):
    Rewatching shows as Watched, and a movie's Watching or On hold as Plan to watch (Watched if Simkl has it so).
    Nothing is sent when Simkl already has that list, and Simkl reporting it doesn't replace the Krida status.
  - Clearing a score keeps watch history and a null timestamp tombstone. All sends require write-back enabled.
  - Ratings-only deltas patch ratings and dates without replacing episode counts or watch progress.
  - The starter sheet leads with watched-but-unrated Simkl titles.
    It freezes the opening batch until dismissal so saving cannot shift or remove cards under the pointer.
  - A Simkl `not_found` response leaves a visible per-title warning; a 2xx response alone is not proof of acceptance.
- **Scheduling.** All send runs are booked through `book()` (one booking at a time). Queries that need the time
  take it as an argument, because Convex caches query results and a query that reads `Date.now()` can answer stale.
  - The sender claims an immutable batch before HTTP. Editing a claimed row creates a new row, so an old
    acknowledgment cannot delete the newer change. Retried rows keep this protection because a failed response
    does not prove Simkl did not apply the request.
  - Bookings carry a scheduler id and are canceled/replaced when needed. Backoff and exhausted budgets move the
    booking to the allowed time. Turning write-back off pauses pending sends; turning it on resumes them.
  - Disconnect/reconnect drops old-account pending changes. Sync callbacks carry the connection timestamp so an
    old run cannot overwrite a new connection's tokens, imported history, or Plan to watch.
  - A batch of thumbs books one pending recommendation refresh per profile.
- **One title, two ids.** An anime opens by its IMDb id from Home, Search and TMDB, and by its Kitsu id from the
  Kitsu addon and the import. When one tracked entry carries an IMDb id (`tracked.imdb`), that id is its alias
  (`convex/lib/titleIds.ts`); an IMDb id shared by several entries (one per season) stays its own title.
  - Choices about the whole title (Plan to watch, status, whole-title score) are written under the tracked id and read
    under both; "I didn't watch this" is written under both. Plays, episode marks and season or episode scores stay
    under the id they were made with, since Kitsu entries number episodes flat.
  - Once a pull has landed (`simkl.mergeAfterPull`, so a second season sharing the IMDb id can arrive first), rows
    saved under the IMDb id join the entry (`convex/lib/mergeTitle.ts`). `library.mergeAliases` (a dry run unless
    `dryRun: false`) does the same for rows saved before this existed.
  - The link lives in `tracked`, so disconnecting Simkl drops it: rows keep their Kitsu ids and nothing is lost.
- **Order and conflicts.** Each sync pushes first, then pulls. A pull never overrides a list change that is still
  waiting in the outbox.
- **Budget.** Simkl's allowance is per user (500 a day on free) and shared with their other apps. Krida counts its
  requests (`connections.usage`) and stops at 250 a day. A 429 sets `backoffUntil` from Retry-After.
  A normal day is a handful of requests; the full import is about 4.

Simkl redirect URLs registered on the Simkl app are exactly `https://krida-open.vercel.app/connect/simkl` and
`http://localhost/connect/simkl`. Local dev on :5173 can start the flow but can't finish it.

Never poll Simkl on a timer, or the client id gets suspended.
