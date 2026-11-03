# Library

Your titles in collections: Plan to watch (including the Simkl watchlist), Watching, Watched, To rate, On hold,
Dropped, plus Stats and Wrapped. One Filters button (type, genre, decade, score) follows you between collections.

## Sub-features

- `library-collections` lists each collection with its count, in a side list (desktop) or tabs (phone).
- `library-filter` narrows by type, genre, decade and score; the button shows how many filters are on.
- `library-search` searches inside the Library.
- `library-stats` shows time watched and Wrapped by year.

## How to get to it (user POV)

- The Library icon in the dock or tab bar; `/library`.
- `?tab=rate` opens To rate.

## Driving it with Playwright

Preconditions: QA app up, signed in as `Regress-QA-one`.

- **Collections.** Go to `/library`; wait for `getByRole("heading", { name: "Plan to watch", exact: true })`.
  `getByRole("navigation", { name: "Library" }).getByRole("link")` has one link per collection, each ending in its
  count. Plan to watch shows 31.
- **Switch.** Click the `Watching` link; the URL stays under `/library` and the heading changes.
- **Filter.** Click `getByRole("button", { name: /^Filters/ })`; `getByRole("dialog", { name: "Filter your Library" })`
  opens. Choose `Anime`; the button reads `Filters, 1 on` and only anime remain. `Clear filters` resets it.
- **Proof.** Screenshot and aria snapshot of each collection you touched, and of the filtered result.

## Gotchas

- Genres for the filter come from `library.genres` and are looked up on first use; the first open can be slow.
- Stats runs `wrapped.compute`, an action that fetches title details from Cinemeta on the backend.
