// Critly audit helper for Settings (and Library): full-page screenshots at 1280 and 390, the inventory of distinct
// design values (scripts/inventory.js), keyboard focus order, and no sideways overflow at either width.
// Needs the QA app (npm run qa -- up) or a *-QA-* profile on dev.
// Usage: node scripts/audit-settings.mjs [base] [profile] [outDir] [tag]
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { launchBrowser } from "./lib/browser.ts";
import { baseUrl, checks, qaProfiles, signIn } from "./lib/qa.ts";

const [baseArg, name, outDir = ".artifacts/audit-settings", tag = "before"] = process.argv.slice(2);
const base = baseUrl(baseArg);
const [profile] = qaProfiles([name]);
await mkdir(outDir, { recursive: true });
const inventory = readFileSync(new URL("./inventory.js", import.meta.url), "utf8");
const br = await launchBrowser();
const { check, finish, watch } = checks();

for (const width of [1280, 390]) {
  const page = await (await br.newContext({ viewport: { width, height: width > 500 ? 800 : 844 } })).newPage();
  watch(page, `${width}px`);
  await signIn(page, base, profile);

  await page.goto(`${base}/settings`);
  await page.getByText("Home rows").waitFor();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${outDir}/a-${tag}-settings-${width}.png`, fullPage: true });
  if (width === 1280) {
    const report = JSON.parse(await page.evaluate(inventory));
    const brief = (k) => report[k].map((x) => `${x.value}×${x.uses}`).join("  ");
    for (const k of ["fontSizes", "fontWeights", "textColors", "backgrounds", "radii", "shadows", "spacing"])
      console.log(`${k}:`, brief(k));
    check("1280: Settings doesn't overflow sideways", !report.horizontalOverflow);
    // Keyboard: what the first stops are, and whether focus is visible.
    const stops = [];
    for (let i = 0; i < 14; i++) {
      await page.keyboard.press("Tab");
      stops.push(
        await page.evaluate(() => {
          const el = document.activeElement;
          const label = el?.getAttribute("aria-label") || el?.textContent?.trim().slice(0, 30) || el?.tagName;
          const style = el ? getComputedStyle(el) : null;
          return `${label}${style && style.outlineStyle !== "none" ? "" : " (no outline)"}`;
        }),
      );
    }
    console.log("tab order:", stops.join(" → "));
  } else {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    check("390: Settings doesn't overflow sideways", !overflow);
  }
  await page.goto(`${base}/library`);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${outDir}/a-${tag}-library-${width}.png` });
  await page.context().close();
}
await br.close();
finish();
