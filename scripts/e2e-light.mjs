// The general check: Home from /api/rows, the synced copy in IndexedDB, search, a title page's ratings and More like
// this, a rating showing at once and surviving a reload, the Library and Settings, and no old whole-library queries.
// Needs the QA app (npm run qa -- up) or a *-QA-* profile on the dev backend. Screenshots in .artifacts/light-check.
// Usage: node scripts/e2e-light.mjs [base] [profile]
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { launchBrowser } from "./lib/browser.ts";
import { baseUrl, qaProfiles, signIn } from "./lib/qa.ts";

const base = baseUrl(process.argv[2]);
const [profile] = qaProfiles([process.argv[3]]);
const out = ".artifacts/light-check";
await mkdir(out, { recursive: true });
const browser = await launchBrowser({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const convex = [];
page.on("websocket", (ws) => ws.on("framesent", (f) => {
  const text = typeof f.payload === "string" ? f.payload : "";
  for (const m of text.matchAll(/"udfPath":"([^"]+)"/g)) convex.push(m[1]);
}));
let checks = 0;
const passed = (name) => { checks++; console.log("PASS", name); };
const film = { id: "tt0047478", name: "Seven Samurai" };

try {
  await signIn(page, base, profile);

  // Home: catalog rows from /api/rows, personal rows from Convex.
  await page.getByRole("heading", { name: /Popular movies|Top 10/ }).first().waitFor({ timeout: 60_000 });
  const headings = await page.getByRole("heading", { level: 2 }).allTextContents();
  assert.ok(headings.length >= 5, `Home shows rows (${headings.join(" | ")})`);
  await page.screenshot({ path: `${out}/home.png` });
  passed(`Home shows ${headings.length} rows`);

  // The synced copy is kept in IndexedDB.
  await page.waitForFunction(async () => {
    const db = await new Promise((resolve) => { const r = indexedDB.open("krida-sync"); r.onsuccess = () => resolve(r.result); });
    const keys = await new Promise((resolve) => { const r = db.transaction("copies").objectStore("copies").getAllKeys(); r.onsuccess = () => resolve(r.result); });
    db.close();
    return keys.length > 0;
  }, null, { timeout: 30_000 });
  passed("the profile's tables are kept in IndexedDB");

  // Search through /api/search.
  await page.goto(`${base}/search?q=seven%20samurai`);
  await page.getByRole("link", { name: new RegExp(film.name) }).first().waitFor({ timeout: 30_000 });
  passed("search finds titles");

  // A title page: ratings from /api/title, More like this from /api/more-like.
  await page.goto(`${base}/title/movie/${film.id}`);
  await page.getByRole("heading", { name: film.name }).waitFor();
  await page.getByText(/IMDb/).first().waitFor({ timeout: 30_000 });
  await page.getByRole("heading", { name: "More like this" }).waitFor({ timeout: 60_000 });
  passed("the title page shows ratings and More like this");

  // Rating shows at once, and is still there after a reload (from the synced copy).
  const rate = () => page.getByRole("button", { name: new RegExp(`(Rate|Change your rating for) ${film.name}`) }).first();
  await rate().click();
  const dialog = page.getByRole("dialog").filter({ hasText: "Your score for the movie" });
  const score = 7 + Math.floor(Math.random() * 3);
  await dialog.locator(`[data-score="${score}"]`).click();
  await dialog.getByRole("button", { name: "Save changes", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  await page.getByRole("button", { name: new RegExp(`Your rating: ${score} out of 10`) }).first().waitFor();
  await page.reload();
  await page.getByRole("button", { name: new RegExp(`Your rating: ${score} out of 10`) }).first().waitFor({ timeout: 30_000 });
  passed(`a ${score}/10 rating shows at once and survives a reload`);

  // The Library is built from the synced copy.
  await page.goto(`${base}/library`);
  await page.getByRole("heading", { name: /Plan to watch|Watched|Watching/ }).first().waitFor({ timeout: 30_000 });
  await page.screenshot({ path: `${out}/library.png` });
  passed("the Library loads");

  // Settings counts come from the copy too.
  await page.goto(`${base}/settings`);
  await page.getByText(/rated in Krida|Nothing rated yet/).waitFor({ timeout: 30_000 });
  passed("Settings shows rating counts");

  // None of the old whole-library queries are asked for.
  const old = ["library:simklRows", "library:ownRows", "library:progressRows", "progress:started", "progress:continueWatching",
    "catalogs:mine", "catalogs:rows", "titles:search", "titles:info", "recs:moreLikeThis", "trailers:imdb", "feedback:summary", "simkl:status"];
  const asked = [...new Set(convex)];
  assert.deepEqual(asked.filter((f) => old.some((o) => f.replace(/\.js:|:/, ":").includes(o))), []);
  passed(`Convex is asked only for: ${asked.join(", ")}`);

  assert.deepEqual(errors, []);
  console.log(`\n${checks} checks passed`);
} catch (error) {
  await page.screenshot({ path: `${out}/failure.png` }).catch(() => {});
  console.error("FAIL", error);
  if (errors.length) console.error("page errors:", errors);
  process.exitCode = 1;
} finally {
  await browser.close();
}
