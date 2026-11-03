// A whole watch party in two browsers (Chrome and Edge): start empty, invite, pick together, queue, switch mid-movie,
// skip an intro, browse away and come back, auto-advance, and go back to picking, staying in sync throughout.
// Needs two *-QA-* profiles on the dev backend (real TorBox streams).
// Usage: KRIDA_QA_PASSWORD=… node scripts/e2e-party-flow.mjs [base] [profileA] [profileB] [outDir]
import { mkdir } from "node:fs/promises";
import { launchBrowser } from "./lib/browser.ts";
import { baseUrl, checks, qaProfiles, signIn } from "./lib/qa.ts";

const [baseArg, nameA, nameB, outDir = ".artifacts/party-flow"] = process.argv.slice(2);
const base = baseUrl(baseArg);
const [pa, pb] = qaProfiles([nameA, nameB]);
// Beyond this the player itself seeks to catch up (src/features/player/playbackSync.ts), so the two are out of sync.
const DRIFT_S = 2.5;
await mkdir(outDir, { recursive: true });
const A = await launchBrowser();
const B = await launchBrowser({}, "msedge");
const mk = async (br, label) => {
  const page = await (await br.newContext({ viewport: { width: 1280, height: 760 } })).newPage();
  page.on("console", (m) => m.type() === "error" && console.log(label, "console:", m.text().slice(0, 200)));
  return page;
};
const a = await mk(A, "A");
const b = await mk(B, "B");
const { check, finish, watch } = checks();
watch(a, "A");
watch(b, "B");
const t0 = Date.now();
const log = (...args) => console.log(((Date.now() - t0) / 1000).toFixed(1) + "s", ...args);
const shot = (page, name) => page.screenshot({ path: `${outDir}/flow-${name}.png` });
const state = (page) =>
  page.evaluate(() => {
    const v = document.querySelector("video");
    return v && { t: +v.currentTime.toFixed(1), paused: v.paused, d: Math.round(v.duration || 0) };
  });
const playing = (page) =>
  page.waitForFunction(() => {
    const v = document.querySelector("video");
    return v && v.readyState >= 3 && !v.paused;
  }, null, { timeout: 120000 });
const wake = async (page) => {
  await page.mouse.move(600, 300);
  await page.mouse.move(640, 360);
  await page.waitForTimeout(150);
};
const drift = (sa, sb) => Math.abs(sa.t - sb.t);
const login = async (page, profile) => {
  await signIn(page, base, profile);
  // Start clean: a party from an earlier run would otherwise still be open.
  const leave = page.getByRole("button", { name: "Leave party" });
  if (await leave.waitFor({ timeout: 4000 }).then(() => true, () => false)) {
    await leave.click();
    await page.getByRole("region", { name: "Your watch party" }).waitFor({ state: "detached" });
  }
};

await login(a, pa);
await login(b, pb);

// 1. Start an empty party from the nav and invite B
await a.getByRole("button", { name: "Watch party" }).click();
await a.getByRole("button", { name: `Start and invite ${pb.name}` }).click();
await a.waitForURL(/\/watch\//);
await a.getByText("What are we watching?").waitFor();
log("A in the lobby");
await b.getByText("invited you to a party").waitFor({ timeout: 20000 });
await shot(b, "invite");
await b.getByRole("region", { name: /Notifications/ }).getByRole("button", { name: "Join", exact: true }).click();
await b.getByText("What are we watching?").waitFor();
log("B in the lobby");
await a.waitForTimeout(1500);
await shot(a, "lobby");

// 2. A lines up an episode from the lobby search
await a.getByRole("textbox", { name: "Search movies and shows" }).fill("breaking bad");
await a.getByRole("button", { name: /^Show Breaking Bad/ }).first().click().catch(async () => {
  await a.getByText("Breaking Bad", { exact: true }).first().click();
});
await a.getByRole("tab", { name: "Season 1" }).waitFor();
await a.getByRole("button", { name: "Add to Up next" }).nth(3).click(); // S1 E3 row
await a.waitForTimeout(800);
await shot(a, "title-sheet");
await a.keyboard.press("Escape");
await b.getByText(/added Breaking Bad S1 E3 to Up next/).first().waitFor({ timeout: 10000 });
log("B saw A's Up next addition");

// 3. B picks a movie for everyone
await b.getByRole("textbox", { name: "Search movies and shows" }).fill("dune part two");
await b.getByText("Dune: Part Two", { exact: true }).first().click();
await b.getByRole("button", { name: /^(Watch this|Resume)$/ }).click();
await a.getByText(`picked by ${pb.name}`).waitFor({ timeout: 20000 });
await shot(a, "preparing");
await Promise.all([playing(a), playing(b)]);
await a.waitForTimeout(5000);
let sa = await state(a), sb = await state(b);
check("Dune plays in sync for both", drift(sa, sb) < DRIFT_S, `drift ${drift(sa, sb).toFixed(2)} s, ${JSON.stringify({ A: sa, B: sb })}`);

// 4. A switches mid-movie to the queued episode from the Up next panel
await wake(a);
await a.getByRole("button", { name: /^Party:/ }).click();
await a.getByRole("button", { name: /Play Breaking Bad now/ }).click();
await Promise.all([
  a.waitForFunction(() => document.title.includes("S1 E3")),
  b.waitForFunction(() => document.title.includes("S1 E3")),
]);
await Promise.all([playing(a), playing(b)]);
log("switched to Breaking Bad S1 E3 for both");

// 5. Skip intro (IntroDB says 183–199s): jump just before it and press the button
await wake(a);
const bar = await a.getByRole("slider", { name: "Seek" }).boundingBox();
const dur = (await state(a)).d;
await a.mouse.click(bar.x + (bar.width * 184) / dur, bar.y + bar.height / 2);
await a.getByRole("button", { name: "Skip intro" }).waitFor({ timeout: 20000 });
await shot(a, "skip-intro");
await a.getByRole("button", { name: "Skip intro" }).click();
await b.waitForTimeout(3000);
sa = await state(a);
sb = await state(b);
check("Skip intro takes both past the intro (3:19)", sa.t >= 199 && sb.t >= 199, JSON.stringify({ A: sa.t, B: sb.t }));

// 6. A steps out to browse; the party bar follows, B keeps watching
await wake(a);
await a.getByRole("button", { name: "Back" }).first().click();
await a.getByRole("region", { name: "Your watch party" }).waitFor();
await a.goto(base + "/title/movie/tt0816692");
await a.getByText(`You’re in a party with ${pb.name}`).waitFor();
await a.waitForTimeout(1200);
await shot(a, "title-in-party");
await wake(b);
await b.getByRole("button", { name: /^Party:/ }).click();
await b.getByText(/is browsing/).waitFor({ timeout: 25000 });
log("B sees A browsing");
await b.keyboard.press("Escape");
// A queues Interstellar from its title page, then returns
await a.getByRole("button", { name: "Add to Up next" }).click();
await a.getByRole("region", { name: "Your watch party" }).getByRole("button", { name: "Open" }).click();
await playing(a);
await a.waitForTimeout(4000);
sa = await state(a);
sb = await state(b);
check("A back in the party, in sync", drift(sa, sb) < DRIFT_S, `drift ${drift(sa, sb).toFixed(2)} s, ${JSON.stringify({ A: sa.t, B: sb.t })}`);

// 7. Auto-advance: jump to the end, let the countdown run, land on the queued movie
await wake(b);
const bar2 = await b.getByRole("slider", { name: "Seek" }).boundingBox();
await b.mouse.click(bar2.x + bar2.width * 0.9995, bar2.y + bar2.height / 2);
await b.getByText(/Up next in/).waitFor({ timeout: 30000 });
await shot(b, "countdown");
log("countdown showing");
await Promise.all([
  a.waitForFunction(() => document.title.startsWith("Interstellar"), null, { timeout: 40000 }),
  b.waitForFunction(() => document.title.startsWith("Interstellar"), null, { timeout: 40000 }),
]);
await Promise.all([playing(a), playing(b)]);
log("auto-advanced to Interstellar for both");

// 8. Back to picking
await wake(a);
await a.getByRole("button", { name: /^Party:/ }).click();
await a.getByRole("button", { name: "Pick something else" }).click();
await Promise.all([a.getByText("What are we watching?").waitFor(), b.getByText("What are we watching?").waitFor()]);
log("both back in the lobby");
await b.waitForTimeout(800);
await shot(b, "lobby-after");
await A.close();
await B.close();
finish();
