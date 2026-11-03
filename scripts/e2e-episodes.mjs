// Episodes in the player: the capsule's Episodes button and its panel (current episode in view, seasons, focus in and
// back, Escape, E), picking an episode, Shift+N, and the controls fitting from 360px to wide screens: one capsule under
// 832px, two above, Episodes always in them, and nothing moving when the panel opens. Needs a *-QA-* profile on the
// dev backend (real TorBox streams).
// Usage: KRIDA_QA_PASSWORD=… node scripts/e2e-episodes.mjs [base] [profile] [outDir]
import { mkdir } from "node:fs/promises";
import { launchBrowser } from "./lib/browser.ts";
import { baseUrl, checks, qaProfiles, signIn } from "./lib/qa.ts";

const [baseArg, name, outDir = ".artifacts/episodes"] = process.argv.slice(2);
const base = baseUrl(baseArg);
const [profile] = qaProfiles([name]);
await mkdir(outDir, { recursive: true });
const SHOW = "/title/series/tt0903747"; // Breaking Bad: five seasons
const br = await launchBrowser();
const page = await (await br.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
const { check, finish } = checks(page);
await signIn(page, base, profile);
await page.goto(base + SHOW);
await page.getByRole("button", { name: /^Play S1 E2,/ }).click();

const episodesButton = page.getByRole("button", { name: "Episodes (E)" });
const panel = page.getByRole("complementary", { name: "Episodes" });
/** Wakes the controls, which hide after a few seconds without the pointer moving. */
const wake = async () => {
  await page.mouse.move(400, 300);
  await page.mouse.move(420, 320);
};
const playing = async (label) => {
  await page.waitForFunction((l) => document.title.includes(l), label, { timeout: 120_000 });
  await episodesButton.waitFor({ state: "attached", timeout: 120_000 });
  await wake();
};

await playing("S1 E2");
check("1280: Episodes sits in the capsule", await episodesButton.isVisible());

// Opening: the episode on now is in view, marked, and can't be picked again.
await episodesButton.click();
await panel.waitFor();
const now = panel.getByRole("listitem").filter({ hasText: "Watching now" });
await now.waitFor();
check("the current episode is in view", await now.isVisible());
check("the current episode can't be picked again", await now.getByRole("button").isDisabled());
check("seasons are tabs", (await panel.getByRole("tab").count()) >= 5);
check("the season on now is selected", (await panel.getByRole("tab", { selected: true }).textContent()) === "Season 1");
// The season strip hides its scrollbar, so a mouse wheel over it brings the seasons past the edge into view.
const seasonTabs = panel.getByRole("tablist", { name: "Seasons" });
const tabsBox = await seasonTabs.boundingBox();
await page.mouse.move(tabsBox.x + tabsBox.width / 2, tabsBox.y + tabsBox.height / 2);
for (let i = 0; i < 10; i++) await page.mouse.wheel(0, 100);
await page.waitForTimeout(300);
check("the wheel scrolls to the last season", await seasonTabs.evaluate((el) => el.scrollLeft > 0 && el.scrollLeft >= el.scrollWidth - el.clientWidth - 1));
for (let i = 0; i < 10; i++) await page.mouse.wheel(0, -100);
check("the button shows the panel is open", (await episodesButton.getAttribute("aria-pressed")) === "true");
await page.screenshot({ path: `${outDir}/episodes-open.png` });

// Closing gives focus back.
await page.keyboard.press("Escape");
await panel.waitFor({ state: "detached" });
check("Escape closes and focus returns to Episodes", await episodesButton.evaluate((el) => el === document.activeElement));

// From the keyboard, focus goes in, to the next episode.
await wake();
await episodesButton.focus();
await page.keyboard.press("Enter");
await panel.waitFor();
await page.waitForTimeout(300);
const focused = await page.evaluate(() => document.activeElement?.textContent ?? "");
check("keyboard focus lands on the next episode", /^\s*3\./.test(focused), focused.slice(0, 40));
await panel.getByRole("button", { name: "Close" }).click();
await panel.waitFor({ state: "detached" });

// E toggles it.
await page.locator("video").focus();
await page.keyboard.press("e");
await panel.waitFor();
await page.keyboard.press("e");
await panel.waitFor({ state: "detached" });
check("E opens and closes Episodes", true);

// Picking another episode: it opens to Play now, starts, and the panel gets out of the way.
await wake();
await episodesButton.click();
const first = panel.getByRole("listitem").filter({ hasText: "Pilot" });
await first.getByRole("button").first().click();
check("an episode opens to Play now", await first.getByRole("button", { name: /Play now/ }).isVisible());
check("and Play after this", await first.getByRole("button", { name: "Play after this" }).isVisible());
await page.screenshot({ path: `${outDir}/episodes-picked.png` });
await first.getByRole("button", { name: /Play now/ }).click();
await panel.waitFor({ state: "detached" });
check("Play now closes the panel", true);
await playing("S1 E1");
check("S1 E1 plays", true);

// Shift+N moves on to the next one.
await page.locator("video").focus();
await page.keyboard.press("Shift+N");
await playing("S1 E2");
check("Shift+N plays S1 E2", true);

// The controls fit at every width: one capsule in the middle under 832px (as on a phone), two above, and Episodes in
// them at every width. The panel opens over the picture, so opening it moves no capsule.
const capsules = () =>
  page.evaluate(() =>
    [...document.querySelectorAll(".refract.rounded-full")]
      .filter((el) => el.querySelector("button") && el.checkVisibility())
      .map((el) => {
        const r = el.getBoundingClientRect();
        return [Math.round(r.left), Math.round(r.right)];
      }),
  );
for (const [width, height] of [
  [360, 740],
  [390, 844],
  [600, 800],
  [700, 800],
  [800, 800],
  [1024, 768],
  [1280, 800],
]) {
  await page.setViewportSize({ width, height });
  await wake();
  await page.waitForTimeout(250);
  const shut = await capsules();
  const fits =
    shut.length === (width < 832 ? 1 : 2) && shut.every(([l, r]) => l >= 0 && r <= width) && (shut.length < 2 || shut[1][0] - shut[0][1] >= 8);
  check(`${width}px: ${width < 832 ? "one capsule" : "two capsules"}, on screen`, fits, JSON.stringify(shut));
  check(`${width}px: Episodes in the capsule`, await episodesButton.isVisible());
  await episodesButton.click();
  await panel.waitFor();
  await wake();
  await page.waitForTimeout(250);
  check(`${width}px: opening Episodes moves no capsule`, JSON.stringify(await capsules()) === JSON.stringify(shut));
  if (width === 390) {
    check("phone: the list opens", await panel.getByRole("listitem").filter({ hasText: "Watching now" }).isVisible());
    await page.screenshot({ path: `${outDir}/episodes-phone.png` });
  }
  await page.keyboard.press("Escape");
  await panel.waitFor({ state: "detached" });
}

await br.close();
finish();
