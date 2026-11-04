// Krida for Android's own player and its TV remote, on an emulator against the QA app. The QA account switches to
// Real-Debrid (a stand-in key) and plays the stand-in debrid addon's MKV (scripts/regress/providers.ts), which the page's
// <video> can't: the app plays it itself under the page (NativePlayer.kt), with Krida's own controls over it, and
// pause and seek reach it. A TV remote there: the middle button plays, up brings the controls with focus on play, the
// arrows move between them, and Back closes a menu before it leaves the player. Then the app's player alone takes
// files with DTS and TrueHD sound, made here, and FFmpeg decodes them. Last, D-pad keys on Home move focus across a
// row and between rows, with a ring you can see.
// Pictures come from the emulator's own screen (the native picture isn't in the page), in .artifacts/android-native/.
// Puts the account back on the stand-in TorBox at the end. Needs ffmpeg, and the internet (Cinemeta).
// Usage: npm run qa -- up; cd android && bash gradlew assembleDebug -PkridaUrl=http://localhost:<QA app port>;
//   adb -s <serial> install -r app/build/outputs/apk/debug/app-debug.apk; node scripts/e2e-android-native.ts [serial] [outDir]
import { execFileSync, spawnSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { _android, type Locator } from "playwright-core";
import { checks, convexSignIn, qaSession, signIn } from "./lib/qa.ts";
import { standInDirectAddon } from "./regress/providers.ts";

const repo = resolve(import.meta.dirname, "..");
const serial = process.argv[2] ?? process.env.ANDROID_SERIAL;
if (!serial) throw new Error("Name the emulator: node scripts/e2e-android-native.ts emulator-5554 (adb devices lists them)");
const out = resolve(process.argv[3] ?? `${repo}/.artifacts/android-native`);
mkdirSync(out, { recursive: true });
const adbPath = `${process.env.ANDROID_HOME ?? `${homedir()}/Library/Android/sdk`}/platform-tools/adb`;
const adb = (...args: string[]) => execFileSync(adbPath, ["-s", serial, ...args], { encoding: "utf8" });
const shot = (name: string) => writeFileSync(resolve(out, name), execFileSync(adbPath, ["-s", serial, "exec-out", "screencap", "-p"], { maxBuffer: 64 << 20 }));
const key = (...codes: string[]) => adb("shell", "input", "keyevent", ...codes);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Files whose sound only FFmpeg decodes on this phone, from the one-minute test picture: DTS, and TrueHD.
const media = resolve(repo, ".artifacts/android-native/media");
mkdirSync(media, { recursive: true });
const SOUNDS = { dts: ["-c:a", "dca", "-strict", "-2", "-ar", "48000"], truehd: ["-c:a", "truehd", "-strict", "-2", "-ar", "48000"] };
for (const [name, audio] of Object.entries(SOUNDS)) {
  const file = resolve(media, `${name}.mkv`);
  if (existsSync(file)) continue;
  const r = spawnSync("ffmpeg", [
    "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24:duration=20", "-f", "lavfi", "-i", "sine=frequency=440:duration=20",
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", ...audio, "-ac", "2", "-f", "matroska", file,
  ], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ffmpeg couldn't make ${name}.mkv: ${r.stderr}`);
}
const files = createServer((req, res) => {
  const file = resolve(media, (req.url ?? "").slice(1));
  if (!file.startsWith(media) || !existsSync(file)) return res.writeHead(404).end();
  const size = statSync(file).size;
  const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? "");
  const start = range ? Number(range[1]) : 0;
  const end = range?.[2] ? Number(range[2]) : size - 1;
  res.writeHead(range ? 206 : 200, { "content-type": "video/x-matroska", "content-length": end - start + 1, "accept-ranges": "bytes", ...(range && { "content-range": `bytes ${start}-${end}/${size}` }) });
  createReadStream(file, { start, end }).pipe(res);
});
await new Promise<void>((done) => files.listen(0, "127.0.0.1", done));
const filesPort = (files.address() as AddressInfo).port;

const s = qaSession();
const providers = /providers (\S+)/.exec(readFileSync(resolve(repo, ".qa/providers.log"), "utf8"))![1]!;
for (const port of [new URL(s.url).port, new URL(s.convexUrl).port, new URL(s.siteUrl).port, new URL(providers).port, String(filesPort)]) adb("reverse", `tcp:${port}`, `tcp:${port}`);
const url = s.url.replace("127.0.0.1", "localhost");

// The account on Real-Debrid, playing from the stand-in debrid addon alone, as scripts/e2e-direct.ts does.
const { adminKey } = JSON.parse(readFileSync(resolve(repo, ".qa/backend/.convex/local/default/config.json"), "utf8")) as { adminKey: string };
const admin = new ConvexHttpClient(s.convexUrl);
(admin as unknown as { setAdminAuth(key: string): void }).setAdminAuth(adminKey);
const client = new ConvexHttpClient(s.convexUrl);
const ref = <T extends "query" | "mutation" | "action">(_kind: T, name: string) => makeFunctionReference<T>(name);
const setDebrid = (service: "realdebrid" | "torbox", key: string) =>
  admin.mutation(ref("mutation", "accounts:setKeysFor"), { account: "QA", keys: { debrid: { service, key } } });
const me = await convexSignIn(client, s.profiles[0]!);
type Addon = { _id: string; url: string; enabled: boolean };
const addons = async () => (await client.query(ref("query", "addons:list"), { token: me.token })) as Addon[];
const direct = standInDirectAddon(providers);
const NIGHT = "tt0063350";

adb("shell", "pm", "clear", "app.krida");
adb("shell", "am", "start", "-W", "-n", "app.krida/.MainActivity");
const device = (await _android.devices()).find((d) => d.serial() === serial);
if (!device) throw new Error(`${serial} isn't attached (adb devices)`);
const page = await (await device.webView({ pkg: "app.krida" })).page();
const { check, finish } = checks(page);

/** What the app's player has said (`player` events), gathered in the page from here on. */
const listen = () =>
  page.evaluate(() => {
    const w = window as unknown as { heard: Record<string, unknown>[] };
    w.heard = [];
    addEventListener("krida-android", (e) => {
      const detail = (e as CustomEvent<Record<string, unknown>>).detail;
      if (detail.type === "player") w.heard.push(detail);
    });
  });
const heard = () => page.evaluate(() => (window as unknown as { heard: Record<string, unknown>[] }).heard);
const lastOf = (events: Record<string, unknown>[], name: string) => events.filter((e) => e.name === name).at(-1)?.value;
/** Where the picture is, from the app's own reports. */
const position = async () => {
  const events = await heard();
  return { at: Number(events.filter((e) => typeof e.time === "number").at(-1)?.time ?? 0), paused: lastOf(events, "pause") !== false };
};
/** A finger on `target`, where the emulator's screen shows it: quicker than the controls hiding again. */
const tapOn = async (target: Locator) => {
  const at = await target.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round((r.left + r.width / 2) * devicePixelRatio), y: Math.round((r.top + r.height / 2) * devicePixelRatio) };
  });
  adb("shell", "input", "tap", String(at.x), String(at.y));
};
const until = async (ok: () => Promise<boolean>, timeout = 60_000) => {
  for (const end = Date.now() + timeout; Date.now() < end; await sleep(500)) if (await ok()) return true;
  return false;
};

try {
  await setDebrid("realdebrid", "stand-in-real-debrid");
  if (!(await addons()).some((a) => a.url === direct)) await client.action(ref("action", "addons:install"), { token: me.token, url: `${direct}/manifest.json` });
  for (const a of await addons()) await client.mutation(ref("mutation", "addons:setEnabled"), { token: me.token, addonId: a._id, enabled: a.url === direct });

  // From the start: the test film is a minute long, and an earlier run's place in it would leave too little to play.
  const night = { type: "movie", imdbId: NIGHT, videoId: NIGHT, name: "Night of the Living Dead", year: "1968" };
  await client.mutation(ref("mutation", "progress:save"), { token: me.token, media: night, position: 0, duration: 60, final: true });
  await signIn(page, url, s.profiles[0]!);
  await page.getByRole("navigation").first().waitFor({ timeout: 60_000 });
  check("the app has its own player (1.4)", await page.evaluate(() => typeof (window as { KridaAndroid?: { playerLoad?: unknown } }).KridaAndroid?.playerLoad === "function"));

  // 1. The MKV, picked from the source list, plays in the app's own player instead of being sent elsewhere.
  await page.goto(`${url}/title/movie/${NIGHT}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Choose a source" }).click({ timeout: 60_000 });
  const sheet = page.getByRole("dialog");
  await sheet.getByText("1080p").first().waitFor({ timeout: 30_000 });
  await listen();
  await sheet.locator("li").filter({ hasText: "1080p" }).first().getByRole("button").first().click();
  await page.waitForURL(/\/watch\//, { timeout: 30_000 });
  const plays = await until(async () => {
    const p = await position();
    return p.at > 3 && !p.paused;
  }, 90_000);
  const state = await page.evaluate(() => ({
    elsewhere: !!document.evaluate("//h2[contains(., 'plays outside the browser')]", document, null, XPathResult.BOOLEAN_TYPE).booleanValue,
    seeThrough: document.documentElement.hasAttribute("data-desktop-video"),
    pageVideo: document.querySelector("video")?.currentSrc ?? "",
  }));
  const events = await heard();
  check("the MKV plays in the app's own player, under a see-through page", plays && !state.elsewhere && state.seeThrough && !state.pageVideo, JSON.stringify({ ...(await position()), ...state }));
  check("ExoPlayer decodes its picture and sound", !!lastOf(events, "video-decoder") && !!lastOf(events, "audio-decoder"), `${lastOf(events, "video-decoder")} / ${lastOf(events, "audio-decoder")}`);
  shot("native-mkv-picture.png");
  // A finger on the picture brings the controls up over it.
  const { width, height } = await page.evaluate(() => ({ width: innerWidth * devicePixelRatio, height: innerHeight * devicePixelRatio }));
  adb("shell", "input", "tap", String(Math.round(width / 2)), String(Math.round(height / 3)));
  await sleep(700);
  // On a phone the one-capsule layout's play button sits in the middle of the picture, without the key in its name.
  const pause = page.getByRole("button", { name: /^Pause( \(Space\))?$/ }).filter({ visible: true }).first();
  check("Krida's own controls are over the picture", await pause.isVisible());

  // Pause and seek go through Krida's controls to the app's player, pressed with a finger, before the controls hide.
  await tapOn(pause);
  await sleep(1500);
  shot("native-mkv-controls.png");
  const paused = await position();
  await sleep(1500);
  const still = await position();
  check("Pause stops the app's player", paused.paused && Math.abs(still.at - paused.at) < 0.3, JSON.stringify([paused, still]));
  await tapOn(page.getByRole("button", { name: "Forward 10 seconds" }).filter({ visible: true }).first());
  const sought = await until(async () => (await position()).at >= paused.at + 9, 20_000);
  check("Forward 10 seconds moves the app's player", sought, JSON.stringify(await position()));
  shot("native-mkv-paused.png");

  // 2. In the player, the remote: the middle button plays, up brings the controls with play focused.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  key("KEYCODE_DPAD_CENTER");
  const resumed = await until(async () => !(await position()).paused, 10_000);
  check("the remote's middle button plays", resumed, JSON.stringify(await position()));
  await sleep(3500);
  key("KEYCODE_DPAD_UP");
  await sleep(1000);
  const focused = await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? "");
  check("up brings the controls with play focused", /^(Pause|Play)( \(Space\))?$/.test(focused), focused);
  key("KEYCODE_DPAD_RIGHT");
  await sleep(600);
  const moved = await page.evaluate(() => ({ label: document.activeElement?.getAttribute("aria-label") ?? "", ring: !!document.activeElement?.matches(":focus-visible") }));
  check("right moves focus to the next control, ringed", moved.label === "Forward 10 seconds" && moved.ring, JSON.stringify(moved));
  const before = await position();
  key("KEYCODE_DPAD_CENTER");
  const forward = await until(async () => (await position()).at >= before.at + 8, 15_000);
  check("the middle button presses the focused control (forward 10 seconds)", forward, JSON.stringify([before, await position()]));
  shot("native-remote-controls.png");

  // Back closes a player menu before it leaves the player.
  await tapOn(page.getByRole("button", { name: /^Subtitles/ }).filter({ visible: true }).first());
  await sleep(800);
  const menuOpen = await page.locator('[aria-haspopup][aria-expanded="true"]').count();
  key("KEYCODE_BACK");
  await sleep(1000);
  const afterBack = { open: await page.locator('[aria-haspopup][aria-expanded="true"]').count(), path: new URL(page.url()).pathname };
  check("Back closes the player's menu and stays in the player", menuOpen === 1 && afterBack.open === 0 && afterBack.path.startsWith("/watch/"), JSON.stringify({ menuOpen, ...afterBack }));

  // 3. FFmpeg's sounds, in the app's player alone: DTS and TrueHD, which this phone has no decoder for.
  await page.goto(`${url}/`, { waitUntil: "domcontentloaded" });
  await page.getByRole("navigation").first().waitFor({ timeout: 30_000 });
  for (const [name, mime] of [["dts", "audio/vnd.dts"], ["truehd", "audio/true-hd"]] as const) {
    await listen();
    await page.evaluate((link) => (window as unknown as { KridaAndroid: { playerLoad(...a: unknown[]): void } }).KridaAndroid.playerLoad(link, 0, false, 1, "Sound test"), `http://127.0.0.1:${filesPort}/${name}.mkv`);
    const decoded = await until(async () => {
      const e = await heard();
      return Number(e.filter((x) => typeof x.time === "number").at(-1)?.time ?? 0) > 2 && !!lastOf(e, "audio-decoder");
    }, 30_000);
    const e = await heard();
    const decoder = String(lastOf(e, "audio-decoder") ?? "");
    check(`${name.toUpperCase()} sound plays through FFmpeg`, decoded && /ffmpeg/i.test(decoder) && lastOf(e, "audio-format") === mime, `${decoder} ${lastOf(e, "audio-format")} ${lastOf(e, "error") ?? ""}`);
    await page.evaluate(() => (window as unknown as { KridaAndroid: { playerStop(): void } }).KridaAndroid.playerStop());
  }

  // 4. Home with a remote: the arrows move focus across a row and down to the next, with a ring.
  await page.goto(`${url}/`, { waitUntil: "domcontentloaded" });
  await page.locator("[data-rail]").first().waitFor({ timeout: 30_000 });
  await sleep(1500);
  const where = () =>
    page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      const r = el?.getBoundingClientRect();
      return { label: el?.getAttribute("aria-label") ?? el?.textContent?.slice(0, 40) ?? "", rail: el?.closest("[data-rail]") ? [...document.querySelectorAll("[data-rail]")].indexOf(el.closest("[data-rail]")!) : -1, x: Math.round(r?.left ?? 0), y: Math.round(r?.top ?? 0), ring: !!el?.matches(":focus-visible"), outline: el ? getComputedStyle(el).outlineWidth : "" };
    });
  // From nothing focused, down lands on the first thing on screen; down again reaches a row of cards.
  for (let i = 0; i < 6 && (await where()).rail < 0; i++) {
    key("KEYCODE_DPAD_DOWN");
    await sleep(500);
  }
  const first = await where();
  check("down reaches a row of cards", first.rail >= 0, JSON.stringify(first));
  key("KEYCODE_DPAD_RIGHT");
  await sleep(700);
  const right = await where();
  check("right moves to the next card in the row", right.rail === first.rail && right.x > first.x && right.label !== first.label, JSON.stringify(right));
  check("the focused card has a 3px ring", right.ring && right.outline === "3px", JSON.stringify(right));
  shot("dpad-home-row.png");
  key("KEYCODE_DPAD_DOWN");
  await sleep(900);
  const down = await where();
  // The page scrolls the row into the middle of the screen, so only the row says where focus went.
  check("down moves to the next row", down.rail === right.rail + 1, JSON.stringify(down));
  shot("dpad-home-next-row.png");
  key("KEYCODE_DPAD_UP");
  await sleep(900);
  const back = await where();
  check("up goes back to the card you left in the row above", back.label === right.label, JSON.stringify(back));
  key("KEYCODE_DPAD_LEFT");
  await sleep(700);
  const left = await where();
  check("left moves back along the row", left.label === first.label, JSON.stringify(left));

} catch (error) {
  check("the run reaches its end", false, String(error).split("\n")[0]);
} finally {
  await setDebrid("torbox", "regress-torbox");
  for (const a of await addons()) {
    if (a.url === direct) await client.mutation(ref("mutation", "addons:remove"), { token: me.token, addonId: a._id });
    else await client.mutation(ref("mutation", "addons:setEnabled"), { token: me.token, addonId: a._id, enabled: true });
  }
  files.close();
  finish();
}
// Closing the device connection waits on adb indefinitely; the run is over.
process.exit(process.exitCode ?? 0);
