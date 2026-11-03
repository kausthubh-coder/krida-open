# Krida verification map

One file per feature a person uses. Read the file for the feature you changed, drive every entry point it lists, and
capture the end state it names. A proof through one convenient entry point is incomplete when the file lists others.

## Baseline

- `npm run qa -- up` is running and `npm run qa -- status` says UP. Use the URL and profiles from `.qa/session.json`
  (`qaSession()` in `scripts/lib/qa.ts`).
- Desktop is 1440x900; phones are 390x844 (the tab bar replaces the dock below 768px).
- `Regress-QA-one` has: 31 titles in Plan to watch (16 movies, 10 shows, 5 anime), 12 rated movies, 6 rated shows,
  8 shows and 5 anime Watching, 2 shows Dropped, 1 On hold, 2 anime Watched, and Continue watching for 4 movies and
  4 shows at S1E2. `Regress-QA-two` has 12 saved movies, 6 ratings and 3 shows in progress. The titles are in
  `scripts/regress/titles.json`.

## Conventions

- Find elements by role and accessible name (`getByRole`), never by CSS class or position.
- After a write, prove it from a second view: reload, or open the Library, or sign in as the other profile.
- Screenshot and `ariaSnapshot()` go in `.artifacts/<task>/`.
- Say which entry points you drove and which you couldn't, and why.

## Features

| Feature | File | Regress steps |
| --- | --- | --- |
| Landing, sign-in, the profile picker and onboarding | [profiles.md](profiles.md) | `gate` (the landing page), `gate-password` (QA sign-in) |
| Home rows and the banner | [home.md](home.md) | `home`, `phone-home` |
| Title page, Plan to watch, rating | [title.md](title.md) | `title-*` |
| Library collections and the filter | [library.md](library.md) | `library*` |
| Search | [search.md](search.md) | `search-*` |
| Player and sources | [title.md](title.md) (Play) | `player`, `player-sources`, `player-skipped-intro`, `player-automatic`, `player-up-next`; two-browser sync: `scripts/e2e-party-sync.mjs` |
| Watch party | [party.md](party.md) | `party-invite`, `party-host`, `party-guest-chat` |
