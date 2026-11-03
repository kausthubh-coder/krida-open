// Skip intro and credits: Breaking Bad S1 E2 (intro 5:14–5:31, credits from 47:23 with Up next) and Interstellar
// (credits from 2:43:59, nothing up next). Needs a *-QA-* profile on the dev backend (real TorBox streams).
// Usage: KRIDA_QA_PASSWORD=… node scripts/e2e-skips.mjs [base] [profile] [outDir]
import { mkdir } from "node:fs/promises";
import { launchBrowser } from "./lib/browser.ts";
import { baseUrl, checks, qaProfiles, signIn } from "./lib/qa.ts";

const [baseArg, name, outDir = ".artifacts/skips"] = process.argv.slice(2);
const base = baseUrl(baseArg);
const [profile] = qaProfiles([name]);
await mkdir(outDir, { recursive: true });
const br = await launchBrowser();
const page = await (await br.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
const { check, finish } = checks(page);
const t0 = Date.now();
const log = (...a) => console.log(((Date.now() - t0) / 1000).toFixed(1) + "s", ...a);
const state = () =>
  page.evaluate(() => {
    const v = document.querySelector("video");
    return v && { t: +v.currentTime.toFixed(1), d: Math.round(v.duration || 0), paused: v.paused };
  });
const playing = () =>
  page.waitForFunction(() => {
    const v = document.querySelector("video");
    return v && v.readyState >= 3 && !v.paused && v.duration > 0;
  }, null, { timeout: 120000 });
const wake = async () => {
  await page.mouse.move(600, 300);
  await page.mouse.move(640, 360);
  await page.waitForTimeout(150);
};
const seek = async (seconds) => {
  await wake();
  const bar = await page.getByRole("slider", { name: "Seek" }).boundingBox();
  const { d } = await state();
  await page.mouse.click(bar.x + (bar.width * seconds) / d, bar.y + bar.height / 2);
};

await signIn(page, base, profile);
await page.waitForTimeout(1500);
const leave = page.getByRole("button", { name: "Leave party" });
if (await leave.isVisible().catch(() => false)) await leave.click();

// Breaking Bad S1 E2
await page.goto(base + "/title/series/tt0903747");
await page.getByRole("button", { name: /^Play S1 E2,/ }).click();
await playing();
log("S1 E2 playing", JSON.stringify(await state()));
await seek(316);
await page.getByRole("button", { name: "Skip intro" }).waitFor({ timeout: 30000 });
await page.waitForTimeout(600);
await page.screenshot({ path: `${outDir}/skip-intro.png` });
await page.getByRole("button", { name: "Skip intro" }).click();
await page.waitForTimeout(1500);
const skipped = await state();
check("Skip intro lands past the intro (5:31)", skipped.t >= 331, JSON.stringify(skipped));
await seek(2846);
await page.getByText(/Up next in/).waitFor({ timeout: 30000 });
log("credits reached, Up next countdown showing");
await wake();
await page.screenshot({ path: `${outDir}/credits-up-next.png` });
const audioButton = page.getByRole("button", { name: "Audio language" });
log("audio language button:", (await audioButton.count()) ? "present" : "hidden (single audio track)");

// Interstellar: credits with nothing up next
await page.getByRole("button", { name: "Back" }).first().click();
await page.goto(base + "/title/movie/tt0816692");
await page.getByRole("button", { name: /^(Play|Resume)$/ }).click();
await playing();
log("Interstellar playing", JSON.stringify(await state()));
await seek(9845);
await page.getByRole("button", { name: "Skip credits" }).waitFor({ timeout: 30000 });
log("Skip credits showing");
await wake();
await page.screenshot({ path: `${outDir}/skip-credits.png` });
if (await page.getByRole("button", { name: "Audio language" }).count()) {
  await page.getByRole("button", { name: "Audio language" }).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${outDir}/audio-menu.png` });
  log("audio language menu opened");
}
await br.close();
finish();
