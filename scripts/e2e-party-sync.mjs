// Two people watching one title together on the QA app: they start in step, a pause and a seek reach the other with
// a note naming who did it, and playing again resumes both. Then a switch A turns down tells B who said no, and Back to
// picking asks A first while B watches. Plays the stand-in providers' test video.
// Needs the QA app: npm run qa -- up (local backend, Regress-QA-one and Regress-QA-two).
// Usage: node scripts/e2e-party-sync.mjs [base]
import { mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { launchBrowser } from "./lib/browser.ts";
import { baseUrl, checks, qaProfiles, signIn } from "./lib/qa.ts";

const base = baseUrl(process.argv[2]);
const [pa, pb] = qaProfiles([undefined, undefined]);
const { movies } = JSON.parse(readFileSync(new URL("./regress/titles.json", import.meta.url), "utf8"));
const film = movies[36];
const out = ".artifacts/party-sync";
// Beyond this the player itself seeks to catch up (src/features/player/playbackSync.ts).
const DRIFT_S = 2.5;
await mkdir(out, { recursive: true });

const browser = await launchBrowser();
const open = async () => (await browser.newContext({ viewport: { width: 1280, height: 760 } })).newPage();
const a = await open();
const b = await open();
const { check, finish, watch } = checks();
watch(a, "A");
watch(b, "B");
const state = (page) => page.evaluate(() => {
  const v = document.querySelector("video");
  return v ? { t: +v.currentTime.toFixed(2), paused: v.paused } : null;
});
const until = (page, fn, arg, timeout = 30_000) => page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);
const playing = (page) => until(page, () => { const v = document.querySelector("video"); return !!v && v.readyState >= 3 && !v.paused; }, null, 90_000);

// Start clean: a party from an earlier run would still be open.
const leaveAnyParty = async (page) => {
  const mine = page.getByRole("button", { name: /^Party,/ }).first();
  if (!(await mine.waitFor({ timeout: 4000 }).then(() => true, () => false))) return;
  await mine.click();
  await page.getByRole("button", { name: "More party options" }).click();
  await page.getByRole("menuitem", { name: "Leave party" }).click();
  await mine.waitFor({ state: "hidden", timeout: 15_000 });
};

try {
  await signIn(a, base, pa);
  await signIn(b, base, pb);
  await leaveAnyParty(a);
  await leaveAnyParty(b);

  // A starts a party and invites B, who joins from the invite.
  await a.getByRole("button", { name: `Watch with ${pb.name}` }).click();
  await a.locator("#party-panel").getByRole("button", { name: `Invite ${pb.name}` }).click();
  await b.getByText("invited you to a party").waitFor({ timeout: 30_000 });
  await b.getByRole("region", { name: /Notifications/ }).getByRole("button", { name: "Join", exact: true }).click();
  await a.getByText(`You and ${pb.name} are here`).waitFor({ timeout: 30_000 });

  // A plays a film for both from its page; everyone goes to the player.
  await a.goto(`${base}/title/movie/${film.id}`, { waitUntil: "domcontentloaded" });
  await a.getByRole("heading", { level: 1 }).first().waitFor();
  // Picking with someone, Suggest leads and Play is the second action ("Play now").
  await a.getByRole("button", { name: /^Play( now| in party)$/ }).first().click();
  const started = (await playing(a)) && (await playing(b));
  check("both start playing", started);
  await a.waitForTimeout(4000);
  let sa = await state(a), sb = await state(b);
  check("both play in step", !!sa && !!sb && Math.abs(sa.t - sb.t) < DRIFT_S, JSON.stringify({ A: sa, B: sb }));
  await a.screenshot({ path: `${out}/playing-a.png` });

  // A pauses: B pauses too, and is told who did it.
  await a.mouse.move(640, 380);
  await a.getByRole("button", { name: /^Pause/ }).click();
  check("B pauses when A does", await until(b, () => document.querySelector("video")?.paused === true));
  check("B is told A paused", await b.getByText("paused").first().waitFor({ timeout: 10_000 }).then(() => true, () => false));
  await b.screenshot({ path: `${out}/paused-b.png` });

  // A seeks to 0:40 through the Seek bar: B lands there too, and is told.
  const bar = await a.getByRole("slider", { name: "Seek" }).boundingBox();
  const duration = await a.evaluate(() => document.querySelector("video").duration);
  await a.mouse.click(bar.x + (bar.width * 40) / duration, bar.y + bar.height / 2);
  check("B follows A's seek to 0:40", await until(b, () => Math.abs((document.querySelector("video")?.currentTime ?? 0) - 40) < 1.5));
  check("B is told A skipped ahead", await b.getByText(/skipped to 0:4\d/).first().waitFor({ timeout: 10_000 }).then(() => true, () => false));

  // B plays again: both run, in step.
  await b.mouse.move(640, 380);
  await b.getByRole("button", { name: /^Play \(/ }).click();
  check("A resumes when B plays", await playing(a));
  await a.waitForTimeout(3000);
  sa = await state(a);
  sb = await state(b);
  check("still in step after resuming", !!sa && !!sb && !sa.paused && !sb.paused && Math.abs(sa.t - sb.t) < DRIFT_S, JSON.stringify({ A: sa, B: sb }));

  // B's connection crawls: every segment takes 7 seconds. A seeks somewhere B hasn't loaded, so B stalls there. The
  // party holds for B, A's picture stops with it, and both carry on together once B has loaded.
  const STALL_MS = 7000;
  // Reloaded, B has only what's ahead of where the party is.
  await b.reload({ waitUntil: "domcontentloaded" });
  check("B plays again after a reload", await playing(b));
  await b.route(/seg\d+\.ts/, async (route) => {
    await new Promise((r) => setTimeout(r, STALL_MS));
    await route.continue().catch(() => {});
  });
  const loaded = await b.evaluate(() => { const v = document.querySelector("video"); return [...Array(v.buffered.length).keys()].map((i) => [v.buffered.start(i), v.buffered.end(i)]); });
  // Past the intro (seeking into it is fine, but a skip would muddle the check) and short of the end.
  const target = [14, 20, 26, 32, 38, 44].find((t) => !loaded.some(([s, e]) => t >= s - 1 && t <= e + 1));
  check("there's a spot B hasn't loaded", target !== undefined, JSON.stringify(loaded));
  await a.mouse.move(640, 380);
  const seekBar = await a.getByRole("slider", { name: "Seek" }).boundingBox();
  await a.mouse.click(seekBar.x + (seekBar.width * target) / duration, seekBar.y + seekBar.height / 2);
  await a.mouse.move(640, 200);
  const waitingPill = a.getByText(`Waiting for ${pb.name} to catch up`);
  check("A is told the party is waiting for B", await waitingPill.waitFor({ timeout: 10_000 }).then(() => true, () => false));
  await a.waitForTimeout(1000);
  const held = await state(a);
  await a.screenshot({ path: `${out}/waiting-a.png` });
  check("A's picture stops while the party waits for B", !!held && held.paused, JSON.stringify(held));
  check("A and B both play again once B has loaded", (await playing(a)) && (await playing(b)));
  await a.waitForTimeout(2000);
  sa = await state(a);
  sb = await state(b);
  check("in step after the hold, without B jumping ahead", !!sa && !!sb && Math.abs(sa.t - sb.t) < DRIFT_S && sb.t < target + 6, JSON.stringify({ target, A: sa, B: sb }));
  await b.unroute(/seg\d+\.ts/);

  // B asks to switch to another film; A keeps watching, and B is told who said no, under the film B asked for.
  const other = movies.find((m) => m.id !== film.id);
  await b.goto(`${base}/title/movie/${other.id}`, { waitUntil: "domcontentloaded" });
  await b.getByRole("button", { name: /^Play( now| in party)$/ }).first().click();
  await a.getByRole("button", { name: "Keep watching" }).click({ timeout: 20_000 });
  check("B is told A said no to the switch", await b.getByText(`${pa.name} said no to switching to`).waitFor({ timeout: 10_000 }).then(() => true, () => false));
  await b.screenshot({ path: `${out}/switch-declined-b.png` });
  await b.getByRole("button", { name: "Keep watching" }).click();

  // Back to picking with B watching asks A first; Keep watching leaves both playing.
  await a.mouse.move(640, 380);
  await a.getByRole("button", { name: /^Party/ }).first().click();
  await a.getByRole("button", { name: "More party options" }).click();
  await a.getByRole("menuitem", { name: "Back to picking" }).click();
  const ask = a.getByRole("dialog", { name: "Stop for everyone?" });
  check("Back to picking asks first while B watches", await ask.waitFor({ timeout: 5000 }).then(() => true, () => false));
  await a.waitForTimeout(400);
  await a.screenshot({ path: `${out}/back-to-picking-a.png` });
  await ask.getByRole("button", { name: "Keep watching" }).click();
  await a.waitForTimeout(1500);
  check("Keep watching leaves the film on", (await state(b))?.paused === false && new URL(b.url()).pathname.startsWith("/watch/"));
  await a.getByRole("button", { name: "More party options" }).click();
  await a.getByRole("menuitem", { name: "Back to picking" }).click();
  await ask.getByRole("button", { name: "Back to picking" }).click();
  check("Back to picking takes B out of the player", await b.waitForURL((url) => url.pathname === "/", { timeout: 15_000 }).then(() => true, () => false));
} finally {
  finish();
  await browser.close();
}
