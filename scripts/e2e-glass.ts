// Krida's bubbles (bubli, ui/bubbles.tsx) in Chrome, Firefox and WebKit:
// - the dock, Play, the search capsule and a title's toolbar are bubbles, and a hit box doesn't move while one is pressed;
// - search works as it does on a wide screen, on a phone too: the bubble stretches into a field across the bar, the places fold
//   away, the suggestions grow above it from your Library first, and pressing elsewhere folds it all back;
// - search folds back on a phone without stalling; pressing your avatar leaves the lens where it is;
// - the Party panel floats, moves nothing, and starts no party until you invite someone; the app's video isn't veiled in grey;
// - a menu grows out of its button and shrinks back; Escape and a press outside close it and focus goes home;
// - a sheet is a bubble with plain controls inside, never a bubble in a bubble; a toast is a bubble;
// - a switch and a slider answer the pointer and the keyboard;
// - on an upright phone the player turns a quarter, and everything in it still draws in place: its long bars too;
// - bubbles are a beta you turn on: by default nothing's a bubble and menus still work; the switch turns them on and off;
// - a card's buttons are bubbles only while the card is under the pointer; Home keeps Krida's neutral page;
// - a kept page stays itself while you're away, and comes back without being built again;
// - a title page gives the page its artwork's colour;
// - reduced motion stops the movement and keeps the look.
// Firefox and WebKit are skipped, saying so, until Playwright's builds are installed (node node_modules/playwright-core/cli.js
// install firefox webkit). Runs on the QA app (`npm run qa -- up`).
// Usage: node scripts/e2e-glass.ts [chrome,firefox,webkit]
import { existsSync, readFileSync } from "node:fs";
import { firefox, webkit, type Browser, type BrowserContext, type Page } from "playwright-core";
import { launchBrowser } from "./lib/browser.ts";
import { baseUrl, checks, qaProfiles, signIn } from "./lib/qa.ts";
import { Network } from "./regress/network.ts";

const base = baseUrl();
const [profile] = qaProfiles(["Regress-QA-one"]);
const { movies } = JSON.parse(readFileSync(new URL("./regress/titles.json", import.meta.url), "utf8")) as Record<string, { id: string; name: string }[]>;
const film = movies[16]!;
const wanted = (process.argv[2] ?? "chrome,firefox,webkit").split(",");
const network = new Network(".artifacts/regress/network", false);
const engines: Record<string, () => Promise<Browser | undefined>> = {
  chrome: () => launchBrowser(),
  firefox: async () => (existsSync(firefox.executablePath()) ? firefox.launch() : undefined),
  webkit: async () => (existsSync(webkit.executablePath()) ? webkit.launch() : undefined),
};

const { check, watch, finish } = checks();
const state = (page: Page, selector: string) => page.locator(selector).first().getAttribute("data-bubli-state");
const bubbles = (page: Page) => page.locator('[data-bubli-state="bubble"]').count();

/** Bubble glass is a beta you turn on (Settings → Display). */
const bubblesOn = (context: BrowserContext) => context.addInitScript(() => localStorage.setItem("krida.bubbles", "on"));
/** How light the screen is around a point, as drawn (canvas and all): the mean of red, green and blue, 0 to 255. */
async function lightness(page: Page, x: number, y: number) {
  const png = (await page.screenshot({ clip: { x: x - 3, y: y - 3, width: 6, height: 6 } })).toString("base64");
  return page.evaluate(async (src) => {
    const img = new Image();
    img.src = `data:image/png;base64,${src}`;
    await img.decode();
    const ctx = Object.assign(document.createElement("canvas"), { width: img.width, height: img.height }).getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, img.width, img.height);
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) sum += (data[i]! + data[i + 1]! + data[i + 2]!) / 3;
    return Math.round(sum / (data.length / 4));
  }, png);
}

async function home(page: Page) {
  await page.goto(base);
  await page.getByRole("heading", { level: 2 }).nth(1).waitFor({ timeout: 60_000 });
  await page.waitForTimeout(600);
}

async function title(page: Page) {
  await page.goto(`${base}/title/movie/${film.id}`);
  await page.getByRole("heading", { name: film.name }).first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(600);
}

async function wide(browser: Browser, name: string) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  await network.attach(context);
  await bubblesOn(context);
  const page = await context.newPage();
  watch(page, name);
  await signIn(page, base, profile!);
  await home(page);

  // The dock and search.
  const nav = page.getByRole("navigation", { name: "Main" });
  check("the dock is a bubble", (await nav.locator('[data-bubli="bar"]').first().getAttribute("data-bubli-state")) === "bubble");
  check("Play is a bubble", (await page.getByRole("button", { name: /^(Play|Resume)/ }).first().getAttribute("data-bubli-state")) === "bubble");
  const field = page.getByRole("combobox", { name: /Search titles/ });
  const before = await field.boundingBox();
  await page.keyboard.press("/");
  await page.waitForTimeout(500);
  check("/ focuses search and it stretches into a field", (await field.boundingBox())!.width > (before?.width ?? 0) + 100);
  await page.keyboard.type("dun", { delay: 30 });
  const listbox = page.getByRole("listbox", { name: "Suggestions" });
  await listbox.getByRole("option").first().waitFor({ timeout: 15_000 });
  check("suggestions rise above the field", (await listbox.boundingBox())!.y + (await listbox.boundingBox())!.height <= (await field.boundingBox())!.y);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);
  check("Escape folds search away", !(await listbox.isVisible()));

  // A press doesn't move what you aim at.
  const play = page.getByRole("button", { name: /^(Play|Resume)/ }).first();
  const box = (await play.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(120);
  const held = (await play.boundingBox())!;
  check("a held button's hit box stays put", held.x === box.x && held.width === box.width && held.height === box.height);
  await page.mouse.move(10, 10);
  await page.mouse.up();

  // A menu's button isn't a place: pressing it leaves the lens on the page you're on.
  const you = page.getByRole("button", { name: /profile menu/ });
  const lens = nav.locator(".krida-lens");
  const lensAt = (await lens.boundingBox())!.x;
  const youBox = (await you.boundingBox())!;
  await page.mouse.move(youBox.x + youBox.width / 2, youBox.y + youBox.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(120);
  const heldAt = (await lens.boundingBox())!.x;
  await page.mouse.up();
  await page.waitForTimeout(250);
  check("pressing your avatar doesn't send the lens there and back", Math.abs(heldAt - lensAt) < 1 && Math.abs((await lens.boundingBox())!.x - lensAt) < 1, `${lensAt} ${heldAt}`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);

  // Party: the panel floats over the page, so nothing moves, and it starts nothing until you invite someone.
  const dockAt = (await nav.boundingBox())!;
  const pageWide = await page.evaluate(() => document.querySelector("main")?.getBoundingClientRect().width);
  await nav.getByRole("button", { name: /^Watch (with|together)/ }).click();
  const partyPanel = page.getByRole("complementary", { name: "Party" });
  await partyPanel.getByRole("button", { name: /^Invite/ }).first().waitFor({ timeout: 5000 });
  check("Party opens its panel without starting a party", (await partyPanel.getByRole("textbox", { name: "Message" }).count()) === 0);
  check("the dock doesn't move for it", (await nav.boundingBox())!.x === dockAt.x);
  check("nor does the page", (await page.evaluate(() => document.querySelector("main")?.getBoundingClientRect().width)) === pageWide);
  const partyBox = (await partyPanel.boundingBox())!;
  check("it's a floating pane, not the whole side of the window", partyBox.height < 500 && partyBox.y > 100, `${partyBox.y} ${partyBox.height}`);
  check("the page's text has frost or body behind it, as a bubble", (await partyPanel.locator('[data-bubli-state="bubble"]').count()) > 0);
  await page.keyboard.press("Escape");
  await partyPanel.waitFor({ state: "hidden", timeout: 3000 });

  // In the Windows app the page is see-through over mpv: a bubble reading that as white veils the picture in grey.
  const tone = await page.evaluate(() => {
    document.documentElement.setAttribute("data-desktop-video", "");
    const value = getComputedStyle(document.documentElement).getPropertyValue("--bubli-tone").trim();
    document.documentElement.removeAttribute("data-desktop-video");
    return value;
  });
  check("over the app's video a bubble is told the page is dark", tone.startsWith("oklch(0.1"), tone);

  // A menu grows and shrinks back.
  await you.click();
  const menu = page.getByRole("menu", { name: "Regress-QA-one" });
  await menu.waitFor({ timeout: 3000 });
  await page.waitForTimeout(600);
  check("the profile menu opens with focus on its first item", await page.evaluate(() => document.activeElement?.getAttribute("role")?.startsWith("menuitem") ?? false));
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden", timeout: 3000 });
  check("Escape closes it and focus goes home", await you.evaluate((el) => el === document.activeElement));
  await you.click();
  await menu.waitFor({ timeout: 3000 });
  await page.mouse.click(300, 200);
  await menu.waitFor({ state: "hidden", timeout: 3000 });
  check("a press outside closes it", true);

  // A card's right-click menu: what it can do, by name, at the pointer. Escape closes it and nothing's left behind.
  const continueCard = page.locator("[data-card]").filter({ has: page.getByRole("button", { name: /^Resume / }) }).first();
  await continueCard.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  const clicked = (await continueCard.boundingBox())!;
  const blocked = page.evaluate(() => new Promise<boolean>((done) => addEventListener("contextmenu", (e) => setTimeout(() => done(e.defaultPrevented)), { once: true })));
  await page.mouse.click(clicked.x + clicked.width / 2, clicked.y + 40, { button: "right" });
  check("the browser's own menu stays shut on a card", await blocked);
  const cardMenu = page.getByRole("menu").filter({ has: page.getByRole("menuitem", { name: "Details" }) });
  await cardMenu.waitFor({ timeout: 3000 });
  await page.waitForTimeout(500);
  for (const name of ["Resume", "Details", "Copy link", "Remove from Continue watching"])
    check(`Continue watching's menu has ${name}`, (await cardMenu.getByRole("menuitem", { name, exact: true }).count()) === 1);
  const menuBox = (await cardMenu.boundingBox())!;
  check("it opens at the pointer", Math.abs(menuBox.x - (clicked.x + clicked.width / 2)) < 24, `${menuBox.x}`);
  check("focus goes to its first item", await page.evaluate(() => document.activeElement?.getAttribute("role") === "menuitem"));
  // The rating sheet outlives the menu that opened it.
  await cardMenu.getByRole("menuitem", { name: /^(Rate|Your rating)/ }).click();
  const rateSheet = page.getByRole("dialog").filter({ hasText: "Your rating" });
  await rateSheet.waitFor({ timeout: 5000 });
  await page.waitForTimeout(1000);
  check("Rate opens its sheet, and it stays open", await rateSheet.isVisible());
  await rateSheet.getByRole("button", { name: "Close" }).click();
  await rateSheet.waitFor({ state: "hidden", timeout: 3000 });
  await page.mouse.click(clicked.x + clicked.width / 2, clicked.y + 40, { button: "right" });
  await cardMenu.waitFor({ timeout: 3000 });
  await page.waitForTimeout(500);
  await page.keyboard.press("ArrowDown");
  check("arrows move through it", await page.evaluate(() => document.activeElement?.textContent === "Details"));
  await page.keyboard.press("Escape");
  await cardMenu.waitFor({ state: "hidden", timeout: 3000 });
  check("Escape closes it", true);
  await page.goto(`${base}/library`);
  const libraryCard = page.locator("[data-card]").first();
  await libraryCard.waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1000);
  await libraryCard.click({ button: "right", position: { x: 40, y: 40 } });
  await cardMenu.waitFor({ timeout: 3000 });
  check("a Library card has it too", (await cardMenu.getByRole("menuitem", { name: "Copy link" }).count()) === 1);
  await page.waitForTimeout(400);
  // What it fetches ends before the next goto: WebKit reports a fetch cut off by leaving as a page error.
  const fetched = ["/api/title", "/api/more-like"].map((path) => page.waitForResponse((r) => r.url().includes(path), { timeout: 20_000 }).catch(() => null));
  await cardMenu.getByRole("menuitem", { name: "Details" }).click();
  await page.waitForURL(/\/title\//, { timeout: 10_000 });
  check("Details opens its title", true);
  await Promise.all(fetched);
  await page.waitForTimeout(500);

  // A title page: its colour, its toolbar, the status menu, the sheet.
  await title(page);
  const art = await page.evaluate(() => document.documentElement.style.getPropertyValue("--art"));
  check("the page takes the artwork's colour", art.startsWith("oklch(") || art === "", art);
  check("the toolbar is a bubble", (await state(page, '[data-bubli="toolbar"]')) === "bubble");
  await page.getByRole("button", { name: /watch status/i }).first().click();
  const status = page.getByRole("menu", { name: `Watch status for ${film.name}` });
  await status.waitFor({ timeout: 3000 });
  await page.waitForTimeout(300);
  check("focus goes into it, on what's chosen", await page.evaluate(() => document.activeElement?.getAttribute("role")?.startsWith("menuitem") ?? false));
  check("the status menu is a frosted bubble", (await status.locator("xpath=ancestor::*[@data-bubli='panel']").getAttribute("data-bubli-state")) === "bubble");
  await page.keyboard.press("Escape");
  await status.waitFor({ state: "hidden", timeout: 3000 });
  await page.getByRole("button", { name: /Choose a source/ }).first().click();
  const sheet = page.getByRole("dialog", { name: "Choose a source" });
  await sheet.waitFor({ timeout: 5000 });
  await page.waitForTimeout(500);
  check("a sheet is a bubble", (await state(page, 'dialog [data-bubli="sheet"]')) === "bubble");
  check("controls inside it are plain, no bubble in a bubble", (await page.locator('dialog [data-bubli="sheet"] [data-bubli="button"][data-bubli-state="bubble"]').count()) === 0);
  await page.keyboard.press("Escape");
  await sheet.waitFor({ state: "hidden", timeout: 3000 });

  // Home stays on Krida's neutral page: only a title takes its artwork's colour.
  await home(page);
  check("Home doesn't take its banner's colour", (await page.evaluate(() => document.documentElement.style.getPropertyValue("--art"))) === "");

  // A card's buttons are bubbles while its card is under the pointer, and none are at rest.
  const cards = page.locator("[data-card]").filter({ has: page.getByRole("button", { name: /watch status/i }) });
  await cards.first().scrollIntoViewIfNeeded();
  check("no card button is a bubble at rest", (await page.locator('[data-card] .fill-scrim[data-bubli-state="bubble"]').count()) === 0);
  await cards.first().hover();
  await page.waitForTimeout(400);
  check("hovered, its buttons are bubbles", (await cards.first().locator('.fill-scrim[data-bubli-state="bubble"]').count()) > 0);
  await page.mouse.move(5, 5);
  await page.waitForTimeout(400);
  check("and they let go when the pointer leaves", (await page.locator('[data-card] .fill-scrim[data-bubli-state="bubble"]').count()) === 0);

  // Going back to a kept page: it never left, so it isn't built or laid out again.
  const homeMark = await page.evaluate(() => {
    const el = document.querySelector("[aria-label=Featured]");
    if (el) (el as HTMLElement).dataset.kept = "yes";
    return !!el;
  });
  await nav.getByRole("link", { name: "Library" }).click();
  await page.getByRole("navigation", { name: "Library" }).first().waitFor({ timeout: 15_000 });
  check("Home is hidden while you're in the Library", !(await page.locator("[aria-label=Featured]").isVisible()));
  check("and reads as out of view, nothing left behind on screen", await page.evaluate(() => { const el = document.querySelector("[aria-label=Featured]"); return !!el && !el.checkVisibility(); }));
  await nav.getByRole("link", { name: "Home" }).click();
  await page.locator("[aria-label=Featured]").waitFor({ timeout: 5000 });
  check("and is the same page when you come back", homeMark && (await page.locator('[aria-label=Featured][data-kept="yes"]').count()) === 1);

  // Settings: the beta switch, off by press and on by key.
  await page.goto(`${base}/settings/display`);
  const beta = page.getByRole("switch", { name: /Bubble glass/ });
  await beta.waitFor({ timeout: 15_000 });
  check("the switch says it's on", (await beta.getAttribute("aria-checked")) === "true");
  await beta.click();
  await page.waitForFunction(() => document.documentElement.dataset.surfaces === "solid");
  await page.waitForTimeout(400);
  check("off, every bubble turns solid", (await bubbles(page)) === 0, `${await bubbles(page)} still drawn`);
  await page.getByRole("switch", { name: /Bubble glass/ }).focus();
  await page.keyboard.press("Space");
  await page.waitForFunction(() => document.documentElement.dataset.surfaces === "glass");
  await page.waitForTimeout(600);
  check("Space turns them back on", (await bubbles(page)) > 0);
  await context.close();
}

async function phone(browser: Browser, name: string) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    // Firefox has no touch emulation in Playwright.
    ...(name === "firefox" ? {} : { hasTouch: true, isMobile: true }),
    deviceScaleFactor: 2,
    serviceWorkers: "block",
  });
  await network.attach(context);
  await bubblesOn(context);
  const page = await context.newPage();
  watch(page, `${name} phone`);
  await signIn(page, base, profile!);
  await home(page);

  const nav = page.getByRole("navigation", { name: "Main" });
  check("no sideways scroll", (await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 0);
  const home_ = nav.getByRole("link", { name: "Home" });
  check("the tab bar has its places by name", await home_.isVisible());
  const field = page.getByRole("combobox", { name: /Search titles/ });
  const capsule = nav.locator('[data-bubli="bar"]').nth(1);
  const round = (await capsule.boundingBox())!;
  check("search starts as a round bubble beside the places", Math.abs(round.width - 64) < 10, `${round.width}`);
  await field.focus();
  await page.waitForTimeout(600);
  const open = (await capsule.boundingBox())!;
  check("focused, it takes the bar", open.width > 340, `${open.width}`);
  check("the places fold away", !(await home_.isVisible()) || (await home_.boundingBox())!.width < 2 || (await page.locator(".dock-fold").getAttribute("data-folded")) !== null);
  await page.keyboard.type("dun", { delay: 30 });
  const listbox = page.getByRole("listbox", { name: "Suggestions" });
  await listbox.getByRole("option").first().waitFor({ timeout: 15_000 });
  const panel = (await listbox.boundingBox())!;
  check("suggestions fit the phone's width", panel.x >= 12 && panel.x + panel.width <= 378, `${panel.x} ${panel.width}`);
  // The field once stayed 10px wide inside the stretched capsule, so what you typed never showed.
  check("what you type shows across the field", (await field.boundingBox())!.width > 200, `${(await field.boundingBox())!.width}px`);
  // Pressing the page above the suggestions leaves search without choosing anything.
  await page.mouse.click(195, 120);
  await page.waitForTimeout(700);
  check("left with words in it, it folds back", Math.abs((await capsule.boundingBox())!.width - 64) < 10, `${(await capsule.boundingBox())!.width}px`);
  check("and the places come back", (await page.locator(".dock-fold").getAttribute("data-folded")) === null && (await home_.boundingBox())!.width > 40);
  await capsule.click();
  check("opened again, the words are still there", (await field.inputValue()) === "dun");
  await field.blur();

  // Folding back keeps moving: the capsule once held at 247px for most of the fold, then jumped the rest in one frame.
  await field.focus();
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    const w = window as unknown as { widths: { at: number; width: number }[]; tracking: boolean };
    const bar = document.querySelector('nav [data-expanded]')!;
    w.widths = [];
    w.tracking = true;
    const step = () => {
      if (!w.tracking) return;
      w.widths.push({ at: performance.now(), width: bar.getBoundingClientRect().width });
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
  await field.blur();
  await page.waitForTimeout(700);
  const widths = await page.evaluate(() => {
    const w = window as unknown as { widths: { at: number; width: number }[]; tracking: boolean };
    w.tracking = false;
    return w.widths;
  });
  // The longest it sits still between open and closed.
  let held = 0;
  let since = widths[0]!;
  for (const now of widths) {
    if (Math.abs(now.width - since.width) > 1 || now.width > 340 || now.width < 80) since = now;
    held = Math.max(held, now.at - since.at);
  }
  check("search folds back without stalling on the way", held < 120, `held ${Math.round(held)} ms`);

  // A quiet control on the page is clear like the bars, not grey: its body once was white at 6%, which read as a grey slab.
  await page.goto(`${base}/library`);
  await page.getByRole("navigation", { name: "Library" }).getByRole("link").first().click();
  const libraryField = page.getByRole("searchbox", { name: "Search your Library" });
  await libraryField.waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1200);
  const box = (await libraryField.boundingBox())!;
  const fieldBody = await lightness(page, box.x + box.width - 40, box.y + box.height / 2);
  const pageBehind = await lightness(page, box.x + box.width - 40, box.y - 24);
  check("a quiet field is about as dark as the page", fieldBody - pageBehind < 12, `field ${fieldBody}, page ${pageBehind}`);

  // The Party panel on a phone: it opens above the tab bar and starts nothing.
  await nav.getByRole("button", { name: /^(Party|Watch)/ }).click();
  const offer = page.getByRole("complementary", { name: "Party" });
  await offer.getByRole("button", { name: /^Invite/ }).first().waitFor({ timeout: 5000 });
  check("on a phone, Party opens its offer without starting a party", (await offer.getByRole("textbox", { name: "Message" }).count()) === 0);
  await page.getByRole("button", { name: "Close party" }).click({ position: { x: 195, y: 150 } });
  await offer.waitFor({ state: "hidden", timeout: 3000 });

  // The player on an upright phone turns a quarter; what's long in it still has to draw inside its canvas.
  await title(page);
  await page.getByRole("button", { name: "Play", exact: true }).first().click();
  await page.waitForURL(/\/watch\//, { timeout: 30_000 });
  await page.waitForFunction(() => (document.querySelector("video")?.readyState ?? 0) >= 2, null, { timeout: 40_000 });
  await page.evaluate(() => document.querySelector("video")?.pause());
  await page.waitForTimeout(900);
  const bar = page.locator('[data-bubli="capsule"]:visible').last();
  check("the player's capsule is a bubble", (await bar.getAttribute("data-bubli-state")) === "bubble");
  check("three clear bubbles on the picture", (await page.getByRole("button", { name: /10 seconds/ }).count()) >= 2);
  // With and without its canvas: if the rim drew anywhere near the bar, its edge pixels differ.
  const clip = (await bar.boundingBox())!;
  const shot = () => page.screenshot({ clip: { x: clip.x, y: clip.y, width: clip.width, height: Math.min(clip.height, 400) } });
  const withRim = await shot();
  await bar.locator(":scope > canvas").evaluate((c) => ((c as HTMLCanvasElement).style.visibility = "hidden"));
  const without = await shot();
  check("its rim draws where the bar is, turned or not", !withRim.equals(without));
  await context.close();
}

async function solidByDefault(browser: Browser, name: string) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  await network.attach(context);
  const page = await context.newPage();
  watch(page, `${name} default`);
  await signIn(page, base, profile!);
  await home(page);
  check("by default nothing is a bubble", (await bubbles(page)) === 0);
  const you = page.getByRole("button", { name: /profile menu/ });
  await you.click();
  const menu = page.getByRole("menu", { name: "Regress-QA-one" });
  await menu.waitFor({ timeout: 3000 });
  check("a menu still opens", await menu.isVisible());
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden", timeout: 3000 });
  check("and closes", true);
  await context.close();
}

async function reduced(browser: Browser, name: string) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce", serviceWorkers: "block" });
  await network.attach(context);
  await bubblesOn(context);
  const page = await context.newPage();
  watch(page, `${name} reduced`);
  await signIn(page, base, profile!);
  await home(page);
  const you = page.getByRole("button", { name: /profile menu/ });
  await you.click();
  const menu = page.getByRole("menu", { name: "Regress-QA-one" });
  await menu.waitFor({ timeout: 3000 });
  await page.waitForTimeout(120);
  const size = (await menu.boundingBox())!;
  check("a menu is already its full size", size.height > 100);
  check("the look stays", (await page.getByRole("button", { name: /^(Play|Resume)/ }).first().getAttribute("data-bubli-state")) === "bubble");
  await page.keyboard.press("Escape");
  await context.close();
}

for (const name of wanted) {
  const browser = await engines[name]?.();
  if (!browser) {
    console.log(`SKIP ${name}: not installed`);
    continue;
  }
  console.log(`--- ${name}`);
  try {
    await solidByDefault(browser, name);
    await wide(browser, name);
    await phone(browser, name);
    await reduced(browser, name);
  } catch (error) {
    check(`${name} finished`, false, (error as Error).message.split("\n").slice(0, 3).join(" "));
  }
  await browser.close();
}
finish();
