// Keys per account, end to end, with the real services: an account with no TMDB key sees "Add your TMDB key" on Home
// and Search; Settings → Connections turns down a wrong key and checks and saves real TMDB, MDBList and TorBox keys;
// then Search finds titles, a title page shows ratings, a film plays from the account's TorBox, and the timeline shows
// preview pictures (through the frames Worker, then through /api/frame with the Worker down). Clearing the TMDB key
// brings the "Add your TMDB key" state back.
// Needs the QA app with no stand-ins and no seeded keys, and the keys in .env.test.local (TMDB_API_KEY,
// MDBLIST_API_KEY, TORBOX_API_KEY). They're typed into password fields and never printed.
//   npm run qa -- up --real && node scripts/e2e-keys.ts [outDir]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";
import type { Page } from "playwright-core";
import { launchBrowser } from "./lib/browser.ts";
import { checks, qaSession, signIn } from "./lib/qa.ts";

const out = process.argv[2] ?? ".artifacts/keys";
mkdirSync(out, { recursive: true });
const keys = parseEnv(readFileSync(new URL("../.env.test.local", import.meta.url), "utf8"));
for (const name of ["TMDB_API_KEY", "MDBLIST_API_KEY", "TORBOX_API_KEY"]) if (!keys[name]) throw new Error(`${name} is missing from .env.test.local`);
const secrets = [keys.TMDB_API_KEY!, keys.MDBLIST_API_KEY!, keys.TORBOX_API_KEY!];

const s = qaSession();
const browser = await launchBrowser();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const { check, watch, finish } = checks(page);
// Everything the browser asked for, to check no key ever went to it in a URL.
const urls: string[] = [];
const frames: { worker: boolean }[] = [];
// Whether the playing file's own index could be read (TorBox's CDN refuses Range reads of some files; the player then
// takes its pictures from TorBox's HLS segments instead).
const indexes: number[] = [];
const track = (p: Page) => {
  p.on("request", (r) => {
    urls.push(r.url());
    if (/\/(api|frames-worker)\/frame\?/.test(r.url())) frames.push({ worker: r.url().includes("/frames-worker/") });
  });
  p.on("response", (r) => {
    const u = new URL(r.url());
    if (u.pathname === "/api/frames" && !u.searchParams.has("ticket")) indexes.push(r.status());
  });
};
track(page);
const shot = (name: string, p = page) => p.screenshot({ path: `${out}/${name}.png` });

await signIn(page, s.url, s.profiles[0]);

// No TMDB key yet: Home and Search say what to add.
await page.goto(`${s.url}/`, { waitUntil: "domcontentloaded" });
const needs = page.getByText("Add your TMDB key to see titles");
await needs.waitFor({ timeout: 30_000 });
check("Home without a TMDB key says to add one", await needs.isVisible());
await shot("01-home-needs-tmdb");
await page.goto(`${s.url}/search?q=inception`, { waitUntil: "domcontentloaded" });
await needs.waitFor({ timeout: 30_000 });
check("Search without a TMDB key says to add one", await needs.isVisible());
await shot("02-search-needs-tmdb");

// Settings → Connections, from the notice's button.
await page.getByRole("link", { name: "Add your TMDB key" }).click();
await page.waitForURL(/\/settings\/connections/);
await page.getByRole("heading", { name: "Connections" }).waitFor();
await shot("03-connections-empty");

const field = (label: string) => page.getByLabel(label, { exact: true });
const saveKey = async (label: string, key: string) => {
  await field(label).fill(key);
  await field(label).locator("xpath=ancestor::form").getByRole("button", { name: "Check and save" }).click();
};
await saveKey("TMDB API key", "not-a-real-key");
const refused = page.getByText("TMDB didn't accept that key. Check it and paste it again.");
await refused.waitFor({ timeout: 30_000 });
check("a wrong TMDB key is turned down with what to do", await refused.isVisible());
await shot("04-connections-wrong-key");

await saveKey("TMDB API key", keys.TMDB_API_KEY!);
await page.getByText(`Saved, ending ${keys.TMDB_API_KEY!.slice(-4)}`).waitFor({ timeout: 30_000 });
await saveKey("MDBList API key", keys.MDBLIST_API_KEY!);
await page.getByText(`Saved, ending ${keys.MDBLIST_API_KEY!.slice(-4)}`).waitFor({ timeout: 30_000 });
await page.getByLabel("Debrid service").selectOption("torbox");
await saveKey("TorBox API key", keys.TORBOX_API_KEY!);
await page.getByText(`Saved, ending ${keys.TORBOX_API_KEY!.slice(-4)}`).waitFor({ timeout: 30_000 });
check("all three keys are checked and saved", true);
await shot("05-connections-saved");

// Search finds titles with the account's TMDB key.
await page.goto(`${s.url}/search?q=inception`, { waitUntil: "domcontentloaded" });
const hit = page.getByRole("link", { name: /Inception/ }).first();
await hit.waitFor({ timeout: 60_000 });
check("Search returns results", await hit.isVisible());
// Let the posters come in for the picture.
await page.waitForFunction(() => [...document.images].filter((i) => i.complete && i.naturalWidth > 0).length >= 4, null, { timeout: 30_000 }).catch(() => {});
await page.waitForTimeout(1500);
await shot("06-search-results");

// A title page shows MDBList's ratings.
await page.goto(`${s.url}/title/movie/tt1375666`, { waitUntil: "domcontentloaded" });
await page.getByRole("heading", { name: "Inception" }).first().waitFor({ timeout: 60_000 });
const imdb = page.getByText(/IMDb/).first();
await imdb.waitFor({ timeout: 60_000 });
check("the title page shows ratings", await imdb.isVisible());
await shot("07-title-ratings");

// It plays from the account's TorBox.
await page.getByRole("button", { name: "Play", exact: true }).first().click();
await page.waitForURL(/\/watch\//);
await page.waitForFunction(() => {
  const v = document.querySelector("video");
  return !!v && v.readyState >= 3 && v.currentTime > 2;
}, null, { timeout: 240_000 });
check("the film plays", true, `at ${(await page.evaluate(() => document.querySelector("video")!.currentTime)).toFixed(1)} s`);
// Past the dark opening, for a picture worth looking at (the room owns the clock, so it plays on rather than seeks).
await page.waitForFunction(() => (document.querySelector("video")?.currentTime ?? 0) > 40, null, { timeout: 180_000 });
await page.mouse.move(720, 450);
await page.waitForTimeout(500);
await shot("08-playing");
// The frame itself, drawn from the <video>, in case the screenshot can't capture hardware-decoded video.
const frame = await page.evaluate(() => {
  const v = document.querySelector("video")!;
  const c = document.createElement("canvas");
  c.width = 960;
  c.height = Math.round((960 * v.videoHeight) / v.videoWidth);
  c.getContext("2d")!.drawImage(v, 0, 0, c.width, c.height);
  try {
    return c.toDataURL("image/png");
  } catch {
    return null;
  }
});
if (frame) writeFileSync(`${out}/08-playing-frame.png`, Buffer.from(frame.split(",")[1], "base64"));

// Preview pictures on the timeline.
const hover = async (p: Page, label: string) => {
  const bar = (await p.getByRole("slider", { name: "Seek" }).boundingBox())!;
  const card = p.locator("canvas.aspect-video[aria-hidden]:not(.hidden)");
  for (let i = 0; i < 40 && !(await card.isVisible().catch(() => false)); i++) {
    await p.mouse.move(bar.x + bar.width * (0.3 + (i % 5) * 0.1), bar.y + bar.height / 2);
    await p.waitForTimeout(1500);
  }
  const lit = await p.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>("canvas.aspect-video[aria-hidden]:not(.hidden)");
    if (!c) return 0;
    const a = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let sum = 0;
    for (let i = 0; i < a.length; i += 4) sum += a[i] + a[i + 1] + a[i + 2];
    return sum / (a.length / 4) / 3;
  });
  check(`the timeline shows a preview picture (${label})`, lit > 5, `mean brightness ${lit.toFixed(1)}`);
  const at = (await p.locator("canvas.aspect-video[aria-hidden]:not(.hidden)").boundingBox())!;
  await p.screenshot({ path: `${out}/09-preview-${label}.png` });
  await p.screenshot({ path: `${out}/09-preview-${label}-card.png`, clip: { x: Math.max(0, at.x - 40), y: Math.max(0, at.y - 40), width: at.width + 80, height: at.height + 120 } });
};
await page.getByRole("button", { name: /^Pause/ }).click().catch(() => {});
await hover(page, "worker");
const fileReadable = indexes.includes(200);
check(
  "pictures came through the frames Worker, or from HLS when TorBox can't read this file",
  fileReadable ? frames.some((f) => f.worker) : frames.length === 0,
  fileReadable ? `${frames.filter((f) => f.worker).length} from the Worker` : `index answered ${indexes.join(", ")}: HLS pictures`,
);

// With the Worker down, the pictures come from /api/frame (a fresh browser, so nothing is kept yet).
const fallbackContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const fallback = await fallbackContext.newPage();
watch(fallback, "fallback");
track(fallback);
await fallback.route("**/frames-worker/**", (route) => route.abort());
frames.length = 0;
// The same profile, so it plays the same file: TorBox's CDN reads some files by Range more reliably than others.
await signIn(fallback, s.url, s.profiles[0]);
await fallback.goto(`${s.url}/title/movie/tt1375666`, { waitUntil: "domcontentloaded" });
await fallback.getByRole("button", { name: "Play", exact: true }).first().click();
await fallback.waitForURL(/\/watch\//);
await fallback.waitForFunction(() => (document.querySelector("video")?.readyState ?? 0) >= 3, null, { timeout: 240_000 });
await fallback.getByRole("button", { name: /^Pause/ }).click().catch(() => {});
await hover(fallback, "api-frame");
if (fileReadable) check("without the Worker, pictures come from /api/frame", frames.some((f) => !f.worker), `${frames.filter((f) => !f.worker).length} from /api/frame`);
await fallbackContext.close();

// Both ways of reading a keyframe, asked directly with the session, for a film in the account's TorBox whose file its
// CDN reads: /api/frames (the index), /api/frame, and the Worker with the sealed ticket give the same bytes.
const listed = await fetch("https://api.torbox.app/v1/api/torrents/mylist?bypass_cache=true", { headers: { authorization: `Bearer ${keys.TORBOX_API_KEY}` } });
const files = ((await listed.json()) as { data: { files?: { size: number; short_name: string }[] }[] }).data
  .flatMap((t) => t.files ?? []).filter((f) => /\.mkv$/i.test(f.short_name) && f.size > 1e9).map((f) => f.size);
const direct = await page.evaluate(async ({ sizes, backend }) => {
  const headers = { "x-krida-backend": backend, "x-krida-session": localStorage.getItem("krida.session") ?? "" };
  const bytes = async (r: Response) => (r.ok ? [...new Uint8Array(await r.arrayBuffer())].join(",") : `HTTP ${r.status}`);
  for (const size of sizes.slice(0, 8)) {
    const res = await fetch(`/api/frames?size=${size}`, { headers });
    const index = res.ok ? ((await res.json()) as { points: number[][]; track: number } | null) : null;
    if (!index?.points.length) continue;
    const [, cluster, relative] = index.points[Math.floor(index.points.length / 2)];
    const place = `size=${size}&cluster=${cluster}&relative=${relative}&track=${index.track}`;
    const viaApi = await bytes(await fetch(`/api/frame?${place}`, { headers }));
    const ticket = (await (await fetch(`/api/frames?size=${size}&ticket`, { headers })).json()) as { url: string; expires: number; ticket: string } | null;
    const viaWorker = ticket ? await bytes(await fetch(`${ticket.url}/frame?${place}&expires=${ticket.expires}&ticket=${ticket.ticket}`)) : "no Worker";
    return { points: index.points.length, viaApi, viaWorker };
  }
  return null;
}, { sizes: files, backend: s.convexUrl });
check("/api/frames reads a film's index with the account's TorBox key", !!direct?.points, direct ? `${direct.points} keyframes` : "no readable file");
check("/api/frame gives a keyframe", !!direct && !direct.viaApi.startsWith("HTTP"), direct?.viaApi.startsWith("HTTP") ? direct.viaApi : `${direct?.viaApi.split(",").length} bytes`);
check("the Worker gives the same keyframe with the sealed ticket", !!direct && direct.viaWorker === direct.viaApi, direct?.viaWorker.startsWith("HTTP") ? direct.viaWorker : "");

check("no key ever went to the browser in a URL", !urls.some((u) => secrets.some((k) => u.includes(k))));

// Clearing the TMDB key brings the notice back.
await page.goto(`${s.url}/settings/connections`, { waitUntil: "domcontentloaded" });
const tmdbRow = page.getByText(`Saved, ending ${keys.TMDB_API_KEY!.slice(-4)}`).locator("xpath=ancestor::div[contains(@class,'flex-col')][1]");
await tmdbRow.getByRole("button", { name: "Remove" }).click();
await field("TMDB API key").waitFor({ timeout: 30_000 });
await shot("10-connections-tmdb-cleared");
await page.goto(`${s.url}/`, { waitUntil: "domcontentloaded" });
await needs.waitFor({ timeout: 30_000 });
check("with the TMDB key cleared, Home says to add it", await needs.isVisible());
await shot("11-home-tmdb-cleared");
await page.goto(`${s.url}/search?q=inception`, { waitUntil: "domcontentloaded" });
await needs.waitFor({ timeout: 30_000 });
check("with the TMDB key cleared, Search says to add it", await needs.isVisible());
await shot("12-search-tmdb-cleared");

await browser.close();
finish();
