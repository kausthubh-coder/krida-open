// A show in the player: Breaking Bad S1 E1 plays, it keeps playing after switching the audio track and the source,
// and Next episode plays S1 E2. Needs a *-QA-* profile on the dev backend that hasn't started the show (real TorBox
// streams).
// Usage: KRIDA_QA_PASSWORD=… node scripts/e2e-series.mjs [base] [profile] [outDir]
import { mkdir } from "node:fs/promises";
import { launchBrowser } from "./lib/browser.ts";
import { baseUrl, checks, qaProfiles, signIn } from "./lib/qa.ts";

const [baseArg, name, outDir = ".artifacts/series"] = process.argv.slice(2);
const base = baseUrl(baseArg);
const [profile] = qaProfiles([name]);
await mkdir(outDir, { recursive: true });
const br = await launchBrowser();
const page = await (await br.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
const { check, finish } = checks(page);
const t0 = Date.now(); const secs = () => ((Date.now() - t0) / 1000).toFixed(1) + "s";
const st = () => page.evaluate(() => { const v = document.querySelector("video"); return v && { t: +v.currentTime.toFixed(1), paused: v.paused, w: v.videoWidth, h: v.videoHeight, audio: v.webkitAudioDecodedByteCount }; });
const ready = () => page.waitForFunction(() => { const v = document.querySelector("video"); return v && v.readyState >= 3 && !v.paused; }, null, { timeout: 120000 });
const wake = async () => { await page.mouse.move(600, 300); await page.mouse.move(640, 360); await page.waitForTimeout(150); };
await signIn(page, base, profile);
await page.goto(base + "/title/series/tt0903747"); await page.getByRole("button", { name: /^(Play|Resume) S\d+ E\d+$/ }).click();
await page.waitForURL(/\/watch\//); await ready(); console.log(secs(), "playing", JSON.stringify(await st()));
check("S1 E1 plays", (await page.title()).includes("S1 E1"), await page.title());
// audio track menu
await wake(); const audioBtn = page.getByRole("button", { name: "Audio", exact: true });
if (await audioBtn.isVisible()) {
  await audioBtn.click(); const rows = page.getByRole("dialog", { name: "Audio" }).getByRole("button");
  console.log("audio tracks:", (await rows.allTextContents()).join(" | "));
  await rows.last().click(); await ready(); console.log(secs(), "after audio switch", JSON.stringify(await st()));
} else console.log("single audio track, no menu");
// change source
await wake(); await page.getByRole("button", { name: "Change source" }).click();
await page.waitForSelector("text=Asking your addons", { state: "detached", timeout: 30000 });
const rows = page.getByRole("dialog").locator("ul > li > button");
const listed = await rows.count();
check("Change source lists at least four sources", listed >= 4, `${listed} listed`);
await rows.nth(3).click(); await page.waitForTimeout(500); await page.screenshot({ path: `${outDir}/series-switching.png` });
await ready(); console.log(secs(), "after source switch", JSON.stringify(await st()));
// next episode
await wake(); await page.getByRole("button", { name: "Next episode" }).click();
await page.waitForFunction(() => document.title.includes("S1 E2"), null, { timeout: 30000 }); await ready();
console.log(secs(), "next episode playing:", await page.title(), JSON.stringify(await st()));
await wake(); await page.screenshot({ path: `${outDir}/series-playing.png` });
await br.close();
finish();
