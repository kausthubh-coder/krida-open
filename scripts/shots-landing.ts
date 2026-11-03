// The landing page's pictures (src/features/landing/shots/) and the Open Graph image (public/og.png), taken from the
// real app: Home, a title page, the player and a party, with real artwork and a real stream. Run it after
// scripts/e2e-onboarding.ts on the same QA app (npm run qa -- up --real): it signs in as that script's two Clerk test
// users, whose accounts are set up by then (A, "Ada", with TorBox and Torrentio; B, "Ben", without TorBox). The player
// and the party play Big Buck Bunny, which is free to show. Needs cwebp (brew install webp).
// Usage: node scripts/shots-landing.ts <a>+clerk_test@example.com <b>+clerk_test@example.com
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import type { Browser, Page } from "playwright-core";
import { launchBrowser } from "./lib/browser.ts";
import { assertLocal, checks, qaSession } from "./lib/qa.ts";

const [emailA, emailB] = process.argv.slice(2);
if (!emailA?.endsWith("+clerk_test@example.com") || !emailB?.endsWith("+clerk_test@example.com"))
  throw new Error("Usage: node scripts/shots-landing.ts <a>+clerk_test@example.com <b>+clerk_test@example.com (Clerk test users only)");
const s = qaSession();
assertLocal(s.url);
const raw = ".artifacts/landing-shots";
const shots = "src/features/landing/shots";
mkdirSync(raw, { recursive: true });
const BUNNY = "tt1254207";
const DUNE = "tt15239678";

const browser = await launchBrowser({ headless: true, args: ["--autoplay-policy=no-user-gesture-required", "--hide-scrollbars"] });
const { check, finish, watch } = checks();

/** Signs in with Clerk (a code by email; test users get 424242) and picks the profile. */
async function signedIn(b: Browser, email: string, profile: string, viewport: { width: number; height: number }, scale: number) {
  const context = await b.newContext({ viewport, deviceScaleFactor: scale, permissions: ["clipboard-read", "clipboard-write"], isMobile: viewport.width < 500, hasTouch: viewport.width < 500 });
  const page = await context.newPage();
  watch(page, `${profile} ${viewport.width}`);
  await page.goto(`${s.url}/sign-in`, { waitUntil: "domcontentloaded" });
  const field = page.getByLabel("Email address");
  await field.waitFor({ timeout: 60_000 });
  await field.fill(email);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  // Clerk shows the code boxes a moment before it has sent the code; a code typed in that moment is refused.
  const early = page.getByText("You need to send a verification code before attempting to verify.");
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.waitForTimeout(2500);
    await page.getByRole("textbox").first().click();
    await page.keyboard.type("424242");
    await page.waitForTimeout(1500);
    if (!(await early.isVisible())) break;
    await page.getByRole("button", { name: "Resend" }).click().catch(() => {});
  }
  await page.getByRole("button", { name: profile, exact: true }).click({ timeout: 60_000 });
  return page;
}

/** Waits for every image on screen to have loaded, then a little for fades. */
async function settled(page: Page, wait = 2500) {
  await page.waitForFunction(() => [...document.images].filter((i) => i.getBoundingClientRect().top < innerHeight).every((i) => i.complete), null, { timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(wait);
}

const webp = (from: string, to: string, width?: number) =>
  execFileSync("cwebp", ["-quiet", "-q", "80", "-m", "6", ...(width ? ["-resize", String(width), "0"] : []), from, "-o", to]);

/** The player's picture: playing, then paused at `at` seconds with its controls showing. */
async function playing(page: Page, at?: number) {
  await page.waitForURL(/\/watch\//, { timeout: 60_000 });
  const ok = await page
    .waitForFunction(() => {
      const v = document.querySelector("video");
      return !!v && v.currentTime > 2 && !v.paused;
    }, null, { timeout: 180_000, polling: 1000 })
    .then(() => true, () => false);
  // A party keeps everyone on one clock, so only a solo player is moved.
  if (at === undefined) return ok;
  await page.evaluate((t) => {
    const v = document.querySelector("video")!;
    v.currentTime = t;
  }, at);
  await page.waitForFunction((t) => {
    const v = document.querySelector("video");
    return !!v && v.currentTime > t + 1 && v.readyState >= 3;
  }, at, { timeout: 60_000 });
  return ok;
}

const partyButton = (p: Page) => p.getByRole("button", { name: /^(Party|Watch together|Watch with)/ }).first();
const partyStart = (p: Page) => p.getByRole("button", { name: /^(Start without inviting anyone|Start a party)$/ });

/** Leaves a party an earlier run left Ada in (Ben's account has no TorBox, so it ends), so pages show no party. */
async function leaveAnyParty(page: Page) {
  await partyButton(page).click({ timeout: 30_000 });
  const options = page.getByRole("button", { name: "More party options" }).first();
  await partyStart(page).or(options).first().waitFor({ timeout: 30_000 });
  if (await options.isVisible()) {
    await options.click();
    await page.getByRole("menuitem", { name: "Leave party" }).click();
    await page.waitForTimeout(2000);
  }
  await page.goto(`${s.url}/`, { waitUntil: "domcontentloaded" });
}

try {
  // Home wide, scrolled so the banner's foot and the rows under it show; on a phone, its banner.
  const a = await signedIn(browser, emailA, "Ada", { width: 1536, height: 960 }, 1.25);
  await a.getByRole("button", { name: /, profile menu$/ }).waitFor({ timeout: 60_000 });
  await leaveAnyParty(a);
  await a.getByRole("button", { name: /, profile menu$/ }).waitFor({ timeout: 60_000 });
  await a.locator("main img").nth(10).waitFor({ timeout: 60_000 });
  await a.mouse.move(1530, 950);
  await a.mouse.wheel(0, 380);
  await settled(a, 4000);
  await a.screenshot({ path: `${raw}/home.png` });
  check("Home has rows of posters", (await a.locator("main img").count()) > 10);

  const phone = await signedIn(browser, emailA, "Ada", { width: 390, height: 844 }, 2);
  await phone.locator("main img").nth(6).waitFor({ timeout: 60_000 });
  await settled(phone, 4000);
  await phone.screenshot({ path: `${raw}/phone.png` });

  // A title page.
  await a.setViewportSize({ width: 1440, height: 900 });
  await a.goto(`${s.url}/title/movie/${DUNE}`, { waitUntil: "domcontentloaded" });
  await a.getByRole("button", { name: /^(Play|Resume)/ }).first().waitFor({ timeout: 60_000 });
  await a.mouse.move(1430, 890);
  await settled(a, 4000);
  await a.screenshot({ path: `${raw}/title.png` });

  // The player, alone: a real TorBox stream.
  await a.goto(`${s.url}/title/movie/${BUNNY}`, { waitUntil: "domcontentloaded" });
  await a.getByRole("button", { name: /^(Play|Resume)/ }).first().click({ timeout: 60_000 });
  check("Big Buck Bunny plays", await playing(a, 245));
  await a.mouse.move(700, 450);
  await a.mouse.move(720, 470);
  await a.waitForTimeout(600);
  await a.screenshot({ path: `${raw}/player.png` });
  await a.goBack();

  // A party: Ada starts one from Home's party panel, Ben joins from the link, Ada puts Big Buck Bunny on.
  await a.goto(`${s.url}/`, { waitUntil: "domcontentloaded" });
  await partyButton(a).click({ timeout: 30_000 });
  await partyStart(a).click({ timeout: 30_000 });
  await a.getByRole("button", { name: /^Copy invite link/ }).click({ timeout: 30_000 });
  await a.getByRole("button", { name: "Link copied" }).waitFor({ timeout: 10_000 });
  const link = await a.evaluate(() => navigator.clipboard.readText());
  const b = await signedIn(browser, emailB, "Ben", { width: 1440, height: 900 }, 1);
  await b.getByRole("button", { name: /, profile menu$/ }).waitFor({ timeout: 60_000 });
  await b.goto(link, { waitUntil: "domcontentloaded" });
  await b.getByRole("button", { name: "Join the party" }).click({ timeout: 30_000 });
  await b.waitForTimeout(3000);
  await a.goto(`${s.url}/title/movie/${BUNNY}`, { waitUntil: "domcontentloaded" });
  await a.getByRole("button", { name: /^(Play now|Resume now)$/ }).first().click({ timeout: 60_000 });
  check("the party plays", await playing(a));
  await b.waitForURL(/\/watch\//, { timeout: 60_000 });
  const chat = (p: Page) => p.getByRole("textbox", { name: "Message", exact: true }).first();
  for (const [p, text] of [[a, "This part gets me every time"], [b, "The squirrels are plotting something"]] as const) {
    if (!(await chat(p).isVisible())) {
      await p.mouse.move(600, 400);
      await p.mouse.move(640, 420);
      await partyButton(p).click();
    }
    await chat(p).fill(text);
    await chat(p).press("Enter");
  }
  await a.getByText("The squirrels are plotting something").waitFor({ timeout: 30_000 });
  await a.mouse.move(700, 450);
  await a.mouse.move(720, 470);
  await a.waitForTimeout(800);
  await a.screenshot({ path: `${raw}/party.png` });
  check("the party shows both people chatting", true);

  // The Open Graph card: the headline beside Home.
  const og = await (await browser.newContext({ viewport: { width: 1200, height: 630 } })).newPage();
  const homeShot = `data:image/png;base64,${readFileSync(`${raw}/home.png`).toString("base64")}`;
  await og.setContent(`<!doctype html><html><body style="margin:0;width:1200px;height:630px;overflow:hidden;background:oklch(0.145 0.006 60);font-family:Inter,-apple-system,system-ui,sans-serif;color:oklch(0.97 0.004 60)">
    <div style="position:absolute;inset:0;background:radial-gradient(70% 80% at 85% 50%, oklch(0.3 0.01 60 / .7), transparent 70%)"></div>
    <div style="position:absolute;left:72px;top:0;bottom:0;width:440px;display:flex;flex-direction:column;justify-content:center;gap:24px">
      <div style="font-size:40px;font-weight:650;letter-spacing:-.035em">krida</div>
      <div style="font-size:60px;font-weight:600;line-height:1.02;letter-spacing:-.035em">Press play on anything</div>
      <div style="font-size:24px;line-height:1.35;color:oklch(0.78 0.006 60)">Free and open source. Your own debrid and addons, alone or together.</div>
    </div>
    <img src="${homeShot}" style="position:absolute;left:560px;top:75px;width:768px;border-radius:16px;box-shadow:0 30px 80px #0009;outline:1px solid #ffffff1a">
  </body></html>`);
  await og.waitForTimeout(500);
  await og.screenshot({ path: "public/og.png" });

  webp(`${raw}/home.png`, `${shots}/home.webp`);
  webp(`${raw}/home.png`, `${shots}/home-small.webp`, 960);
  webp(`${raw}/phone.png`, `${shots}/phone.webp`);
  // Full size for wide screens, 1080 wide for phones (a figure is 358 CSS pixels wide on a 3x phone, 690 on a wide screen).
  for (const name of ["title", "player", "party"]) {
    webp(`${raw}/${name}.png`, `${shots}/${name}.webp`);
    webp(`${raw}/${name}.png`, `${shots}/${name}-small.webp`, 1080);
  }
} catch (error) {
  check("the shots finished", false, error instanceof Error ? error.message.split("\n")[0] : String(error));
  let n = 0;
  for (const context of browser.contexts()) for (const page of context.pages()) await page.screenshot({ path: `${raw}/failed-${++n}.png` }).catch(() => {});
} finally {
  finish();
  await browser.close();
}
