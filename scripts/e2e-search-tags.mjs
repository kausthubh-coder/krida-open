// Search by tags: parsing queries like "telugu comedy", typing and chips staying in step, Back restoring them, phone
// chips and the movie filter, ambiguous title, person and no-results pages, and loading, error and retry.
// Needs the QA app (npm run qa -- up) or a *-QA-* profile on the dev backend.
// Usage: node scripts/e2e-search-tags.mjs [base] [profile] [outDir]
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { launchBrowser } from "./lib/browser.ts";
import { parseTags, formatTags } from "../shared/tags.ts";
import { baseUrl, qaProfiles, signIn } from "./lib/qa.ts";

assert.deepEqual(parseTags("telugu comedy"), { genres: ["Comedy"], language: "te" });
assert.deepEqual(parseTags("90s horror movies"), { genres: ["Horror"], years: { from: 1990, to: 1999 }, type: "movie" });
assert.deepEqual(parseTags("k-drama"), { genres: ["Drama"], language: "ko", type: "series" });
assert.deepEqual(parseTags("rom com"), { genres: ["Romance", "Comedy"] });
for (const q of ["2012", "1917", "new girl", "christopher nolan"]) assert.equal(parseTags(q), null, q);
for (const q of ["best korean thrillers", "90s horror movies", "sci-fi shows"]) {
  assert.deepEqual(parseTags(formatTags(parseTags(q))), parseTags(q));
}

const [baseArg, name, out = ".artifacts/search-verified"] = process.argv.slice(2);
const base = baseUrl(baseArg);
const [profile] = qaProfiles([name]);
await mkdir(out, { recursive: true });
const browser = await launchBrowser();
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(30000);
  page.on("pageerror", (e) => errors.push(e.message));
  await signIn(page, base, profile);
  const input = page.getByRole("textbox", { name: "Search titles, people, genres and languages" });
  const grid = page.locator("main ul li a");
  const ready = () => grid.first().waitFor({ timeout: 30000 });
  const checkOverflow = async () => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);

  await page.goto(`${base}/search`);
  await page.getByText("Trending movies this week", { exact: true }).waitFor();
  await page.screenshot({ path: `${out}/desktop-empty.png` });
  await input.fill("telugu ");
  await page.waitForURL(/q=telugu$/);
  assert.equal(await input.inputValue(), "telugu ");
  await input.pressSequentially("comedy");
  await page.waitForURL(/q=telugu\+comedy/);
  await ready();
  assert.ok(await grid.count() > 0);
  await page.getByRole("heading", { name: "Popular Telugu comedy movies and shows", exact: true }).waitFor();
  await checkOverflow();
  await page.screenshot({ path: `${out}/desktop-telugu-comedy.png` });
  console.log("PASS typed Telugu comedy:", await grid.count(), "titles");

  await page.getByRole("button", { name: "Tamil", exact: true }).click();
  await page.goBack();
  await page.waitForFunction(() => document.querySelector("input").value === "telugu comedy");
  assert.equal(await page.getByRole("button", { name: "Telugu", exact: true }).getAttribute("aria-pressed"), "true");
  console.log("PASS browser Back restores input and chips");

  await page.setViewportSize({ width: 390, height: 844 });
  await ready();
  await checkOverflow();
  assert.equal(await page.getByRole("button", { name: "Comedy", exact: true }).evaluate((e) => e.getBoundingClientRect().height), 44);
  await page.screenshot({ path: `${out}/mobile-telugu-comedy.png` });
  await page.getByRole("button", { name: "Clear search", exact: true }).click();
  await page.getByRole("button", { name: "Telugu", exact: true }).click();
  await page.getByRole("button", { name: "Comedy", exact: true }).click();
  await page.getByRole("tab", { name: "Movies", exact: true }).click();
  await ready();
  assert.equal(await input.inputValue(), "telugu comedy movies");
  assert.equal(await grid.evaluateAll((links) => links.every((a) => a.getAttribute("href").startsWith("/title/movie/"))), true);
  console.log("PASS mobile chip composition, movie filter and 44px targets");

  await page.goto(`${base}/search?q=scary%20movie`);
  await page.getByRole("heading", { name: "Titles with this name", exact: true }).waitFor({ timeout: 30000 });
  console.log("PASS ambiguous title Scary Movie");
  await page.goto(`${base}/search?q=christopher%20nolan`);
  await page.getByRole("heading", { name: /Christopher Nolan/ }).waitFor({ timeout: 30000 });
  console.log("PASS person search");
  await page.goto(`${base}/search?q=2026%20telugu%20western%20shows`);
  await page.getByText("Nothing for", { exact: false }).waitFor({ timeout: 30000 });
  await page.screenshot({ path: `${out}/mobile-no-results.png` });
  console.log("PASS no-results state");

  // Hold one action in the browser to inspect loading, then reject it to inspect recovery.
  await page.evaluate(async () => {
    const moduleUrl = performance.getEntriesByType("resource").find((r) => r.name.includes("/convex_react.js?")).name;
    const { ConvexReactClient } = await import(moduleUrl);
    const p = ConvexReactClient.prototype;
    window.__searchQA = { p, action: p.action };
    p.action = function (fn, args) {
      if (args?.q === "2025 tamil mystery") return new Promise((_, reject) => { window.__searchQA.reject = reject; });
      return window.__searchQA.action.call(this, fn, args);
    };
  });
  await input.fill("2025 tamil mystery");
  await page.getByText("Finding them on TMDB…", { exact: true }).waitFor();
  await page.screenshot({ path: `${out}/mobile-loading.png` });
  await page.waitForFunction(() => !!window.__searchQA.reject);
  await page.evaluate(() => {
    const qa = window.__searchQA;
    qa.p.action = qa.action;
    qa.reject(new Error("Controlled search outage"));
    delete window.__searchQA;
  });
  await page.getByText("Couldn’t load these", { exact: true }).waitFor();
  await page.screenshot({ path: `${out}/mobile-error.png` });
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await ready();
  console.log("PASS controlled loading, error and live retry");
  assert.deepEqual(errors, []);
  console.log("PASS no page errors; screenshots:", out);
} finally {
  await browser.close();
}
