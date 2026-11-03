// Muted trailers on Home: the banner's trailer playing (and pausing for a poster's), a poster resting under the pointer
// widening in place into its trailer without covering its neighbours, a poster at the row's end pulling the row along
// and giving it back, brushing past opening nothing, and phones getting neither. Records a video of the desktop run.
// Needs the QA app (npm run qa -- up) or a *-QA-* profile on dev.
// Usage: node scripts/e2e-home-trailers.mjs [base] [profile] [outDir]
import { mkdir } from "node:fs/promises";
import { launchBrowser } from "./lib/browser.ts";
import { baseUrl, checks, qaProfiles, signIn } from "./lib/qa.ts";

const [baseArg, name, outDir = ".artifacts/home-trailers"] = process.argv.slice(2);
const base = baseUrl(baseArg);
const [profile] = qaProfiles([name]);
await mkdir(outDir, { recursive: true });
const br = await launchBrowser({ args: ["--autoplay-policy=no-user-gesture-required"] });
const { check, finish, watch } = checks();

async function open(width, height, video) {
  const context = await br.newContext({
    viewport: { width, height },
    ...(video && { recordVideo: { dir: outDir, size: { width, height } } }),
  });
  const page = await context.newPage();
  watch(page, `${width}px`);
  await signIn(page, base, profile);
  await page.locator("[data-preview]").first().waitFor({ timeout: 60000 });
  return page;
}

/** Whether the trailer under `root` is advancing: played on over a second. */
async function advancing(page, root) {
  const before = await video(page, root);
  await page.waitForTimeout(1000);
  const after = await video(page, root);
  return after.time > before.time + 0.5 && !after.paused ? after : null;
}

/** The trailer under `root` (IMDb's file, else the <video> inside a YouTube embed): seconds played and whether it's paused. */
async function video(page, root) {
  const file = page.locator(`${root} video`).first();
  if (await file.count()) return file.evaluate((v) => ({ time: v.currentTime, paused: v.paused }));
  const handle = await page.locator(`${root} iframe[src*="youtube-nocookie.com/embed/"]`).first().elementHandle({ timeout: 1000 }).catch(() => null);
  const frame = await handle?.contentFrame();
  if (!frame) return { time: -1, paused: true };
  return frame.evaluate(() => {
    const v = document.querySelector("video");
    return { time: v?.currentTime ?? -1, paused: v?.paused ?? true };
  });
}

const box = (loc) => loc.boundingBox();
const HERO = 'section[aria-label="Featured"]';

// Desktop
{
  const page = await open(1440, 900, true);
  // The banner rotates until a title slide's trailer plays (not "Continue watching").
  // The trailer shows (with its sound button) once it is playing.
  const heroSound = page.locator(HERO).getByRole("button", { name: "Turn sound on" });
  const heroShown = await heroSound.waitFor({ timeout: 45000 }).then(() => true, () => false);
  check("banner trailer shows, with Turn sound on", heroShown);
  const hero = await advancing(page, HERO);
  check("banner trailer plays", !!hero, JSON.stringify(hero));
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${outDir}/hero-trailer.png` });

  // A poster in the first row of posters that aren't anime (Kitsu has few trailers), away from either end.
  const rail = page
    .locator("section", { has: page.locator("[data-preview]"), hasNot: page.getByRole("heading", { name: /anime/i }) })
    .locator("[data-rail]")
    .first();
  // In the middle of the screen, so its posters and their buttons are all on it, wherever the row is on Home.
  await rail.evaluate((el) => el.scrollIntoView({ block: "center" }));
  const cards = rail.locator("[data-preview]");
  const card = cards.nth(1);
  const before = await box(card);
  // Away from every poster: beside the row's heading. (The row's own margin isn't: a row scrolled along for a
  // poster at its end slides its first poster under it on the way back.)
  const park = () => page.mouse.move(8, before.y - 24, { steps: 2 });
  const nextBefore = await box(cards.nth(2));

  // Brushing past opens nothing.
  for (let i = 0; i < 5; i++) {
    const b = await box(cards.nth(i));
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 3, { steps: 3 });
    await page.waitForTimeout(120);
  }
  await park();
  await page.waitForTimeout(1200);
  check("brushing past opens nothing", (await rail.locator('[data-preview="open"]').count()) === 0);

  // Crossing the artwork to its buttons, resting on them, and clicking one opens nothing either.
  // Measured first: a busy page can make measuring outlast the rest that opens a poster.
  const rate = card.locator("[data-card-actions] button").last();
  const r = await box(rate);
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 3, { steps: 3 });
  await page.waitForTimeout(200);
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2, { steps: 8 });
  await page.mouse.move(r.x + r.width / 2 + 2, r.y + r.height / 2 + 1);
  await page.waitForTimeout(2000);
  check("resting on a poster's buttons doesn't open it", (await card.getAttribute("data-preview")) === "closed");
  check("...or load its trailer", (await card.locator("iframe, video").count()) === 0);
  await rate.click();
  await page.waitForTimeout(1500);
  check("clicking one doesn't open it", (await card.getAttribute("data-preview")) === "closed");
  await page.keyboard.press("Escape");
  await park();
  await page.waitForTimeout(800);

  // Rest on it: it widens, and the row makes room instead of being covered.
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 3, { steps: 4 });
  await page.mouse.move(before.x + before.width / 2 + 4, before.y + before.height / 3 + 2);
  // How much of it shows on every frame, from the page itself: the card takes its open width at once, and a
  // window over the artwork springs open.
  const widths = await card.evaluate(
    (el) =>
      new Promise((done) => {
        const seen = [];
        const frame = el.querySelector("a > div > div");
        const tick = () => {
          seen.push(Math.round(Math.min(frame.getBoundingClientRect().right, el.getBoundingClientRect().right + 40) - el.getBoundingClientRect().left));
          if (seen.length < 150) requestAnimationFrame(tick);
          else done(seen);
        };
        tick();
      }),
  );
  const moving = widths.filter((w, i) => w !== widths[i - 1]);
  console.log("widths:", moving.join(" "));
  const after = await box(card);
  const ratio = after.width / before.width;
  check("poster widens to the backdrop's shape", ratio > 2.5 && ratio < 2.8, `${ratio.toFixed(2)}x`);
  check("the spring overshoots a little before settling", Math.max(...widths) > after.width + 2, `peak ${Math.max(...widths)}, settled ${Math.round(after.width)}`);
  await page.screenshot({ path: `${outDir}/poster-open.png` });
  check("row height doesn't change", Math.abs(after.height - before.height) < 2);
  const nextAfter = await box(cards.nth(2));
  check("the next poster moves aside, nothing is covered", nextAfter.x >= after.x + after.width);
  check("it moves by exactly the growth", Math.abs(nextAfter.x - nextBefore.x - (after.width - before.width)) < 3);

  const posterShown = await card
    .getByRole("button", { name: "Turn sound on" })
    .waitFor({ timeout: 20000 })
    .then(() => true, () => false);
  check("poster trailer shows, with Turn sound on", posterShown);
  const poster = await advancing(page, '[data-preview="open"]');
  check("poster trailer plays", !!poster, JSON.stringify(poster));
  await page.waitForTimeout(400);
  const heroPaused = await video(page, HERO);
  check("banner pauses while a poster plays", heroPaused.paused);
  await page.screenshot({ path: `${outDir}/poster-trailer.png` });

  // Slipping off its edge and straight back keeps it open (it waits a moment before closing).
  await page.mouse.move(after.x + after.width / 2, after.y - 16, { steps: 2 });
  await page.waitForTimeout(150);
  await page.mouse.move(after.x + after.width / 2, after.y + after.height / 3, { steps: 2 });
  await page.waitForTimeout(500);
  check("slipping off its edge and back keeps it open", (await card.getAttribute("data-preview")) === "open");

  // Moving on to the next poster opens that one, and the two are never open together.
  const widest = card.evaluate(
    (el) =>
      new Promise((done) => {
        const rail = el.closest("[data-rail]");
        let most = 0;
        const t0 = performance.now();
        const tick = () => {
          most = Math.max(most, rail.querySelectorAll('[data-preview="open"]').length);
          if (performance.now() - t0 < 1500) requestAnimationFrame(tick);
          else done(most);
        };
        tick();
      }),
  );
  const n = await box(cards.nth(2));
  await page.mouse.move(n.x + n.width / 2, n.y + n.height / 3, { steps: 4 });
  await page.mouse.move(n.x + n.width / 2 + 3, n.y + n.height / 3 + 2);
  check("never two posters open at once", (await widest) === 1);
  check("the next poster opens quickly", (await cards.nth(2).getAttribute("data-preview")) === "open");
  await page.mouse.move(after.x + after.width / 2, after.y + after.height / 3, { steps: 4 });
  await page.mouse.move(after.x + after.width / 2 + 3, after.y + after.height / 3 + 2);
  await page.waitForTimeout(1200);

  // Leaving closes it back to a poster, and the banner carries on.
  await park();
  await page.waitForTimeout(900);
  const closed = await box(card);
  check("leaving closes it to its poster width", Math.abs(closed.width - before.width) < 1);
  check("no poster left open", (await rail.locator('[data-preview="open"]').count()) === 0);

  // The last poster fully on screen: the row scrolls so it opens fully inside, then scrolls back.
  const scroller = await box(rail);
  const count = await cards.count();
  let edge = -1;
  for (let i = 0; i < count; i++) {
    const b = await box(cards.nth(i));
    if (b.x + b.width <= scroller.x + scroller.width - 48) edge = i;
  }
  const startScroll = await rail.evaluate((el) => el.scrollLeft);
  const e = await box(cards.nth(edge));
  await page.mouse.move(e.x + e.width / 2, e.y + e.height / 3, { steps: 4 });
  await page.mouse.move(e.x + e.width / 2 + 4, e.y + e.height / 3 + 2);
  await page.waitForTimeout(1800);
  const opened = await box(cards.nth(edge));
  check("a poster at the row's end opens fully on screen", opened.x + opened.width <= scroller.x + scroller.width - 47);
  check("...without leaving the row's left edge", opened.x >= scroller.x + 47);
  const pointerX = e.x + e.width / 2 + 4;
  check("...and stays under the pointer", pointerX > opened.x && pointerX < opened.x + opened.width);
  await page.screenshot({ path: `${outDir}/poster-edge.png` });
  await park();
  await page.waitForTimeout(1200);
  check("the row scrolls back where it was", Math.abs((await rail.evaluate((el) => el.scrollLeft)) - startScroll) < 2);
  check("snapping is back on", (await rail.evaluate((el) => el.style.scrollSnapType)) === "");

  // The poster half past the row's end, rested on in the row's right margin: opening would slide it out from
  // under the pointer, so it stays shut and the row holds still (it used to scroll back and forth on its own).
  const cut = await box(cards.nth(edge + 1));
  const margin = { x: scroller.x + scroller.width - 38, y: cut.y + cut.height / 3 };
  check("a poster crosses the row's end", cut.x < margin.x - 4 && cut.x + cut.width > margin.x + 2);
  await rail.evaluate((el) => {
    window.__railScrolls = 0;
    el.addEventListener("scroll", () => window.__railScrolls++);
  });
  await page.mouse.move(margin.x - 4, margin.y, { steps: 3 });
  for (let i = 0; i < 12; i++) {
    await page.mouse.move(margin.x + (i % 2 ? 2 : -2), margin.y + 1);
    await page.waitForTimeout(300);
  }
  check("resting in the row's margin on a poster past its end opens nothing", (await rail.locator('[data-preview="open"]').count()) === 0);
  check("...and the row holds still", (await page.evaluate(() => window.__railScrolls)) === 0, `${await page.evaluate(() => window.__railScrolls)} scrolls`);
  await park();

  await page.context().close();
}

// Phone: no banner trailer, and posters stay posters.
{
  const page = await open(390, 844, false);
  await page.waitForTimeout(6000);
  check("phone: no banner trailer", (await page.locator(`${HERO} iframe, ${HERO} video`).count()) === 0);
  check("phone: no poster opens", (await page.locator('[data-preview="open"]').count()) === 0);
  await page.close();
}

await br.close();
finish();
