// Screenshots of what TMDB, MDBList and Simkl add: search (titles, a person, a typo), title ratings, the Simkl
// connection in Settings, and the home rows; starts the Simkl connect flow up to Simkl's consent page without signing
// in there. Needs a *-QA-* profile with picks on the dev backend (SIMKL_CLIENT_ID is a Convex env variable there).
// Usage: KRIDA_QA_PASSWORD=… node scripts/shots-integrations.mjs [base] [profile] [outDir] [width] [height]
import { mkdir } from "node:fs/promises";
import { launchBrowser } from "./lib/browser.ts";
import { baseUrl, checks, qaProfiles, signIn } from "./lib/qa.ts";

const [baseArg, name, outDir = ".artifacts/shots-integrations", width = "1280", height = "800"] = process.argv.slice(2);
const base = baseUrl(baseArg);
const [profile] = qaProfiles([name]);
await mkdir(outDir, { recursive: true });
const br = await launchBrowser();
const page = await (await br.newContext({ viewport: { width: +width, height: +height } })).newPage();
const { finish } = checks(page);
const consoleErrors = [];
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text().slice(0, 300)));
const shot = async (name) => {
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${outDir}/${width}-${name}.png` });
  console.log("shot", name);
};

await signIn(page, base, profile);

for (const [q, name] of [
  ["breaking bad", "search-title"],
  ["christopher nolan", "search-person"],
  ["intersteller", "search-typo"],
]) {
  const t = Date.now();
  await page.goto(`${base}/search?q=${encodeURIComponent(q)}`);
  await page.locator("main ul li a").first().waitFor({ timeout: 30000 });
  console.log(`${q}: ${Date.now() - t}ms`, (await page.locator("main a p.truncate.font-medium").allTextContents()).slice(0, 8).join(" | "));
  await shot(name);
}

await page.goto(`${base}/title/series/tt0903747`);
await page.getByText("Rotten Tomatoes").waitFor({ timeout: 30000 });
await shot("title-ratings");
await page.getByText("More like this").scrollIntoViewIfNeeded();
await shot("title-more-like-this");

await page.goto(`${base}/settings/taste`);
await page.getByRole("button", { name: "Connect Simkl" }).waitFor({ timeout: 30000 });
await shot("settings-connections");

await page.goto(base);
await page.getByText("Top picks for you").waitFor({ timeout: 30000 });
console.log("rows:", (await page.locator("main h2").allTextContents()).join(" | "));
await page.mouse.wheel(0, 700);
await shot("home-rows");

// The connect flow up to Simkl's consent page (no Simkl sign-in here).
await page.goto(`${base}/settings/taste`);
await page.getByRole("button", { name: "Connect Simkl" }).click();
await page.waitForURL(/simkl\.com/, { timeout: 30000 });
const url = new URL(page.url());
console.log("simkl:", url.origin + url.pathname, [...url.searchParams.keys()].join(","));
await shot("simkl-consent");

// Console errors include Simkl's own page, so they're shown, not counted.
console.log("console errors:", JSON.stringify(consoleErrors));
await br.close();
finish();
