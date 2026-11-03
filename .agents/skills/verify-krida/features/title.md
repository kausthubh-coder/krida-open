# Title page

A movie, show or anime page: the artwork, scores (IMDb, Rotten Tomatoes, Metacritic, Letterboxd), Play or Resume,
Trailer, watch status, Rate, Plan to watch, start a party, episodes for shows, cast and More like this.

## Sub-features

- `title-resume` shows Resume with the episode and time left when the profile is part way through.
- `title-save` adds to and removes from Plan to watch.
- `title-rate` scores 1 to 10 for the whole title, a season or an episode.
- `title-status` sets Watching, Watched, On hold, Dropped, Rewatching from the status menu.
- `title-episodes` lists seasons and episodes, marks them watched.
- `title-anime` opens a Kitsu title (`kitsu:<n>`); an anime has an IMDb and a Kitsu id (`convex/lib/titleIds.ts`).

## How to get to it (user POV)

- Click any poster, a search result or `More info` on the banner.
- `/title/movie/<imdb id>` or `/title/series/<imdb or kitsu id>`.

## Driving it with Playwright

Preconditions: QA app up, signed in as `Regress-QA-one`.

- **Open.** Go to `/title/movie/tt0311113` (Master and Commander: not saved, not rated). Wait for `getByRole("heading", { level: 1 })`; its
  name is the title or its logo's alt text.
- **Save.** Click the button `Add <title> to Plan to watch or set a watch status`, then
  `getByRole("menuitemradio", { name: "Plan to watch" })`. The button becomes `Plan to watch. Change watch status for
  <title>`. Open `/library`: the title is the first card in Plan to watch.
- **Rate.** Click the button `Rate <title>`, then `getByRole("radio", { name: /^8,/ })`, then `Save changes`. The button becomes `Your
  rating: 8 out of 10. Change your rating for <title>`; reload and it still says 8.
- **Resume.** `/title/series/tt12324366` (Percy Jackson) shows `Resume S1 E2` and "15 min left" (seeded progress).
- **Proof.** Screenshots before and after each write, and the Library screenshot that reads the save back.

## Gotchas

- Play on the QA app plays the stand-ins' test video, not the title. To check real sources and files, use the dev
  backend with a `*-QA-*` profile.
- Scores, certification and More like this come from signed `/api` endpoints; on the local backend they load only
  from Vercel's cache or regress's store.
- Season and episode scores stay in Krida; only whole-title scores go to Simkl.
