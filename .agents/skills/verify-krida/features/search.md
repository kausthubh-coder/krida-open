# Search

Search any movie, show, anime or person. The field lives in the dock on every page (`/` or Ctrl+K), with suggestions
that put your Library first. On a phone the places fold away and it takes the bar. The Search page also browses by genre when the field is empty.

## Sub-features

- `search-suggest` shows suggestions above the dock field as you type, your Library first.
- `search-results` lists results on `/search?q=<text>`, with more on scroll.
- `search-browse` shows genre browsing on `/search` with no query.
- `search-recent` remembers recent searches in this browser.

## How to get to it (user POV)

- The search bubble in the dock or the phone's bar, `/` or Ctrl+K anywhere. Browse is the first row of its suggestions.
- `/search` and `/search?q=<text>`.

## Driving it with Playwright

Preconditions: QA app up, signed in as `Regress-QA-one`, `/api` keys set (or run under regress).

- **Results.** Go to `/search?q=Animals`. `getByRole("link", { name: /Animals/ }).first()` shows.
- **Suggestions.** Press `/`, type `Perc`. Suggestions show above the field; Percy Jackson is in the Library.
- **Browse.** Go to `/search`; `getByRole("textbox", { name: "Search titles, people, genres and languages" })` is empty
  and genre rows show.
- **Proof.** Screenshot of results and of the suggestion list.

## Gotchas

- Results come from `/api/search` and `/api/search-page` (TMDB); without keys they're empty in the QA app.
- On the Search page the dock field hands over to the page's own field.
- On a phone a focused field needs a press elsewhere (or a blur) to fold back; the scrim behind the panel is that press.
