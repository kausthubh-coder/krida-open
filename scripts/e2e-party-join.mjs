// Getting into a party on the QA app, two people. A's "Watch with B" only opens the panel: B hears nothing and no party
// starts until A presses Invite, and then B is invited. Then B watches a film alone, and A's
// party button asks to join instead of dropping in: B turns the first knock down, lets the second in, and A lands in
// B's film, playing in step.
// Needs the QA app: npm run qa -- up (local backend, Regress-QA-one and Regress-QA-two).
// Usage: node scripts/e2e-party-join.mjs [base]
import { mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { launchBrowser } from "./lib/browser.ts";
import { baseUrl, checks, qaProfiles, signIn } from "./lib/qa.ts";

const base = baseUrl(process.argv[2]);
const [pa, pb] = qaProfiles([undefined, undefined]);
const { movies } = JSON.parse(readFileSync(new URL("./regress/titles.json", import.meta.url), "utf8"));
const film = movies[36];
const out = ".artifacts/party-join";
await mkdir(out, { recursive: true });

const browser = await launchBrowser();
const open = async () => (await browser.newContext({ viewport: { width: 1280, height: 760 } })).newPage();
const a = await open();
const b = await open();
const { check, finish, watch } = checks();
watch(a, "A");
watch(b, "B");
const seen = (locator, timeout = 10_000) => locator.waitFor({ timeout }).then(() => true, () => false);
const playing = (page) =>
  page.waitForFunction(() => { const v = document.querySelector("video"); return !!v && v.readyState >= 3 && !v.paused; }, null, { timeout: 90_000 })
    .then(() => true, () => false);
const time = (page) => page.evaluate(() => document.querySelector("video")?.currentTime ?? -1);
const leaveAnyParty = async (page) => {
  const mine = page.getByRole("button", { name: /^Party,/ }).first();
  if (!(await seen(mine, 4000))) return;
  // Starting a party opens the panel already; pressing the button then would close it.
  const panel = page.locator("#party-panel");
  if (!(await panel.isVisible())) await mine.click();
  await panel.getByRole("button", { name: "More party options" }).click();
  await page.getByRole("menuitem", { name: "Leave party" }).click();
  await mine.waitFor({ state: "hidden", timeout: 15_000 });
};

try {
  await signIn(a, base, pa);
  await signIn(b, base, pb);
  await leaveAnyParty(a);
  await leaveAnyParty(b);

  // "Watch with B" opens the panel and starts nothing: B never hears of it.
  await a.getByRole("button", { name: `Watch with ${pb.name}` }).click();
  const invite = a.locator("#party-panel").getByRole("button", { name: `Invite ${pb.name}` });
  check("A is offered the invite", await seen(invite));
  await a.screenshot({ path: `${out}/offer-a.png` });
  await b.waitForTimeout(3000);
  check("opening the panel doesn't invite B", !(await b.getByText("invited you to a party").isVisible()));

  // Pressing Invite does.
  await invite.click();
  const invited = await seen(b.getByText("invited you to a party"), 8000);
  check("Invite invites B", invited);
  if (!invited) {
    await a.screenshot({ path: `${out}/not-invited-a.png` });
    await b.screenshot({ path: `${out}/not-invited-b.png` });
  }
  await b.getByRole("region", { name: /Notifications/ }).getByRole("button", { name: "Not now", exact: true }).click();
  await leaveAnyParty(a);

  // B watches a film alone.
  await b.goto(`${base}/title/movie/${film.id}`, { waitUntil: "domcontentloaded" });
  await b.getByRole("button", { name: "Play", exact: true }).first().click();
  check("B plays alone", await playing(b));

  // A's party button asks rather than joins. B says not now.
  await a.goto(base, { waitUntil: "domcontentloaded" });
  const ask = a.getByRole("button", { name: new RegExp(`^${pb.name} is watching .*\\. Ask to join$`) });
  check("A's party button offers to ask B", await seen(ask, 30_000));
  await ask.click();
  check("A is told it's asking", await seen(a.getByText(`Asking ${pb.name} to let you in`)));
  check("B is asked, over the film", await seen(b.getByText("wants to join you")));
  await b.waitForTimeout(800);
  await b.screenshot({ path: `${out}/knock-b.png` });
  check("A hasn't joined before B answers", !new URL(a.url()).pathname.startsWith("/watch/"));
  await b.getByRole("region", { name: /Notifications/ }).getByRole("button", { name: "Not now", exact: true }).click();
  check("A hears B said not now", await seen(a.getByText(`${pb.name} said not now`)));

  // Again: B lets A in, and A lands in B's film, in step.
  await ask.click();
  await b.getByRole("region", { name: /Notifications/ }).getByRole("button", { name: "Let in", exact: true }).click({ timeout: 10_000 });
  check("A joins B's film once let in", await a.waitForURL(/\/watch\//, { timeout: 15_000 }).then(() => true, () => false));
  check("A plays", await playing(a));
  await a.waitForTimeout(3000);
  const [ta, tb] = [await time(a), await time(b)];
  check("A and B in step", Math.abs(ta - tb) < 2.5, JSON.stringify({ A: ta, B: tb }));
  await b.screenshot({ path: `${out}/joined-b.png` });
} finally {
  // Leave from Home: the next script needs both profiles out of every party.
  for (const page of [a, b]) {
    await page.goto(base, { waitUntil: "domcontentloaded" }).catch(() => {});
    await leaveAnyParty(page).catch(() => {});
  }
  finish();
  await browser.close();
}
