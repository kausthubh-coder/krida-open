// The intro skips itself when a title opens inside it or plays into it, but not when the page reloads in the middle
// of it: a reload (or someone joining) mid-intro used to skip it for everyone, even after "Watch it".
// Plays the stand-in providers' test video, whose intro runs from 0:02 to 0:12. Needs the QA app: npm run qa -- up.
// Usage: node scripts/e2e-intro-reload.mjs [base]
import { readFileSync } from "node:fs";
import { launchBrowser } from "./lib/browser.ts";
import { baseUrl, checks, qaProfiles, signIn } from "./lib/qa.ts";

const base = baseUrl(process.argv[2]);
const [pa] = qaProfiles([undefined]);
const { movies } = JSON.parse(readFileSync(new URL("./regress/titles.json", import.meta.url), "utf8"));
const film = movies[38];

const browser = await launchBrowser();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 760 } })).newPage();
const { check, finish } = checks(page);
const time = () => page.evaluate(() => document.querySelector("video")?.currentTime ?? 0);
const playing = () => page.waitForFunction(() => { const v = document.querySelector("video"); return !!v && v.readyState >= 3 && !v.paused; }, null, { timeout: 90_000 });
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
  check("opening the title runs into the intro and skips it", await page.getByText("Skipped intro").waitFor({ timeout: 30_000 }).then(() => true, () => false));

  // Back into the intro by the Seek bar (a seek never skips), then reload there.
  await page.mouse.move(640, 380);
  const bar = await page.getByRole("slider", { name: "Seek" }).boundingBox();
  const duration = await page.evaluate(() => document.querySelector("video").duration);
  await page.mouse.click(bar.x + (bar.width * 4) / duration, bar.y + bar.height / 2);
  await page.waitForFunction(() => { const t = document.querySelector("video")?.currentTime ?? 0; return t > 3 && t < 7; }, null, { timeout: 15_000 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await playing();
  const back = await time();
  await page.waitForTimeout(3000);
  const later = await time();
  check("after a reload mid-intro, the intro plays on", back < 11 && later < 11 && later > back, JSON.stringify({ back, later }));
} finally {
  finish();
  await browser.close();
}
