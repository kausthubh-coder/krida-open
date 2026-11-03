# Krida for Windows

`desktop/` is a Tauri 2 app (identifier `app.krida`, product name Krida) that opens the live site in a window and plays the picture with mpv instead of the
page's `<video>`. Everything apart from playback is the site itself, so the app has every feature the web has as soon
as the site deploys. Parties mix freely: the app, the web and phones share one room clock.

Why mpv: the web plays TorBox's HLS, which for a 4K Dolby Vision film is an 8-bit H.264 re-encode with Dolby Vision
dropped and the audio turned into AAC. The app plays the original file (HEVC 10-bit, Dolby Vision, TrueHD and Atmos),
decoded on the GPU and tone-mapped by libplacebo for whatever screen it's on. `scripts/e2e-desktop-quality.ts`
measures both.

## How it fits together

- **Start page** (`desktop/offline/index.html`): dark at once, moves on to Krida when it answers, says so offline.
  Krida is `https://krida-open.vercel.app` unless `KRIDA_URL` names another.
- **Bridge** (`BRIDGE` in `desktop/src-tauri/src/main.rs`, run first on every page): sets `window.kridaDesktop`
  (version, home, `fullscreen(on)`), makes the window's full screen follow the page's, and adds F11 and Esc. WebView2
  leaves both keys to the app.
- **Open in full screen** (Settings, Display and sound, from 0.1.8): the app keeps it as a file, `open-fullscreen` in
  its config folder (in `KRIDA_DATA_DIR` for a test run), through `open_fullscreen` and `set_open_fullscreen`, and
  builds its window full screen, so it opens that way before any page loads. A page can only go full screen from a
  press, so the window can be full screen while the page isn't; the bridge's `isFullscreen` and `setFullscreen` let
  the site show it and leave it (`src/ui/fullscreen.ts`), and its `kridafullscreenchange` event says when it changes,
  including from the system (a Mac's green button). The page leaving its own full screen (a trailer's) leaves the
  window's only when the page's put it there. `scripts/e2e-desktop-fullscreen.ts` checks the bridge in Chrome.
- **mpv** (`desktop/src-tauri/src/mpv.rs`): `mpv.exe` (fetched by `desktop/scripts/fetch-mpv.mjs`, pinned) runs as
  its own process, draws into the app's window under the page, and talks JSON IPC over a named pipe. The page calls
  `mpv_load`, `mpv_seek`, `mpv_set` (an allowlist of properties) and `mpv_stop`, and hears `mpv` events. A job object
  ends mpv with the app. mpv starts when the player opens (`mpv_warm`, from 0.1.5), while the file's link is fetched,
  and stays idle between titles. Its compiled shaders are kept in the app's cache folder (`mpv-shaders`): without
  them, every new mpv spent about half a second compiling before the first picture (0.6 s to 0.1 s from the file
  opening, measured on the owner's Windows laptop; more for HDR). The site is remote, so `capabilities/default.json` lists the origins allowed to call these and
  `build.rs` declares them.
- **The site's side**: `src/data/desktop.ts` tells the app from a browser. In the player,
  `src/features/player/desktop.ts` has `MpvVideo`, which stands in for the `<video>` element with the properties and
  events party sync, skips and the controls use, and `useDesktopStream`, which gets the file's link from
  `desktop:fileLink` and makes the page see-through while mpv plays (`html[data-desktop-video]` in `src/styles.css`,
  outside the CSS layers so it beats `<html class="bg-page">`). In the app, `currentScreen()` says `app`, and Krida's
  pick goes for the best file rather than the one that survives TorBox's conversion: HDR and Dolby Vision, remuxes
  up to 60 Mbps, lossless audio (`scoreOf` in `convex/lib/rank.ts`). A party gets that pick only when everyone in it
  is in the app.

- **Updates** (`desktop/src-tauri/src/update.rs`, Windows from 0.1.3, Mac from 0.1.4): the app looks for a newer version as it opens and every
  6 hours, in the public `kausthubh-coder/krida-open-releases` repo (`latest.json` of its latest release; the code's repo is
  private, so the app couldn't read its releases). It downloads it in the background and checks it against the
  public key in `tauri.conf.json`. Then it installs when that can't stop a film: at once if it was found as the app
  opened, before anything played, or when the site's Restart is pressed (a toast outside the player, and Settings),
  or as the app closes, without opening it again. From 0.1.7, Check for updates (Settings and the profile menu) looks
  at once (`update_check`); a version it finds waits for Restart. Windows gets the installer; a Mac a new `Krida.app`, after which
  the app opens itself again. The site hears where it stands through `update_status` and the `update` event
  (`useDesktopUpdate` in `src/data/desktop.ts`, shared with Android's in `src/ui/appUpdate.ts`). An app older than
  0.1.3 can't update itself, so the site offers its users the releases page, once. After an update, the site shows
  the release's notes once ("What's new", `useWhatsNew`), which the build carries (`KRIDA_RELEASE_NOTES`).

- **Signing in** (`desktop/src-tauri/src/signin.rs`): email codes work in the window. Google refuses to sign anyone
  in inside WebView2 or WKWebView, so in the app the page (`src/data/appSignIn.ts`, which the bridge's `signIn: true`
  turns on) takes the click on Clerk's Continue with Google. It asks the app for a link to come back to
  (`sign_in_listen`: a page the app serves on `http://127.0.0.1:<free port>/sso-callback` for 10 minutes), starts a
  Clerk sign-in that redirects there, and has the app open Google in the computer's browser (`sign_in_open`, https
  only). When Google is done, Clerk sends the browser to that page, which says to go back to Krida. The app brings
  its window forward and sends the page a `signin` event, and the page finishes the sign-in, or makes the account
  when the Google account is new. Clerk's development instance takes any redirect; a production instance needs the
  loopback link allowlisted (Clerk dashboard, Native applications) before moving to it.

A change to the site reaches the app with the next deploy. A change under `desktop/` needs a release (below), which
bumps the version itself.

Another debrid service (Real-Debrid, AllDebrid, Premiumize…): the profile's addon gives a link that redirects to the
file itself, and the stream is that link (`streams.direct`, built in `engine.ts` with `resolveDirect`), not a TorBox
torrent. `desktop:fileLink` follows it afresh each time and hands the app the file's link, which holds no API key; mpv
plays it as it does TorBox's. A browser plays such a file itself only when it's MP4 or WebM with codecs it has
(`src/features/player/playsIn.ts`); otherwise the room offers the app and external players (`elsewhere.tsx`). In a
party, a member of another account can't have the host's file, so the app plays the room's HLS in the page instead of
mpv (`ownFile` in `rooms.get`). `scripts/e2e-desktop-direct.ts` checks the Mac app on the QA app.

Subtitles drawn by mpv rise with the controls, as the page's own do: while they show, the page sets mpv's
`sub-margin-y` to clear them (`liftSubtitles`, from 0.1.6), in mpv's 720-line units. A file that has ended and holds
its last frame may not redraw at once on a Mac; mid-film it does.

Dropped connections and TorBox's 429s: mpv alone retries a few times at once and then ends the film. From 0.1.6 it
passes ffmpeg's reconnect options (`--stream-lavf-o`), which keep trying with growing waits for about a minute while
the player shows it's buffering. Checked against a server that drops the first connection and answers 429 five times:
without them the film ended at 2.7 s; with them it recovered and played on.

Subtitles: the player's menu offers the file's own tracks (TorBox lists them when a stream starts, kept as the
stream's `subtitles`) above OpenSubtitles. mpv draws a file track, set through `sid` and `sub-delay`; Krida draws
OpenSubtitles over the picture as on the web. The web can't show file tracks: TorBox's browser stream carries only
H.264 and AAC, with or without a subtitle index in its URL (checked October 2026). A pick is kept per title on the
device as its language, or off (`subtitleMemory.ts`), so the next episode starts in that language: its own track in
the app, OpenSubtitles on the web.

Picture (fit, crop, stretch, original): the web scales its `<video>`, which can't reach mpv's picture, so in the app
`MpvVideo.setFit` sets mpv's own `panscan` (crop), `keepaspect` (stretch) and `video-unscaled` (original), as Nuvio
and Stremio Kai do. The app allows those from 0.1.1; an older install gets no Picture menu (`mpvFits`), since its
mpv would refuse them. V steps through them in the player, and the one chosen is kept on the device (`krida.fit`).

Picture quality: mpv scales with spline36 (sharper than its default for a 1080p film on a 1440p screen) and debands,
evening out the stepped colour compression leaves in skies and dark scenes, as Nuvio's Windows app does on a
discrete GPU. "Smooth colour banding" in the Picture menu and Settings turns deband off (`krida.deband`, from 0.1.3,
`mpvDebands`). Not taken from Stremio Kai: its default colour grade (the film's colours, changed), SVP motion
smoothing and Anime4K, which cost a laptop's integrated GPU more than they give. Settings has a Krida for Windows
section with the version, where updates stand, and the same picture settings as the Picture menu.

Blacks: with Windows in SDR, mpv targets gamma 2.2 and assumes a 1000:1 screen unless told otherwise. True black stays
0, but it raises everything just above it, which an OLED shows plainly. `--target-contrast=inf` (from 0.1.9) stops
that. Measured on a Dolby Vision frame of Beef S2 E4 against the file's own light: the darkest pixels 3x too bright
before, the median 1.45x; both within 8% after. An LCD adds its own black on top either way. With Windows in SDR the
picture is still mapped to BT.709 and SDR brightness, so a Dolby Vision or HDR film needs Windows' HDR on (Win+Alt+B)
to use an OLED's highlights and colour.

Black bars built into a film: many widescreen films are stored in a 16:9 frame with black bands above and below, so
on a screen wider than 16:9 the picture is boxed in on all four sides. While a film plays, `MpvVideo` asks the app
how lit each row and column of the frame is every 2 seconds of film (`mpv_frame_light`: mpv's own screenshot of the
decoded frame, read at about 960x540, one at a time), and `bars.ts` settles where the picture ends: the thinnest bars
any frame has shown. A dark frame can only show bars too thick, but a bright shot with dark edges (a street at night,
a lit doorway) looks like bars while it lasts. So bars settle only once they've held for 20 seconds of film with 4
bright frames among them, only one pair is trimmed (above and below, or the sides), and only if the picture left is
within 1% of a shape films are made in. Anything else leaves the film whole, as does a frame lit to its edges. Then
the file's own `video-crop` trims them once, and every Picture mode fits the film without them. The switch is in the
Picture menu and Settings, on unless turned off, and remembered on this computer (`krida.trimBars`); B switches it in
the player. When it gives up without knowing (bars in no film's shape, a film too dark to tell, mpv not answering),
the menu says so and points at Crop, rather than saying the film has none. The app can from 0.1.2 (`mpvTrims`).

What it can't tell: a shot holding the same film-shaped dark edges for over 20 seconds is trimmed to them. A trim
stays for the whole film, so later IMAX scenes keep the first shape's trim, and burned-in subtitles that first show
in the bar after it are cut. A bright picture lit to the frame's edges (a full-frame studio logo) leaves the film
untrimmed.

## Krida for Mac

The same app builds on a Mac and is released beside Windows, for Apple Silicon. It isn't signed with an Apple
Developer ID or notarized (it's signed ad hoc), so a first install by hand asks: open it, then System Settings,
Privacy & Security, Open Anyway. Updates don't ask. Its identifier is `app.krida`; private Krida's is
`app.krida.desktop`, so both install side by side (each as `Krida.app`, so in different folders). The site calls it Krida for Mac (`platform` in the bridge, `desktopName` in `src/data/desktop.ts`).

- **mpv** (`desktop/src-tauri/src/mpv_mac.rs`): macOS can't put one process's window inside another's, and libmpv
  there ignores `--wid`, so mpv runs inside the app as libmpv. A release carries it in `Contents/Frameworks` with
  every library it needs and MoltenVK, the Vulkan driver it draws through (`desktop/scripts/bundle-mac.mjs`, signed
  ad hoc); a build without them uses Homebrew's (`brew install mpv`) or `KRIDA_LIBMPV`. It opens a window of its own, which the app makes a borderless child window under its own, the size
  of its content area, ignoring clicks; it moves with the app's window and is resized with it (`mpv::window_changed`).
  It takes the same options as on Windows and talks the same JSON IPC, over a Unix socket in `$TMPDIR`
  (`krida-mpv-<pid>-<n>.sock`). `mpv_windows.rs` is the Windows side.
- **See-through page**: WKWebView draws no background only with Tauri's `macos-private-api` (`Cargo.toml`,
  `app.macOSPrivateApi` in `tauri.conf.json`), and even then it paints white under a see-through page until the
  window's background colour is cleared as well (`main.rs`). Neither changes anything on Windows.
- **Build**: `cd desktop && npm ci && npx tauri build --debug --bundles app` makes
  `src-tauri/target/debug/bundle/macos/Krida.app`, on Homebrew's mpv. `tauri.macos.conf.json` drops the Windows
  mpv.exe and the installer, and `fetch-mpv.mjs` skips itself.
- **Run on the QA app**: `KRIDA_URL=<QA app URL> KRIDA_SILENT=1 Krida.app/Contents/MacOS/krida`. KRIDA_URL may be a
  `/watch/<room>` link, so the app opens straight on a film once signed in, or
  `/qa?name=<QA profile>&password=<its password>&next=/watch/<room>`, which signs in first: nothing can type into the
  app's page.
- **Testing**: WKWebView has no CDP, so `scripts/e2e-desktop.ts` can't drive it. Computer use can (Codex on the Mac
  mini), but only for the `.app` bundle: it can't attach to the bare `target/debug/krida`. A
  terminal agent had no Screen Recording permission, so `screencapture` failed there; on 2026-11-03 it works from
  Claude Code on the Mac mini, and `screencapture -o -l <window id>` pictures the app's window alone. Computer use
  runs as `codex exec --dangerously-bypass-approvals-and-sandbox "<task>"` from a scratch folder. mpv's own state comes from its
  socket: `printf '{"command":["get_property","hwdec-current"]}\n' | nc -U -w 1 $TMPDIR/krida-mpv-<pid>-1.sock`.
  `KRIDA_DATA_DIR` doesn't separate sign-ins here (WKWebView has no data folder to point at); it still keeps the run
  from handing over to another open Krida.

## Links into the app

From 0.1.11 the app answers `krida://<page>` links (`desktop/src-tauri/src/links.rs`, `tauri-plugin-deep-link`):
`krida://title/movie/tt1254207` opens `/title/movie/tt1254207` in the app's window, starting the app when it isn't
open; a link while it runs reaches the open window (single-instance with its `deep-link` feature). Only paths on the
app's own site open; anything else is ignored. A Mac learns the scheme from the bundle's Info.plist
(`plugins.deep-link` in `tauri.conf.json`), Windows from the installer and `register_all` at each start.

In a browser, the player's "Open in the desktop app" (shown when the browser can't play the file,
`src/features/player/elsewhere.tsx`) sends the title's link through `openInDesktopApp` (`src/data/desktop.ts`). A
browser says nothing when no app takes a link, so when the page keeps its focus for 1.5 s a toast offers the download
(the app may be missing, older than 0.1.11, or the browser may still be asking whether to open it, so the toast asks
rather than says it failed). `scripts/e2e-direct.ts` checks that toast.

Try it on a Mac: build the `.app` (above), open it once so Launch Services registers it, then
`open 'krida://title/movie/tt1254207'`. `/usr/libexec/PlistBuddy -c 'Print :CFBundleURLTypes' Krida.app/Contents/Info.plist`
shows the scheme.

## Build and release

```sh
npm run release -- "What changed, one line"     # from the repo, on main as it is on GitHub
```

`scripts/release.ts` releases every app whose own folder changed since its last release tag: `desktop/` for Krida for
Windows and Mac, `android/` for Krida for Android (`android/README.md`). It bumps the version, builds each signed,
and publishes them to `kausthubh-coder/krida-open-releases`: for the desktop, the Windows installer, the Mac app packed for
the updater, a `.dmg` to install it from, their signatures and `latest.json`, as the `desktop-v<version>` release,
the repo's latest. Then it commits the versions, tags them in this repo and pushes main. `--dry-run` says what would
go out; `--only desktop` releases one app regardless. Installed apps take it within 6 hours or at their next start.
The landing page's download buttons link straight to the newest `.dmg`, `.exe` and `.apk` among the recent releases.

It runs on the Mac mini: it builds the Mac app there and cross-builds the Windows one with tauri's cargo-xwin
runner (its header lists the tools). Updates are signed with open Krida's own key, `~/.krida-open/krida-open-updater.key`
there (no password; made 2026-11-03, never private Krida's `~/.krida` key). Losing it means no installed app takes
another update: they'd need a new installer by hand. The public key in `tauri.conf.json` is its other half
(`~/.krida-open/krida-open-updater.key.pub`).

### Windows, built last on the laptop

Open Krida's first releases are Mac only: `npm run release -- "notes" --no-windows` builds and publishes the Mac app
with a `latest.json` that names only `darwin-aarch64`, and the landing page says Windows is coming soon. To add
Windows to that release, on the Windows laptop, in a checkout of `main` at the release commit (its
`tauri.conf.json` names the released version):

1. Copy `krida-open-updater.key` from the Mac mini's `~/.krida-open/` to `%USERPROFILE%\.krida-open\` by hand
   (never through the repo or a chat).
2. Have Rust (MSVC), Node and `gh` signed in, then `npm ci` in the repo and in `desktop/`.
3. `node scripts/release.ts --add-windows`. It fetches mpv, builds the NSIS installer with `npx tauri build`, signs
   it for the updater, adds `windows-x86_64` to the release's `latest.json`, uploads the installer, its signature
   and that `latest.json` to the same `desktop-v<version>` release, and renames it "Krida for Windows and Mac".

Later releases can build both on the Mac mini again (without `--no-windows`) once the cross-build is set up there.

The Windows installer isn't code-signed: SmartScreen asks on a first install by hand (More info, then Run anyway).
Updates don't ask. It installs per user and needs no admin rights.

## Testing it quietly

The owner keeps working while tests run, so every run is silent and out of sight:

- `KRIDA_SILENT=1` gives mpv no sound device. `KRIDA_WINDOW_POS=-3000,0` puts the window off-screen and unfocused,
  and `KRIDA_WINDOW_SIZE=1376,576` gives it a screen's shape (an ultrawide's, there). Windows makes no window wider
  than the desktop, so a size past a laptop's screen comes out narrower and loses the shape.
  `KRIDA_DATA_DIR` keeps the test's sign-ins apart, and the run from the Krida the owner may have open (without it, a
  second launch hands over to that window and brings it forward). Put it outside the repo, where Vite's file watcher
  doesn't trip on it.
- `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>` lets playwright drive the page over CDP.
  Pick a port other than 9339, which the Studi nightly uses.
- `desktop/scripts/capture.ps1` pictures the window even when it's covered or off-screen (`-Client` for the inside).
- Real full screen would take over the screen. Replace `window.kridaDesktop.fullscreen` to record the calls instead;
  Tauri's own `__TAURI__` objects are frozen, so stubbing them silently does nothing.
- `scripts/e2e-desktop.ts` (QA app) and `scripts/e2e-desktop-quality.ts` (dev, real TorBox) are the checks.
- Updates: a debug build never looks for one unless `KRIDA_UPDATE_URL` names a `latest.json`, and a run with
  `KRIDA_DATA_DIR` never installs, since the installer replaces the Krida in `%LOCALAPPDATA%\Krida`. To try a real
  install, build a renamed copy twice, at two versions (`npx tauri build --config` with another `productName` and
  `identifier`, and `plugins.updater.dangerousInsecureTransportProtocol` for a local server), install the older, and
  start it with `KRIDA_UPDATE_URL` pointing at a `latest.json` for the newer. It installs into its own folder.

## Things learned the hard way

- TorBox answers 429 to a file's links for a while after many reads of the same file in a row. Space out runs.
- A source plays only as fast as the connection: a 74 Mbps remux buffers on a 70 Mbps line in any player. In the
  app, Krida's ranking marks files over 60 Mbps as buffering and picks a lighter 4K file.
- Node gives each of a host's addresses 250 ms to connect. On a busy Windows machine with no IPv6 that fails against
  Convex; scripts that call it raise the limit with `setDefaultAutoSelectFamilyAttemptTimeout`.
- mpv's own Windows media controls are off: a pause from them would happen behind the party's back.
- mpv's `video-target-params` changes every frame (it carries the live HDR peak); observing it floods the page.
- mpv's `cropdetect` filter refuses frames the GPU decoded ("Impossible to convert between the formats"), and mpv's
  own autocrop script turns GPU decoding off to feed it, which stutters a 4K film. Its screenshot of the frame
  works with GPU decoding, takes 50 to 150 ms for 4K, and dropped no frames in testing.
- A `video-crop` change while playing waits for the frame on screen to finish, and the wakeup for that can be lost
  (mpv's VO loop skips it while a redraw is pending): the picture froze in about a quarter of changes on a file
  without sound, until the next command came. A file with sound never froze in 50 changes, since the audio keeps
  waking mpv. Films have sound.
