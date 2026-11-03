# Krida for Android

A Kotlin app (`app.krida`) that opens the live site in a WebView. Private Krida's app is `tv.krida.app`, signed with
another key, so the two install side by side. Every deploy reaches it with no new APK. Only a
change under `android/` needs a new build.

The page is the whole UI, drawn edge to edge. The app tells it the status bar, navigation bar and cutout sizes
(`--android-inset-*`, which `src/styles.css` turns into `--inset-*`), because WebView's own `env(safe-area-inset-*)`
is 0 on some versions and real on others. The app adds what a page can't reach, through `window.KridaAndroid`
(`Bridge.kt`; the page's side is `src/ui/android.ts`, null in a browser): real screen brightness and media volume for the player's
swipes, volume keys that show Krida's own meter, haptics, the landscape lock, keep-screen-on, picture in picture,
back closing sheets, Krida links and the icon's Search and Library shortcuts opening in the app. A new bridge
method only works once the site that calls it is deployed, so ship the web side before handing out an APK that needs
it, and keep old methods (installed APKs keep calling them).

## Signing in

Email codes work in the WebView as on the web. Google refuses to sign anyone in inside a WebView (its page answers
`disallowed_useragent`), so in the app, Clerk's Continue with Google button opens Google in a Custom Tab instead.
The page (`src/data/appSignIn.ts`) takes the button's click, starts a Clerk sign-in whose redirect is the app's own
link `app.krida://sso-callback`, and calls `KridaAndroid.openSignIn(url)`. When Google is done, Clerk sends the
Custom Tab to that link. The manifest claims it, so Android brings `MainActivity` forward (closing the tab), and the
page hears a `signin` event with the link. It then reloads the sign-in from Clerk and signs in, or makes the account
when the Google account is new (a transfer). A callback that reaches a closed app opens `/sign-in`, which reads it
from `signInCallback()`.

Clerk's development instance takes any redirect link. A production instance only takes allowlisted ones: add
`app.krida://sso-callback` under Native applications in Clerk's dashboard before moving to it.

## Build

Needs JDK 17+ and the Android SDK (`ANDROID_HOME`; `local.properties` holds `sdk.dir`, ignored by git).

```sh
cd android
./gradlew assembleRelease   # app/build/outputs/apk/release/app-release.apk, opens https://krida-open.vercel.app
./gradlew assembleDebug -PkridaUrl=http://localhost:5551   # a debug build on a dev server
```

Raise `versionCode` in `app/build.gradle.kts` for each APK you hand out, or Android refuses to update over it.

## Signing

Release builds are signed with open Krida's own key, `~/.krida-open/krida-open-release.jks` (alias `krida-open`).
Its passwords are in `~/.krida-open/android-signing.properties`, as `storeFile` (the keystore's full path on that
machine), `storePassword`, `keyAlias` and `keyPassword`. Both stay out of the repo, on the Mac mini. Back them up:
an APK signed with any other key can't update an installed Krida. The key's SHA-256 fingerprint
(`BE:D5:89:26:...:F2:64:A5`) is in `public/.well-known/assetlinks.json`, which lets Android open Krida links in the
app. Print it with `keytool -list -v -keystore ~/.krida-open/krida-open-release.jks`. Never sign with private
Krida's `~/.krida` key.

Without the properties file, `assembleRelease` still builds but leaves the APK unsigned.

## Releases and updates

`npm run release -- "What changed"` (`scripts/release.ts`, on the Mac mini) releases the app when `android/` changed
since its last `android-v*` tag: it raises `versionCode` and `versionName`, builds the release APK signed with the key
above (so both must be in the Mac's `~/.krida-open`, with `storeFile` naming the Mac's path), publishes it as the
`android-v<name>` release of `kausthubh-coder/krida-open-releases` (never the repo's latest, which the desktop apps read),
and writes `android.json` on that repo's main branch. The landing page's Download for Android button finds the APK
in that release (`src/features/landing/releases.ts` looks through every recent release, not only the latest).

From 1.2 the app updates itself (`Updates.kt`): as it comes to the front, at most every 6 hours, it reads
`android.json`, downloads a newer APK in the background and checks its checksum. The page then offers it (a toast,
and Settings, `src/ui/appUpdate.ts`); Install sends the phone once to "allow installs from Krida", then Android's own
installer asks. Android won't install over the app without asking, and only takes an APK signed with the same key.
After the update, the page shows the release's notes once. An APK from before 1.2 is pointed at the newest one by
hand, once. `scripts/e2e-android-update.ts` walks all of it on the emulator.

## Testing on the emulator

- `emulator -avd <name> -no-window -no-audio` runs it headless; `adb exec-out screencap -p > shot.png` shows it.
- Vite listens on IPv6 only and `adb reverse` reaches the host over IPv4: run a TCP forward from `127.0.0.1:5552` to
  `[::1]:5551`, then `adb reverse tcp:5551 tcp:5552`. The debug build loads `http://localhost:5551`. Simpler: start
  Vite on IPv4 (`npx vite --port 5551 --strictPort --host 127.0.0.1`) and `adb reverse tcp:5551 tcp:5551`.
- The page's side of a change (the Google sign-in in `src/data/appSignIn.ts`, say) reaches a release APK only once
  it's deployed. Before that, try it on a debug build pointed at this checkout's Vite.
- Debug builds allow Chrome DevTools: `adb forward tcp:9339 localabstract:webview_devtools_remote_$(adb shell pidof app.krida)`,
  then `http://127.0.0.1:9339/json` lists the page to drive over CDP.
- Playback needs `npm run dev -- --shared` and a disposable QA profile on dev (AGENTS.md, Proving a change works).
- Release and debug builds are signed differently: `adb uninstall app.krida` before switching.

### On the QA app, with the Mac mini's emulator

The Mac mini has a Pixel 9 Pro emulator, `krida-pixel-9-pro` (Android 16, Google APIs, arm64). Drive its screen
through T3's device tools (`device_open`, then the `agent-device` command it returns); adb is for installs, port
forwards and logs. Remake it with the
SDK's own avdmanager (Homebrew's looks at another SDK and finds no images):

```sh
export JAVA_HOME=/opt/homebrew/opt/openjdk@17 ANDROID_HOME=~/Library/Android/sdk
$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager create avd -n krida-pixel-9-pro -d pixel_9_pro \
  -k "system-images;android-35;google_apis;arm64-v8a"
$ANDROID_HOME/emulator/emulator -avd krida-pixel-9-pro -no-window -no-audio -no-boot-anim -port 5584 &
```

Then, with `npm run qa -- up` running:

```sh
cd android && bash gradlew assembleDebug -PkridaUrl=http://localhost:<QA app port>   # bash: gradlew has no exec bit
adb -s emulator-5584 install -r app/build/outputs/apk/debug/app-debug.apk
cd .. && node scripts/e2e-android.ts emulator-5584
```

`e2e-android.ts` carries the QA app, its backend (3210, 3211) and the stand-in providers into the phone with
`adb reverse`, wipes the app's data, and drives the WebView through Playwright's `_android`. Plain
`connectOverCDP` to the WebView fails ("Browser context management is not supported"). Other agents' emulators may
be running on the same Mac (`adb devices`): pass the serial, and leave theirs alone.
