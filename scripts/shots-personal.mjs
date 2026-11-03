// Personalisation end to end: a brand-new profile sees "Make Krida yours", rates a few titles and gets its own picks;
// rating from a title page; search by genre, anime and genre queries; then signing out and into another profile.
// Needs a brand-new *-QA-* profile (npx convex run profiles:add, or on the QA app's backend) and a second QA profile.
// Usage: KRIDA_QA_PASSWORD=… node scripts/shots-personal.mjs [base] <newProfile> [otherProfile] [outDir]
import { mkdir } from "node:fs/promises";
import { launchBrowser } from "./lib/browser.ts";
import { baseUrl, checks, qaProfiles, signIn } from "./lib/qa.ts";

const [baseArg, newArg, otherArg, outDir = ".artifacts/shots-personal"] = process.argv.slice(2);
// A seeded profile already has picks, so the new one is never a default.
if (!newArg) throw new Error("Pass a brand-new QA profile: node scripts/shots-personal.mjs [base] <newProfile> [otherProfile] [outDir]");
const base = baseUrl(baseArg);
const [fresh, other] = qaProfiles([newArg, otherArg]);
await mkdir(outDir, { recursive: true });
const br = await launchBrowser();
const page = await (await br.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
const { check, finish } = checks(page);
const shot = async (name) => {
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${outDir}/p-${name}.png` });
  console.log("shot", name);
};

await signIn(page, base, fresh);
await page.getByText("Make Krida yours").waitFor({ timeout: 30000 });
await shot("home-cold");

await page.getByRole("button", { name: "Rate a few" }).click();
const sheet = page.getByRole("dialog");
await sheet.getByRole("button", { name: "Love this" }).first().waitFor({ timeout: 20000 });
const love = sheet.getByRole("button", { name: "Love this" });
const like = sheet.getByRole("button", { name: "I like this" });
const nope = sheet.getByRole("button", { name: "Not for me" });
await love.nth(0).click();
await love.nth(3).click();
await like.nth(1).click();
await like.nth(5).click();
await nope.nth(2).click();
await shot("starter-sheet");
await sheet.getByRole("button", { name: "Done" }).click();

// Ratings recompute picks a few seconds later.
const t = Date.now();
await page.getByText("Top picks for you").waitFor({ timeout: 120000 });
console.log(`personal picks after ${Math.round((Date.now() - t) / 1000)}s`);
const picks = page.locator("section", { has: page.getByRole("heading", { name: "Top picks for you" }) });
const picked = (await picks.locator("a p.font-medium").allTextContents()).slice(0, 8);
check("Top picks for you lists titles", picked.length > 0, picked.join(" | "));
check("the Make Krida yours card is gone", (await page.getByText("Make Krida yours").count()) === 0);
await page.getByText("Top picks for you").scrollIntoViewIfNeeded();
await shot("home-personal");

await page.goto(`${base}/title/series/tt0903747`);
await page.getByRole("button", { name: "Rate this" }).click();
await page.getByRole("button", { name: "Love this" }).click();
await page.getByRole("button", { name: /Your rating: Love this/ }).waitFor();
await shot("title-rated");

await page.goto(`${base}/search`);
await page.getByRole("listitem").filter({ hasText: "Horror" }).waitFor();
await shot("search-landing");
await page.getByRole("listitem").filter({ hasText: "Horror" }).click();
await page.locator("main ul li a").first().waitFor({ timeout: 30000 });
console.log("horror:", (await page.locator("main ul a p.font-medium").allTextContents()).slice(0, 6).join(" | "));
await shot("search-genre");

for (const [q, name] of [
  ["sci-fi shows", "search-genre-query"],
  ["naruto", "search-anime"],
]) {
  await page.goto(`${base}/search?q=${encodeURIComponent(q)}`);
  await page.locator("main a").first().waitFor({ timeout: 30000 });
  console.log(`${q}:`, (await page.locator("main h2").allTextContents()).join(" | "));
  await shot(name);
}

// Switch profiles.
await page.goto(`${base}/settings`);
await page.getByRole("button", { name: `Sign out of ${fresh.name}` }).click();
await signIn(page, base, other);
await page.goto(`${base}/settings`);
const signedIn = await page.locator("main h1").textContent();
check("signing out and in switches the profile", signedIn === other.name, `Settings shows ${signedIn}`);

await br.close();
finish();
