// Onboarding end to end, with real Clerk sign-ups (test users, code 424242) and real keys: A opens the landing page,
// signs up, makes a profile, adds a TMDB key, picks TorBox, installs Torrentio from the suggestions, adds MDBList,
// lands on Home with rows and plays a movie. B signs up, tries Real-Debrid with a fake key, skips it, and sees Play
// (no debrid service) and parties (no TorBox) as unavailable, with why. B then joins A's party (joining needs no TorBox). Every step is shot at 1440 and
// 390 wide into .artifacts/onboarding/, key fields blurred.
// Needs the QA app with no stand-ins (npm run qa -- up --real) with Clerk set up (VITE_CLERK_PUBLISHABLE_KEY in
// .env.local), and TMDB_API_KEY, MDBLIST_API_KEY and TORBOX_API_KEY in .env.test.local (never printed). Two new Clerk
// test users with no account in Krida yet: Clerk's bot protection stops a scripted browser at the sign-up form, so make
// them first (npx clerk users create --email <name>+clerk_test@example.com); signing in is the same form and isn't
// stopped. MOVIE picks the film to play (an IMDb id; default Big Buck Bunny, which is free to show).
// Usage: node scripts/e2e-onboarding.ts <a>+clerk_test@example.com <b>+clerk_test@example.com
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import type { BrowserContext, Page } from "playwright-core";
import { launchBrowser } from "./lib/browser.ts";
import { assertLocal, checks, qaSession } from "./lib/qa.ts";

const [emailA, emailB] = process.argv.slice(2);
if (!emailA?.endsWith("+clerk_test@example.com") || !emailB?.endsWith("+clerk_test@example.com"))
  throw new Error("Usage: node scripts/e2e-onboarding.ts <a>+clerk_test@example.com <b>+clerk_test@example.com (Clerk test users only)");
const keyFile = ".env.test.local";
if (!existsSync(keyFile)) throw new Error(`No ${keyFile} with TMDB_API_KEY, MDBLIST_API_KEY and TORBOX_API_KEY`);
const keys = parseEnv(readFileSync(keyFile, "utf8"));
for (const name of ["TMDB_API_KEY", "MDBLIST_API_KEY", "TORBOX_API_KEY"]) if (!keys[name]) throw new Error(`${keyFile} has no ${name}`);
const MOVIE = process.env.MOVIE ?? "tt1254207";

const s = qaSession();
assertLocal(s.url);
const out = ".artifacts/onboarding";
mkdirSync(out, { recursive: true });
const browser = await launchBrowser({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const open = async (): Promise<[BrowserContext, Page]> => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, permissions: ["clipboard-read", "clipboard-write"] });
  return [context, await context.newPage()];
};
const [, a] = await open();
const [, b] = await open();
const { check, finish, watch } = checks(a);
watch(b, "B");

let shots = 0;
/** One step at 1440 and at 390 wide, with every key field blurred. */
async function shot(page: Page, name: string, { full = false } = {}) {
  await page.addStyleTag({ content: "input[type=password], input[id$='-key'], [data-key-hint] { filter: blur(8px) !important; }" }).catch(() => {});
  await page.waitForTimeout(700);
  const n = String(++shots).padStart(2, "0");
  await page.screenshot({ path: `${out}/${n}-${name}-1440.png`, fullPage: full });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${out}/${n}-${name}-390.png`, fullPage: full });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(400);
}

/** Clerk's sign-in, reached from the landing page: a code by email (test users get 424242). */
async function signUp(page: Page, email: string) {
  await page.getByRole("link", { name: "Get started" }).first().click();
  await page.waitForURL(/\/sign-in/);
  const field = page.getByLabel("Email address");
  await field.waitFor({ timeout: 60_000 });
  await shot(page, `${who(page)}-sign-in`);
  await field.fill(email);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByText(/check your email|verify your email/i).first().waitFor({ timeout: 30_000 });
  // Clerk shows the code boxes a moment before it has sent the code; a code typed in that moment is refused.
  const early = page.getByText("You need to send a verification code before attempting to verify.");
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.waitForTimeout(1500);
    await page.getByRole("textbox").first().click();
    await page.keyboard.type("424242");
    await page.waitForTimeout(1500);
    if (!(await early.isVisible())) return;
    await page.getByRole("button", { name: "Resend" }).click().catch(() => {});
  }
}

const who = (page: Page) => (page === a ? "a" : "b");
const heading = (page: Page, name: string | RegExp) => page.getByRole("heading", { name, level: 1 });

async function makeProfile(page: Page, name: string) {
  await heading(page, "Make your profile").waitFor({ timeout: 60_000 });
  await page.getByLabel("Name", { exact: true }).fill(name);
  await shot(page, `${who(page)}-profile`);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
}

async function checkKey(page: Page, label: string, key: string) {
  await page.getByLabel(label, { exact: true }).fill(key);
  await page.getByLabel(label, { exact: true }).locator("xpath=ancestor::form").getByRole("button", { name: "Check key" }).click();
}

async function tmdbStep(page: Page) {
  await heading(page, "Connect TMDB").waitFor({ timeout: 60_000 });
  check(`${who(page)}: after the profile comes the TMDB step`, true);
  await shot(page, `${who(page)}-tmdb`, { full: true });
  await checkKey(page, "TMDB API key", "not-a-real-key");
  await page.getByText("TMDB didn't accept that key. Check it and paste it again.").waitFor({ timeout: 30_000 });
  check(`${who(page)}: a wrong TMDB key is refused`, true);
  await shot(page, `${who(page)}-tmdb-refused`);
  await checkKey(page, "TMDB API key", keys.TMDB_API_KEY!);
  await heading(page, "Pick your debrid service").waitFor({ timeout: 30_000 });
  check(`${who(page)}: a good TMDB key moves on to debrid`, true);
}

try {
  // The landing page, as a visitor sees it.
  await a.goto(s.url, { waitUntil: "load" });
  await heading(a, "Press play on anything").waitFor({ timeout: 60_000 });
  const scripts = await a.evaluate(() => performance.getEntriesByType("resource").filter((r) => r.name.includes("/src/") || r.name.includes("/assets/")).map((r) => r.name));
  check("the landing page loads without the app", !scripts.some((u) => /\/src\/app\/main|bubli|convex\/react/.test(u)), `${scripts.length} files`);
  await shot(a, "landing", { full: true });

  // A: sign up, profile, TMDB, TorBox, Torrentio, MDBList, Home, Play.
  await signUp(a, emailA);
  await makeProfile(a, "Ada");
  await tmdbStep(a);
  await shot(a, "a-debrid", { full: true });
  await checkKey(a, "TorBox API key", keys.TORBOX_API_KEY!);
  await heading(a, "Add where streams come from").waitFor({ timeout: 30_000 });
  check("A: a TorBox key moves on to addons", true);
  await shot(a, "a-addons", { full: true });
  await a.getByRole("button", { name: "Install Torrentio" }).click();
  await a.getByText("Installed for this profile").waitFor({ timeout: 60_000 });
  check("A: Torrentio installs from the suggestions, and the step stays open", await heading(a, "Add where streams come from").isVisible());
  await shot(a, "a-addons-installed", { full: true });

  // Another device resumes at the first step still needed: with Torrentio installed, that's the extras. (This device
  // keeps the addons step open until Continue, in case A wants more.)
  const [other, resumed] = await open();
  await resumed.goto(`${s.url}/sign-in`, { waitUntil: "domcontentloaded" });
  await signInAgain(resumed, emailA);
  await resumed.getByRole("button", { name: "Ada", exact: true }).click({ timeout: 60_000 });
  await heading(resumed, "A few extras").waitFor({ timeout: 60_000 });
  check("A on a second device resumes at the next step needed", await heading(a, "Add where streams come from").isVisible());
  await other.close();

  await a.getByRole("button", { name: "Continue", exact: true }).click();
  await heading(a, "A few extras").waitFor({ timeout: 30_000 });
  await shot(a, "a-extras", { full: true });
  await checkKey(a, "MDBList API key", keys.MDBLIST_API_KEY!);
  await a.getByText("MDBList key saved, ending").waitFor({ timeout: 30_000 });
  check("A: a saved MDBList key keeps the extras step open until Go to Home", await heading(a, "A few extras").isVisible());
  await shot(a, "a-extras-saved");
  await a.getByRole("button", { name: "Go to Home" }).click();
  await a.getByRole("button", { name: /, profile menu$/ }).waitFor({ timeout: 60_000 });
  await a.locator("main img").nth(6).waitFor({ timeout: 60_000 });
  await a.waitForTimeout(4000);
  const rows = await a.getByRole("region").count();
  check("A: Home shows rows", rows >= 2, `${rows} rows`);
  await shot(a, "a-home");

  await a.goto(`${s.url}/title/movie/${MOVIE}`, { waitUntil: "domcontentloaded" });
  const play = a.getByRole("button", { name: /^(Play|Resume)$/ }).first();
  await play.waitFor({ timeout: 60_000 });
  await a.waitForTimeout(2500);
  await shot(a, "a-title");
  await play.click();
  await a.waitForURL(/\/watch\//, { timeout: 60_000 });
  const playing = await a.waitForFunction(() => {
    const v = document.querySelector("video");
    return !!v && v.currentTime > 3 && !v.paused;
  }, null, { timeout: 180_000, polling: 1000 }).then(() => true, () => false);
  check("A: the movie plays", playing);
  await a.mouse.move(700, 500);
  await a.mouse.move(720, 520);
  await shot(a, "a-playing");

  // B: Real-Debrid with a fake key is refused; B skips, and sees what needs a debrid service and what needs TorBox.
  await b.goto(s.url, { waitUntil: "load" });
  await heading(b, "Press play on anything").waitFor({ timeout: 60_000 });
  await signUp(b, emailB);
  await makeProfile(b, "Ben");
  await tmdbStep(b);
  await b.getByRole("radio", { name: "Real-Debrid" }).click();
  await b.getByText("Parties and timeline previews need TorBox").waitFor();
  check("B: picking Real-Debrid says what needs TorBox", true);
  await checkKey(b, "Real-Debrid API key", "fake-real-debrid-key");
  await b.getByText("Real-Debrid didn't accept that key. Check it and paste it again.").waitFor({ timeout: 30_000 });
  check("B: a fake Real-Debrid key is refused", true);
  await shot(b, "b-debrid-realdebrid", { full: true });
  await b.getByRole("button", { name: "Skip for now" }).click();
  await heading(b, "Add where streams come from").waitFor({ timeout: 30_000 });
  await shot(b, "b-addons-no-debrid", { full: true });
  await b.getByRole("button", { name: "Skip for now" }).click();
  await heading(b, "A few extras").waitFor({ timeout: 30_000 });
  await b.getByRole("button", { name: "Go to Home" }).click();
  await b.getByRole("button", { name: /, profile menu$/ }).waitFor({ timeout: 60_000 });
  await b.goto(`${s.url}/title/movie/${MOVIE}`, { waitUntil: "domcontentloaded" });
  await b.getByText("Playing needs a debrid service.").waitFor({ timeout: 60_000 });
  check("B: the title page shows Play as unavailable, with why", (await b.getByRole("button", { name: "Play", exact: true }).getAttribute("aria-disabled")) === "true");
  // aria-disabled, so Playwright would wait for it to turn on; a person can still press it, and it says why.
  await b.getByRole("button", { name: "Play", exact: true }).click({ force: true });
  await b.getByText("Playing needs a debrid service", { exact: true }).waitFor({ timeout: 10_000 });
  check("B: pressing Play says why instead of starting", !/\/watch\//.test(b.url()));
  await shot(b, "b-title-needs-debrid");
  await b.getByRole("button", { name: "Watch together" }).first().click();
  await b.getByText(/Parties need TorBox/).first().waitFor({ timeout: 10_000 });
  check("B: starting a party says it needs TorBox", true);
  await shot(b, "b-party-needs-torbox");

  // B joins A's party anyway: everyone watches the host's TorBox stream. A starts it from Home's party panel.
  await a.goto(`${s.url}/`, { waitUntil: "domcontentloaded" });
  await a.getByRole("button", { name: /^(Party|Watch together|Watch with)/ }).first().click({ timeout: 30_000 });
  await a.getByRole("button", { name: /^(Start without inviting anyone|Start a party)$/ }).click({ timeout: 30_000 });
  await a.getByRole("button", { name: /^Copy invite link/ }).click({ timeout: 30_000 });
  await a.getByRole("button", { name: "Link copied" }).waitFor({ timeout: 10_000 });
  const link = await a.evaluate(() => navigator.clipboard.readText());
  await b.goto(link, { waitUntil: "domcontentloaded" });
  await b.getByRole("button", { name: "Join the party" }).click({ timeout: 30_000 });
  const here = b.getByText(/Ada and you are here|You and Ada are here/).first();
  if (!(await here.waitFor({ timeout: 5000 }).then(() => true, () => false))) {
    await b.getByRole("button", { name: /^(Party|Watch together|Watch with)/ }).first().click({ timeout: 30_000 });
    await here.waitFor({ timeout: 30_000 });
  }
  check("B joins A's party without TorBox", true);
  // A party still picking opens its panel over Home; the join page, its button still spinning, mustn't stay behind it.
  const left = await b.waitForURL((u) => u.pathname === "/", { timeout: 10_000 }).then(() => true, () => false);
  check("B leaves the join page for Home, the panel open", left && (await b.getByRole("button", { name: "Join the party" }).count()) === 0, new URL(b.url()).pathname);
  await shot(b, "b-in-party");
} catch (error) {
  check("the walk finished", false, error instanceof Error ? error.message.split("\n")[0] : String(error));
  await a.screenshot({ path: `${out}/failed-a.png` }).catch(() => {});
  await b.screenshot({ path: `${out}/failed-b.png` }).catch(() => {});
} finally {
  finish();
  await browser.close();
}

/** Signing in again on another device: the email and the code, then the picker. */
async function signInAgain(page: Page, email: string) {
  const field = page.getByLabel("Email address");
  await field.waitFor({ timeout: 60_000 });
  await field.fill(email);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const early = page.getByText("You need to send a verification code before attempting to verify.");
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.waitForTimeout(2500);
    await page.getByRole("textbox").first().click();
    await page.keyboard.type("424242");
    await page.waitForTimeout(1500);
    if (!(await early.isVisible())) return;
    await page.getByRole("button", { name: "Resend" }).click().catch(() => {});
  }
}
