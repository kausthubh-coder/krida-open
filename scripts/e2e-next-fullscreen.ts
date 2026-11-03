// A show in full screen on a phone, then the next episode: it stays full screen and held sideways. The player is
// rebuilt for every episode, and once took the landscape lock with it, so a phone with auto-rotate off went upright.
// Runs on the QA app (`npm run qa -- up`) after `node scripts/e2e-player-touch.ts`, which makes the test video.
// Usage: node scripts/e2e-next-fullscreen.ts
import { existsSync, readFileSync } from "node:fs";
import { launchBrowser } from "./lib/browser.ts";
import { checks, qaSession, signIn } from "./lib/qa.ts";

const out = ".artifacts/next-fullscreen";
const { shows } = JSON.parse(readFileSync(new URL("./regress/titles.json", import.meta.url), "utf8")) as Record<string, { id: string; name: string }[]>;
const show = shows[16]!;
const s = qaSession();
const h264 = existsSync(".artifacts/regress/media/playlist.m3u8");
const MEDIA = existsSync(".artifacts/player-touch/media/playlist.m3u8") ? ".artifacts/player-touch/media" : ".artifacts/regress/media";
if (!existsSync(`${MEDIA}/playlist.m3u8`) && !h264) throw new Error("No test video: run `node scripts/e2e-player-touch.ts` first.");

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

const browser = await launchBrowser();
const viewport = { width: 844, height: 390 };
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
const { check, finish } = checks(page);
await signIn(page, s.url, s.profiles[0]!);
await page.goto(`${s.url}/title/series/${show.id}`);
await page.getByRole("button", { name: /^(Play|Resume)/ }).first().click();
await page.waitForURL(/\/watch\//);
const playing = () =>
  page.waitForFunction(() => {
    const v = document.querySelector("video");
    return !!v && v.readyState >= 3 && !v.paused;
  }, null, { timeout: 60_000 });
const episode = async () => /S\d+ E\d+/.exec(await page.locator("body").innerText())?.[0];
await playing();
const first = await episode();

// Play itself goes full screen and turns the phone sideways.
const entered = await page.evaluate(() => (window as unknown as { calls: string[] }).calls.splice(0));
check("Play goes full screen and turns the phone sideways", entered.includes("fullscreen") && entered.includes("lock landscape"), entered.join(", "));

await page.keyboard.press("Shift+N");
await page.waitForFunction((was) => !document.body.innerText.includes(was!), first, { timeout: 60_000 });
await playing();
const after = await page.evaluate(() => (window as unknown as { calls: string[] }).calls.splice(0));
check("the next episode plays", (await episode()) !== first, `${first} → ${await episode()}`);
check("it's still full screen", await page.evaluate(() => !!document.fullscreenElement));
check("and still held sideways", !after.includes("unlock") && !after.includes("exit"), after.join(", ") || "nothing asked");
await page.screenshot({ path: `${out}/next-episode.png` });

// Leaving the room still lets the phone turn freely.
await page.getByRole("button", { name: "Back", exact: true }).click({ force: true });
await page.waitForURL((url) => !url.pathname.startsWith("/watch/"));
const left = await page.evaluate(() => (window as unknown as { calls: string[] }).calls.splice(0));
check("leaving the player lets the phone turn again and ends Play's full screen", left.includes("unlock") && left.includes("exit"), left.join(", ") || "nothing asked");

await browser.close();
finish();
