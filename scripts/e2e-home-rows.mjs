// Home's rows fill in as they come within reach: nothing moves while they do, every card can still be reached (arrows,
// scrolling, Tab), Back returns to the same spot, Play is prepared only when the pointer rests on it, and a title page
// asks for its sources once. Needs the QA app (npm run qa -- up; Regress-QA-one has 31 titles in Plan to watch) or a
// *-QA-* profile on dev with at least 14.
// Usage: node scripts/e2e-home-rows.mjs [base] [profile]
import { launchBrowser } from "./lib/browser.ts";
import { baseUrl, checks, qaProfiles, signIn } from "./lib/qa.ts";

const base = baseUrl(process.argv[2]);
const [profile] = qaProfiles([process.argv[3]]);
const br = await launchBrowser();
const { check, finish, watch } = checks();

// Counts Convex calls by name and adds up layout shifts, from the moment the page loads.
function instrument() {
  window.__calls = {};
  const Native = window.WebSocket;
  window.WebSocket = class extends Native {
    send(data) {
      try {
        const m = JSON.parse(data);
        if (m.type === "Mutation" || m.type === "Action") (window.__calls[m.udfPath] ??= []).push(m.args?.[0] ?? {});
      } catch {}
      return super.send(data);
    }
  };
  window.__cls = 0;
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) if (!e.hadRecentInput) window.__cls += e.value;
  }).observe({ type: "layout-shift", buffered: true });
}

async function open(width, height) {
  const context = await br.newContext({ viewport: { width, height } });
  await context.addInitScript(instrument);
  const page = await context.newPage();
  watch(page, `${width}px`);
  await signIn(page, base, profile);
  await page.locator("main section[aria-labelledby] [data-rail] a[href^='/title/']").first().waitFor({ timeout: 60000 });
  await page.waitForTimeout(1500);
  return page;
}
const calls = (page, name) => page.evaluate((n) => window.__calls[n] ?? [], name);
const heights = (page) => page.$$eval("main section[aria-labelledby]", (s) => s.map((e) => Math.round(e.getBoundingClientRect().height)));
const cards = (page) => page.$$eval("main [data-rail] > div", (d) => d.length);

for (const [width, height] of [[1440, 900], [390, 844]]) {
  const at = `${width}px:`;
  const page = await open(width, height);
  const before = await heights(page);
  const initialCards = await cards(page);
  await page.evaluate(() => (window.__cls = 0));
  // Scroll the whole page the way a wheel does, then come back up.
  for (let y = 0; y < (await page.evaluate(() => document.documentElement.scrollHeight)); y += 400) {
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(500);
  const after = await heights(page);
  const changed = before.map((h, i) => [i, h, after[i]]).filter(([, h, a]) => Math.abs(h - a) > 1);
  check(`${at} no row changes height as it fills in`, changed.length === 0, changed.length ? JSON.stringify(changed) : "");
  const cls = await page.evaluate(() => window.__cls);
  check(`${at} scrolling Home shifts nothing`, cls < 0.01, `CLS ${cls.toFixed(4)}`);
  const allCards = await cards(page);
  check(`${at} rows fill in as they come near`, allCards > initialCards * 2, `${initialCards} cards at first, ${allCards} after scrolling`);
  check(`${at} nothing overflows sideways`, !(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)));
  await page.close();
}

{
  const page = await open(1440, 900);
  // A long row: the arrow pages to its very end, and only then hides.
  const row = page.locator("main section").filter({ has: page.getByRole("heading", { name: "Plan to watch", exact: true }) });
  const scroller = row.locator("[data-rail]");
  await row.scrollIntoViewIfNeeded();
  await row.hover();
  const forward = row.getByRole("button", { name: "Scroll forward" });
  let presses = 0;
  while (presses < 60 && (await forward.evaluate((b) => !b.className.includes("pointer-events-none")))) {
    await forward.click();
    await page.waitForTimeout(450);
    presses++;
  }
  const end = await scroller.evaluate((el) => el.scrollLeft + el.clientWidth >= el.scrollWidth - 4);
  const rendered = await scroller.locator(":scope > div").count();
  check("the forward arrow pages to the end of Plan to watch", end && presses > 1, `${presses} presses, ${rendered} cards`);

  // Tab walks card by card, past the first batch.
  await scroller.evaluate((el) => (el.scrollLeft = 0));
  await scroller.locator("a").first().focus();
  const hrefs = [];
  // Each card is its link and then its buttons.
  for (let i = 0; i < 60; i++) {
    const href = await page.evaluate(() => document.activeElement?.closest("[data-rail]") && document.activeElement.getAttribute("href"));
    if (href && !hrefs.includes(href)) hrefs.push(href);
    await page.keyboard.press("Tab");
  }
  check("Tab reaches cards past the first batch", hrefs.length >= 14, `${hrefs.length} cards in a row`);

  check("Home doesn't fetch sources for every title", (await calls(page, "sources:warm")).length === 0);

  // Back returns to the same spot, deep in the page.
  await page.evaluate(() => scrollTo(0, 0));
  const deep = page.locator("main section[aria-labelledby]").nth(12);
  await deep.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  const y = await page.evaluate(() => scrollY);
  await deep.locator("a[href^='/title/']").first().click();
  await page.locator("main h1").waitFor();
  await page.goBack();
  await page.waitForTimeout(1500);
  const back = await page.evaluate(() => scrollY);
  check("Back returns to the same spot", Math.abs(back - y) < 3, `${y} → ${back}`);
  check("the row there is filled in", (await deep.locator("[data-rail] > div").count()) > 1);

  // Play is prepared after resting on it, once; a pass over it prepares nothing.
  const play = page.locator("section[aria-label='Featured'] button").filter({ hasText: /^(Play|Resume|Play next episode)$/ }).first();
  await page.evaluate(() => scrollTo(0, 0));
  await play.hover();
  await page.waitForTimeout(100);
  await page.mouse.move(5, 5);
  await page.waitForTimeout(600);
  check("brushing past Play prepares nothing", (await calls(page, "rooms:warm")).length === 0);
  await play.hover();
  await page.waitForTimeout(1200);
  await page.mouse.move(5, 5);
  await play.hover();
  await page.waitForTimeout(1200);
  const warmed = await calls(page, "rooms:warm");
  check("resting on Play prepares it once", warmed.length === 1 && !!warmed[0].media?.videoId, warmed.map((w) => w.media?.videoId).join(", "));
  await page.close();
}

{
  // A title page asks for the sources of what its Play button would play, once.
  const page = await open(1440, 900);
  const href = await page.locator("main [data-rail] a[href^='/title/series/']").first().getAttribute("href");
  await page.goto(base + href);
  const playButton = page.locator("main button").filter({ hasText: /^(Play|Resume)/ }).first();
  await playButton.waitFor();
  await page.waitForTimeout(1500);
  const asked = await calls(page, "sources:warm");
  const label = (await playButton.textContent())?.trim() ?? "";
  const episode = /S(\d+) E(\d+)/.exec(label);
  check("a title page fetches its sources once", asked.length === 1, asked.map((a) => a.videoId).join(", "));
  check("...for the episode Play shows", !!episode && asked[0]?.videoId.endsWith(`:${episode[1]}:${episode[2]}`), label);
  await page.close();
}

await br.close();
finish();
