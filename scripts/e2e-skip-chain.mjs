// Attack on Titan S1 E9 (IntroDB: recap 0:17–0:53, intro 0:38–2:08, credits from 22:22): the recap and the intro it
// runs into skip in one go, Up next counts down 5 s over the credits, Watch credits holds it until the end, and the end
// counts down again and moves on to E10. Needs a *-QA-* profile on the dev backend (real TorBox streams); on a PR, run
// the frontend locally against the PR's Convex preview instead of dev, which other branches share.
// Usage: KRIDA_QA_PASSWORD=… node scripts/e2e-skip-chain.mjs [base] [profile] [outDir]
import { mkdir } from "node:fs/promises";
import { launchBrowser } from "./lib/browser.ts";
import { baseUrl, checks, qaProfiles, signIn } from "./lib/qa.ts";

const [baseArg, name, outDir = ".artifacts/skip-chain"] = process.argv.slice(2);
const base = baseUrl(baseArg);
const [profile] = qaProfiles([name]);
await mkdir(outDir, { recursive: true });
const br = await launchBrowser({ args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await (await br.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
const { check, finish } = checks(page);
const state = () =>
  page.evaluate(() => {
    const v = document.querySelector("video");
    return v && { t: +v.currentTime.toFixed(2), d: Math.round(v.duration || 0), paused: v.paused, ended: v.ended };
  });
const playing = () =>
  page.waitForFunction(() => {
    const v = document.querySelector("video");
    return v && v.readyState >= 3 && !v.paused && v.duration > 0;
  }, null, { timeout: 180000 });
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

await page.goto(base + "/title/series/tt2560140");
await page.getByRole("button", { name: /^Play S1 E9,/ }).click();
await playing();
const start = await state();
check("starts before the recap", start.t < 17, JSON.stringify(start));

// Run into the recap: one jump, straight past the intro.
const times = [];
let landed = null;
for (let i = 0; i < 160 && !landed; i++) {
  await page.waitForTimeout(250);
  const s = await state();
  times.push(s.t);
  if (s.t > 100) landed = s;
}
const before = times.filter((t) => t < 100).at(-1);
check("skipped to the end of the intro (2:08)", !!landed && landed.t >= 128 && landed.t < 132, `landed ${JSON.stringify(landed)}`);
check("the skip happened as the recap began (0:17)", before !== undefined && before >= 16.5 && before < 19, `last time before the jump ${before}`);
check("never played from inside the intro", !times.some((t) => t > 53 && t < 128));
const receipt = await page.getByText("Skipped recap and intro").waitFor({ timeout: 5000 }).then(() => true, () => false);
check("receipt says Skipped recap and intro", receipt);
check("no Skip intro button left over", (await page.getByRole("button", { name: "Skip intro" }).count()) === 0);
await page.screenshot({ path: `${outDir}/skipped-recap-and-intro.png` });

// Credits: 5 s countdown with Watch credits.
await seek(1335);
await page.getByText(/^Next episode in/).waitFor({ timeout: 60000 });
const shownAt = Date.now();
const label = await page.getByText(/^Next episode in/).textContent();
check("countdown starts at 5", /in\s*[45]$/.test(label.trim()), label);
check("Watch credits offered in the credits", await page.getByRole("button", { name: "Watch credits" }).isVisible());
check("Stop here waits for the end", (await page.getByRole("button", { name: "Stop here" }).count()) === 0);
await page.screenshot({ path: `${outDir}/credits-countdown.png` });
await page.getByRole("button", { name: "Watch credits" }).click();
console.log("clicked Watch credits after", Date.now() - shownAt, "ms");
const t1 = (await state()).t;
await page.waitForTimeout(7000);
const t2 = await state();
check("Watch credits puts Up next away", (await page.getByText(/^Next episode in/).count()) === 0);
check("the credits keep playing", t2.t > t1 + 5, `${t1} → ${t2.t}`);

// The end: counts down again, with Stop here, then moves on.
await seek(t2.d - 6);
await page.getByText(/^Next episode in/).waitFor({ timeout: 60000 });
check("the end offers Stop here", await page.getByRole("button", { name: "Stop here" }).isVisible());
await page.screenshot({ path: `${outDir}/end-countdown.png` });
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(300);
await page.screenshot({ path: `${outDir}/end-countdown-phone.png` });
const card = await page.getByRole("button", { name: "Stop here" }).boundingBox();
check("phone: the card's buttons fit on screen", !!card && card.x + card.width <= 390);
await page.setViewportSize({ width: 1280, height: 720 });
// The next episode starts from the top (the card itself names E10, so watch the video instead).
const movedOn = await page.waitForFunction(() => {
  const v = document.querySelector("video");
  return v && !v.paused && v.currentTime > 0.5 && v.currentTime < 60;
}, null, { timeout: 180000 }).then(() => true, () => false);
check("moved on to E10", movedOn);
await page.waitForTimeout(1000);
await page.screenshot({ path: `${outDir}/moved-on.png` });

await br.close();
finish();
