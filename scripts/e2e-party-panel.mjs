// A watch party picked from the app with the Party panel, desktop and phone: start, invite, suggest from a title page
// and from a poster, chat, both in, the countdown, everyone into the player, stepping out, and back to picking.
// Needs two QA profiles: the QA app (npm run qa -- up) or two *-QA-* profiles on the dev backend.
// Usage: node scripts/e2e-party-panel.mjs [base] [profileA] [profileB]
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { launchBrowser } from "./lib/browser.ts";
import { baseUrl, qaProfiles, signIn } from "./lib/qa.ts";

const [baseArg, argA, argB] = process.argv.slice(2);
const base = baseUrl(baseArg);
const [pa, pb] = qaProfiles([argA, argB]);
const nameB = pb.name;
const out = ".artifacts/party-panel";
await mkdir(out, { recursive: true });

const browser = await launchBrowser({ headless: true });
const errors = [];
const open = async (label, viewport) => {
  const page = await (await browser.newContext({ viewport })).newPage();
  page.on("pageerror", (e) => errors.push(`${label}: ${e.message}`));
  return page;
};
const a = await open("A", { width: 1440, height: 900 });
const b = await open("B", { width: 390, height: 844 });
const panel = (page) => page.locator("#party-panel");
const shot = async (page, name) => {
  await page.waitForFunction(() => {
    const dock = document.querySelector("#party-panel");
    return !dock || getComputedStyle(dock).opacity === "1";
  });
  await page.screenshot({ path: `${out}/${name}.png` });
};
let checks = 0;
const passed = (name) => {
  checks++;
  console.log("PASS", name);
};
try {
  await signIn(a, base, pa);
  await signIn(b, base, pb);

  // Start an empty party from the header pill, inviting only B.
  await a.getByRole("button", { name: /^Watch (together|with)/ }).click();
  await panel(a).getByRole("button", { name: `Invite ${nameB}` }).click();
  await panel(a).getByRole("textbox", { name: "Message" }).waitFor();
  assert.equal(new URL(a.url()).pathname, "/");
  assert.equal(await a.evaluate(() => getComputedStyle(document.querySelector("header + div")).paddingRight), "0px");
  passed("inviting someone starts the party on the page, with the panel floating over it");

  // B joins from the invite and picks from where they are.
  await b.getByText("invited you to a party").waitFor({ timeout: 20000 });
  await b.getByRole("region", { name: /Notifications/ }).getByRole("button", { name: "Join", exact: true }).click();
  await panel(b).waitFor();
  assert.equal(new URL(b.url()).pathname, "/");
  await panel(a).getByText(`You and ${nameB} are here`).waitFor({ timeout: 20000 });
  passed("joining a picking party opens the panel instead of a lobby page");

  // A suggests from a title page; Suggest leads because B is here.
  await a.goto(`${base}/title/movie/tt15239678`);
  await a.getByRole("button", { name: "Suggest", exact: true }).click();
  await panel(a).getByText(`You’re in · waiting for ${nameB}`).waitFor();
  await a.getByRole("button", { name: "Suggested", exact: true }).waitFor();
  passed("Suggest on a title page puts it on the table");

  // B suggests a show from a poster on their phone.
  await panel(b).getByRole("button", { name: "Close", exact: true }).click();
  await panel(b).waitFor({ state: "hidden" });
  await b.goto(`${base}/search?q=severance`);
  const severance = b.locator('div.group\\/card').filter({ has: b.locator('a[href="/title/series/tt11280740"]') }).first();
  await severance.getByRole("button", { name: "Suggest to the party" }).click();
  await severance.getByRole("button", { name: "On the table" }).waitFor();
  await panel(a).getByRole("link", { name: "Open Severance", exact: true }).waitFor();
  assert.match(await panel(a).innerText(), /S1 E1/);
  await panel(a).getByText(/suggested · waiting for you/).waitFor({ timeout: 15000 });
  passed("Suggest on a poster puts a show on the table at the episode to play next");
  await shot(a, "a-desktop-picking");

  // B is in for Dune: both in starts the countdown, then everyone goes to the player.
  if (!(await panel(b).isVisible())) await b.getByRole("button", { name: "Party", exact: true }).click();
  await shot(b, "b-phone-picking");
  await panel(b).getByRole("link", { name: "Open Severance", exact: true }).click();
  await b.waitForURL(/\/title\/series\/tt11280740$/);
  await panel(b).waitFor({ state: "hidden" });
  await b.getByRole("button", { name: "Party", exact: true }).click();
  passed("opening a title from the phone panel closes the sheet and reveals the title");
  await panel(b).getByRole("textbox", { name: "Message" }).fill("Ready when you are");
  await panel(b).getByRole("button", { name: "Send", exact: true }).click();
  await panel(a).getByText("Ready when you are", { exact: true }).waitFor();
  passed("chat sent from the phone reaches the desktop panel");
  await panel(b).getByRole("button", { name: "I’m in" }).first().click();
  await panel(a).getByText(/Starting in \d/).waitFor();
  await shot(a, "a-countdown");
  passed("both in starts the countdown");
  await Promise.all([a.waitForURL(/\/watch\//, { timeout: 15000 }), b.waitForURL(/\/watch\//, { timeout: 15000 })]);
  passed("everyone picking goes to the player together");

  // A steps out: the panel shows what's on and the way back.
  await a.getByRole("button", { name: "Back" }).first().click();
  await a.waitForURL((url) => !url.pathname.startsWith("/watch/"));
  // The panel comes back as it was left once the party loads; toggling before then would close it.
  if (!(await panel(a).waitFor({ timeout: 4000 }).then(() => true, () => false)))
    await a.getByRole("button", { name: /^Party,/ }).click();
  await panel(a).getByRole("button", { name: "Back to the player" }).waitFor();
  await shot(a, "a-stepped-out");
  passed("stepping out of the player keeps the party in the panel");

  // Back to picking from the panel brings B out of the player to Home, panel open.
  await panel(a).getByRole("button", { name: "More party options" }).click();
  await a.getByRole("menuitem", { name: "Back to picking" }).click();
  // B is still watching, so A is asked first.
  await a.getByRole("dialog", { name: "Stop for everyone?" }).getByRole("button", { name: "Back to picking" }).click();
  await b.waitForURL((url) => url.pathname === "/", { timeout: 15000 });
  await panel(b).getByText("On the table").waitFor();
  passed("back to picking returns everyone to the app with the panel open");

  assert.deepEqual(errors, []);
  passed("no page errors");
} finally {
  // Leave the party so the next run starts clean.
  for (const page of [a, b]) {
    if (!(await panel(page).isVisible().catch(() => false))) {
      const toggle = page.locator('button[aria-controls="party-panel"]:visible').first();
      if (await toggle.isVisible().catch(() => false)) await toggle.click().catch(() => {});
    }
    const options = panel(page).getByRole("button", { name: "More party options" });
    if (await options.isVisible().catch(() => false)) {
      await options.click();
      await page.getByRole("menuitem", { name: "Leave party" }).click().catch(() => {});
    }
  }
  await browser.close();
}
console.log(`${checks} checks passed`);
