// Krida for Android on an emulator, against the QA app: the app opens the QA app, signs in, hears its bridge
// (window.KridaAndroid) and isn't taken for the desktop app, a film plays in the page's <video> (the stand-in's test
// file), the controls have the same feel as the web, and Settings has no desktop app section. Pictures come from
// the emulator's own screen, as a person sees it.
// It wipes the app's data on the emulator first, so each run starts signed out.
// Usage: npm run qa -- up; cd android && bash gradlew assembleDebug -PkridaUrl=http://localhost:<QA app port>;
//   adb -s <serial> install -r app/build/outputs/apk/debug/app-debug.apk; node scripts/e2e-android.ts [serial] [outDir]
// The serial is the emulator's (adb devices), default ANDROID_SERIAL. android/README.md says how to make one.
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { _android } from "playwright-core";
import { checks, convexSignIn, qaSession, signIn } from "./lib/qa.ts";

const repo = resolve(import.meta.dirname, "..");
const serial = process.argv[2] ?? process.env.ANDROID_SERIAL;
if (!serial) throw new Error("Name the emulator: node scripts/e2e-android.ts emulator-5554 (adb devices lists them)");
const out = resolve(process.argv[3] ?? `${repo}/.artifacts/android`);
mkdirSync(out, { recursive: true });
const adbPath = `${process.env.ANDROID_HOME ?? `${homedir()}/Library/Android/sdk`}/platform-tools/adb`;
const adb = (...args: string[]) => execFileSync(adbPath, ["-s", serial, ...args], { encoding: "utf8" });
const shot = (name: string) => writeFileSync(resolve(out, name), execFileSync(adbPath, ["-s", serial, "exec-out", "screencap", "-p"], { maxBuffer: 64 << 20 }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const s = qaSession();
// The debug build opens localhost, which adb reverse carries to this machine: the app, its backend and the stand-in
// providers serving the film. 127.0.0.1 in the page would be the phone itself.
const providers = /providers http:\/\/127\.0\.0\.1:(\d+)/.exec(readFileSync(resolve(repo, ".qa/providers.log"), "utf8"))![1]!;
for (const port of [new URL(s.url).port, new URL(s.convexUrl).port, new URL(s.siteUrl).port, providers]) adb("reverse", `tcp:${port}`, `tcp:${port}`);
const url = s.url.replace("127.0.0.1", "localhost");
adb("shell", "pm", "clear", "app.krida");
adb("shell", "am", "start", "-W", "-n", "app.krida/.MainActivity");

// A room of its own each run (one from an earlier run may have ended), for the film the desktop e2e plays.
const film = JSON.parse(readFileSync(resolve(repo, "scripts/regress/titles.json"), "utf8")).movies[36];
const client = new ConvexHttpClient(s.convexUrl);
const { token } = await convexSignIn(client, s.profiles[0]!);
const media = { type: "movie", imdbId: film.id, videoId: film.id, name: film.name, year: film.year, poster: film.poster };
const room = await client.mutation(makeFunctionReference<"mutation">("rooms:create"), { token, media, screen: "sdr" });

const device = (await _android.devices()).find((d) => d.serial() === serial);
if (!device) throw new Error(`${serial} isn't attached (adb devices)`);
const page = await (await device.webView({ pkg: "app.krida" })).page();
const { check, finish } = checks(page);
check("the app opens the QA app", page.url().startsWith(url), page.url());
await signIn(page, url, s.profiles[0]!);
// The emulator is slower than a phone: wait for the row itself, and say how long it took.
const homeAt = Date.now();
await page.locator('[aria-label^="Resume "]').first().waitFor({ timeout: 30_000 }).catch(() => {});
console.log(`Continue watching showed ${Date.now() - homeAt} ms after sign-in`);
await sleep(1000);
shot("home.png");
check("Home shows after sign-in", await page.getByRole("navigation").first().isVisible(), page.url());
check("the page hears the Android bridge", await page.evaluate(() => !!(window as { KridaAndroid?: unknown }).KridaAndroid));
check("the page doesn't take itself for the desktop app", await page.evaluate(() => !(window as { kridaDesktop?: unknown }).kridaDesktop));
// The WebView (Chrome 124 on this image) sized a caption in a card's button to its text, so a long title ran into
// the next card. Every caption must fit its card, and the seeded row has long ones.
const captions = await page.locator('[aria-label^="Resume "]').evaluateAll((cards) =>
  cards.map((card) => ({ name: card.getAttribute("aria-label"), card: Math.round(card.getBoundingClientRect().width), caption: Math.round(card.querySelector("p")!.parentElement!.getBoundingClientRect().width) })),
);
check("Continue watching titles stay inside their cards", captions.length > 0 && captions.every((c) => c.caption <= c.card), JSON.stringify(captions.filter((c) => c.caption > c.card)));

// The feel, not only the look: with Bubble glass on (the default) the app has what the web has. A real finger held on a
// button bounces bigger; the selected tab's lens is a bubble, and a switch's knob held turns into a lens that swells past
// its track. Off, the app goes back to its earlier plain controls.
const hold = async (selector: string, read: (el: Element) => unknown) => {
  const box = await page.evaluate((sel) => {
    const r = document.querySelector(sel)!.getBoundingClientRect();
    return { x: (r.left + r.width / 2) * devicePixelRatio, y: (r.top + r.height / 2) * devicePixelRatio };
  }, selector);
  // Read in the page, frame by frame, for as long as the finger is down: on an emulator that draws a few frames a second,
  // a read from out here can arrive after the finger has lifted.
  await page.evaluate(([sel, source]) => {
    const el = document.querySelector(sel!)!;
    const reader = (0, eval)(source!) as (el: Element) => unknown;
    const w = window as unknown as { heldRead: unknown };
    w.heldRead = null;
    let down = false;
    let lifted = false;
    addEventListener("pointerdown", () => (down = true), { once: true, capture: true });
    addEventListener("pointerup", () => (lifted = true), { once: true, capture: true });
    const frame = () => {
      if (lifted) return;
      if (down) w.heldRead = reader(el);
      requestAnimationFrame(frame);
    };
    frame();
  }, [selector, read.toString()]);
  await new Promise((done) => execFile(adbPath, ["-s", serial, "shell", "input", "swipe", `${box.x | 0}`, `${box.y | 0}`, `${box.x | 0}`, `${box.y | 0}`, "2500"], done));
  await sleep(800);
  return page.evaluate(() => (window as unknown as { heldRead: unknown }).heldRead);
};
const widthWhileHeld = (el: Element) => {
  const m = new DOMMatrix(getComputedStyle(el).transform);
  return { scaleX: +m.a.toFixed(3) };
};
await page.evaluate(() => localStorage.setItem("krida.bubbles", "on"));
await page.reload();
await page.getByRole("navigation", { name: "Main" }).waitFor({ timeout: 30_000 });
await sleep(1500);
const rims = await page.evaluate(() => document.querySelectorAll('[data-bubli="bar"][data-bubli-state="bubble"]').length);
check("the tab bar is a bubble", rims > 0, `${rims} bars`);
await page.goto(`${url}/settings/display`, { waitUntil: "domcontentloaded" });
await page.getByRole("switch").first().waitFor();
await sleep(1000);
shot("settings-feel.png");
const knob = await page.evaluate(() => document.querySelector('[role="switch"]')?.getAttribute("data-bubli-state"));
check("a switch's thumb is a drawn bubble", knob === "bubble", String(knob));

await page.goto(`${url}/watch/${room}`, { waitUntil: "domcontentloaded" });
let video = { t: 0, paused: true };
for (let i = 0; i < 90 && !(video.t > 3 && !video.paused); i++) {
  await sleep(1000);
  video = await page.evaluate(() => {
    const v = document.querySelector("video");
    return { t: Math.round(v?.currentTime ?? 0), paused: v?.paused ?? true };
  });
}
check("the film plays in the page's <video>", video.t > 3 && !video.paused, JSON.stringify(video));
await page.mouse.click(200, 300);
await sleep(800);
shot("playing.png");

await page.goto(`${url}/settings`, { waitUntil: "domcontentloaded" });
const settingsAt = Date.now();
await page.getByRole("link", { name: /^Display and sound/ }).first().waitFor({ timeout: 30_000 }).catch(() => {});
console.log(`Settings showed ${Date.now() - settingsAt} ms after opening`);
shot("settings.png");
// Display and sound is in the list on every device, so the list was read.
const sections = { display: await page.getByRole("link", { name: /^Display and sound/ }).count(), desktop: await page.getByRole("link", { name: /^Krida for (Windows|Mac)/ }).count() };
check("Settings has no desktop app section", sections.display === 1 && sections.desktop === 0, JSON.stringify(sections));
finish();
// Closing the device connection waits on adb indefinitely; the run is over.
process.exit(process.exitCode ?? 0);
