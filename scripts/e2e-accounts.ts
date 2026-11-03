// Accounts end to end, with real Clerk sign-ins (test users, code 424242): A signs in, makes a profile and sets the
// account up (onboarding), makes a second profile with a PIN and switches between them; B, in another browser, signs in and sees none of A's profiles or rooms; A hosts a
// party and copies its invite link; B's profile joins through it; both see the same title and chat; A leaves and the
// party goes to B, whose account has TorBox. Screenshots in .artifacts/accounts/.
// Needs the QA app (npm run qa -- up, with its stand-in providers) with Clerk set up (VITE_CLERK_PUBLISHABLE_KEY in
// .env.local), TMDB_API_KEY in .env.test.local (onboarding checks it with TMDB; never printed), and two Clerk test users
// with no profiles yet: npx clerk users create --email <name>+clerk_test@example.com
// Usage: node scripts/e2e-accounts.ts <a>+clerk_test@example.com <b>+clerk_test@example.com
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import type { Page } from "playwright-core";
import { launchBrowser } from "./lib/browser.ts";
import { assertLocal, checks, qaSession } from "./lib/qa.ts";

const [emailA, emailB] = process.argv.slice(2);
if (!emailA?.endsWith("+clerk_test@example.com") || !emailB?.endsWith("+clerk_test@example.com"))
  throw new Error("Usage: node scripts/e2e-accounts.ts <a>+clerk_test@example.com <b>+clerk_test@example.com (Clerk test users only)");
const s = qaSession();
assertLocal(s.url);
const tmdbKey = existsSync(".env.test.local") ? parseEnv(readFileSync(".env.test.local", "utf8")).TMDB_API_KEY : undefined;
if (!tmdbKey) throw new Error("No TMDB_API_KEY in .env.test.local: onboarding needs a key TMDB accepts");
const out = ".artifacts/accounts";
mkdirSync(out, { recursive: true });
const browser = await launchBrowser({ headless: true });
const open = async () =>
  (await browser.newContext({ viewport: { width: 1280, height: 860 }, permissions: ["clipboard-read", "clipboard-write"] })).newPage();
const a = await open();
const b = await open();
const { check, finish, watch } = checks(a);
watch(b, "B");
let shots = 0;
const shot = async (page: Page, name: string) => {
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${out}/${String(++shots).padStart(2, "0")}-${name}.png` });
};

/** Clerk's sign-in, by a code sent to the email: test users get 424242. */
async function clerkSignIn(page: Page, email: string) {
  // Signed out, / is the landing page; sign-in has its own address.
  await page.goto(`${s.url}/sign-in`, { waitUntil: "domcontentloaded", timeout: 120_000 });
  const field = page.getByLabel("Email address");
  await field.waitFor({ timeout: 60_000 });
  await field.fill(email);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByText(/check your email/i).waitFor({ timeout: 30_000 });
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

/** An account's first profile: Continue goes straight on to setting the account up. */
async function firstProfile(page: Page, name: string) {
  await page.getByRole("heading", { name: "Make your profile" }).waitFor({ timeout: 60_000 });
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
}

const key = async (page: Page, label: string, value: string) => {
  await page.getByLabel(label, { exact: true }).fill(value);
  await page.getByLabel(label, { exact: true }).locator("xpath=ancestor::form").getByRole("button", { name: "Check key" }).click();
};

/** Onboarding with the account's keys (TorBox is the QA app's stand-in, which takes any key); no addons, no extras. */
async function onboard(page: Page) {
  await page.getByRole("heading", { name: "Connect TMDB" }).waitFor({ timeout: 60_000 });
  await key(page, "TMDB API key", tmdbKey!);
  await page.getByRole("heading", { name: "Pick your debrid service" }).waitFor({ timeout: 30_000 });
  await key(page, "TorBox API key", "stand-in-torbox-key");
  await skipToHome(page);
}

/** The steps a profile still has (its addons; the account's extras), skipped. */
async function skipToHome(page: Page) {
  await page.getByRole("heading", { name: "Add where streams come from" }).waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: "Skip for now" }).click();
  const extras = page.getByRole("heading", { name: "A few extras" });
  await extras.or(picked(page)).first().waitFor({ timeout: 30_000 });
  if (await extras.isVisible()) await page.getByRole("button", { name: "Go to Home" }).click();
  await picked(page).waitFor({ timeout: 60_000 });
}

async function addProfile(page: Page, name: string, pin?: string) {
  const heading = page.getByRole("heading", { name: /Make your profile|Add a profile/ });
  if (!(await heading.isVisible())) await page.getByRole("button", { name: "Add profile", exact: true }).click();
  await heading.waitFor();
  await page.getByLabel("Name", { exact: true }).fill(name);
  if (pin) {
    await page.getByRole("switch", { name: "Lock with a 4-digit PIN" }).click();
    await page.getByLabel("PIN", { exact: true }).fill(pin);
  }
  await page.getByRole("button", { name: "Add profile", exact: true }).click();
  await page.getByRole("heading", { name: "Who’s watching?" }).waitFor();
}

const picked = (page: Page) => page.getByRole("button", { name: /, profile menu$/ });
const who = async (page: Page) => (await picked(page).getAttribute("aria-label"))?.replace(/, profile menu$/, "");

async function choose(page: Page, name: string, pin?: string) {
  await page.getByRole("button", { name: pin ? `${name}, locked with a PIN` : name, exact: true }).click();
  if (pin) {
    await page.getByLabel("PIN", { exact: true }).waitFor();
    await shot(page, `pin-${name.toLowerCase()}`);
    await page.getByLabel("PIN", { exact: true }).fill(pin);
  }
  // A new profile of a set-up account still has its own addons step.
  const addons = page.getByRole("heading", { name: "Add where streams come from" });
  await addons.or(picked(page)).first().waitFor({ timeout: 60_000 });
  if (await addons.isVisible()) await skipToHome(page);
}

async function switchProfile(page: Page) {
  await picked(page).click();
  await page.getByRole("menuitem", { name: "Switch profile" }).click();
  await page.getByRole("heading", { name: "Who’s watching?" }).waitFor();
}

const chatBox = (page: Page) => page.getByRole("textbox", { name: "Message", exact: true }).first();

/** The Party panel, from the dock or the player's controls (shown by moving the pointer). */
async function openPanel(page: Page, ready = chatBox(page)) {
  if (await ready.isVisible()) return;
  await page.mouse.move(600, 400);
  await page.mouse.move(640, 420);
  await page.getByRole("button", { name: /^(Party|Watch together|Watch with)/ }).first().click();
  await ready.waitFor({ timeout: 30_000 });
}

try {
  // A: first sign-in makes the account; the first profile sets it up, then one with a PIN.
  await clerkSignIn(a, emailA);
  await a.getByRole("heading", { name: "Make your profile" }).waitFor({ timeout: 60_000 });
  await shot(a, "a-first-profile");
  await firstProfile(a, "Ada");
  await onboard(a);
  check("Ada opens on Home once the account is set up", (await who(a)) === "Ada", await who(a));
  await switchProfile(a);
  await addProfile(a, "Kid", "1234");
  await shot(a, "a-picker");
  check("A's picker lists Ada and Kid", (await a.getByRole("button", { name: /^(Ada|Kid, locked with a PIN)$/ }).count()) === 2);

  await choose(a, "Ada");
  check("choosing Ada opens Krida as Ada", (await who(a)) === "Ada", await who(a));
  await shot(a, "a-home-ada");
  await switchProfile(a);
  await a.getByRole("button", { name: "Kid, locked with a PIN" }).click();
  await a.getByLabel("PIN", { exact: true }).fill("9999");
  await a.getByText("Wrong PIN. Try again.").waitFor();
  check("a wrong PIN is refused", true);
  await shot(a, "a-wrong-pin");
  await a.getByRole("button", { name: "Switch profile" }).click();
  await choose(a, "Kid", "1234");
  check("Kid opens with its PIN", (await who(a)) === "Kid", await who(a));
  await switchProfile(a);
  await choose(a, "Ada");

  // B: another account sees none of A's.
  await clerkSignIn(b, emailB);
  await b.getByRole("heading", { name: "Make your profile" }).waitFor({ timeout: 60_000 });
  // Both accounts get TorBox in onboarding (the stand-in accepts any key): A to host, B so the party can go to B.
  await firstProfile(b, "Ben");
  await onboard(b);
  await switchProfile(b);
  await shot(b, "b-picker");
  const bNames = await b.getByRole("main").getByRole("listitem").getByRole("button").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? e.textContent));
  check("B's picker lists only Ben", bNames.join("|") === "Ben|Add profile", bNames.join("|"));
  await choose(b, "Ben");

  // A starts a party and copies its link.
  await a.goto(`${s.url}/`, { waitUntil: "domcontentloaded" });
  await openPanel(a, a.getByRole("button", { name: "Start without inviting anyone" }));
  await a.getByRole("button", { name: "Start without inviting anyone" }).click();
  await a.getByRole("button", { name: /^Copy invite link/ }).click();
  await a.getByRole("button", { name: "Link copied" }).waitFor();
  const link = await a.evaluate(() => navigator.clipboard.readText());
  check("the invite link is copied", /\/party#[0-9a-f]{32}$/.test(link), link);
  await shot(a, "a-party-link");

  // B doesn't see A's party anywhere before opening the link.
  await b.goto(`${s.url}/`, { waitUntil: "domcontentloaded" });
  await b.waitForTimeout(3000);
  const bParty = await b.getByRole("button", { name: /is in a party|is watching/ }).count();
  check("B sees no room of A's before the link", bParty === 0);
  await shot(b, "b-home-no-party");

  // B opens the link and joins.
  await b.goto(link, { waitUntil: "domcontentloaded" });
  await b.getByRole("heading", { name: "Join Ada’s party" }).waitFor({ timeout: 30_000 });
  await shot(b, "b-party-link");
  await b.getByRole("button", { name: "Join the party" }).click();
  await openPanel(b);
  await b.getByText("Ada and you are here").or(b.getByText("You and Ada are here")).first().waitFor({ timeout: 30_000 });
  check("B is in A's party", true);

  // A puts a title on; both screens show it.
  await a.goto(`${s.url}/title/movie/tt15239678`, { waitUntil: "domcontentloaded" });
  await a.getByRole("button", { name: "Play now", exact: true }).first().click({ timeout: 60_000 });
  await a.waitForURL(/\/watch\//, { timeout: 60_000 });
  await b.waitForURL(/\/watch\//, { timeout: 60_000 });
  const title = async (page: Page) => (await page.title()).replace(/ — Krida$/, "");
  await a.waitForFunction(() => document.title.startsWith("Dune"), null, { timeout: 60_000 });
  await b.waitForFunction(() => document.title.startsWith("Dune"), null, { timeout: 60_000 });
  check("both see the same title", (await title(a)) === (await title(b)), `${await title(a)} / ${await title(b)}`);

  // Chat, both ways.
  await openPanel(a);
  await chatBox(a).fill("Ready when you are");
  await chatBox(a).press("Enter");
  await openPanel(b);
  await b.getByText("Ready when you are").waitFor({ timeout: 30_000 });
  await chatBox(b).fill("Go");
  await chatBox(b).press("Enter");
  await a.getByText("Go", { exact: true }).waitFor({ timeout: 30_000 });
  check("chat reaches both", true);
  await shot(a, "a-party-watching");
  await shot(b, "b-party-watching");

  // A leaves: Ada's account has nobody else here, so the party goes to Ben (his account has TorBox).
  await a.getByRole("button", { name: "More party options" }).first().click();
  await a.getByRole("menuitem", { name: "Leave party" }).click();
  await b.getByText(/is the host now/).waitFor({ timeout: 30_000 });
  check("hosting moves to B when A leaves", true);
  await shot(b, "b-hosting-now");

  // Managing A's profiles: renaming one with a PIN asks for it; deleting one takes it off the picker.
  await a.goto(`${s.url}/`, { waitUntil: "domcontentloaded" });
  await switchProfile(a);
  await addProfile(a, "Guest room");
  await a.getByRole("button", { name: "Manage profiles" }).click();
  await a.getByRole("button", { name: "Edit Kid" }).click();
  await a.getByLabel("PIN", { exact: true }).fill("1234");
  await a.getByRole("heading", { name: "Edit profile" }).waitFor();
  await a.getByLabel("Name", { exact: true }).fill("Kiddo");
  await a.getByRole("button", { name: "Save", exact: true }).click();
  await a.getByRole("button", { name: "Edit Guest room" }).click();
  await a.getByRole("button", { name: "Delete profile" }).click();
  await shot(a, "a-delete-profile");
  await a.getByRole("button", { name: "Delete Guest room" }).click();
  await a.getByRole("button", { name: "Done" }).click();
  const left = await a.getByRole("main").getByRole("listitem").getByRole("button").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? e.textContent));
  check("renamed and deleted profiles show on the picker", left.join("|") === "Ada|Kiddo, locked with a PIN|Add profile", left.join("|"));
  await shot(a, "a-picker-after-manage");
} catch (error) {
  check("the flow ran to the end", false, (error as Error).message.split("\n")[0]);
  await shot(a, "a-failed");
  await shot(b, "b-failed");
} finally {
  await browser.close();
  finish();
}
