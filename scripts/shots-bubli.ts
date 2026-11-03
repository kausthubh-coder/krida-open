import { mkdirSync, readFileSync } from "node:fs";
import type { Page } from "playwright-core";
import { launchBrowser } from "./lib/browser.ts";
import { qaSession, signIn } from "./lib/qa.ts";
import { Network } from "./regress/network.ts";

// Every main screen at a phone's and a desktop's size, with menus, sheets and the player's panels open, for looking at
// a visual change side by side. Run against the QA app (`npm run qa -- up`). Outside data comes from the regress store,
// so pages show real artwork without the /api keys. A step that fails is reported and the walk carries on.
// Usage: node scripts/shots-bubli.ts <name> [phone|desktop|only-step-substring]

const name = process.argv[2] || "now";
const filter = process.argv[3] ?? "";
const { movies, shows } = JSON.parse(readFileSync(new URL("./regress/titles.json", import.meta.url), "utf8")) as Record<string, { id: string; name: string }[]>;
const s = qaSession();
const network = new Network(".artifacts/regress/network", false);
const browser = await launchBrowser();
const failed: string[] = [];

async function walk(device: "phone" | "desktop") {
  const out = `.artifacts/bubli/${name}/${device}`;
  mkdirSync(out, { recursive: true });
  const phone = device === "phone";
  const context = await browser.newContext({
    viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    isMobile: phone,
    hasTouch: phone,
    deviceScaleFactor: phone ? 2 : 1,
    serviceWorkers: "block",
  });
  await network.attach(context);
  // Bubble glass is off by default: BUBBLES=off walks the solid look.
  if (process.env.BUBBLES !== "off") await context.addInitScript(() => localStorage.setItem("krida.bubbles", "on"));
  const page = await context.newPage();
  page.on("pageerror", (e) => failed.push(`${device}: page error: ${e.message.slice(0, 200)}`));
  const step = async (label: string, run: (page: Page) => Promise<void>, settle = 1000) => {
    if (filter && filter !== device && !label.includes(filter) && filter !== "phone" && filter !== "desktop") return;
    try {
      await run(page);
      await page.waitForTimeout(settle);
      await page.screenshot({ path: `${out}/${label}.png` });
      const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      if (over > 0) failed.push(`${device}/${label}: ${over}px sideways scroll`);
    } catch (e) {
      failed.push(`${device}/${label}: ${(e as Error).message.split("\n")[0]}`);
    }
  };
  const press = phone ? "tap" : "click";
  const close = async () => {
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(350);
  };

  await signIn(page, s.url, s.profiles[0]!);
  await page.getByRole("heading", { level: 2 }).nth(1).waitFor({ timeout: 60_000 });
  await step("home", async () => {});
  await step("home-rows", async () => void (await page.evaluate(() => scrollBy(0, 760))));
  await step("home-more", async () => void (await page.evaluate(() => scrollBy(0, 900))));
  await page.evaluate(() => scrollTo(0, 0));

  const movie = movies[16]!;
  const show = shows[16]!;
  const openMovie = async () => {
    await page.goto(`${s.url}/title/movie/${movie.id}`);
    await page.getByRole("heading", { name: movie.name }).first().waitFor({ timeout: 30_000 });
  };
  await step("title-movie", openMovie);
  await step("title-movie-more", async () => void (await page.evaluate(() => scrollBy(0, 760))));
  await step("title-status-menu", async () => {
    await page.evaluate(() => scrollTo(0, 0));
    await page.getByRole("button", { name: /Plan to watch|watch status/i }).first()[press]();
  }, 700);
  await close();
  await step("title-sources", async () => {
    await openMovie();
    const more = page.getByRole("button", { name: /sources|Choose a source|All sources/i }).first();
    await more[press]({ timeout: 4000 });
  }, 1400);
  await close();
  await step("title-show", async () => {
    await page.goto(`${s.url}/title/series/${show.id}`);
    await page.getByRole("heading", { name: show.name }).first().waitFor({ timeout: 30_000 });
  });
  await step("title-show-episodes", async () => void (await page.evaluate(() => scrollBy(0, 760))));

  await step("search-empty", async () => void (await page.goto(`${s.url}/search`)));
  await step("search-results", async () => {
    await page.goto(`${s.url}/search?q=${encodeURIComponent(movies[0]!.name)}`);
    await page.getByRole("link", { name: new RegExp(movies[0]!.name) }).first().waitFor({ timeout: 30_000 });
  });
  if (phone) {
    await step("search-bubble", async () => {
      await page.goto(s.url);
      await page.getByRole("heading", { level: 2 }).nth(1).waitFor({ timeout: 30_000 });
      await page.getByRole("combobox", { name: /Search titles/ }).focus();
    }, 900);
    await step("search-bubble-typed", async () => {
      await page.keyboard.type("dun", { delay: 40 });
    }, 1500);
    await close();
    await page.locator("body").tap({ position: { x: 195, y: 100 } }).catch(() => {});
  }
  if (!phone) {
    await step("search-dock-open", async () => {
      await page.goto(s.url);
      await page.getByRole("heading", { level: 2 }).nth(1).waitFor({ timeout: 30_000 });
      await page.keyboard.press("/");
      await page.waitForTimeout(400);
      await page.keyboard.type("dun", { delay: 40 });
    }, 1500);
    await close();
  }
  await step("library", async () => {
    await page.goto(`${s.url}/library`);
    await page.getByRole("navigation", { name: "Library" }).first().waitFor({ timeout: 30_000 });
  });
  await step("library-plan", async () => {
    await page.goto(`${s.url}/library?tab=plan`);
    await page.getByRole("button", { name: "Filters" }).waitFor({ timeout: 30_000 });
  });
  await step("library-filter", async () => {
    await page.getByRole("button", { name: "Filters" })[press]({ timeout: 4000 });
  }, 800);
  await close();
  await step("settings", async () => void (await page.goto(`${s.url}/settings`)));
  await step("settings-more", async () => void (await page.evaluate(() => scrollBy(0, 800))));

  let inPlayer = false;
  await step("player", async () => {
    await openMovie();
    await page.getByRole("button", { name: "Play", exact: true }).first().click({ timeout: 8000 });
    await page.waitForURL(/\/watch\//, { timeout: 30_000 });
    await page.waitForFunction(() => (document.querySelector("video")?.readyState ?? 0) >= 2, null, { timeout: 40_000 });
    await page.evaluate(() => {
      const v = document.querySelector("video");
      if (v) v.currentTime = 30;
    });
    inPlayer = true;
    await page.waitForTimeout(1000);
    await page.mouse.move(700, 450);
    if (phone) await page.touchscreen.tap(195, 120);
  }, 700);
  if (inPlayer) {
    for (const [label, button] of [
      ["player-picture", /Picture|Automatic/],
      ["player-subtitles", /Subtitles|Captions/],
      ["player-sources", /Change source/],
    ] as const) {
      await step(label, async () => {
        await page.mouse.move(700, 460);
        const target = page.getByRole("button", { name: button }).first();
        if (!(await target.isVisible()) && phone) await page.touchscreen.tap(195, 120);
        await target.click({ timeout: 4000 });
      }, 900);
      await close();
    }
  }
  await context.close();
}

await walk("phone");
await walk("desktop");
await browser.close();
console.log(failed.length ? `Problems:\n${failed.join("\n")}` : "Walked every step");
