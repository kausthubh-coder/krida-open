// Addons per profile, end to end, with the real services: the account's keys are added in Settings → Connections; the
// first QA profile installs Torrentio from the suggestions (built with the account's TorBox key) and Cinemeta and an
// anime catalog addon by pasting their links; a bad link says why; Home shows their catalogs; the catalog editor
// renames, hides, reorders and pins rows, and Home follows; a movie and an episode play from the installed addon; and
// the second profile in the account has its own, empty, addon list until it copies the first one's.
// Needs the QA app with no stand-ins and no seeded keys, and the keys in .env.test.local (TMDB_API_KEY,
// MDBLIST_API_KEY, TORBOX_API_KEY). They're typed into password fields and never printed.
//   npm run qa -- up --real && node scripts/e2e-addons.ts [outDir] [--from <step>]
import { mkdirSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import type { Page } from "playwright-core";
import { launchBrowser } from "./lib/browser.ts";
import { checks, qaSession, signIn } from "./lib/qa.ts";

const out = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : ".artifacts/addons";
mkdirSync(out, { recursive: true });
const keys = parseEnv(readFileSync(new URL("../.env.test.local", import.meta.url), "utf8"));
for (const name of ["TMDB_API_KEY", "MDBLIST_API_KEY", "TORBOX_API_KEY"]) if (!keys[name]) throw new Error(`${name} is missing from .env.test.local`);
const secrets = [keys.TMDB_API_KEY!, keys.MDBLIST_API_KEY!, keys.TORBOX_API_KEY!];

const CINEMETA = "https://v3-cinemeta.strem.io/manifest.json";
const KITSU = "https://anime-kitsu.strem.fun/manifest.json";

const s = qaSession();
const browser = await launchBrowser();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const { check, finish } = checks(page);
const shot = (name: string, p: Page = page) => p.screenshot({ path: `${out}/${name}.png` });
const urls: string[] = [];
page.on("request", (r) => urls.push(r.url()));

await signIn(page, s.url, s.profiles[0]);

// A fresh account goes through onboarding first: the keys there, the addons later in Settings.
const tmdbStep = page.getByRole("heading", { name: "Connect TMDB" });
if (await tmdbStep.waitFor({ timeout: 15_000 }).then(() => true, () => false)) {
  const onboardingKey = async (label: string, key: string) => {
    await page.getByLabel(label, { exact: true }).fill(key);
    await page.getByLabel(label, { exact: true }).locator("xpath=ancestor::form").getByRole("button", { name: "Check key" }).click();
  };
  await onboardingKey("TMDB API key", keys.TMDB_API_KEY!);
  await page.getByRole("heading", { name: "Pick your debrid service" }).waitFor({ timeout: 30_000 });
  await onboardingKey("TorBox API key", keys.TORBOX_API_KEY!);
  await page.getByRole("heading", { name: "Add where streams come from" }).waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: "Skip for now" }).click();
  await page.getByRole("heading", { name: "A few extras" }).waitFor({ timeout: 30_000 });
  await onboardingKey("MDBList API key", keys.MDBLIST_API_KEY!);
  await page.getByText("MDBList key saved, ending").waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: "Go to Home" }).click();
  await page.getByRole("link", { name: "Krida home" }).first().waitFor({ timeout: 60_000 });
  check("a fresh account sets up its keys in onboarding", true);
}

// Keys, unless the account has them from an earlier run.
await page.goto(`${s.url}/settings/connections`, { waitUntil: "domcontentloaded" });
await page.getByRole("heading", { name: "Connections" }).waitFor();
const field = (label: string) => page.getByLabel(label, { exact: true });
const saveKey = async (label: string, key: string) => {
  if (!(await field(label).isVisible().catch(() => false))) return;
  await field(label).fill(key);
  await field(label).locator("xpath=ancestor::form").getByRole("button", { name: "Check and save" }).click();
  await page.getByText(`Saved, ending ${key.slice(-4)}`).waitFor({ timeout: 30_000 });
};
await page.waitForTimeout(1000);
await saveKey("TMDB API key", keys.TMDB_API_KEY!);
await saveKey("MDBList API key", keys.MDBLIST_API_KEY!);
if (await page.getByLabel("Debrid service").isVisible().catch(() => false)) await page.getByLabel("Debrid service").selectOption("torbox");
await saveKey("TorBox API key", keys.TORBOX_API_KEY!);

// Settings → Addons, empty.
await page.goto(`${s.url}/settings/addons`, { waitUntil: "domcontentloaded" });
await page.getByRole("heading", { name: "Addons", level: 1 }).waitFor();
await page.getByText("No addons yet").or(page.getByRole("switch").first()).waitFor({ timeout: 30_000 });
await shot("01-addons-empty");

// An installed addon has its own switch; its name alone is also in the Browse list.
const installed = (name: string) => page.getByRole("switch", { name: `Use ${name}` });
const install = async (url: string, name: string) => {
  if (await installed(name).isVisible().catch(() => false)) return;
  await page.getByLabel("Install from a link").fill(url);
  await page.getByRole("button", { name: "Install", exact: true }).click();
  await installed(name).waitFor({ timeout: 30_000 });
};

// A link that isn't an addon says why.
await page.getByLabel("Install from a link").fill("https://example.com/manifest.json");
await page.getByRole("button", { name: "Install", exact: true }).click();
const refused = page.getByText(/example\.com answered 404|didn’t give an addon manifest/);
await refused.waitFor({ timeout: 30_000 });
check("a link that isn't an addon says why", await refused.isVisible(), await refused.innerText());
await shot("02-addons-bad-link");

// Torrentio, from the suggestions.
const torrentio = page.getByRole("button", { name: "Install Torrentio" });
if (await torrentio.isVisible().catch(() => false)) {
  await torrentio.click();
  await page.getByText("Torrentio TB", { exact: true }).waitFor({ timeout: 30_000 });
}
check("Torrentio installs from the suggestions with the account's TorBox", await page.getByText("Torrentio TB", { exact: true }).isVisible());
await install(CINEMETA, "Cinemeta");
await install(KITSU, "Anime Kitsu");
await page.waitForTimeout(500);
await shot("03-addons-installed");

// From the default rows, so the script can run again.
await page.goto(`${s.url}/settings/home`, { waitUntil: "domcontentloaded" });
await page.getByRole("button", { name: /^Move .* down$/ }).first().waitFor({ timeout: 30_000 });
const reset = page.getByRole("button", { name: "Reset to the default rows" });
if (await reset.isVisible().catch(() => false)) await reset.click();
await page.getByLabel("Banner", { exact: true }).selectOption({ label: "Your picks and the Top 10" });
await page.waitForTimeout(500);

// Home shows the addons' catalogs among Krida's own rows.
const headings = () => page.locator("main h2").allInnerTexts();
/** Scrolls a row into view; its heading is drawn again when the row's titles arrive, so it's found afresh. */
const scrollToRow = (name: string) =>
  page.evaluate((n) => [...document.querySelectorAll("main h2")].find((h) => h.textContent === n)?.scrollIntoView({ block: "center" }), name);
const homeHas = async (name: string) => {
  await page.goto(`${s.url}/`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name, level: 2 }).waitFor({ timeout: 60_000 });
};
await homeHas("Popular · Movies");
await page.getByRole("heading", { name: "Kitsu Trending · Anime", level: 2 }).waitFor({ timeout: 60_000 });
const before = await headings();
check("Home shows Cinemeta's and Kitsu's catalogs", before.includes("Popular · Movies") && before.includes("Kitsu Trending · Anime"), before.join(" | "));
check("Torrentio's downloads list isn't a row", !before.some((h) => /TorBox/.test(h)));
await scrollToRow("Popular · Movies");
await page.waitForTimeout(2500);
await shot("04-home-addon-rows");

// Settings → Home: rename, hide, reorder and pin rows.
await page.goto(`${s.url}/settings/home`, { waitUntil: "domcontentloaded" });
await page.getByRole("heading", { name: "Home", level: 1 }).waitFor();
const showAll = page.getByRole("button", { name: /^Show all \d+ rows$/ });
if (await showAll.isVisible().catch(() => false)) await showAll.click();
await page.getByRole("button", { name: "Rename or change Popular · Movies" }).click();
await page.getByLabel("Name for Popular · Movies").fill("Big films");
await page.getByRole("button", { name: "Rename", exact: true }).click();
await page.getByRole("button", { name: "Hide Featured · Shows" }).click();
await page.getByRole("button", { name: "Pin Kitsu Trending · Anime to the top" }).click();
await page.getByRole("button", { name: "Unpin Kitsu Trending · Anime" }).waitFor();
await page.getByRole("button", { name: "Move Big films · Movies up" }).waitFor();
const order = async () => (await page.locator("main ul > li span.truncate.text-body").allInnerTexts());
const was = await order();
await page.getByRole("button", { name: "Move Big films · Movies up" }).click();
await page.waitForFunction((n) => {
  const t = [...document.querySelectorAll("main ul > li span.truncate.text-body")].map((x) => x.textContent);
  return t.indexOf("Big films · Movies") === n;
}, was.indexOf("Big films · Movies") - 1, { timeout: 15_000 });
await page.getByLabel("Banner", { exact: true }).selectOption({ label: "Kitsu Highest Rated · Anime" });
await page.waitForTimeout(800);
await shot("05-settings-home-editor");
await page.setViewportSize({ width: 1440, height: 1600 });
await shot("05b-settings-home-editor-full");
await page.setViewportSize({ width: 1440, height: 900 });

await homeHas("Big films · Movies");
await page.waitForTimeout(1500);
const after = await headings();
const firstRow = after.find((h) => h.trim().length > 0);
check("a pinned row leads Home", firstRow === "Kitsu Trending · Anime", after.slice(0, 4).join(" | "));
check("a renamed row shows its new name", after.includes("Big films · Movies") && !after.includes("Popular · Movies"));
check("a hidden row is gone", !after.includes("Featured · Shows"));
// Moved up past the row above it in Settings (Netflix's Top 10 shows), so on Home too.
check("a row moved up comes earlier on Home", after.indexOf("Big films · Movies") < after.indexOf("Top 10 shows on Netflix"),
  `before: ${before.slice(0, 5).join(" | ")}; after: ${after.slice(0, 5).join(" | ")}`);
await shot("06-home-after-editing");
const eyebrow = await page.getByText("Kitsu Highest Rated · Anime", { exact: true }).first().isVisible().catch(() => false);
check("the banner draws from the chosen row", eyebrow);

// See all, with the catalog's genres.
await scrollToRow("Big films · Movies");
await page.waitForTimeout(2000);
await page.getByRole("heading", { name: "Big films · Movies", level: 2 }).locator("xpath=ancestor::section").getByRole("link", { name: "See all" }).click();
await page.getByRole("heading", { name: "Big films · Movies", level: 1 }).waitFor({ timeout: 30_000 });
await page.locator("#see-all-genre").selectOption("Action");
await page.waitForURL(/genre=Action/);
await page.waitForTimeout(3000);
check("See all filters a catalog by genre", (await page.getByRole("listitem").count()) > 10);
await shot("07-see-all-genre");

// Search joins the addons' searchable catalogs.
await page.goto(`${s.url}/search?q=naruto`, { waitUntil: "domcontentloaded" });
const kitsuSearch = page.getByText("From Anime Kitsu").first();
await kitsuSearch.waitFor({ timeout: 60_000 });
check("Search shows an addon's search results as their own row", await kitsuSearch.isVisible());
await kitsuSearch.scrollIntoViewIfNeeded();
await page.waitForTimeout(1500);
await shot("08-search-addon-section");

// Sources come from the installed addon.
const sourcesOf = async (path: string, title: string) => {
  await page.goto(`${s.url}${path}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: title }).first().waitFor({ timeout: 60_000 });
  await page.getByRole("button", { name: "Choose a source", exact: true }).first().click();
  const sheet = page.getByRole("dialog", { name: "Choose a source" });
  await sheet.getByRole("button", { name: "Refresh" }).waitFor({ timeout: 90_000 });
  // A row's details name the addon that found it.
  await sheet.getByRole("button", { name: "Details" }).first().click();
  await page.waitForTimeout(400);
  return (await sheet.innerText()).replace(/\s+/g, " ");
};
const playing = async (label: string) => {
  await page.waitForURL(/\/watch\//, { timeout: 60_000 });
  await page.waitForFunction(() => {
    const v = document.querySelector("video");
    return !!v && v.readyState >= 3 && v.currentTime > 2;
  }, null, { timeout: 240_000 });
  check(`${label} plays`, true, `at ${(await page.evaluate(() => document.querySelector("video")!.currentTime)).toFixed(1)} s`);
  await page.mouse.move(720, 450);
  await page.waitForTimeout(800);
};
const movieSources = await sourcesOf("/title/movie/tt0111161", "The Shawshank Redemption");
check("a movie's sources come from Torrentio", movieSources.includes("Torrentio"), /.{0,60}Torrentio.{0,40}/.exec(movieSources)?.[0] ?? movieSources.slice(0, 160));
await shot("09-movie-sources");
await page.keyboard.press("Escape");
await page.getByRole("button", { name: "Play", exact: true }).first().click();
await playing("the movie");
await shot("10-movie-playing");

await page.goto(`${s.url}/title/series/tt0903747`, { waitUntil: "domcontentloaded" });
await page.getByRole("heading", { name: "Breaking Bad" }).first().waitFor({ timeout: 60_000 });
await page.getByRole("button", { name: /^(Play|Resume)/ }).first().click();
await playing("an episode");
await shot("11-episode-playing");

// The second profile in the account has its own list, and can copy the first one's.
// Its own browser profile: one browser keeps one Krida session.
const second = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await signIn(second, s.url, s.profiles[1]);
// A profile with no addons yet gets onboarding's addons step (the account's keys are done); it skips to Home.
const addonsStep = second.getByRole("heading", { name: "Add where streams come from" });
if (await addonsStep.waitFor({ timeout: 15_000 }).then(() => true, () => false)) await second.getByRole("button", { name: "Skip for now" }).click();
// Home first, so the new session is in place before another page loads.
await second.getByRole("heading", { level: 2 }).first().waitFor({ timeout: 60_000 });
await second.goto(`${s.url}/settings/addons`, { waitUntil: "domcontentloaded" });
await second.getByText("No addons yet").waitFor({ timeout: 30_000 }).catch(async (error) => {
  await shot("12-second-profile-failed", second);
  throw error;
});
check("another profile in the account starts with its own, empty, list", true);
await shot("12-second-profile-empty", second);
await second.getByRole("button", { name: "Copy addons" }).click();
await second.getByText("Torrentio TB", { exact: true }).waitFor({ timeout: 30_000 });
check("it can copy the first profile's addons", await second.getByRole("switch", { name: "Use Anime Kitsu" }).isVisible());
await shot("13-second-profile-copied", second);

check("no key went to the browser in a URL", !urls.some((u) => secrets.some((k) => u.includes(k))));
await finish();
await browser.close();
