// The Library: To rate (scoring in place, Undo, Didn't watch it, the phone sheet), collections on phones, search, sort,
// filters following you, genres, Stats and Wrapped, each read back from Convex. Needs a local backend (the QA app, or
// KRIDA_QA_CONVEX_URL and KRIDA_QA_TOKEN) and a *-QA-* profile there with at least one unrated finished movie.
// Usage: node scripts/e2e-library.mjs [base] [profile]
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { launchBrowser } from "./lib/browser.ts";
import { ConvexHttpClient } from "convex/browser";
import { assertLocal, assertQaProfile, baseUrl, convexSignIn, convexUrls, qaProfiles } from "./lib/qa.ts";

const base = baseUrl(process.argv[2]);
const backend = process.env.KRIDA_QA_CONVEX_URL ?? convexUrls().url;
// It writes scores and history straight to the backend, so only a throwaway one on this machine.
assertLocal(backend);
const client = new ConvexHttpClient(backend);
const token = process.env.KRIDA_QA_TOKEN ?? (await convexSignIn(client, qaProfiles([process.argv[3]])[0])).token;
const me = await client.query("profiles:me", { token });
assertQaProfile(me?.name ?? "");
const backlog = await client.query("library:toRate", { token });
const item = backlog.items.find((i) => i.type === "movie");
assert.ok(item, "Seed at least one unrated finished movie");
const out = ".artifacts/library-qa";
await mkdir(out, { recursive: true });
const browser = await launchBrowser({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
await context.addInitScript((value) => localStorage.setItem("krida.session", value), token);
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const check = (ok, label) => { assert.ok(ok, label); console.log(`PASS ${label}`); };
const query = (name, args = {}) => client.query(name, { token, ...args });
const waitFor = async (predicate) => {
  for (let i = 0; i < 80; i++) { if (await predicate()) return; await new Promise((r) => setTimeout(r, 250)); }
  throw new Error("Read-back timed out");
};
const row = () => page.locator("main li").filter({ has: page.getByRole("link", { name: item.name, exact: true }) });
const overflow = async () => page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
try {
  await page.goto(`${base}/library?tab=rate`);
  await row().getByRole("group", { name: `Score ${item.name}` }).waitFor();
  for (const name of backlog.tooFew.names) check(await page.locator("main li").filter({ has: page.getByRole("link", { name, exact: true }) }).count() === 0, `${name} is excluded from rating rows`);
  const y = (await row().boundingBox()).y;
  await row().getByRole("button", { name: /^8 out of 10/ }).click();
  await row().getByRole("button", { name: "Undo" }).waitFor();
  check((await query("ratings:details", { id: item.id })).rating === 8, "score persisted independently");
  check(Math.abs((await row().boundingBox()).y - y) < 2, "scoring keeps the row in place");
  await page.screenshot({ path: `${out}/to-rate-desktop.png` });
  await row().getByRole("button", { name: "Undo" }).click();
  await waitFor(async () => (await query("ratings:details", { id: item.id })).rating === null);
  await row().getByRole("button", { name: "Didn’t watch it" }).click();
  await row().getByRole("button", { name: "Undo" }).waitFor();
  await waitFor(async () => !(await query("library:overview", { separateStatuses: true })).watched.some((i) => i.id === item.id));
  check(!(await query("library:toRate")).items.some((i) => i.id === item.id), "didn't watch hides the title in independent queries");
  await row().getByRole("button", { name: "Undo" }).click();
  await waitFor(async () => (await query("library:overview", { separateStatuses: true })).watched.some((i) => i.id === item.id));
  console.log("PASS undo restores watched history");

  for (const width of [320, 390, 768, 1100, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    check(!(await overflow()), `rating page fits ${width}px`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${out}/to-rate-mobile.png` });
  await row().getByRole("button", { name: "Rate", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("group", { name: `Score ${item.name}` }).waitFor();
  await page.screenshot({ path: `${out}/rating-sheet-mobile.png` });
  await page.keyboard.press("7");
  await waitFor(async () => (await query("ratings:details", { id: item.id })).rating === 7);
  console.log("PASS keyboard score saved from mobile sheet");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  await page.reload();
  await page.getByRole("heading", { name: "To rate", exact: true }).waitFor();
  await page.getByRole("heading", { name: /titles? to rate|No titles waiting/ }).waitFor();
  check(await row().count() === 0, "rated title stays out after reload");

  // Phones open the list of collections; each one is its own page with a way back.
  await page.goto(`${base}/library`);
  const nav = page.getByRole("navigation", { name: "Library" });
  await nav.getByRole("link", { name: /^Plan to watch/ }).waitFor();
  check(await nav.getByRole("link", { name: /^All/ }).count() === 0, "there is no All collection");
  for (const name of ["Plan to watch", "Watching", "Watched"]) check(await nav.getByRole("link", { name: new RegExp(`^${name}`) }).count() === 1, `${name} is listed on mobile`);
  check(!(await overflow()), "collection list fits mobile");
  await nav.getByRole("link", { name: /^Watching/ }).click();
  await page.getByRole("heading", { name: "Watching", exact: true }).waitFor();
  check(!(await overflow()), "Watching fits mobile");
  await page.getByRole("main").getByRole("link", { name: "Library", exact: true }).click();
  await nav.waitFor();

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${base}/library?tab=watched`);
  check(await nav.getByRole("link", { name: /^Watched/ }).getAttribute("aria-current") === "page", "the open collection is marked in the side list");
  const search = page.getByRole("searchbox", { name: "Search your Library" });
  await search.fill("zzqx no such title");
  await page.getByRole("button", { name: "Clear search" }).last().click();
  check(await search.inputValue() === "", "clearing a search with no matches empties the field");
  const overview = await query("library:overview", { separateStatuses: true });
  const sample = overview.watched.find((i) => i.name.length > 4);
  await search.fill(sample.name);
  await page.locator("main p[title]").filter({ hasText: sample.name }).first().waitFor();
  check(await page.locator("main ul li").count() <= overview.watched.filter((i) => i.name.toLowerCase().includes(sample.name.toLowerCase())).length + 1, "search narrows the diary");
  await search.press("Escape");
  await nav.getByRole("link", { name: /^Plan to watch/ }).click();
  await page.getByRole("heading", { name: "Plan to watch", exact: true }).waitFor();
  await page.getByRole("combobox", { name: "Sort by" }).selectOption("title");
  const names = await page.locator("main ul li p[title]").evaluateAll((els) => els.slice(0, 5).map((e) => e.getAttribute("title")));
  check(names.every((n, i) => i === 0 || names[i - 1].localeCompare(n, undefined, { sensitivity: "base", ignorePunctuation: true }) <= 0), "Plan to watch sorts by title");

  // Filters follow you between collections and narrow the side list's counts too.
  await page.goto(`${base}/library?tab=watched`);
  await page.getByRole("button", { name: "Filters" }).click();
  await page.getByRole("dialog", { name: "Filter your Library" }).getByText("Anime", { exact: true }).click();
  await page.keyboard.press("Escape");
  check(await page.getByRole("button", { name: "Filters, 1 on" }).isVisible(), "the filter button counts what's on");
  const anime = overview.watched.filter((i) => i.id.startsWith("kitsu:")).length;
  await page.getByText(`${anime} of ${overview.watched.length}`).waitFor();
  const facts = await page.locator("main ul li").evaluateAll((els) => els.map((e) => e.textContent ?? ""));
  check(facts.length > 0 && facts.every((t) => t.includes("Anime")), "Anime keeps only anime in the diary");
  check((await nav.getByRole("link", { name: /^Watched/ }).textContent()).includes(String(anime)), "the side list counts the filtered titles");
  await nav.getByRole("link", { name: /^Plan to watch/ }).click();
  check(await page.getByRole("button", { name: "Filters, 1 on" }).isVisible(), "filters follow you to another collection");
  await page.getByRole("button", { name: "Clear filters" }).first().click();

  // Genres load on the way to the button, and narrow like the rest.
  await page.goto(`${base}/library?tab=watched`);
  await page.getByRole("button", { name: "Filters" }).click();
  const filterSheet = page.getByRole("dialog", { name: "Filter your Library" });
  await filterSheet.getByText("Any genre", { exact: true }).waitFor({ timeout: 30_000 });
  const genre = (await filterSheet.getByRole("group", { name: "Genre" }).locator("label").allTextContents()).find((g) => g !== "Any genre");
  await filterSheet.getByText(genre, { exact: true }).click();
  await page.keyboard.press("Escape");
  await page.getByText(new RegExp(`^${genre} · \\d+ of ${overview.watched.length}`)).waitFor();
  check((await page.locator("main ul li").count()) < overview.watched.length, `${genre} narrows the diary`);
  await page.getByRole("button", { name: "Clear filters" }).first().click();
  check(await page.getByRole("button", { name: "Filters", exact: true }).isVisible(), "Clear filters turns them all off");
  await page.goto(`${base}/library?tab=stats`);
  await page.getByRole("heading", { name: "What you watched most" }).waitFor({ timeout: 60_000 });
  await page.screenshot({ path: `${out}/stats-desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  check(!(await overflow()), "stats fits mobile");
  await page.screenshot({ path: `${out}/stats-mobile.png`, fullPage: true });
  const openWrapped = page.getByRole("button", { name: "Open your Wrapped" });
  await openWrapped.click();
  await page.getByRole("heading", { name: /hours in other worlds/ }).waitFor();
  check(await dialog.evaluate((el) => el.scrollHeight > el.clientHeight), "Wrapped is a scrollable retrospective");
  await page.screenshot({ path: `${out}/wrapped-mobile.png` });
  const downloadReady = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save your card" }).click();
  const download = await downloadReady;
  await download.saveAs(`${out}/wrapped-card.png`);
  check((await download.failure()) === null, "Wrapped card downloads as PNG");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  check(await openWrapped.evaluate((el) => el === document.activeElement), "closing Wrapped restores focus");
  check(errors.length === 0, `no page errors: ${errors.join("; ")}`);
} finally {
  await client.mutation("ratings:save", { token, item: { id: item.id, type: item.type, name: item.name }, rating: null });
  await client.mutation("library:restoreWatched", { token, id: item.id });
  await browser.close();
}
