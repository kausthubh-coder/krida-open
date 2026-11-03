// Subtitles picked in one episode are on in the next: French from OpenSubtitles carries over with Shift+N, and so
// does Off. The player is rebuilt for every episode and used to start each one from the profile's language.
// Plays the stand-in providers' test video; the subtitle lists come from the real OpenSubtitles addon.
// Needs the QA app: npm run qa -- up.
// Usage: node scripts/e2e-subtitle-memory.mjs [base]
import { mkdirSync, readFileSync } from "node:fs";
import { launchBrowser } from "./lib/browser.ts";
import { baseUrl, checks, qaProfiles, signIn } from "./lib/qa.ts";

const base = baseUrl(process.argv[2]);
const [pa] = qaProfiles([undefined]);
const { shows } = JSON.parse(readFileSync(new URL("./regress/titles.json", import.meta.url), "utf8"));
const show = shows[10]; // Rick and Morty: every episode has subtitles in many languages
const out = ".artifacts/subtitle-memory";
mkdirSync(out, { recursive: true });

const browser = await launchBrowser();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 760 } })).newPage();
const { check, finish } = checks(page);
const playing = () => page.waitForFunction(() => { const v = document.querySelector("video"); return !!v && v.readyState >= 3 && !v.paused; }, null, { timeout: 90_000 });
const episode = async () => /S\d+ E\d+/.exec(await page.locator("body").innerText())?.[0];
const openSubtitles = async () => {
  await page.mouse.move(640, 380);
  await page.getByRole("button", { name: "Subtitles (C)" }).click();
  const french = page.getByRole("button", { name: "French", exact: true });
  await french.waitFor({ timeout: 30_000 });
  await french.scrollIntoViewIfNeeded();
};
const pressed = (name) => page.getByRole("button", { name, exact: true }).getAttribute("aria-pressed");
const nextEpisode = async () => {
  const was = await episode();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Shift+N");
  await page.waitForFunction((w) => !document.body.innerText.includes(w), was, { timeout: 60_000 });
  await playing();
  return `${was} → ${await episode()}`;
};
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
  await page.goto(`${base}/title/series/${show.id}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { level: 1 }).first().waitFor();
  await page.getByRole("button", { name: /^(Play|Resume)/ }).first().click();
  await page.waitForURL(/\/watch\//);
  await playing();

  await openSubtitles();
  await page.getByRole("button", { name: "French", exact: true }).click();
  check("French is on in the first episode", (await pressed("French")) === "true");
  await page.screenshot({ path: `${out}/1-french-picked.png` });

  const moved = await nextEpisode();
  await openSubtitles();
  check("the next episode starts with French on", (await pressed("French")) === "true", moved);
  await page.screenshot({ path: `${out}/2-next-episode-french.png` });

  await page.getByRole("button", { name: "Off", exact: true }).click();
  const movedAgain = await nextEpisode();
  await openSubtitles();
  check("after turning them off, the next episode starts with them off", (await pressed("Off")) === "true" && (await pressed("French")) === "false", movedAgain);
  await page.screenshot({ path: `${out}/3-next-episode-off.png` });
} finally {
  finish();
  await browser.close();
}
