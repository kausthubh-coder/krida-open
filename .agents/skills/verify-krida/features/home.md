# Home

Home is a banner that rotates through where you left off and today's top picks, then rows: Continue watching, your
picks, Plan to watch, what friends watch, and catalog rows (Netflix and Disney+ top 10s, trending, top-rated by genre).

## Sub-features

- `home-banner` rotates every 9 s (pauses on hover and focus); the dots under it switch slides.
- `home-continue` shows titles in progress with time left, newest first.
- `home-rows` shows catalog rows from `/api/rows` and personal rows from this profile's synced tables.
- `home-friends` shows what the other profile watched, unless they turned on Private mode.
- `home-card` widens a poster you rest on and plays its trailer (desktop, trailers on).
- `home-phone` shows a tab bar instead of the dock under 768px.
- `home-claude` shows Claude's lists in Top picks and "For you and…" on the real profiles (`docs/recommendations.md`). Drive it with `node scripts/e2e-picks.ts`.

## How to get to it (user POV)

- Sign in; Home is the first page.
- The house icon in the dock (desktop) or tab bar (phone). The `Krida home` link at the top.

## Driving it with Playwright

Preconditions: QA app up, signed in as `Regress-QA-one`.

- **Rows.** Wait for `page.getByRole("heading", { level: 2 }).nth(4)`. `getByRole("heading", { name: "Continue watching" })`
  is visible and its row has 8 cards.
- **Banner.** `getByRole("tablist", { name: "Featured titles" })` has one tab per slide; clicking
  `getByRole("tab", { name: "Show <title>" })` selects it (`aria-selected`).
- **Phone.** Same profile at 390x844: no dock, a bar of icons named Home, Library, Party and You, with search as its own bubble beside it.
- **Proof.** Screenshot at the top of Home and the aria snapshot of the whole page.

## Gotchas

- Catalog rows need `/api` keys in `.env.local`; without them only personal rows show in the QA app. `npm run regress`
  answers `/api` from its store, so it always has them.
- "For you" picks come from `/api/recs`, which only accepts sessions from production or a preview backend. On the
  local backend they never load; that's expected.
- The banner's trailer and poster trailers are YouTube or IMDb video; regress blocks them on both sides.
