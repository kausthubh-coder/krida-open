import { mkdirSync, readFileSync } from "node:fs";
import { launchBrowser } from "./lib/browser.ts";
import { checks, qaSession, signIn } from "./lib/qa.ts";
import { Network } from "./regress/network.ts";

// A phone held upright, on every main screen: Home, a title, Search, Library, Settings and the player, plus the peek a
// long press on a poster opens, and Settings' Install row as an iPhone shows it. Pressing the tab you're on takes the
// page back to the top. Installed on an iPhone, a swipe in from the left edge goes back (only there: Safari and
// Android have their own). The sideways phone has its own script (shots-landscape.ts).
// Run against the QA app (`npm run qa -- up`); screenshots go to .artifacts/phone/. Outside data comes from the
// regress store, so pages show real artwork without the /api keys.
// Usage: node scripts/shots-phone.ts [width] [height]

const width = Number(process.argv[2]) || 390;
const height = Number(process.argv[3]) || 844;
const out = `.artifacts/phone/${width}x${height}`;
mkdirSync(out, { recursive: true });

const { movies, shows } = JSON.parse(readFileSync(new URL("./regress/titles.json", import.meta.url), "utf8")) as Record<string, { id: string; name: string }[]>;
const s = qaSession();
const network = new Network(".artifacts/regress/network", false);
const browser = await launchBrowser();
const context = await browser.newContext({
  viewport: { width, height },
  screen: { width, height },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
  serviceWorkers: "block",
});
await network.attach(context);
const page = await context.newPage();
const { check, finish } = checks(page);

const shot = async (name: string) => {
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${out}/${name}.png` });
  const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check(`${name}: no sideways scroll`, over <= 0, `${over}px too wide`);
};
const scroll = async (y: number) => {
  await page.evaluate((y) => scrollBy(0, y), y);
};

await signIn(page, s.url, s.profiles[0]!);
await page.getByRole("heading", { level: 2 }).nth(1).waitFor({ timeout: 60_000 });
await shot("home");
// The banner clips what overflows it, so a button pushed off the edge never shows up as sideways scroll.
const clipped = await page.evaluate(() =>
  [...document.querySelectorAll("[aria-label=Featured] button")].filter((b) => b.getBoundingClientRect().right > innerWidth).map((b) => b.textContent),
);
check("the banner's buttons fit on the screen", clipped.length === 0, clipped.join(", "));
await scroll(700);
await shot("home-rows");

// A long press on a poster: the peek rises, and the poster's link doesn't open.
const poster = page.locator("[data-card] a[href^='/title/']").nth(3);
const cdp = await context.newCDPSession(page);
async function longPress(target: typeof poster) {
  await target.scrollIntoViewIfNeeded();
  const box = (await target.boundingBox())!;
  const at = { x: box.x + box.width / 2, y: box.y + box.width * 0.6 };
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [at] });
  await page.waitForTimeout(700);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}
await longPress(poster);
const peek = page.getByRole("dialog");
await peek.waitFor({ timeout: 5_000 });
check("a long press opens the peek", await peek.isVisible());
check("and stays on Home", new URL(page.url()).pathname === "/");
check("the peek has Details", await peek.getByRole("link", { name: "Details" }).isVisible());
await shot("home-peek");
// Its top dragged down a little springs back; dragged further, it closes.
async function dragDown(from: { x: number; y: number }, by: number) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [from] });
  for (let i = 1; i <= 6; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: from.x, y: from.y + (by * i) / 6 }] });
    await page.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(400);
}
const sheetTop = (await peek.boundingBox())!;
await dragDown({ x: width / 2, y: sheetTop.y + 30 }, 30);
const settled = (await peek.boundingBox())!;
check("a short drag on the peek springs back", (await peek.isVisible()) && Math.abs(settled.y - sheetTop.y) < 2, `${sheetTop.y} → ${settled.y}`);
await dragDown({ x: width / 2, y: sheetTop.y + 30 }, 260);
await peek.waitFor({ state: "hidden", timeout: 2_000 });
check("dragging it down closes it", true);

// Play in the peek starts the title, and the peek doesn't stay open over the player.
await longPress(poster);
await peek.getByRole("button", { name: "Play", exact: true }).click();
await page.waitForURL(/\/watch\//, { timeout: 30_000 });
check("Play in the peek opens the player", true);
await page.waitForTimeout(500);
check("and the peek is gone", !(await page.getByRole("dialog").isVisible()));
await page.getByRole("button", { name: "Back", exact: true }).click({ force: true }).catch(() => page.goBack());
await page.waitForURL((url) => url.pathname === "/", { timeout: 30_000 });

// A plain tap still opens the title page.
await poster.scrollIntoViewIfNeeded();
const href = await poster.getAttribute("href");
await poster.tap();
await page.waitForURL((url) => url.pathname === href, { timeout: 30_000 });
check("a tap opens the title page", true);
await page.goBack();
await page.waitForURL((url) => url.pathname === "/");
await scroll(900);
await shot("home-rows-more");
await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Home" }).tap();
await page.waitForTimeout(900);
check("pressing Home on Home goes back to the top", (await page.evaluate(() => scrollY)) === 0 && new URL(page.url()).pathname === "/");
await scroll(900);
await page.goto(`${s.url}/title/movie/${movies[16]!.id}`);
await page.getByRole("heading", { name: movies[16]!.name }).first().waitFor({ timeout: 30_000 });
await shot("title-movie");
/** A finger from the left edge across by `dx`; `during` runs before it lifts. */
async function edgeSwipe(on: typeof page, dx: number, during?: () => Promise<void>) {
  const touch = await on.context().newCDPSession(on);
  const y = height / 2;
  await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 4, y }] });
  for (let i = 1; i <= 8; i++) {
    await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 4 + (dx * i) / 8, y }] });
    await on.waitForTimeout(16);
  }
  await during?.();
  await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await on.waitForTimeout(600);
}
await edgeSwipe(page, 160);
check("in the browser, a swipe from the edge is the browser's own", new URL(page.url()).pathname.startsWith("/title/"));
await scroll(800);
await shot("title-movie-more");
await page.goto(`${s.url}/title/series/${shows[16]!.id}`);
await page.getByRole("heading", { name: shows[16]!.name }).first().waitFor({ timeout: 30_000 });
await shot("title-show");
await scroll(700);
await shot("title-show-episodes");
await page.goto(`${s.url}/search`);
await shot("search-empty");
await page.goto(`${s.url}/search?q=${encodeURIComponent(movies[0]!.name)}`);
await page.getByRole("link", { name: new RegExp(movies[0]!.name) }).first().waitFor({ timeout: 30_000 });
await shot("search");
await page.goto(`${s.url}/library`);
await page.getByRole("navigation", { name: "Library" }).first().waitFor({ timeout: 30_000 });
await shot("library");
await scroll(700);
await shot("library-more");
await page.goto(`${s.url}/settings`);
await shot("settings");
await scroll(900);
await shot("settings-more");

// Settings on an iPhone: Install explains Share, then Add to Home Screen.
const iphone = await browser.newContext({
  viewport: { width, height },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
  serviceWorkers: "block",
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
});
await network.attach(iphone);
// Opened from the home screen: Safari says so with navigator.standalone.
const installed = await iphone.newPage();
await installed.addInitScript(() => Object.defineProperty(Navigator.prototype, "standalone", { get: () => true }));
await signIn(installed, s.url, s.profiles[0]!);
await installed.getByRole("heading", { level: 2 }).nth(1).waitFor({ timeout: 60_000 });
const card = installed.locator("[data-card] a[href^='/title/']").nth(1);
const cardHref = await card.getAttribute("href");
await card.tap();
await installed.waitForURL((url) => url.pathname === cardHref, { timeout: 30_000 });
await installed.waitForTimeout(1000);
await edgeSwipe(installed, 40);
check("installed on an iPhone, a short swipe from the edge stays", new URL(installed.url()).pathname === cardHref);
await edgeSwipe(installed, 160, async () => {
  await installed.screenshot({ path: `${out}/edge-back.png` });
});
check("and a longer one goes back", new URL(installed.url()).pathname === "/", installed.url());
await installed.close();
// Signed in already, by the installed page above.
const ios = await iphone.newPage();
await ios.goto(`${s.url}/settings/display`);
const install = ios.getByText("Install Krida");
await install.waitFor({ timeout: 30_000 });
await install.scrollIntoViewIfNeeded();
await ios.evaluate(() => scrollBy(0, 200));
await ios.waitForTimeout(800);
await ios.screenshot({ path: `${out}/settings-install-iphone.png` });
check("an iPhone is told how to install", await ios.getByText("Add to Home Screen", { exact: false }).isVisible());
await iphone.close();

// The player, upright, with its controls showing.
await page.goto(`${s.url}/title/movie/${movies[16]!.id}`);
await page.getByRole("button", { name: "Play", exact: true }).first().click();
await page.waitForURL(/\/watch\//);
await page.waitForFunction(() => (document.querySelector("video")?.readyState ?? 0) >= 3, null, { timeout: 60_000 }).catch(() => {});
// Clear of play and the skips in the middle, which a tap there would press.
if (!(await page.getByRole("button", { name: "Back", exact: true }).isVisible())) await page.touchscreen.tap(width / 2, height * 0.25);
await shot("player");

network.save();
await browser.close();
finish();
