# How recommendations work

Seeds per profile come from four places:

- What the profile watched in Krida. Recent and finished titles count most (30-day half-life).
- What it saved to Plan to watch.
- Its own ratings. Love counts most; Not for me is excluded and pushes similar titles down.
- Its Simkl library. Ratings count most, old history ages slowly, dropped or rated 4 or lower is excluded.

Candidates are the cached catalog rows, TMDB's recommendations for the top 20 seeds, and well-voted titles in each
language the profile watches (`tmdb:lang:*` rows, never shown on Home). Each candidate is scored on:

- how strongly the seeds' fans liked it (TMDB). Lists that cross languages from a regional seed barely count.
- resemblance to the seeds (genres, cast, director, writer)
- quality (MDBList score)
- popularity

That score is weighed by fit: the profile's mix of worlds (anime, Indian cinema, other languages; `cultureOf` in
`server/score.ts`) and era (titles much older than what it watches drift down). Titles under IMDb 6 never make a row; Top
picks and For you two need 6.5. Top picks keep about the profile's mix of anime, films and shows, and skip
franchises it has already watched. Because rows stay in their seed's world.

Picks are then diversified (MMR) and limited to one title per franchise, so a row isn't ten versions of one thing
or three recap films of a show you've seen. Anime seeds (Kitsu ids) use their IMDb id from Simkl for TMDB. Rows: Top picks, Because you watched (×2),
For you and <friend>, and taste-based genre rows. Home also shows Still watching and the Simkl watchlist, TMDB
trending, Netflix's Top 10 and the profile's addon catalogs. The first eight of those catalogs (their IMDb titles, up to
150) also go to `/api/recs` as candidates beside Krida's own rows.

A profile with nothing to go on sees "Make Krida yours" on Home: connect Simkl, or rate a few well-known titles (the
starter set is TMDB's most-voted per genre, `/api/starter`).

Picks are worked out in the browser's refresher (`src/features/home/recsRefresh.ts`): it builds the profile's taste from its
synced tables (`shared/taste.ts`), sends it with the others' tastes (`recs.others`) to `POST /api/recs`, and saves the
rows and the taste (`recs.save`, which rewrites nothing when they're unchanged). It recomputes when the taste's digest
changes (a minute after the last change, at least two minutes apart), when another profile's taste changes (for "For
you and…"), and when picks are 6 hours old (the catalogs move on), a few seconds after Krida opens. Nothing reads a
profile's history from the database for this.
