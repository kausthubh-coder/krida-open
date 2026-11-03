// Screenshots of Home, a title page with More like this, an anime title, and Home rows in Settings; at 1000px and
// wider, also plays an anime episode to check Kitsu titles stream. Needs a *-QA-* profile with picks on the dev
// backend (real TorBox streams).
// Usage: KRIDA_QA_PASSWORD=… node scripts/shots-home.mjs [base] [profile] [outDir] [width] [height]
import { mkdir } from "node:fs/promises";
import { launchBrowser } from "./lib/browser.ts";
import { baseUrl, checks, qaProfiles, signIn } from "./lib/qa.ts";

const [baseArg, name, outDir = ".artifacts/shots-home", width = "1280", height = "800"] = process.argv.slice(2);
const base = baseUrl(baseArg);
const [profile] = qaProfiles([name]);
await mkdir(outDir, { recursive: true });
const br = await launchBrowser();
const page = await (await br.newContext({ viewport: { width: +width, height: +height } })).newPage();
const { check, finish } = checks(page);
const shot = async (name) => {
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${outDir}/${width}-${name}.png` });
  console.log("shot", name);
};

await signIn(page, base, profile);
const leave = page.getByRole("button", { name: "Leave party" });
if (await leave.waitFor({ timeout: 4000 }).then(() => true, () => false)) {
  await leave.click();
  await page.getByRole("region", { name: "Your watch party" }).waitFor({ state: "detached" });
}
await page.getByText("Top picks for you").waitFor({ timeout: 30000 });
await shot("home-hero");
await page.mouse.wheel(0, 700);
await shot("home-rows-1");
await page.mouse.wheel(0, 900);
await shot("home-rows-2");
console.log("rows:", (await page.locator("main h2").allTextContents()).join(" | "));

await page.goto(base + "/title/series/tt0903747");
await page.getByText("More like this").waitFor({ timeout: 30000 });
await page.getByText("More like this").scrollIntoViewIfNeeded();
await shot("title-more-like-this");

await page.goto(base + "/title/series/kitsu:12");
await page.getByText("Episodes").waitFor({ timeout: 30000 });
await shot("anime-title");
await page.mouse.wheel(0, 700);
await shot("anime-episodes");

await page.goto(base + "/settings");
await page.getByText("Home rows").scrollIntoViewIfNeeded();
await shot("settings-rows");

if (+width >= 1000) {
  await page.goto(base + "/title/series/kitsu:12");
  await page.getByRole("button", { name: /^Play S1 E1,/ }).click();
  await page.waitForFunction(() => {
    const v = document.querySelector("video");
    return v && v.readyState >= 3 && !v.paused;
  }, null, { timeout: 120000 });
  const s = await page.evaluate(() => {
    const v = document.querySelector("video");
    return { w: v.videoWidth, h: v.videoHeight, d: Math.round(v.duration), title: document.title };
  });
  check("an anime episode streams", s.w > 0 && s.d > 0, JSON.stringify(s));
}
await br.close();
finish();
