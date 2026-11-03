# Performance

## Speed

- Play is prepared before it's pressed. A title page fetches the sources its Play button would use (`sources.warm`,
  AIOStreams only). Resting the pointer on any Play button for 300 ms prepares the whole stream, TorBox included
  (`useWarmOnHover` → `rooms.warm`). One fetch per source list and one build per episode run at a time
  (`sourceFetches`, `streamBuilds`); a Play that arrives meanwhile waits for it and shows its step. Source lists can
  be hundreds of KB, so freshness and waiting read `sourceFetches`, and the list itself is a file.
- A prepared stream starts at once for 3 hours. For 30 days after that (TorBox keeps a file that long after its
  last download), Play restarts the same file with one `createstream` call instead of searching again, and falls
  back to a full build if TorBox has dropped it. Daily crons drop source lists after 2 days and streams nobody
  started in 30 days (`sources.sweep`, `engine.sweep`, batched).
- TorBox re-encodes every file to 8-bit H.264 but keeps HDR as HDR (PQ, BT.2020), and a browser on an SDR screen
  (or an HDR one with HDR off in Windows) squeezes it into SDR dark and dull. So each device sends its screen
  (`dynamic-range`, `src/ui/screen.ts`) with Play, warm-ups, the source list and heartbeats; an SDR screen ranks
  HDR files below SDR copies (`rank.ts`), a room plays SDR if anyone there is on SDR (`screenFor` in `convex/lib/rooms.ts`),
  and prepared streams are kept per screen (`rankedFor`). Test HDR in Chrome with `--force-color-profile=hdr10`.
- Going back to Home or the Library doesn't lay them out again: a kept page you've left is `content-visibility: hidden`, which keeps its layout, where `display: none` (and so `<Activity>`) throws it away. Press to next frame, Library → Home on a production build at 4× CPU throttling, median of 10 runs a side alternating on the QA backend: 115 → 72 ms on a phone-sized window, 150 → 71 ms on a desktop one; in Firefox without throttling, 65 → 50 ms. Layout was the limiter: the bubble code's first read of `offsetWidth` after the switch took 82 to 113 ms of self time at 1×, and 2 ms after.
- Rows render only what's in reach (`Rail`): two cards while far down the page (enough to hold the row's height),
  then about two screens' width, more as they scroll. Posters become springs only when one opens.
- A poster opening into its trailer lays out once, then only moves things (`expandingPoster.tsx`): the row's cards
  glide by FLIP on CSS transitions whose easing is the spring (`String(spring(...))`), which the compositor runs.
  Don't animate a width or a scroll position per frame there.
- Trailers on Home play IMDb's own trailer file in a plain `<video>` when the title has one (about 88% do):
  nothing is drawn over it and it starts in about 0.3 s. `trailers.imdb` asks IMDb's GraphQL API (undocumented;
  it needs `x-imdb-client-name`, and only IMDb's own sites may call it from a browser) for up to 30 titles at once.
  Nothing is stored: the links are signed for about a day, and the browser keeps them until they expire.
  - Otherwise YouTube, cropped like Hayase: the frame is 200 px taller than the picture, so YouTube's title bar and
    logo strip (drawn at the frame's edges) fall outside it, and it shows as soon as it plays. Its pause button in
    the middle stays for the first 3 s of playback; nothing can crop that, and no setting turns it off.
  - The banner and the posters each keep one YouTube player (`trailerPlayer.ts`) and move it into the next slot
    with `moveBefore`, which doesn't reload a frame (re-parenting any other way does). Browsers without
    `moveBefore` get a player per trailer. A poster player is only warmed for rows with a title IMDb lacks.
  - A mouse entering a row asks IMDb about its titles (`useWarmRow`); a rest of 100 ms starts the trailer hidden.
  - Measured on dev (Chrome, 1440 px): a poster opens about 470 ms after the pointer settles and its trailer shows
    about 80 ms later (median 0.55 s; 3.9 s with YouTube alone, which hid until its overlay faded).
- Under a playing film the player redraws only when something on screen changes. Subtitles change the line when a
  cue starts or ends (a timer to the next one, `nextCueChange`), not on every frame; a loop per frame kept the page
  drawing 60 times a second. Clocks tick only while something counts down (floating chat, a switch request). Measured
  on a production build in headless Chrome, controls hidden: main-thread work fell from about 46 to 20 ms a second
  with subtitles on, and 30 to 21 without (`useVideoState`'s half-second time is what's left).
- The player's own time changes only as playback crosses a mark something compares it with (`playerMarks` in
  `together.ts`: each skip's start and last second, a minute in, Up next's last 40 s), not every half second; the
  auto-skip watches the video's `timeupdate` itself. The timeline follows the film only while the controls show and
  catches up as they come back. Measured on the Mac mini, production build, headless Chrome, controls hidden,
  subtitles off, 5 interleaved runs: main-thread work 13.0 to 5.7 ms a second (ranges 11.5–13.9 and 3.7–6.3),
  layouts 4 to 0 a second. A tick between two marks doesn't even ask React (`follow` in `useVideo.ts` compares with
  a ref): an update that comes out the same still renders the player whenever React can't skip it at once, which
  was most of the once-a-second renders left. React's own performance tracks (a Chrome trace of the dev build, the
  "Scheduler ⚛" track) name the event behind each render; what's left under a playing film is a Convex update and
  the marks themselves.
- Buttons revealed on hover blur what's behind them only while shown (`data-card` / `data-hover-reveal` in
  `styles.css`). A `backdrop-filter` is a compositor layer even when transparent; Home had hundreds.
- Don't read layout (`offsetLeft`, `getBoundingClientRect`) in a layout effect that runs on navigation: the new
  page is half built, so the browser lays it out twice. The lens (`lens.tsx`) measures on the next frame, and
  only the nav the screen shows is mounted (the dock from 768px, the tab bar below).
- Home and Library are kept (`Pages.tsx`), so going back to them re-runs effects but builds nothing. Rows skip
  layout off screen (`content-visibility: auto` on `Rail`), so measure a row in a ResizeObserver callback, not
  in an effect: reading `scrollWidth` there lays out the row it was skipping (86 ms across Home). Status menus
  build their options only once their trigger is reached for (`watchStatus.tsx`); Home had 600 hidden buttons.
- Switching pages has no fade: one over the whole page composites every glass surface on it per frame and
  dropped frames on each switch. The dock never changes shape on scroll or navigation; the lens is the motion.
- The first load is Home and the shell. Title, Search, Library and Settings are their own chunks (`lazyPage` in
  `src/ui/lazyPage.ts`, one `page.ts` per feature) that download once the browser is idle after start-up, so
  opening one is still instant. A feature's `index.ts` re-exports its page from `page.ts`, never from the page's
  file: a static import of the page file anywhere puts it back in the first load. The player stays out until Play.
- Icons keep only the weights Krida draws (regular, bold, fill; `iconWeights` in `vite.config.ts`). Phosphor ships
  six per icon, which was 167 KB of the first load. `scripts/check-boundaries.ts` fails on any other weight.
- Hashed files under `/assets/` are cached for a year (`vercel.json`); only `index.html` is checked on each visit.
  Before, every visit re-checked the whole bundle with Vercel before it could run.
- `scripts/perf.mjs` times cold loads and interactions in Chrome against a production build (dev backend, a
  disposable `Perf-QA-*` profile); `--play` adds real TorBox plays. When comparing builds, click the nav by role
  or position: Home has other links to `/library` far down the page, and Playwright scrolls to whichever it finds.

## What PostHog measures

Real numbers from both people's devices, every platform (`docs/ops.md`, "PostHog", for access). Each event carries
`platform` (web, web app, android, mac 0.1.x, windows 0.1.x), `build` (commit) and `environment`.

| Event | Sent by | What it says |
| --- | --- | --- |
| `page_ready` | `useReadyTiming` in Home, Title, Search | ms from opening the screen to its data; `coldStart` marks the first screen of a load, with `sinceStart` |
| `$web_vitals` | posthog-js | LCP, INP, CLS, FCP per page |
| `play_timing` | `features/player/playTiming.ts` | from Play pressed: when each step began (`steps`), `readyMs`, `firstFrameMs`, outcome (played, error, left) |
| `play_build` | `convex/engine.ts` | the same Play on the server: steps, every copy tried (`attempts`: ms, slowest host, why it failed), outcome |
| `playback_health` | `features/player/playTiming.ts` | per 5 min of watching and at close: stalls and their ms, waits after seeking, dropped frames, size, mpv or not |
| `api_call` | `src/data/api.ts` | every `/api` call from the browser: path, status, ms, CDN `cache` |
| `api_request` | `server/telemetry.ts` | every `/api` function run: status, ms, each upstream host's ms (`upstream`) |
| `meta_call` | `src/data/cinemeta.ts` | Cinemeta's ms and tries |
| `problem`, `$exception` | `src/data/log.ts`, both telemetry helpers | every `logProblem` and every error, with the replay around it |

## Artwork, scores and card sizes

Artwork: `Art` replaces a failed Metahub image (it has none for many regional films) with TMDB's, via
`/api/artwork` (by IMDb id, then exact title; `server/titles.ts`). Cards show scores through
`src/ui/scores.tsx`, built on `publicScores` in `src/ui/scoreValues.ts` (the title page's formats).

Card sizes come from `--poster-w` and `--wide-w` in `styles.css`. From 1024px a poster follows the screen's height
(184px on a laptop, up to 288px), so big and ultrawide screens show larger posters and more of them while keeping
about two and a half rows in view. Grids use the same sizes (`grid-posters`, `grid-wide`), as many columns as fit.

## Bubbles

The numbers below measured the soap film bubli replaced; `e2e-glass` holds its behaviour and `node scripts/perf.mjs` its load. bubli's own measurements are on its `/performance` page. What still holds: a bubble only draws when something happens to it, and nothing repeated gets one.

To price a glass change, compare GPU and compositor busy time against a `main` build in a Chrome trace (`toplevel` category); frame rates won't show it, headless Chrome holds 60 fps either way. The glass classes, tokens and files are in the Liquid glass row of the map in `docs/architecture.md`.

The soap film, measured on 2026-11-01: production builds on the QA backend, Home at 1440×900 at 2×, Chrome on the Mac mini at a load of about 8 to 10 on 10 cores, median of 5 alternating runs. Busy time per second on the page, GPU and compositor threads, with Bubble glass off, the engine glass it replaced, and the film:

| | Off | Engine glass | Film |
| --- | --- | --- | --- |
| Sitting on Home | 133 ms | 164 ms | 84 ms |
| Moving the pointer across the dock | 95 ms | 121 ms | 261 ms |
| Scrolling Home | 277 ms | 303 ms | 286 ms |
| Film playing, controls showing | 248 ms | 281 ms | 102 ms |

No version dropped a video frame, and the film adds 15 KB gzipped overall, loaded after first paint. Controls no longer blur, which is most likely why the film beats Bubble glass off at rest and during playback: GPU time during a film is 322 ms against 1,125 ms over 8 s. Hover is the one place it costs more, because the control under the pointer redraws every frame while it wobbles. A film that draws all the time is what makes it expensive: letting every film's oil drift cost 180 draws a second, so at rest nothing draws (`film.ts`). Don't give it a backdrop of the page: `html-to-image` failed on Home in all 15 tries, and the first took over 3 s. A canvas you've drawn yourself is fine (Krida's pick).

- Libraries sit in chunks of their own (`codeSplitting` in `vite.config.ts`: react, convex, motion, hls), so a deploy
  that changes only Krida leaves them cached. Measured as bytes for one visit (sign in, Home, a title, a film
  playing): 541 KB gzipped on a first visit either way; after a one-string change to Home, 383 KB to fetch again with
  one bundle, 140 KB split. Most of Krida's own chunks still change hash with any edit (rolldown carries hashes
  through imports), which is the next thing to look at.
