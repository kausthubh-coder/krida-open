import { mkdirSync, readFileSync } from "node:fs";
import { launchBrowser } from "./lib/browser.ts";
import { checks, qaSession, signIn } from "./lib/qa.ts";
import { Network } from "./regress/network.ts";

// A phone held sideways, on every main screen: Home, a title, Search, Library and Settings. The player has its own
// script (e2e-player-touch.ts).
// Run against the QA app (`npm run qa -- up`); screenshots go to .artifacts/landscape/. Outside data comes from
// the regress store, so pages show real artwork without the /api keys.
// Usage: node scripts/shots-landscape.ts [width] [height]

const width = Number(process.argv[2]) || 844;
const height = Number(process.argv[3]) || 390;
const out = `.artifacts/landscape/${width}x${height}`;
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
  // Nothing on the page may be wider than the window: sideways scrolling is the first thing that breaks.
  const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check(`${name}: no sideways scroll`, over <= 0, `${over}px too wide`);
};

await signIn(page, s.url, s.profiles[0]!);
await page.getByRole("heading", { level: 2 }).nth(1).waitFor({ timeout: 60_000 });
await shot("home");
await page.mouse.wheel(0, 500);
await shot("home-scrolled");
await page.goto(`${s.url}/title/movie/${movies[16]!.id}`);
await page.getByRole("heading", { name: movies[16]!.name }).first().waitFor({ timeout: 30_000 });
await shot("title-movie");
await page.goto(`${s.url}/title/series/${shows[16]!.id}`);
await page.getByRole("heading", { name: shows[16]!.name }).first().waitFor({ timeout: 30_000 });
await shot("title-show");
await page.mouse.wheel(0, 400);
await shot("title-show-scrolled");
await page.goto(`${s.url}/search?q=${encodeURIComponent(movies[0]!.name)}`);
await page.getByRole("link", { name: new RegExp(movies[0]!.name) }).first().waitFor({ timeout: 30_000 });
await shot("search");
await page.goto(`${s.url}/library`);
await page.getByRole("heading", { name: "Plan to watch" }).first().waitFor({ timeout: 30_000 });
await shot("library");
await page.goto(`${s.url}/settings`);
await shot("settings");

network.save();
await browser.close();
finish();
