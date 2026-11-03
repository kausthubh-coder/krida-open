---
name: verify-krida
description: "Drive Krida (the streaming web app in this repo) in a real browser to prove a change works: start it on a throwaway local backend with seeded QA profiles, use the changed screen like a person would, capture an accessibility snapshot and a screenshot, and run the regression gate that proves nothing else changed. Use before saying any change to Krida is done, after a refactor or move, and when a screen looks wrong."
---

# Verify Krida

Two tools, both on this machine and never on dev or production data:

- **`npm run qa -- up`** starts Krida with this checkout's code against a throwaway local Convex backend, seeded with
  two QA profiles that have real-sized libraries. Use it to see and drive your change.
- **`npm run regress`** walks every screen on the base commit and on your working tree and fails if anything a person
  sees differs. Use it to prove a change you meant to be invisible (a refactor, a move, a dependency bump) is invisible,
  and to see exactly what a visible change changed.

## Doctor

Run `npm run doctor` first in a new worktree and whenever something looks off. It must show PASS for Dependencies,
.env.local, Dev port, Convex HTTP and Browser. `npm run doctor -- --fix` copies a missing `.env.local` from the main
checkout. Doctor is read-only otherwise.

## Launch

```sh
npm run qa -- up        # prints the URL, e.g. http://127.0.0.1:55762, and the two profiles
npm run qa -- up --real # no stand-ins and no keys: add real keys in Settings → Connections (scripts/e2e-keys.ts)
npm run qa -- status    # UP or DOWN, with the PIDs it started
npm run qa -- down      # stops both processes by PID and deletes the backend's data
```

- Ready when `up` prints `Krida is up at <url>`; `status` exits 0 while the page answers.
- Profiles: `Regress-QA-one` (the main one: 31 titles in Plan to watch, ratings, Watching, Dropped, On hold, Continue
  watching) and `Regress-QA-two` (a smaller library, so friend rows have data). The password is printed by `up` and
  stored in `.qa/session.json`. It is local-only, not a secret.
- Vite hot-reloads your edits. Backend edits in `convex/` need `down` then `up` (the local backend loads functions
  once; seeding takes about a minute).
- Only one QA app or regress run at a time: both use the local backend's ports 3210 and 3211.
- Keys belong to accounts: both QA profiles are in the account "QA". `/api` (catalog rows, search, title ratings) asks
  with that account's TMDB and MDBList keys, which `up` seeds from `TMDB_API_KEY` and `MDBLIST_API_KEY` in `.env.local`
  (placeholders without them: those parts then load empty). `npm run regress` doesn't need them.
- Play works: a stand-in stream addon (installed on both QA profiles), TorBox and IntroDB (`scripts/regress/providers.ts`) give every title three
  sources and a one-minute test video with an intro from 0:02 to 0:12. Real files, real sources lists, subtitles,
  Simkl and anything else that needs the owner's keys can't run locally: use the dev backend with a disposable
  `*-QA-*` profile (AGENTS.md, "Proving a change works") and remove it after.

## Drive

Use Playwright (`playwright-core`) through `launchBrowser` from `scripts/lib/browser.ts`: Chrome where it's installed,
else Playwright's Chromium (a cloud VM's, headless). Helpers in `scripts/lib/qa.ts`:

```ts
import { launchBrowser } from "./lib/browser.ts";            // from scripts/
import { checks, qaSession, signIn } from "./lib/qa.ts";

const s = qaSession();                                       // URL and profiles from `npm run qa -- up`
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const { check, finish } = checks(page);                      // fails the script on a failed check or a page error
await signIn(page, s.url, s.profiles[0]);                    // refuses non-local URLs and non-QA profiles
```

Run a script like this with `node scripts/<name>.ts`. Stable handles, from the app's accessible names:

- Sign in: `signIn` from `scripts/lib/qa.ts` (the `/qa` page: textbox `QA profile`, textbox `Password`, button
  `Sign in as QA profile`); signed in when link `Krida home` shows. Real Clerk sign-in and the profile picker:
  `features/profiles.md`.
- Home: rows are level-2 headings. Title page: `/title/movie/<imdb id>` or `/title/series/<id>`, heading = the title.
- Plan to watch (title page): button `Add <title> to Plan to watch or set a watch status` opens menu `Watch status for
  <title>`; menuitemradio `Plan to watch` saves it, and the button becomes `Plan to watch. Change watch status for
  <title>`.
- Rate: button `Rate <title>`, the radio whose name starts `8,`, then `Save changes` (cards save on the tap alone); the
  button becomes `Your rating: 8 out of 10.
  Change your rating for <title>`.
- Library: `/library`, navigation `Library` with one link per collection (name ends in its count), button `Filters`
  opens dialog `Filter your Library`. Search: `/search?q=<text>`, field `Search titles, people, genres and languages`.
  Settings: `/settings`.

The feature map in `features/` lists each feature's entry points and end states. Read the file for the feature you
changed before driving it.

## The apps

A change to the player, `src/data/desktop.ts`, `src/ui/android.ts` or anything under `desktop/` or `android/` also
needs the app it touches. Both run against the QA app on the Mac mini.

- **Krida for Android**: the `krida-pixel-9-pro` emulator, a debug APK pointed at the QA app, then
  `node scripts/e2e-android.ts emulator-5584`. Steps and setup: `android/README.md`, "On the QA app".
- **Krida for Mac** (the Windows app's Mac build): `cd desktop && npx tauri build --debug --bundles app`, then start
  `src-tauri/target/debug/bundle/macos/Krida.app/Contents/MacOS/krida` with `KRIDA_URL=<QA app URL>/watch/<room>`
  and `KRIDA_SILENT=1`. No script can drive its page (no CDP in WKWebView). Drive it with computer use: Codex, run
  from a scratch folder with `codex exec --dangerously-bypass-approvals-and-sandbox "<task>" < /dev/null`
  (without `< /dev/null` it waits on stdin forever). Read mpv's state from its socket. `docs/desktop.md`, "Krida for
  Mac", has the commands.
- **Updates**: `node scripts/e2e-android-update.ts emulator-5584` (an older APK updates to a newer one through the
  real install prompts) and `node scripts/e2e-desktop-mac-update.ts` (a Mac test app replaces itself and reopens).
  Run the one for the app you touched whenever its updater, its version or `scripts/release.ts` changes.
- **Krida for Windows** itself (`scripts/e2e-desktop.ts`, its installer) runs only on the Windows laptop.

## Evidence

- Put screenshots and snapshots in `.artifacts/<task>/` (ignored by git), named after what they show.
- Capture the action and its result: the screen before, the screen after, and `await page.locator("body").ariaSnapshot()`
  of the result. For a write (save, rate, status), reload or open a second screen that reads it back.
- Drive the real path a person uses. Don't call mutations directly to stand in for clicking.
- Show UI changes as images in your reply, before and after.

## Regression gate

```sh
npm run regress                    # base = HEAD, so it checks your uncommitted change
npm run regress -- --base main     # or any commit with the same package-lock.json
```

- It checks out the base under `.artifacts/regress/base-tree`, runs each side on its own fresh local backend with the
  same seed, and walks the steps in `scripts/regress/walk.ts`: the signed-out screen (built without Clerk there), QA sign-in, Home, three title pages, Search,
  every Library collection, the filter, Settings, saving and rating a title, the player (paused at 0:30, the sources
  sheet, the intro skipping itself), Home on a phone, and a party in two browsers.
- Outside data (`/api`, artwork, Cinemeta) comes from `.artifacts/regress/network/`. A response it hasn't seen is
  fetched once: `/api` GETs from the side that asks first (the base) through its own local `/api`, other GETs from
  where they point. The live site's `/api` answers only signed-in accounts, so recording needs `TMDB_API_KEY` and
  `MDBLIST_API_KEY` (environment, else `.env.test.local`, else `.env.local`); the run seeds them as the QA account's
  keys. A full store needs none. `--offline` refuses anything new. Trailers and every POST are refused the same way on
  both sides.
- PASS means every step's accessibility tree is identical and under 0.2% of pixels changed, with no new page errors.
  Read `.artifacts/regress/report.html` for side-by-side screenshots, a red difference image and the tree diff.
- What never counts as a change: Convex ids, clock times like `6:44 PM`, and the pixels inside an image showing the
  same file in the same box on both sides (blue in the difference image; Chrome sometimes paints a big backdrop late).
  Pages see the time the store was recorded (`.artifacts/regress/network/meta.json`), so "Updated 1 h ago" holds.
  Delete `.artifacts/regress/network/` to record fresh data; both sides of the next run then share the new store.
- A change you meant to make shows up as CHANGED. Check the report shows only that, and say so when you report.
- Takes about 5 to 10 minutes. It removes the base worktree and both backends when it ends, pass or fail.
- When you add a screen or a feature, add a step to `walk.ts` so the gate covers it.

## Cleanup

- `npm run qa -- down` stops only the two processes `up` recorded. Never stop processes by name.
- Evidence in `.artifacts/` stays. Logs stay in `.qa/`.
- If a run was killed midway: `git worktree list` may show `.artifacts/regress/base-tree`; the next `npm run regress`
  removes it, or run `git worktree remove --force .artifacts/regress/base-tree`.
