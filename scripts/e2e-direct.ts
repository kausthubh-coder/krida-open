// Another debrid service's files, end to end on the QA app: the QA account switches to Real-Debrid (a stand-in key)
// and the first QA profile plays from the stand-in debrid addon (scripts/regress/providers.ts `standInDirectAddon`),
// whose links redirect to the file itself: a 480p MP4 of Night of the Living Dead (public domain, the Internet
// Archive) and a 1080p MKV. The browser picks the MP4 and plays it in the page; picking the MKV offers the desktop app
// and external players instead of a player that fails (on a computer and on an iPhone); the source list hands any
// file to an external player. Puts the account back on the stand-in TorBox at the end.
// Needs the QA app with its stand-ins (npm run qa -- up) and the internet (Cinemeta, the Internet Archive).
//   node scripts/e2e-direct.ts [outDir]
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import type { Page } from "playwright-core";
import { launchBrowser } from "./lib/browser.ts";
import { assertLocal, checks, convexSignIn, qaSession, signIn } from "./lib/qa.ts";
import { PUBLIC_DOMAIN_MP4, standInDirectAddon } from "./regress/providers.ts";

const out = process.argv[2] ?? ".artifacts/playback";
mkdirSync(out, { recursive: true });
const s = qaSession();
assertLocal(s.url);
assertLocal(s.convexUrl);
const repo = join(import.meta.dirname, "..");
const providers = /providers (\S+)/.exec(readFileSync(join(repo, ".qa/providers.log"), "utf8"))![1];
const { adminKey } = JSON.parse(readFileSync(join(repo, ".qa/backend/.convex/local/default/config.json"), "utf8")) as { adminKey: string };

const admin = new ConvexHttpClient(s.convexUrl);
(admin as unknown as { setAdminAuth(key: string): void }).setAdminAuth(adminKey);
const client = new ConvexHttpClient(s.convexUrl);
const ref = <T extends "query" | "mutation" | "action">(_kind: T, name: string) => makeFunctionReference<T>(name);
const setDebrid = (service: "realdebrid" | "torbox", key: string) =>
  admin.mutation(ref("mutation", "accounts:setKeysFor"), { account: "QA", keys: { debrid: { service, key } } });

const NIGHT = "tt0063350";
const me = await convexSignIn(client, s.profiles[0]);
type Addon = { _id: string; url: string; enabled: boolean };
const addons = async () => (await client.query(ref("query", "addons:list"), { token: me.token })) as Addon[];
const direct = standInDirectAddon(providers);

// Set up: Real-Debrid on the account, the stand-in debrid addon on, the stand-in TorBox addon off.
await setDebrid("realdebrid", "stand-in-real-debrid");
if (!(await addons()).some((a) => a.url === direct)) await client.action(ref("action", "addons:install"), { token: me.token, url: `${direct}/manifest.json` });
for (const a of await addons()) await client.mutation(ref("mutation", "addons:setEnabled"), { token: me.token, addonId: a._id, enabled: a.url === direct });

const browser = await launchBrowser({ args: ["--autoplay-policy=no-user-gesture-required"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] });
const page = await context.newPage();
const { check, finish, watch } = checks(page);
const shot = (name: string, p: Page = page) => p.screenshot({ path: `${out}/${name}.png` });

try {
  await signIn(page, s.url, s.profiles[0]);
  await page.getByRole("link", { name: "Krida home" }).first().waitFor({ timeout: 60_000 });

  // 1. Play: the browser gets the MP4, straight from its link.
  await page.goto(`${s.url}/title/movie/${NIGHT}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { level: 1 }).first().waitFor({ timeout: 60_000 });
  await page.getByRole("button", { name: /^(Play|Resume)$/ }).first().click();
  await page.waitForURL(/\/watch\//, { timeout: 30_000 });
  const playing = await page
    .waitForFunction(() => {
      const v = document.querySelector("video");
      return !!v && !v.paused && v.currentTime > 2 && v.src.startsWith("https://");
    }, null, { timeout: 90_000 })
    .then(() => true, () => false);
  const src = await page.evaluate(() => document.querySelector("video")?.src ?? "");
  check("the browser plays another service's MP4 from its own link", playing && src.includes("archive.org"), src.replace(/\?.*/, ""));
  await page.mouse.move(700, 450);
  await page.waitForTimeout(500);
  await shot("direct-mp4-playing");

  // 2. The MKV: picked from the source list, it's offered elsewhere instead of failing.
  await page.goto(`${s.url}/title/movie/${NIGHT}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Choose a source" }).click();
  const sheet = page.getByRole("dialog");
  await sheet.getByText("1080p").first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(600);
  await shot("direct-sources");
  // Krida's pick is the MKV (1080p); its row in the list plays it.
  await sheet.locator("li").filter({ hasText: "1080p" }).first().getByRole("button").first().click();
  await page.waitForURL(/\/watch\//, { timeout: 30_000 });
  const heading = page.getByRole("heading", { name: "This file plays outside the browser" });
  await heading.waitFor({ timeout: 60_000 });
  await page.getByText("This copy is an MKV file, which browsers can’t play.").waitFor();
  await page.getByRole("button", { name: "Copy link" }).waitFor({ timeout: 30_000 });
  check("an MKV says why and offers other players, with no broken player", (await page.locator("video").count()) === 0);
  await shot("direct-mkv-elsewhere");
  await page.getByRole("button", { name: "Copy link" }).click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  check("Copy link copies the file's own link, with no key in it", copied === `${providers}/file/test.mkv`, copied);
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download playlist" }).click()]);
  const playlist = readFileSync((await download.path())!, "utf8");
  check("the playlist names the film and its link", download.suggestedFilename() === "Night of the Living Dead.m3u" && playlist === `#EXTM3U\n#EXTINF:-1,Night of the Living Dead\n${providers}/file/test.mkv\n`, download.suggestedFilename());
  const watchUrl = page.url();
  // With no app taking the krida:// link, the page keeps its focus and offers the download. In a tab of its own: where
  // a Krida build has registered the link, headless Chrome's unseen "Open Krida?" prompt stays pending in the tab, and
  // the tab then ignores the next press.
  const tab = await context.newPage();
  watch(tab, "app link");
  await tab.goto(watchUrl, { waitUntil: "domcontentloaded" });
  await tab.getByRole("button", { name: "Open in the desktop app" }).click({ timeout: 60_000 });
  await tab.getByText("Don’t have Krida for Mac or Windows?").waitFor({ timeout: 10_000 });
  check("Open in the desktop app, with no app, offers the download", await tab.getByRole("button", { name: "Download", exact: true }).isVisible());
  await shot("direct-mkv-no-desktop-app", tab);
  check("trying the app leaves the page where it was", tab.url() === watchUrl, tab.url());
  await tab.close();

  // 3. The same room on an iPhone: VLC and Infuse take the link.
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  });
  const iphone = await phone.newPage();
  watch(iphone, "iPhone");
  await signIn(iphone, s.url, s.profiles[0]);
  await iphone.waitForURL((u) => !u.pathname.startsWith("/qa"), { timeout: 60_000 });
  await iphone.goto(watchUrl, { waitUntil: "domcontentloaded" });
  await iphone.getByRole("button", { name: "Open in VLC" }).waitFor({ timeout: 60_000 }).catch(async (error) => {
    await shot("direct-mkv-elsewhere-iphone-failed", iphone);
    throw error;
  });
  const vlc = await iphone.evaluate(() => [...document.querySelectorAll("button")].some((b) => b.textContent === "Open in Infuse"));
  check("on an iPhone, VLC and Infuse are offered", vlc);
  await shot("direct-mkv-elsewhere-iphone", iphone);
  await phone.close();

  // 4. Any source from the list, to an external player.
  await page.goto(`${s.url}/title/movie/${NIGHT}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Choose a source" }).click();
  // The 480p MP4 is listed as SD.
  const sd = sheet.locator("li").filter({ hasText: "SD" }).first();
  await sd.waitFor({ timeout: 30_000 });
  await sd.getByRole("button", { name: "Details" }).click();
  await sheet.getByRole("button", { name: "Open in another player" }).click();
  await sheet.getByRole("button", { name: "Copy link" }).click();
  const fromList = await page.evaluate(() => navigator.clipboard.readText());
  // The Internet Archive's own redirect, followed to the file.
  check("the source list hands a file's link to another player", fromList.startsWith("https://") && fromList.endsWith(new URL(PUBLIC_DOMAIN_MP4).pathname.replace("/download/", "/items/")), fromList);
  await shot("direct-source-handoff");
} finally {
  // Put the account and the profile back as `npm run qa -- up` left them.
  await setDebrid("torbox", "regress-torbox");
  for (const a of await addons()) {
    if (a.url === direct) await client.mutation(ref("mutation", "addons:remove"), { token: me.token, addonId: a._id });
    else await client.mutation(ref("mutation", "addons:setEnabled"), { token: me.token, addonId: a._id, enabled: true });
  }
  await browser.close();
  finish();
}
