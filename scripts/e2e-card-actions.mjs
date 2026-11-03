// Save and rate from a poster: hover shows the buttons, saving updates the badge, removing from Plan to watch offers
// Undo and Undo puts it back, keyboard focus shows them too, and touch screens never see them. Removes its test save
// and rating on success. Needs the QA app (npm run qa -- up) or a *-QA-* profile on dev.
// Usage: node scripts/e2e-card-actions.mjs [base] [profile] [outDir]
import { mkdir } from "node:fs/promises";
import { launchBrowser } from "./lib/browser.ts";
import { baseUrl, checks, qaProfiles, signIn } from "./lib/qa.ts";

const [baseArg, name, outDir = ".artifacts/card-actions"] = process.argv.slice(2);
const base = baseUrl(baseArg);
const [profile] = qaProfiles([name]);
await mkdir(outDir, { recursive: true });
const QUERY = "dune part two";
const TITLE = "Dune: Part Two";
const br = await launchBrowser();
const { check, finish, watch } = checks();
try {
async function open(options) {
  const ctx = await br.newContext(options);
  const page = await ctx.newPage();
  watch(page);
  page.on("console", (m) => { if (m.type() === "error") console.error(m.text().slice(0, 500)); });
  await signIn(page, base, profile);
  return page;
}
const card = (page) => page.locator("main li").filter({ hasText: TITLE }).first();
const opacity = (loc) => loc.evaluate((el) => getComputedStyle(el.closest("[class*='aspect-2/3']")).opacity);

const page = await open({ viewport: { width: 1280, height: 800 } });
await page.goto(`${base}/search?q=${encodeURIComponent(QUERY)}`);
await card(page).waitFor({ timeout: 30000 });
const save = card(page).getByRole("button", { name: /Plan to watch$/ });
const rate = card(page).getByRole("button", { name: /^(Rate this|Your rating)/ });
await page.waitForFunction(() => [...document.querySelectorAll('main button[aria-busy]')].every(b => b.getAttribute('aria-busy') === 'false'));

// Start clean: not saved, not rated.
await card(page).hover();
if ((await save.getAttribute("aria-label")) === "Remove from Plan to watch") await save.click();
if ((await rate.getAttribute("aria-label")).startsWith("Your rating")) {
  await rate.click();
  await card(page).locator("[role=group] [aria-pressed=true]").click();
  await card(page).getByRole("button", { name: "Rate this" }).waitFor();
}
check("hover shows the buttons", (await opacity(save)) === "1");
await page.mouse.move(5, 5);
check("moving away hides them", (await opacity(save)) === "0");

await card(page).hover();
await save.click();
await card(page).getByRole("button", { name: "Remove from Plan to watch" }).waitFor();
check("saving shows the In Plan to watch badge", await card(page).getByText("In Plan to watch").isVisible());

await rate.click();
await card(page).getByRole("button", { name: "I like this", exact: true }).click();
await card(page).getByRole("button", { name: "Your rating: I like this. Change it" }).waitFor();
check("rating from the card", true);
check("choosing a rating returns focus to its button", await rate.evaluate(el => el === document.activeElement));
await page.screenshot({ path: `${outDir}/card-saved-rated.png` });

// Keyboard: Tab from the poster's link lands on the buttons and shows them.
await page.mouse.move(5, 5);
await card(page).getByRole("link").focus();
await page.keyboard.press("Tab");
check("keyboard focus shows the buttons", (await opacity(save)) === "1");
check("Tab reaches Save with visible focus", await save.evaluate(el => el === document.activeElement && el.matches(':focus-visible')));
await page.keyboard.press("Tab");
await page.keyboard.press("Enter");
await card(page).getByRole("group", { name: "Rate", exact: true }).waitFor();
await page.keyboard.press("Escape");
check("Escape closes ratings and restores focus", await rate.evaluate(el => el === document.activeElement && el.getAttribute('aria-expanded') === 'false'));

// Plan to watch: removing makes the card leave, Undo brings it back.
await page.goto(`${base}/library`);
await card(page).waitFor({ timeout: 20000 });
await card(page).hover();
await card(page).getByRole("button", { name: "Remove from Plan to watch" }).click();
await page.getByText(`Removed ${TITLE} from Plan to watch`).waitFor();
check("removed card leaves Plan to watch", (await card(page).count()) === 0);
await page.getByRole("button", { name: "Undo" }).click();
await card(page).waitFor({ timeout: 10000 });
check("Undo puts it back", true);
await page.reload();
await card(page).waitFor({ timeout: 10000 });
check("Undo persists after reload", true);
await page.screenshot({ path: `${outDir}/card-undo.png` });

// Clean up.
await card(page).hover();
await card(page).getByRole("button", { name: /^Your rating/ }).click();
await card(page).getByRole("button", { name: "I like this", exact: true }).click();
await card(page).getByRole("button", { name: "Rate this" }).waitFor();
await card(page).getByRole("button", { name: "Remove from Plan to watch" }).click();
await page.waitForTimeout(1500);

// Touch: no hover, so the buttons stay hidden and can't be tapped by accident; a tap opens the title.
const phone = await open({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
await phone.goto(`${base}/search?q=${encodeURIComponent(QUERY)}`);
await card(phone).waitFor({ timeout: 30000 });
const phoneSave = card(phone).getByRole("button", { name: /Plan to watch$/ });
check("touch: buttons hidden", (await opacity(phoneSave)) === "0");
const box = await phoneSave.boundingBox();
await phone.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
await phone.waitForURL(/\/title\//, { timeout: 10000 });
check("touch: tapping where the button sits opens the title", true);
await phone.getByRole("heading", { name: TITLE, exact: true }).waitFor({ timeout: 30000 });
check("touch: title page retains Save", await phone.getByRole("button", { name: "Add to Plan to watch", exact: true }).first().isVisible());

await page.goto(base);
const homeCard = page.locator('main [class~="group/card"]').first();
await homeCard.waitFor({ timeout: 30000 });
await homeCard.hover();
check("Home rails show shared hover actions", (await opacity(homeCard.getByRole("button", { name: /Plan to watch$/ }))) === "1");
await page.goto(`${base}/title/movie/tt15239678`);
const related = page.locator('main [class~="group/card"]').first();
await related.waitFor({ timeout: 30000 });
await related.hover();
check("More like this shows shared hover actions", (await opacity(related.getByRole("button", { name: /Plan to watch$/ }))) === "1");
} finally {
  await br.close();
}
finish();
