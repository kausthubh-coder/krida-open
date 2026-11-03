// Screenshots of a party at desktop and phone widths: the player with the Party panel and its Episodes view, then the
// lobby after Back to picking. Needs a *-QA-* profile on the dev backend (real TorBox streams).
// Usage: KRIDA_QA_PASSWORD=… node scripts/shots-party.mjs [base] [profile] [outDir]
import { mkdir } from "node:fs/promises";
import { launchBrowser } from "./lib/browser.ts";
import { baseUrl, checks, qaProfiles, signIn } from "./lib/qa.ts";

const [baseArg, name, outDir = ".artifacts/shots-party"] = process.argv.slice(2);
const base = baseUrl(baseArg);
const [profile] = qaProfiles([name]);
await mkdir(outDir, { recursive: true });
const br = await launchBrowser();
const { finish, watch } = checks();
for (const [width, height] of [
  [1280, 800],
  [390, 844],
]) {
  const page = await (await br.newContext({ viewport: { width, height } })).newPage();
  watch(page, String(width));
  const shot = async (name) => {
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${outDir}/party-${name}-${width}.png` });
    console.log("shot", name, width);
  };
  await signIn(page, base, profile);

  // An empty party from the title page's Watch together icon lands in the lobby once we go back to picking.
  await page.goto(base + "/title/series/tt0903747");
  await page.getByRole("button", { name: "Watch together" }).first().click();
  await page.getByRole("button", { name: /Start (and invite|the party)/ }).click();
  await page.waitForFunction(() => {
    const v = document.querySelector("video");
    return v && v.readyState >= 3 && !v.paused;
  }, null, { timeout: 120000 });
  await page.mouse.move(200, 300);
  await page.mouse.move(220, 320);

  // Player with the Party panel, then its Episodes view.
  await page.getByRole("button", { name: /^Party/ }).click();
  await shot("panel");
  const episodes = page.getByRole("button", { name: "Episodes" });
  if (await episodes.isVisible()) {
    await episodes.click();
    await shot("episodes");
    await page.getByRole("button", { name: "Back to chat" }).click();
  }

  // Back to picking shows the lobby.
  await page.getByRole("button", { name: "More party options" }).click();
  await page.getByRole("menuitem", { name: "Back to picking" }).click();
  await page.getByRole("heading", { name: "What are we watching?" }).waitFor();
  await shot("lobby");
  await page.context().close();
}
await br.close();
finish();
