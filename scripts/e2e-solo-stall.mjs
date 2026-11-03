// Watching alone on the QA app, the stream stalls for a few seconds: the player shows its spinner and never says
// anyone is waiting for you, and once the picture loads it carries on from where it stalled instead of jumping ahead
// by the length of the stall. Plays the stand-in providers' test video, holding its segments back to make the stall.
// Needs the QA app: npm run qa -- up.
// Usage: node scripts/e2e-solo-stall.mjs [base]
import { mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { launchBrowser } from "./lib/browser.ts";
import { baseUrl, checks, qaProfiles, signIn } from "./lib/qa.ts";

const base = baseUrl(process.argv[2]);
const [pa] = qaProfiles([undefined]);
const { movies } = JSON.parse(readFileSync(new URL("./regress/titles.json", import.meta.url), "utf8"));
const film = movies[37];
const out = ".artifacts/solo-stall";
// Long enough that the room holds (2.5 s) and a jump ahead would show.
const STALL_MS = 7000;
await mkdir(out, { recursive: true });

const browser = await launchBrowser();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 760 } })).newPage();
const { check, finish } = checks(page);
const video = () => page.evaluate(() => {
  const v = document.querySelector("video");
  return { t: +v.currentTime.toFixed(2), paused: v.paused, ready: v.readyState, buffered: [...Array(v.buffered.length).keys()].map((i) => [v.buffered.start(i), v.buffered.end(i)]) };
});
// Start alone: a party from an earlier run (e2e-party-sync leaves one open) would make Play a party's.
const leaveAnyParty = async () => {
  const mine = page.getByRole("button", { name: /^Party,/ }).first();
  if (!(await mine.waitFor({ timeout: 4000 }).then(() => true, () => false))) return;
  await mine.click();
  await page.getByRole("button", { name: "More party options" }).click();
  await page.getByRole("menuitem", { name: "Leave party" }).click();
  await mine.waitFor({ state: "hidden", timeout: 15_000 });
};

try {
  await signIn(page, base, pa);
  await leaveAnyParty();
  await page.goto(`${base}/title/movie/${film.id}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { level: 1 }).first().waitFor();
  await page.getByRole("button", { name: "Play", exact: true }).first().click();
  await page.waitForURL(/\/watch\//);
  // It starts, runs into the intro and skips it; then it plays on a little, filling what's ahead.
  await page.waitForFunction(() => (document.querySelector("video")?.currentTime ?? 0) > 15, null, { timeout: 90_000 });

  // Every segment from here on takes 7 seconds to arrive.
  let held = 0;
  await page.route(/seg\d+\.ts/, async (route) => {
    held++;
    await new Promise((r) => setTimeout(r, STALL_MS));
    await route.continue().catch(() => {});
  });
  const before = await video();
  const ahead = before.buffered.reduce((end, [s, e]) => (s <= before.t + 0.5 ? Math.max(end, e) : end), 0);
  const target = Math.min(Math.ceil(ahead) + 2, 54);
  check("the stall point isn't loaded yet", target > ahead, JSON.stringify({ at: before.t, loadedTo: ahead, target }));

  // Seek there the way a person does, by clicking the Seek bar.
  await page.mouse.move(640, 380);
  const bar = await page.getByRole("slider", { name: "Seek" }).boundingBox();
  const duration = await page.evaluate(() => document.querySelector("video").duration);
  await page.mouse.click(bar.x + (bar.width * target) / duration, bar.y + bar.height / 2);
  await page.mouse.move(640, 200);

  // Through the stall, nobody is said to be waiting.
  let pill = false;
  const stallEnds = Date.now() + STALL_MS + 3000;
  let shot = false;
  while (Date.now() < stallEnds) {
    pill ||= await page.getByText(/waiting for you|to catch up/).first().isVisible().catch(() => false);
    const v = await video();
    if (!shot && Date.now() > stallEnds - STALL_MS) {
      await page.screenshot({ path: `${out}/stalled.png` });
      shot = true;
    }
    if (v.ready >= 3 && !v.paused && v.t > target + 0.5) break;
    await page.waitForTimeout(200);
  }
  check("segments were held back", held > 0, `${held} held`);
  check("no \"everyone's waiting for you\" while alone", !pill);

  // Once it loads, it plays on from where it stalled.
  const resumed = await page.waitForFunction((t) => {
    const v = document.querySelector("video");
    return v.readyState >= 3 && !v.paused && v.currentTime > t + 0.5;
  }, target, { timeout: 30_000 }).then(() => true, () => false);
  check("it plays again after the stall", resumed);
  await page.waitForTimeout(1500);
  const after = await video();
  // Played about 2 seconds since it loaded; a jump ahead would add the 7-second stall.
  check("it carries on from where it stalled", after.t < target + 4, JSON.stringify({ target, after: after.t }));
  await page.screenshot({ path: `${out}/after.png` });
} finally {
  finish();
  await browser.close();
}
