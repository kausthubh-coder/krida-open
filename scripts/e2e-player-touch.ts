// The player on a phone held sideways: a tap shows and hides the controls without pausing, play and the skips sit in
// the middle of the picture, a double tap on a side skips 10 seconds (and each tap after adds 10), dragging the left
// side sets brightness and the right side volume, holding plays at 2× until the finger lifts, sliding sideways scrubs
// with the time shown, a pinch fills the screen and fits it again, Picture stretches it and fits it, > and < set the
// speed (and it holds against the room's clock), swiping down the middle leaves full screen and swiping up goes back,
// every file in the source sheet can be scrolled to and tapped, and the lock screen knows what's playing. Play itself
// goes full screen and turns the phone sideways. Held upright (where the phone isn't turned for us), the player turns
// itself sideways: taps, double taps, slides and the timeline work in its turned frame, a sheet turns with it (every
// file in it reachable), turning the phone for real puts it back upright, and leaving ends the full screen Play started.
// Runs on the QA app (`npm run qa -- up`). The page gets a test video straight from disk, so it plays even where the
// local backend can't reach the stand-in providers: the stand-in's own (H.264), or where the browser can't decode
// H.264 (Playwright's Chromium on a cloud VM) a VP9 one this makes with ffmpeg.
// Usage: node scripts/e2e-player-touch.ts
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import type { Locator, Page } from "playwright-core";
import { launchBrowser } from "./lib/browser.ts";
import { checks, qaSession, signIn } from "./lib/qa.ts";

const out = ".artifacts/player-touch";
const { movies } = JSON.parse(readFileSync(new URL("./regress/titles.json", import.meta.url), "utf8")) as Record<string, { id: string; name: string }[]>;
const movie = movies[16]!;
const s = qaSession();
const browser = await launchBrowser();

const probe = await browser.newPage();
const h264 = await probe.evaluate(() => MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E,mp4a.40.2"'));
await probe.close();
const MEDIA = h264 ? ".artifacts/regress/media" : `${out}/media`;
if (!h264 && !existsSync(`${MEDIA}/playlist.m3u8`)) {
  mkdirSync(MEDIA, { recursive: true });
  const made = spawnSync("ffmpeg", [
    "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24:duration=60", "-f", "lavfi", "-i", "sine=frequency=440:duration=60",
    "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-b:v", "300k", "-c:a", "libopus",
    "-f", "hls", "-hls_time", "6", "-hls_playlist_type", "vod", "-hls_segment_type", "fmp4", "-hls_segment_filename", `${MEDIA}/seg%02d.m4s`, `${MEDIA}/playlist.m3u8`,
  ], { encoding: "utf8" });
  if (made.status !== 0) throw new Error(`ffmpeg couldn't make the VP9 test video: ${made.stderr}`);
}
if (!existsSync(`${MEDIA}/playlist.m3u8`)) throw new Error(`No test video in ${MEDIA}: run \`npm run qa -- up\` first.`);

// What the page asked of the browser: full screen, and which way to hold the screen.
const spy = `
  window.calls = [];
  const request = Element.prototype.requestFullscreen;
  Element.prototype.requestFullscreen = function (options) {
    calls.push("fullscreen");
    return request.call(this, options);
  };
  const exit = Document.prototype.exitFullscreen;
  Document.prototype.exitFullscreen = function () {
    calls.push("exit");
    return exit.call(this);
  };
  if (screen.orientation) {
    screen.orientation.lock = (o) => (calls.push("lock " + o), Promise.resolve());
    screen.orientation.unlock = () => calls.push("unlock");
  }
`;

const cors = { "access-control-allow-origin": "*" };

async function open(viewport: { width: number; height: number }) {
  const context = await browser.newContext({ viewport, screen: viewport, isMobile: true, hasTouch: true, deviceScaleFactor: 2, serviceWorkers: "block" });
  await context.addInitScript(spy);
  await context.route(/\/hls\/playlist\.m3u8/, (route) =>
    route.fulfill({
      headers: cors,
      contentType: "application/vnd.apple.mpegurl",
      body: readFileSync(`${MEDIA}/playlist.m3u8`, "utf8").replace(/^(?!#)(\S+)$/gm, `${s.siteUrl}/test-media/$1`).replace(/URI="(init\.mp4)"/, `URI="${s.siteUrl}/test-media/$1"`),
    }),
  );
  await context.route(/\/test-media\/[\w.]+$/, (route) => {
    const file = route.request().url().split("/").pop()!;
    return route.fulfill({ headers: cors, contentType: file.endsWith(".ts") ? "video/mp2t" : "video/mp4", body: readFileSync(`${MEDIA}/${file}`) });
  });
  const page = await context.newPage();
  await signIn(page, s.url, s.profiles[0]!);
  await page.goto(`${s.url}/title/movie/${movie.id}`);
  await page.getByRole("button", { name: "Play", exact: true }).first().click();
  await page.waitForURL(/\/watch\//);
  await page.waitForFunction(() => {
    const v = document.querySelector("video");
    return !!v && v.readyState >= 3 && !v.paused;
  }, null, { timeout: 60_000 });
  return { context, page };
}

const videoTime = (page: Page) => page.evaluate(() => document.querySelector("video")!.currentTime);
const calls = (page: Page) => page.evaluate(() => (window as unknown as { calls: string[] }).calls.splice(0));
const controlsShown = (page: Page) => page.getByRole("button", { name: "Back", exact: true }).isVisible();
const rate = (page: Page) => page.evaluate(() => document.querySelector("video")!.playbackRate);
const playing = (page: Page) => page.evaluate(() => !document.querySelector("video")!.paused);

/** A one-finger swipe from (x, y) by dy (and dx), as touch events; `during` runs before the finger lifts. */
async function swipe(page: Page, x: number, y: number, dy: number, dx = 0, during?: () => Promise<void>) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let i = 1; i <= 6; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + (dx * i) / 6, y: y + (dy * i) / 6 }] });
    await page.waitForTimeout(16);
  }
  await during?.();
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(400);
}

/**
 * Whether each file in the source sheet scrolls into the sheet and takes a tap. A phone held sideways once had the pick,
 * the tabs and the column headers fill the sheet, with every row below its edge.
 */
const sourceRowsReachable = (sheet: Locator) =>
  sheet.evaluate(async (el) => {
    const edge = el.getBoundingClientRect();
    const rows = [...el.querySelectorAll("li")];
    const out: boolean[] = [];
    for (const li of rows) {
      li.scrollIntoView({ block: "nearest", behavior: "instant" });
      await new Promise((r) => requestAnimationFrame(r));
      const b = li.getBoundingClientRect();
      const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      out.push(!!hit && li.contains(hit) && b.top >= edge.top && b.bottom <= edge.bottom);
    }
    return out;
  });

/** Two fingers level across (x, y), from `apart` px apart to `to` px apart. */
async function pinch(page: Page, x: number, y: number, apart: number, to: number) {
  const cdp = await page.context().newCDPSession(page);
  const points = (d: number) => [{ x: x - d / 2, y, id: 1 }, { x: x + d / 2, y, id: 2 }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points(apart) });
  for (let i = 1; i <= 8; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: points(apart + ((to - apart) * i) / 8) });
    await page.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(300);
}

// ----- Sideways: taps, double taps, holds, slides, pinches, swipes, speed and the lock screen.
const { context, page } = await open({ width: 844, height: 390 });
const { check, watch, finish } = checks(page);
const atPlay = await calls(page);
check("Play goes full screen and turns the phone sideways", atPlay.includes("fullscreen") && atPlay.includes("lock landscape"), atPlay.join(", "));
const w = 844;
const h = 390;
// Side taps go above the middle: the "Skipped intro" pill sits there on the right once the test video's intro skips.
const side = h * 0.3;
// Taps that only show or hide the controls go above the middle too, clear of play and the skips there.
const tapAt = [w / 2, h * 0.22] as const;

await page.waitForFunction(() => !document.querySelector("video")!.paused);
await page.getByRole("button", { name: "Back", exact: true }).waitFor({ state: "hidden", timeout: 10_000 });
await page.touchscreen.tap(...tapAt);
await page.waitForTimeout(250);
check("a tap brings the controls back", await controlsShown(page));
const middle = page.getByRole("button", { name: "Pause", exact: true });
check("touch has pause in the middle of the picture", await middle.isVisible());
const box = await middle.boundingBox();
check("right in the middle", !!box && Math.abs(box.x + box.width / 2 - w / 2) < 4 && Math.abs(box.y + box.height / 2 - h / 2) < 4, JSON.stringify(box));
check(
  "with the skips either side",
  (await page.getByRole("button", { name: "Back 10 seconds" }).isVisible()) && (await page.getByRole("button", { name: "Forward 10 seconds" }).isVisible()),
);
check("and the capsule along the bottom drops them", !(await page.getByRole("button", { name: "Pause (Space)" }).isVisible()));
await page.screenshot({ path: `${out}/controls.png` });
await middle.tap();
await page.waitForTimeout(250);
check("pause in the middle pauses", !(await playing(page)));
await page.screenshot({ path: `${out}/paused.png` });
await page.getByRole("button", { name: "Play", exact: true }).tap();
await page.waitForFunction(() => !document.querySelector("video")!.paused);
await page.touchscreen.tap(...tapAt);
await page.waitForTimeout(250);
check("a tap while they show hides them", !(await controlsShown(page)));
check("and doesn't pause", await playing(page));
// The middle too: the tap brings up pause right under the finger, and its click mustn't press it (in a party that
// paused everyone).
await page.touchscreen.tap(w / 2, h / 2);
await page.waitForTimeout(400);
check("a tap in the middle brings the controls back", await controlsShown(page));
check("without pressing the pause it brings up", await playing(page));
await page.touchscreen.tap(...tapAt);
await page.waitForTimeout(250);

const before = await videoTime(page);
await page.touchscreen.tap(w * 0.85, side);
await page.waitForTimeout(80);
await page.touchscreen.tap(w * 0.85, side);
await page.getByText("10 seconds", { exact: true }).waitFor({ timeout: 2_000 });
check("a double tap on the right says 10 seconds", true);
await page.touchscreen.tap(w * 0.85, side);
await page.getByText("20 seconds", { exact: true }).waitFor({ timeout: 2_000 });
check("a third tap adds 10 more", true);
// The taps after the first gather into one seek, 300 ms after the last (skipping.ts).
await page.waitForTimeout(450);
await page.screenshot({ path: `${out}/double-tap-forward.png` });
const ahead = (await videoTime(page)) - before;
check("the video skipped about 20 seconds ahead", ahead > 18 && ahead < 23, `${ahead.toFixed(1)} s`);
await page.waitForTimeout(900);

const fromHere = await videoTime(page);
await page.touchscreen.tap(w * 0.15, side);
await page.waitForTimeout(80);
await page.touchscreen.tap(w * 0.15, side);
await page.getByText("10 seconds", { exact: true }).waitFor({ timeout: 2_000 });
await page.waitForTimeout(150);
await page.screenshot({ path: `${out}/double-tap-back.png` });
const back = fromHere - (await videoTime(page));
check("a double tap on the left skips about 10 seconds back", back > 8 && back < 12, `${back.toFixed(1)} s`);
check("a double tap doesn't pause", await playing(page));
await page.waitForTimeout(900);
await calls(page);

// Holding and dragging a side: the left third is brightness, the right third volume.
const filter = () => page.evaluate(() => document.querySelector("video")!.style.filter);
await swipe(page, w * 0.15, h * 0.55, -120);
const brighter = await filter();
check("dragging up the left side brightens the picture", /^brightness\(1\.\d+\)$/.test(brighter), brighter);
await page.screenshot({ path: `${out}/drag-brightness.png` });
await swipe(page, w * 0.15, h * 0.2, 250);
const dimmer = await filter();
check("dragging down it dims the picture", /^brightness\(0\.\d+\)$/.test(dimmer), dimmer);
await page.waitForTimeout(800);
check("the level goes away once the finger lifts", !(await page.getByRole("status", { name: /^Brightness/ }).isVisible()));
const volumeBefore = await page.evaluate(() => document.querySelector("video")!.volume);
await swipe(page, w * 0.85, h * 0.2, 120);
const volumeAfter = await page.evaluate(() => document.querySelector("video")!.volume);
check("dragging down the right side turns the volume down", volumeAfter < volumeBefore - 0.3, `${volumeBefore} → ${volumeAfter}`);
await page.screenshot({ path: `${out}/drag-volume.png` });
check("a drag doesn't skip or pause", (await playing(page)) && !(await page.getByText("10 seconds", { exact: true }).isVisible()));
await swipe(page, w * 0.85, h * 0.8, -250);
await swipe(page, w * 0.15, h * 0.8, -125);
await page.waitForTimeout(800);
await calls(page);

// Holding still: 2× while held, as YouTube does, and back to normal once the finger lifts.
const hold = await context.newCDPSession(page);
await hold.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: w / 2, y: h * 0.3 }] });
await page.waitForTimeout(800);
check("holding the picture plays at 2×", (await rate(page)) === 2, String(await rate(page)));
check("and says so", await page.getByText("2× speed", { exact: true }).isVisible());
await page.screenshot({ path: `${out}/hold-2x.png` });
await hold.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
await page.waitForTimeout(300);
check("letting go goes back to normal", (await rate(page)) === 1, String(await rate(page)));
check("without pausing or bringing up the controls", (await playing(page)) && !(await controlsShown(page)));
await page.waitForTimeout(400);
check("and the 2× note goes", !(await page.getByText("2× speed", { exact: true }).isVisible()));

// Sliding sideways scrubs: the time it would land on shows while the finger moves, and it lands there.
const slideFrom = await videoTime(page);
const duration = await page.evaluate(() => document.querySelector("video")!.duration);
const slideTo = Math.max(0, slideFrom - 0.4 * Math.min(duration, 90));
let shownWhileSliding = false;
await swipe(page, w * 0.7, h * 0.4, 0, -w * 0.4, async () => {
  shownWhileSliding = await page.getByRole("status", { name: /^Seek to / }).isVisible();
  await page.screenshot({ path: `${out}/scrub.png` });
});
check("sliding sideways shows where it would land", shownWhileSliding);
const landed = await videoTime(page);
check("and lands there", Math.abs(landed - slideTo) < 3, `${slideFrom.toFixed(1)} → ${landed.toFixed(1)}, expected about ${slideTo.toFixed(1)}`);
check("without pausing or skipping 10", (await playing(page)) && !(await page.getByText("10 seconds", { exact: true }).isVisible()));
await page.waitForTimeout(600);

// Pinching out fills the screen (the test video is 16:9 on a wider screen); pinching in fits it again.
const scale = () => page.evaluate(() => document.querySelector("video")!.style.scale);
await pinch(page, w / 2, h / 2, 80, 320);
const filledScale = Number(await scale());
check("pinching out fills the screen", filledScale > 1.15 && filledScale < 1.3, String(filledScale));
check("and says so", await page.getByText("Zoomed to fill", { exact: true }).isVisible());
await page.waitForTimeout(350);
await page.screenshot({ path: `${out}/pinch-fill.png` });
await pinch(page, w / 2, h / 2, 320, 80);
check("pinching in fits it again", (await scale()) === "", await scale());
check("a pinch doesn't pause or skip", (await playing(page)) && !(await page.getByText("10 seconds", { exact: true }).isVisible()));
await page.waitForTimeout(900);

// Picture: Stretch fills the screen out of shape, wider only; Fit puts it back.
await page.touchscreen.tap(...tapAt);
await page.waitForTimeout(250);
await page.getByRole("button", { name: "Picture (V)" }).tap();
const pictureMenu = page.getByRole("dialog", { name: "Picture" });
await pictureMenu.getByRole("button", { name: /^Stretch/ }).tap();
await page.waitForTimeout(350);
const [stretchX, stretchY] = (await scale()).split(" ").map(Number);
check("Stretch widens the picture and keeps its height", stretchX! > 1.15 && stretchX! < 1.3 && stretchY === 1, await scale());
await page.screenshot({ path: `${out}/picture-stretch.png` });
await pictureMenu.getByRole("button", { name: /^Fit/ }).tap();
await page.waitForTimeout(350);
check("Fit puts it back", (await scale()) === "", await scale());
await page.touchscreen.tap(...tapAt);
await page.waitForTimeout(600);

// Speed, held against the room's clock, which would otherwise pull the picture back to 1×. It has no button: > and <.
await page.keyboard.press(">");
await page.keyboard.press(">");
await page.waitForTimeout(300);
check("> twice sets 1.5×", (await rate(page)) === 1.5 && (await page.getByText("Speed 1.5×", { exact: true }).isVisible()), String(await rate(page)));
check("with no Speed button", (await page.getByRole("button", { name: /^Speed/ }).count()) === 0);
const t1 = await videoTime(page);
await page.waitForTimeout(4_000);
const gained = (await videoTime(page)) - t1;
check("and it holds: 4 seconds later the picture has gone about 6", (await rate(page)) === 1.5 && gained > 5 && gained < 7, `${gained.toFixed(1)} s at ${await rate(page)}×`);
await page.keyboard.press("<");
await page.keyboard.press("<");
await page.waitForTimeout(300);
check("< twice puts it back", (await rate(page)) === 1, String(await rate(page)));
const t2 = await videoTime(page);
await page.waitForTimeout(2_500);
const after = (await videoTime(page)) - t2;
check("and the room's clock follows: no jump back afterwards", after > 1.8 && after < 3.2, `${after.toFixed(1)} s`);
await page.keyboard.press("Escape");
await page.keyboard.press(">");
await page.waitForTimeout(150);
check("> steps up a speed", (await rate(page)) === 1.25 && (await page.getByText("Speed 1.25×", { exact: true }).isVisible()), String(await rate(page)));
await page.keyboard.press("<");
await page.waitForTimeout(150);
check("< steps back down", (await rate(page)) === 1, String(await rate(page)));
await page.waitForTimeout(3_000);
await calls(page);

await swipe(page, w / 2, h * 0.25, 150);
const down = await calls(page);
check("swiping down leaves full screen and lets the phone turn", down.includes("exit") && down.includes("unlock"), down.join(", "));
await swipe(page, w / 2, h * 0.75, -150);
const up = await calls(page);
check("swiping up goes full screen and turns the phone sideways", up.includes("fullscreen") && up.includes("lock landscape"), up.join(", "));

if (!(await controlsShown(page))) await page.touchscreen.tap(w / 2, h * 0.3);
await page.getByRole("button", { name: "Change source" }).tap();
const sideSources = page.getByRole("dialog", { name: "Choose a source" });
await sideSources.waitFor();
await sideSources.locator("li").first().waitFor();
const sideRows = await sourceRowsReachable(sideSources);
check("every file in the source sheet scrolls into view and takes a tap", sideRows.length > 1 && sideRows.every(Boolean), JSON.stringify(sideRows));
await page.screenshot({ path: `${out}/sideways-sources.png` });
await sideSources.getByRole("button", { name: "Close" }).tap();
await sideSources.waitFor({ state: "hidden" });

const session = await page.evaluate(() => ({ title: navigator.mediaSession.metadata?.title, album: navigator.mediaSession.metadata?.album }));
check("the lock screen shows what's playing", session.title === movie.name && session.album === "Krida", JSON.stringify(session));
await context.close();

// ----- Upright, where the phone isn't turned for us (an iPhone, or rotation locked): the player turns itself a quarter
// turn clockwise. A point in its frame (fx, fy) is at (W - fy, fx) on the upright screen.
const W = 390;
const H = 844;
const upright = await open({ width: W, height: H });
const tall = upright.page;
watch(tall, "upright");
const onScreen = (fx: number, fy: number) => [W - fy, fx] as const;
check("held upright, the player turns itself sideways", await tall.evaluate(() => document.documentElement.hasAttribute("data-sideways")));
const frame = (await tall.locator("video").boundingBox())!;
check("its frame is the phone's length wide", Math.abs(frame.width - W) < 2 && Math.abs(frame.height - H) < 2, JSON.stringify(frame));
if (!(await controlsShown(tall))) await tall.touchscreen.tap(...onScreen(H / 2, W * 0.22));
await tall.waitForTimeout(300);
await tall.screenshot({ path: `${out}/upright-turned.png` });
const pause = (await tall.getByRole("button", { name: "Pause", exact: true }).boundingBox())!;
check("pause is in the middle", Math.abs(pause.x + pause.width / 2 - W / 2) < 4 && Math.abs(pause.y + pause.height / 2 - H / 2) < 4, JSON.stringify(pause));
await tall.touchscreen.tap(...onScreen(H / 2, W * 0.22));
await tall.waitForTimeout(300);
check("a tap hides the controls", !(await controlsShown(tall)));

const t0 = await videoTime(tall);
await tall.touchscreen.tap(...onScreen(H * 0.85, W * 0.3));
await tall.waitForTimeout(80);
await tall.touchscreen.tap(...onScreen(H * 0.85, W * 0.3));
await tall.getByText("10 seconds", { exact: true }).waitFor({ timeout: 2_000 });
const skipped = (await videoTime(tall)) - t0;
check("a double tap on the frame's right skips forward", skipped > 8 && skipped < 12, `${skipped.toFixed(1)} s`);
await tall.waitForTimeout(900);

const slideStart = await videoTime(tall);
const [sx, sy] = onScreen(H * 0.7, W * 0.4);
// Sliding left along the frame is sliding up the upright screen.
await swipe(tall, sx, sy, -H * 0.4);
const slid = await videoTime(tall);
const slideExpected = Math.max(0, slideStart - 0.4 * Math.min(await tall.evaluate(() => document.querySelector("video")!.duration), 90));
check("sliding along the frame scrubs back", Math.abs(slid - slideExpected) < 3, `${slideStart.toFixed(1)} → ${slid.toFixed(1)}, expected about ${slideExpected.toFixed(1)}`);
await tall.waitForTimeout(600);

await tall.touchscreen.tap(...onScreen(H / 2, W * 0.22));
await tall.waitForTimeout(300);
const bar = (await tall.getByRole("slider", { name: "Seek" }).boundingBox())!;
check("the timeline runs along the frame", bar.height > bar.width * 5, JSON.stringify(bar));
const duration2 = await tall.evaluate(() => document.querySelector("video")!.duration);
await tall.touchscreen.tap(bar.x + bar.width / 2, bar.y + bar.height * 0.25);
await tall.waitForTimeout(400);
const tapped = await videoTime(tall);
check("a tap a quarter along it lands a quarter in", Math.abs(tapped - duration2 * 0.25) < 3, `${tapped.toFixed(1)} of ${duration2.toFixed(1)}`);
await tall.screenshot({ path: `${out}/upright-turned-controls.png` });

if (!(await controlsShown(tall))) await tall.touchscreen.tap(...onScreen(H / 2, W * 0.22));
await tall.getByRole("button", { name: "Change source" }).tap();
const sources = tall.getByRole("dialog", { name: "Choose a source" });
await sources.waitFor();
await tall.waitForTimeout(800);
const sheetTurn = await sources.evaluate((el) => getComputedStyle(el).rotate);
check("a sheet opened from it turns with it", sheetTurn === "90deg", sheetTurn);
const turnedRows = await sourceRowsReachable(sources);
check("and every file in it scrolls into view and takes a tap", turnedRows.length > 1 && turnedRows.every(Boolean), JSON.stringify(turnedRows));
await tall.screenshot({ path: `${out}/upright-turned-sheet.png` });
await sources.getByRole("button", { name: "Close" }).tap();
await sources.waitFor({ state: "hidden" });

// The Party panel opens from its button in the turned frame, over the picture, as it does on a phone held sideways.
if (!(await controlsShown(tall))) await tall.touchscreen.tap(...onScreen(H / 2, W * 0.22));
const partyButton = tall.getByRole("button", { name: /^Party/ }).first();
const buttonBox = (await partyButton.boundingBox())!;
await partyButton.tap();
const party = tall.getByRole("complementary", { name: "Party" });
await party.waitFor();
await tall.waitForTimeout(500);
const pane = (await party.boundingBox())!;
// The frame's up is the screen's right, so above the controls is to the right of the button, and the panel's
// right edge (the screen's bottom) sits at the frame's edge.
check(
  "the Party panel opens above its button, on screen",
  pane.x >= buttonBox.x + buttonBox.width && pane.x + pane.width <= W + 1 && pane.y >= 0 && pane.y + pane.height <= H + 1,
  JSON.stringify({ pane, button: buttonBox }),
);
// Sideways the picture fills the width, so the panel keeps to its end and the middle stays in view.
check("and leaves the middle of the picture clear", pane.y > H / 2, JSON.stringify(pane));
check("and leaves the controls where they were", JSON.stringify(await partyButton.boundingBox()) === JSON.stringify(buttonBox));
await tall.screenshot({ path: `${out}/upright-turned-party.png` });
await party.getByRole("button", { name: "Close" }).first().tap();
await party.waitFor({ state: "hidden" });

// Turning the phone for real: the picture is sideways by itself, so the player stops turning.
await calls(tall);
const cdp = await upright.context.newCDPSession(tall);
await cdp.send("Emulation.setDeviceMetricsOverride", {
  width: H, height: W, deviceScaleFactor: 2, mobile: true, screenWidth: H, screenHeight: W,
  screenOrientation: { type: "landscapePrimary", angle: 90 },
});
await tall.waitForTimeout(600);
const level = (await tall.locator("video").boundingBox())!;
check(
  "turned for real, it stops turning itself",
  !(await tall.evaluate(() => document.documentElement.hasAttribute("data-sideways"))) && Math.abs(level.width - H) < 2,
  JSON.stringify(level),
);
if (!(await controlsShown(tall))) await tall.touchscreen.tap(H / 2, W * 0.22);
await tall.getByRole("button", { name: "Back", exact: true }).tap();
await tall.waitForURL((url) => !url.pathname.startsWith("/watch/"));
await tall.waitForTimeout(400);
const left = await calls(tall);
check("leaving ends the full screen Play started", left.includes("exit") && left.includes("unlock"), left.join(", "));
await upright.context.close();

await browser.close();
finish();
