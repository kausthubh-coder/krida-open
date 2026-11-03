// Ratings: exact scores on a reported title, episode and season scores kept apart, stable Settings cards after rating
// and clearing, rating an untracked movie adding it to Watched, and the phone sheet persisting across a reload.
// Needs the QA app (npm run qa -- up) or a *-QA-* profile on the dev backend; it writes ratings, not to Simkl.
// Usage: node scripts/e2e-ratings.mjs [base] [profile]
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { launchBrowser } from "./lib/browser.ts";
import { baseUrl, qaProfiles, signIn } from "./lib/qa.ts";

const base = baseUrl(process.argv[2]);
const [profile] = qaProfiles([process.argv[3]]);
const out = ".artifacts/ratings-check";
await mkdir(out, { recursive: true });
const browser = await launchBrowser({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const showId = "tt29764006";
const showName = "#90’s - A Middle Class Biopic";
const dialog = () => page.getByRole("dialog", { name: showName, exact: true });
const rate = () => page.getByRole("button", { name: /Rate #90’s - A Middle Class Biopic/ });
const save = async () => {
  await dialog().getByRole("button", { name: "Save changes", exact: true }).click();
  await dialog().waitFor({ state: "detached" });
};
let checks = 0;
const passed = (name) => { checks++; console.log("PASS", name); };
try {
  await signIn(page, base, profile);

  await page.goto(`${base}/title/series/${showId}`);
  await rate().click();
  await dialog().getByRole("button", { name: "8 out of 10", exact: true }).click();
  await save();
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label")?.includes("Your rating: 8/10"));
  await rate().click();
  assert.equal(await dialog().getByRole("button", { name: "8 out of 10", exact: true }).getAttribute("aria-pressed"), "true");
  passed("the reported title saves an exact score, restores focus and reopens with it selected");

  await dialog().getByRole("radio", { name: "Episode", exact: true }).check();
  await dialog().getByRole("combobox", { name: "Episode", exact: true }).selectOption("3");
  await dialog().getByRole("radio", { name: "Rewatching", exact: true }).check();
  await dialog().getByRole("button", { name: "6 out of 10", exact: true }).click();
  await save();
  await page.getByText(/Rewatching/).first().waitFor();
  await rate().click();
  assert.equal(await dialog().getByRole("button", { name: "8 out of 10", exact: true }).getAttribute("aria-pressed"), "true");
  await dialog().getByRole("radio", { name: "Episode", exact: true }).check();
  await dialog().getByRole("combobox", { name: "Episode", exact: true }).selectOption("3");
  assert.equal(await dialog().getByRole("button", { name: "6 out of 10", exact: true }).getAttribute("aria-pressed"), "true");
  assert.equal(await dialog().getByRole("combobox", { name: "Episode", exact: true }).locator("option").count(), 6);
  await dialog().getByRole("radio", { name: "Season", exact: true }).check();
  await dialog().getByRole("button", { name: "9 out of 10", exact: true }).click();
  await save();
  passed("episode and season scores persist independently; Rewatching retains the show score and real episode list");

  await page.goto(`${base}/settings`);
  await page.getByRole("button", { name: "Rate watched titles", exact: true }).click();
  const starter = page.getByRole("dialog", { name: "Rate what you've watched", exact: true });
  const titles = () => starter.locator("li [data-rating-title]").evaluateAll((els) => els.map((e) => e.textContent));
  await starter.getByRole("button", { name: "Rate Inception", exact: true }).waitFor();
  const before = await titles();
  await starter.getByRole("button", { name: "Rate Inception", exact: true }).click();
  const movie = page.getByRole("dialog", { name: "Inception", exact: true });
  await movie.getByRole("button", { name: "5 out of 10", exact: true }).click();
  await movie.getByRole("button", { name: "Save changes", exact: true }).click();
  await movie.waitFor({ state: "detached" });
  assert.deepEqual(await titles(), before);
  await starter.getByRole("button", { name: "Your rating: 5/10. Rate Inception", exact: true }).click();
  await movie.getByRole("button", { name: "Clear rating", exact: true }).click();
  await movie.getByRole("button", { name: "Save changes", exact: true }).click();
  await movie.waitFor({ state: "detached" });
  assert.deepEqual(await titles(), before);
  await starter.getByRole("button", { name: "Done", exact: true }).click();
  passed("Settings retains card order after rating and clearing, including the neutral 5/10 score");

  await page.goto(`${base}/title/movie/tt0047478`);
  await page.getByRole("button", { name: /Rate Seven Samurai/ }).click();
  const newMovie = page.getByRole("dialog", { name: "Seven Samurai", exact: true });
  await newMovie.getByRole("button", { name: "10 out of 10", exact: true }).click();
  await newMovie.getByRole("button", { name: "Save changes", exact: true }).click();
  await newMovie.waitFor({ state: "detached" });
  await page.getByText(/^Watched/).first().waitFor();
  await page.goto(`${base}/library`);
  await page.getByRole("tab", { name: /^Watched/ }).click();
  await page.getByRole("link", { name: /Seven Samurai/ }).waitFor();
  passed("rating an untracked movie immediately adds it to Watched");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}/title/series/${showId}`);
  await rate().click();
  await dialog().getByRole("radio", { name: "Episode", exact: true }).check();
  await dialog().getByRole("combobox", { name: "Episode", exact: true }).selectOption("2");
  await dialog().getByRole("button", { name: "7 out of 10", exact: true }).click();
  await page.screenshot({ path: `${out}/mobile-episode-rating.png` });
  const box = await dialog().boundingBox();
  assert.ok(box && box.x >= 0 && box.x + box.width <= 391);
  await save();
  await page.reload();
  await rate().click();
  await dialog().getByRole("radio", { name: "Episode", exact: true }).check();
  await dialog().getByRole("combobox", { name: "Episode", exact: true }).selectOption("2");
  assert.equal(await dialog().getByRole("button", { name: "7 out of 10", exact: true }).getAttribute("aria-pressed"), "true");
  passed("mobile controls fit the viewport, save successfully and persist across reload");
  assert.deepEqual(errors, []);
  passed("no uncaught browser errors across rating, clearing, Settings, Library and mobile flows");
  console.log(`${checks} browser checks passed. Disposable dev account; no live Simkl writes.`);
} finally { await browser.close(); }
