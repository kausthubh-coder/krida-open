// The first open after a deploy shows Home's catalog rows at once, from the last answer this browser kept, while
// /api/rows rebuilds (a deploy empties Vercel's cache, and a rebuild takes 5 to 15 s); the new answer replaces them
// when it comes. /api/rows is answered here, so it needs no catalog keys. A deploy is played by renaming what this
// build kept to an older build's name, which is what a new bundle hash does. Needs the QA app (npm run qa -- up).
// Usage: node scripts/e2e-home-new-build.mjs [base] [profile]
import { launchBrowser } from "./lib/browser.ts";
import { baseUrl, checks, qaProfiles, signIn } from "./lib/qa.ts";

const base = baseUrl(process.argv[2]);
const [profile] = qaProfiles([process.argv[3]]);
const br = await launchBrowser();
const { check, finish, watch } = checks();

const BEFORE = "Rows from before the deploy";
const AFTER = "Rows after the deploy";
const REBUILD_MS = 12_000;
const answer = (title) => ({
  rows: [{
    key: "aio:test", title, style: "poster", source: "aio", updatedAt: Date.now(),
    items: ["tt0111161", "tt0068646", "tt0468569", "tt0071562", "tt0050083", "tt0108052"].map((id, i) => ({ id, type: "movie", name: `Film ${i + 1}`, year: "1994", genres: ["Drama"] })),
  }],
});

const context = await br.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
watch(page);
let rebuilding = false;
await page.route("**/api/rows*", async (route) => {
  if (rebuilding) await new Promise((resolve) => setTimeout(resolve, REBUILD_MS));
  await route.fulfill({ json: answer(rebuilding ? AFTER : BEFORE), headers: { "Cache-Control": "no-store" } });
});

await signIn(page, base, profile);
await page.getByRole("heading", { name: BEFORE }).waitFor({ timeout: 60_000 });
// The answer is kept when the page is idle, within 2 s.
await page.waitForTimeout(3000);

const renamed = await page.evaluate(() => {
  let n = 0;
  for (const key of Object.keys(localStorage)) {
    const m = /^krida\.q\.([0-9a-z]+)\.(.+)$/.exec(key);
    if (!m) continue;
    localStorage.setItem(`krida.q.0ldbuild.${m[2]}`, localStorage.getItem(key));
    localStorage.removeItem(key);
    n++;
  }
  return n;
});
check("this build had kept results to age", renamed > 0, `${renamed} renamed`);

rebuilding = true;
const opened = Date.now();
await page.reload({ waitUntil: "domcontentloaded" });
const shown = await page.getByRole("heading", { name: BEFORE }).waitFor({ timeout: REBUILD_MS - 2000 }).then(() => Date.now() - opened, () => null);
check("after a deploy, Home shows the kept catalog rows before /api/rows answers", shown !== null, shown === null ? `nothing within ${(REBUILD_MS - 2000) / 1000} s` : `${shown} ms`);
await page.screenshot({ path: ".artifacts/e2e-home-new-build.png" });

const replaced = await page.getByRole("heading", { name: AFTER }).waitFor({ timeout: REBUILD_MS + 10_000 }).then(() => true, () => false);
check("the new answer replaces them when it comes", replaced);
check("the kept rows are gone once replaced", (await page.getByRole("heading", { name: BEFORE }).count()) === 0);
check("results kept for the older build were dropped", await page.evaluate(() => !Object.keys(localStorage).some((k) => k.startsWith("krida.q.0ldbuild."))));

await br.close();
finish();
