// Screenshots of the top nav and the Party panel against a realistic party seeded through Convex: a long chat with
// many suggestions, votes, hold-offs, leaving and lining things up. Nav at 390, 820, 1280 and 1920, over the hero and
// scrolled, with and without a party; the panel while browsing and in the player. Needs two QA profiles: the QA app
// (npm run qa -- up) or two *-QA-* profiles on the dev backend.
// Usage: node scripts/shots-nav-party.mjs [base] [profileA] [profileB] [outDir] [nav|party|all]
import { mkdir } from "node:fs/promises";
import { launchBrowser } from "./lib/browser.ts";
import { ConvexHttpClient } from "convex/browser";
import { baseUrl, checks, convexSignIn, convexUrls, qaProfiles } from "./lib/qa.ts";

const [baseArg, nameA, nameB, out = ".artifacts/nav-party", phase = "all"] = process.argv.slice(2);
const base = baseUrl(baseArg);
const [pa, pb] = qaProfiles([nameA, nameB]);
await mkdir(out, { recursive: true });

const client = new ConvexHttpClient(convexUrls().url);
const A = await convexSignIn(client, pa);
const B = await convexSignIn(client, pb);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const as = (who) => ({
  m: (name, args = {}) => client.mutation(name, { token: who.token, ...args }),
  q: (name, args = {}) => client.query(name, { token: who.token, ...args }),
});

// Start clean: nobody is in an old party.
for (const who of [A, B]) {
  const party = await as(who).q("rooms:mine");
  if (party) await as(who).m("rooms:leave", { roomId: party._id });
}

const browser = await launchBrowser({ headless: true });
const { finish, watch } = checks();
const open = async (who, viewport, panel = "closed") => {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  await context.addInitScript(
    ([token, panel]) => {
      localStorage.setItem("krida.session", token);
      sessionStorage.setItem("krida.partyPanel", panel);
    },
    [who.token, panel],
  );
  const page = await context.newPage();
  watch(page, who.name);
  return page;
};
const settle = async (page, ready = 'a[aria-label="Krida home"]') => {
  await page.locator(ready).first().waitFor({ timeout: 30000 });
  // Artwork and live queries land a moment after the shell.
  await page.waitForTimeout(1500);
};
const shot = async (page, name) => {
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log("shot", name);
};
const scrolled = async (page) => {
  await page.evaluate(() => window.scrollTo(0, 700));
  await page.waitForTimeout(400);
};
const sizes = { phone: { width: 390, height: 844 }, tablet: { width: 820, height: 1180 }, laptop: { width: 1280, height: 800 }, wide: { width: 1920, height: 1080 } };

async function navShots(tag) {
  for (const [label, viewport] of Object.entries(sizes)) {
    const page = await open(A, viewport);
    await page.goto(base);
    await settle(page);
    await shot(page, `nav-${tag}-${label}-top`);
    await scrolled(page);
    await shot(page, `nav-${tag}-${label}-scrolled`);
    await page.goto(`${base}/search`);
    await settle(page);
    await shot(page, `nav-${tag}-${label}-search`);
    await page.context().close();
  }
}

const movie = (imdbId, name, year) => ({ type: "movie", imdbId, videoId: imdbId, name, year });
const pastLives = movie("tt13238346", "Past Lives", "2023");
const dune = movie("tt15239678", "Dune: Part Two", "2024");
const drishyam = movie("tt3417422", "Drishyam", "2015");
const bear = { type: "series", imdbId: "tt14452776", videoId: "tt14452776:1:1", season: 1, episode: 1, name: "The Bear", episodeTitle: "System" };

async function seedParty() {
  const a = as(A);
  const b = as(B);
  const roomId = await a.m("rooms:createParty", { inviteIds: [B._id] });
  await sleep(300);
  await b.m("rooms:join", { roomId });
  // Both count as here while picking.
  const beat = () => Promise.all([a.m("rooms:heartbeat", { roomId, watching: true }), b.m("rooms:heartbeat", { roomId, watching: true })]);
  await beat();
  const say = async (who, body) => {
    await as(who).m("messages:send", { roomId, kind: "chat", body });
    await sleep(250);
  };
  const table = async () => (await a.q("rooms:get", { roomId })).suggestions;
  await say(A, "yo");
  await say(B, "what are we watching tonight? something light, I'm wiped");
  await a.m("rooms:suggest", { media: pastLives, roomId });
  await b.m("rooms:suggest", { media: dune, roomId });
  await say(A, "dune is like three hours lol");
  await a.m("rooms:vote", { roomId, suggestionId: (await table()).find((s) => s.media.videoId === dune.videoId).id, in: true });
  await sleep(300);
  await a.m("rooms:cancelStart", { roomId });
  await say(B, "fair. past lives then?");
  await a.m("rooms:leave", { roomId, announce: true });
  await sleep(300);
  await a.m("rooms:join", { roomId });
  await beat();
  await say(A, "sorry, wifi dropped");
  await a.m("rooms:suggest", { media: drishyam, roomId });
  await b.m("messages:send", { roomId, kind: "reaction", body: "💥" });
  await say(B, "ok ok drishyam is a classic but I've seen it four times, you haven't seen past lives right?");
  await say(A, "nope");
  await b.m("rooms:playSuggestion", { roomId, suggestionId: (await table()).find((s) => s.media.videoId === pastLives.videoId).id });
  await sleep(500);
  await say(B, "putting it on");
  await say(A, "the opening scene in the bar 😭");
  await a.m("rooms:setNext", { roomId, media: bear });
  await say(B, "bear after? yes chef");
  const room = await a.q("rooms:get", { roomId });
  if (room.media) {
    await b.m("rooms:setStopAfter", { roomId, on: true, videoId: room.media.videoId });
    await a.m("rooms:setStopAfter", { roomId, on: false, videoId: room.media.videoId });
  }
  await say(A, "ok this is beautiful");
  await say(B, "told you");
  return roomId;
}

try {
  if (phase === "nav" || phase === "all") await navShots("solo");
  if (phase === "party" || phase === "all") {
    const roomId = await seedParty();
    console.log("room", roomId);
    await navShots("party");
    for (const [label, viewport] of Object.entries(sizes)) {
      const page = await open(A, viewport, "open");
      await page.goto(base);
      await settle(page);
      await shot(page, `panel-${label}-top`);
      await scrolled(page);
      await shot(page, `panel-${label}-scrolled`);
      await page.context().close();
    }
    // In the player, with the panel open.
    for (const [label, viewport] of [["laptop", sizes.laptop], ["phone", sizes.phone]]) {
      const page = await open(label === "phone" ? B : A, viewport);
      await page.goto(`${base}/watch/${roomId}`);
      await settle(page, 'button[aria-label^="Party"]');
      await page.mouse.move(viewport.width / 2, viewport.height / 2);
      await page.getByRole("button", { name: /^Party/ }).first().click();
      await page.waitForTimeout(700);
      await shot(page, `player-${label}-panel`);
      await page.context().close();
    }
  }
} finally {
  await browser.close();
}
finish();
