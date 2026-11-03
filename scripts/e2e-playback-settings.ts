// The playback and Continue watching settings change what the first QA profile sees, each shot before and after into
// the out folder: a second subtitle language and how subtitles look (in the player, with the stand-in Spanish
// subtitle addon), hiding sources by words (the source list), blurring unwatched episodes (a title page), Continue
// watching from the furthest episode, and an episode not out yet in a row of its own. Every setting is changed in
// Settings like a person would, and put back at the end.
// Needs the QA app with its stand-ins (npm run qa -- up) and the internet (Cinemeta, artwork).
//   node scripts/e2e-playback-settings.ts [outDir]
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import type { Locator, Page } from "playwright-core";
import { launchBrowser } from "./lib/browser.ts";
import { assertLocal, checks, convexSignIn, qaSession, signIn } from "./lib/qa.ts";
import { standInSubtitles } from "./regress/providers.ts";

const out = process.argv[2] ?? ".artifacts/playback";
mkdirSync(out, { recursive: true });
const s = qaSession();
assertLocal(s.url);
const repo = join(import.meta.dirname, "..");
const providers = /providers (\S+)/.exec(readFileSync(join(repo, ".qa/providers.log"), "utf8"))![1];
const client = new ConvexHttpClient(s.convexUrl);
const ref = <T extends "query" | "mutation" | "action">(_kind: T, name: string) => makeFunctionReference<T>(name);
const me = await convexSignIn(client, s.profiles[0]);
type Addon = { _id: string; url: string };
const subsAddon = standInSubtitles(providers);
const addons = async () => (await client.query(ref("query", "addons:list"), { token: me.token })) as Addon[];

const browser = await launchBrowser({ args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const { check, finish } = checks(page);
const shot = (name: string, target: Page | Locator = page) => target.screenshot({ path: `${out}/${name}.png` });
const settle = (ms = 800) => page.waitForTimeout(ms);

/** Settings → <section>: a select by its label, a switch by its name. */
async function openSettings(section: "playback" | "home") {
  await page.goto(`${s.url}/settings/${section}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { level: 1, name: section === "home" ? "Home" : "Playback" }).waitFor({ timeout: 60_000 });
}
const choose = async (label: string, option: string) => {
  await page.getByLabel(label, { exact: true }).selectOption({ label: option });
  await settle(400);
};
const toggle = async (label: string) => {
  await page.locator("label").filter({ hasText: label }).first().click();
  await settle(400);
};

const NCIS = "tt0364845";
const SHOW = "tt0203259"; // Law & Order: SVU, played here to S28 E4 and back to S28 E1.
const subsCue = page.locator(".subtitle-cue").first();

try {
  // Fixtures through the app's own functions: the stand-in subtitle addon, and plays of two shows.
  if (!(await addons()).some((a) => a.url === subsAddon)) await client.action(ref("action", "addons:install"), { token: me.token, url: `${subsAddon}/manifest.json` });
  const episode = (imdbId: string, season: number, ep: number, name: string) => ({ type: "series", imdbId, videoId: `${imdbId}:${season}:${ep}`, season, episode: ep, name });
  const finished = (media: ReturnType<typeof episode>) => client.mutation(ref("mutation", "progress:save"), { token: me.token, media, position: 2500, duration: 2600, final: true });
  await finished(episode(SHOW, 28, 4, "Law & Order: Special Victims Unit"));
  await finished(episode(SHOW, 28, 1, "Law & Order: Special Victims Unit"));
  await finished(episode(NCIS, 24, 4, "NCIS"));

  await signIn(page, s.url, s.profiles[0]);
  await page.getByRole("link", { name: "Krida home" }).first().waitFor({ timeout: 60_000 });

  // 1. Settings → Playback as it starts.
  await openSettings("playback");
  await choose("Subtitles", "English");
  await shot("settings-playback-before", page.locator("main"));

  // 2. Subtitles: English has none here, so nothing shows; Spanish as the second language does.
  const film = (await client.mutation(ref("mutation", "rooms:create"), {
    token: me.token, media: { type: "movie", imdbId: "tt9999990", videoId: "tt9999990", name: "Subtitle test" },
  })) as string;
  const watch = async (roomId: string) => {
    await page.goto(`${s.url}/watch/${roomId}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => {
      const v = document.querySelector("video");
      return !!v && v.currentTime > 13;
    }, null, { timeout: 90_000 });
  };
  await watch(film);
  await settle(1500);
  check("with only English asked for, no subtitles show", (await page.locator(".subtitle-cue").count()) === 0);
  await shot("subtitles-second-language-before");
  await openSettings("playback");
  await choose("If there are none, use", "Spanish");
  await watch((await client.mutation(ref("mutation", "rooms:create"), {
    token: me.token, media: { type: "movie", imdbId: "tt9999991", videoId: "tt9999991", name: "Subtitle test" },
  })) as string);
  await subsCue.waitFor({ timeout: 30_000 });
  check("the second language fills in", /¿Dónde está el barco\?/.test(await subsCue.innerText()));
  await page.mouse.move(10, 10);
  await settle(2500);
  await shot("subtitles-second-language-after");
  // How they look.
  await openSettings("playback");
  await choose("Size", "Extra large");
  await choose("Text colour", "Yellow");
  await choose("Edge", "Dark box");
  await watch((await client.mutation(ref("mutation", "rooms:create"), {
    token: me.token, media: { type: "movie", imdbId: "tt9999992", videoId: "tt9999992", name: "Subtitle test" },
  })) as string);
  await subsCue.waitFor({ timeout: 30_000 });
  const look = await subsCue.evaluate((el) => {
    const css = getComputedStyle(el);
    return { size: parseFloat(css.fontSize), color: css.color, background: css.backgroundColor };
  });
  check("subtitles are drawn extra large, yellow, on a dark box", look.size > 30 && look.background !== "rgba(0, 0, 0, 0)", JSON.stringify(look));
  await page.mouse.move(10, 10);
  await settle(2500);
  await shot("subtitles-style-after");

  // 3. Sources: hiding a word takes those copies out of the list.
  await page.goto(`${s.url}/title/movie/tt0063350`, { waitUntil: "domcontentloaded" });
  const sources = async (name: string) => {
    await page.getByRole("button", { name: "Choose a source" }).click();
    const sheet = page.getByRole("dialog");
    await sheet.getByText("1080p").first().waitFor({ timeout: 30_000 });
    await settle(600);
    const rows = await sheet.locator("ul.source-list > li").count();
    await shot(name);
    await page.keyboard.press("Escape");
    await settle(500);
    return rows;
  };
  const before = await sources("sources-filter-before");
  await openSettings("playback");
  await toggle("Reuse the last source");
  await page.getByLabel("Hide sources containing").fill("2160p|720p");
  await page.getByRole("button", { name: "Save" }).click();
  await settle(800);
  await shot("settings-playback-after", page.locator("main"));
  await page.getByRole("heading", { name: "Sources" }).evaluate((h) => h.scrollIntoView({ block: "start" }));
  await settle(400);
  await shot("settings-sources-after");
  await page.goto(`${s.url}/title/movie/tt0063350`, { waitUntil: "domcontentloaded" });
  const after = await sources("sources-filter-after");
  check("hidden words take copies out of the source list, and it says so", before === 3 && after === 1, `${before} then ${after}`);

  // 4. Settings → Home: Continue watching before.
  const continueRow = page.locator("section").filter({ has: page.getByRole("heading", { name: "Continue watching" }) }).first();
  await page.goto(s.url, { waitUntil: "domcontentloaded" });
  await continueRow.waitFor({ timeout: 60_000 });
  await settle(2500);
  const svuBefore = await continueRow.getByText(/Next after S28 E\d/).first().innerText();
  check("Continue watching goes on from the last episode played", svuBefore.startsWith("Next after S28 E1"), svuBefore);
  await shot("continue-watching-before", continueRow);
  await openSettings("home");
  await shot("settings-home-before", page.locator("main"));
  await choose("After an episode, go on from", "The furthest one");
  await choose("Episodes not out yet", "Show in Coming up");
  await toggle("Blur unwatched episodes");
  await shot("settings-home-after", page.locator("main"));
  await page.goto(s.url, { waitUntil: "domcontentloaded" });
  await continueRow.waitFor({ timeout: 60_000 });
  const comingUp = page.locator("section").filter({ has: page.getByRole("heading", { name: "Coming up" }) }).first();
  await comingUp.waitFor({ timeout: 60_000 });
  await settle(2500);
  // From the furthest episode (S28 E4), SVU's next is S28 E5, which isn't out yet either: both move to Coming up.
  const upcoming = await comingUp.locator("a").allInnerTexts();
  check("…and from the furthest one once asked, with episodes not out yet in Coming up",
    upcoming.some((t) => t.includes("Law & Order") && t.includes("S28 E5")) && upcoming.some((t) => t.includes("NCIS") && t.includes("S24 E5")) &&
      (await continueRow.getByText(/Law & Order|NCIS/).count()) === 0,
    upcoming.map((t) => t.replace(/\s+/g, " ")).join(" / "));
  await comingUp.scrollIntoViewIfNeeded();
  await settle(2500);
  await shot("continue-watching-after");
  await page.evaluate(() => window.scrollTo(0, 0));

  // 5. Blur: a title page's unwatched episodes.
  await page.goto(`${s.url}/title/series/${NCIS}`, { waitUntil: "domcontentloaded" });
  const episodes = page.getByRole("list").filter({ has: page.getByRole("button", { name: /^Play S\d+ E\d+/ }) }).first();
  await episodes.waitFor({ timeout: 60_000 });
  await episodes.scrollIntoViewIfNeeded();
  await settle(2500);
  const blurred = await page.locator(".spoiler").count();
  check("unwatched episodes are blurred", blurred > 0, `${blurred} stills`);
  await shot("blur-unwatched-after");
  await openSettings("home");
  await toggle("Blur unwatched episodes");
  await page.goto(`${s.url}/title/series/${NCIS}`, { waitUntil: "domcontentloaded" });
  await episodes.waitFor({ timeout: 60_000 });
  await episodes.scrollIntoViewIfNeeded();
  await settle(2500);
  check("with it off, none are", (await page.locator(".spoiler").count()) === 0);
  await shot("blur-unwatched-before");
} finally {
  // Back as `npm run qa -- up` left the profile.
  await client.mutation(ref("mutation", "profiles:update"), {
    token: me.token,
    prefsPatch: { subLang: null, subLang2: null, sourceFilter: null, reuseSource: false, nextUpFrom: null, upcoming: null, blurUnwatched: false, subtitleSize: "medium", subtitleColor: "white", subtitleEdge: "shadow" },
  });
  for (const a of await addons()) if (a.url === subsAddon) await client.mutation(ref("mutation", "addons:remove"), { token: me.token, addonId: a._id });
  await browser.close();
  finish();
}
