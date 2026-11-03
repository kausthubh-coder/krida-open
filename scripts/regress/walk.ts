import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright-core";
import { launchBrowser } from "../lib/browser.ts";
import type { Network } from "./network.ts";
import type { Profile } from "./seed.ts";

type Title = { id: string; type: "movie" | "series"; name: string };
const { movies, shows, anime } = JSON.parse(readFileSync(new URL("./titles.json", import.meta.url), "utf8")) as Record<"movies" | "shows" | "anime", Title[]>;

/** An image on screen: which file, and the box it fills in CSS pixels. */
export type Shown = { src: string; x: number; y: number; w: number; h: number };
export type Capture = { step: string; aria: string; errors: string[]; images: Shown[] };

// Same pixels on every run: no motion, a seeded Math.random, one clock zone and locale. Each browser gets its own
// seed: the Convex client draws its session id from Math.random, and two browsers with one id confuse the backend.
const freeze = (seed: number) => `
  (() => {
    let s = ${seed};
    Math.random = () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    // Inline animations drive timers (the Home banner moves on when its progress bar's animation ends), so they're
    // paused where they start rather than finished at once.
    const style = "*:not([style*=animation]),*::before,*::after{animation-duration:0s!important;animation-delay:0s!important}" +
      "*,*::before,*::after{transition-duration:0s!important;transition-delay:0s!important;caret-color:transparent!important}" +
      "[style*=animation]{animation-play-state:paused!important}";
    addEventListener("DOMContentLoaded", () => { const el = document.createElement("style"); el.textContent = style; document.head.append(el); });
  })();
`;

/** Ids and clock times (a chat message shows when the walk sent it) never count as a difference. */
export function normalize(aria: string) {
  return aria.replace(/\b[a-z0-9]{32}\b/g, "<id>").replace(/\b\d{1,2}:\d{2}\s?[AP]M\b/g, "<time>");
}

/**
 * The walk: every screen a person uses, in the same order with the same data. Each step leaves an accessibility
 * snapshot (what a screen reader would read, so text, roles, names and states) and a screenshot in `out`.
 */
export async function walk(base: string, profiles: Profile[], network: Network, out: string): Promise<Capture[]> {
  rmSync(out, { recursive: true, force: true });
  contexts = 0;
  mkdirSync(out, { recursive: true });
  const browser = await launchBrowser({ headless: true });
  const captures: Capture[] = [];
  const opened: Opened[] = [];
  const open = async (viewport: { width: number; height: number }, clock = true) => {
    const o = await openContext(browser.newContext.bind(browser), viewport, network, clock);
    opened.push(o);
    return o;
  };
  try {
    const desktop = await open({ width: 1440, height: 900 });
    await signIn(desktop.page, base, profiles[0], (step) => capture(desktop, step));
    const page = desktop.page;
    const at = async (step: string, path: string, ready: (page: Page) => Promise<unknown>) => {
      await page.goto(`${base}${path}`, { waitUntil: "domcontentloaded" });
      await ready(page);
      await capture(desktop, step);
    };
    const heading = (name: string) => (p: Page) => p.getByRole("heading", { name, exact: true }).first().waitFor({ timeout: 30_000 });
    // A title page's heading is the title's logo when it has one, so wait for the page's one level-1 heading.
    const titlePage = (p: Page) => p.getByRole("heading", { level: 1 }).first().waitFor({ timeout: 30_000 });

    await page.getByRole("heading", { level: 2 }).nth(4).waitFor({ timeout: 60_000 });
    await capture(desktop, "home");
    await at("title-movie", `/title/movie/${movies[16].id}`, titlePage);
    await at("title-show", `/title/series/${shows[16].id}`, titlePage);
    await at("title-anime", `/title/series/${encodeURIComponent(anime[0].id)}`, titlePage);
    await at("search-browse", "/search", (p) => p.getByRole("textbox", { name: "Search titles, people, genres and languages" }).waitFor());
    await at("search-results", `/search?q=${encodeURIComponent(movies[0].name)}`, (p) => p.getByRole("link", { name: new RegExp(movies[0].name) }).first().waitFor({ timeout: 30_000 }));
    await at("library", "/library", heading("Plan to watch"));
    const collections = page.getByRole("navigation", { name: "Library" }).getByRole("link");
    const names = (await collections.allTextContents()).map((text) => text.trim());
    for (const [i, text] of names.entries()) {
      // Collections end in their count. Stats and Wrapped compute in a backend job that reads Cinemeta live, so when
      // they finish isn't the same on both sides.
      if (i === 0 || !/\d$/.test(text)) continue;
      const name = text.replace(/\d+$/, "").trim();
      await collections.nth(i).click();
      await page.waitForURL((url) => url.pathname.startsWith("/library"));
      await capture(desktop, `library-${slug(name)}`);
    }
    await page.goto(`${base}/library`, { waitUntil: "domcontentloaded" });
    await heading("Plan to watch")(page);
    await page.getByRole("button", { name: /^Filters/ }).click();
    await page.getByRole("dialog", { name: "Filter your Library" }).waitFor();
    await capture(desktop, "library-filter");
    await page.keyboard.press("Escape");
    await at("settings", "/settings", (p) => p.getByRole("main").waitFor());
    // Settings' sections. A commit from before sections answers these paths with Not found.
    const settingsReady = (p: Page) =>
      p.getByRole("heading", { level: 1 }).or(p.getByText("There’s nothing at this address")).first().waitFor({ timeout: 30_000 });
    for (const id of ["playback", "taste", "home", "display", "account"]) await at(`settings-${id}`, `/settings/${id}`, settingsReady);

    // Changing something: save a title to Plan to watch, then rate it.
    const fresh = movies[36];
    await at("title-unsaved", `/title/movie/${fresh.id}`, titlePage);
    await page.getByRole("button", { name: `Add ${fresh.name} to Plan to watch or set a watch status` }).click();
    await page.getByRole("menuitemradio", { name: "Plan to watch" }).click();
    await page.getByRole("button", { name: `Plan to watch. Change watch status for ${fresh.name}` }).waitFor();
    await capture(desktop, "title-saved");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: `Rate ${fresh.name}`, exact: true }).click();
    await page.getByRole("radio", { name: /^8,/ }).click();
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await page.getByRole("button", { name: `Your rating: 8 out of 10. Change your rating for ${fresh.name}` }).waitFor();
    await capture(desktop, "title-rated");
    await at("library-after-save", "/library", heading("Plan to watch"));

    // Playback, from the stand-in providers (providers.ts): a one-minute test video with an intro from 0:02 to 0:12.
    // Paused, the controls stay up, so each capture is at a fixed point. Positions are set on the element directly:
    // the walk checks what the player shows at a time, not how the slider is dragged.
    const watching = await open({ width: 1440, height: 900 }, false);
    await signIn(watching.page, base, profiles[0]);
    const player = watching.page;
    // Seeking the way a person does, by clicking the Seek bar: the player is a room, and a seek that skips the room
    // gets pulled back to the room's position.
    const at_ = async (seconds: number) => {
      const bar = (await player.getByRole("slider", { name: "Seek" }).boundingBox())!;
      const duration = await player.evaluate(() => document.querySelector("video")!.duration);
      const seeked = player.evaluate(() => new Promise<void>((resolve, reject) => {
        document.querySelector("video")!.addEventListener("seeked", () => resolve(), { once: true });
        setTimeout(() => reject(new Error("The player didn't seek after a click on the Seek bar")), 15_000);
      }));
      await player.mouse.click(bar.x + (bar.width * seconds) / duration, bar.y + bar.height / 2);
      await seeked;
      await player.mouse.move(720, 300);
    };
    await player.goto(`${base}/title/movie/${fresh.id}`, { waitUntil: "domcontentloaded" });
    await titlePage(player);
    await player.getByRole("button", { name: "Play", exact: true }).first().click();
    await player.waitForURL(/\/watch\//);
    await player.waitForFunction(() => (document.querySelector("video")?.readyState ?? 0) >= 3, null, { timeout: 60_000 });
    await player.getByRole("button", { name: /^Pause/ }).click();
    await at_(30);
    await capture(watching, "player");
    // Pointing at the timeline shows the time there and, once it loads, the picture at that time. A nearby
    // picture can show first, so the capture waits for the card to stop changing.
    const seekBar = (await player.getByRole("slider", { name: "Seek" }).boundingBox())!;
    await player.mouse.move(seekBar.x + seekBar.width * 0.75, seekBar.y + seekBar.height / 2);
    await player.getByText("0:45", { exact: true }).waitFor();
    await player.locator("canvas[aria-hidden]:not(.hidden)").waitFor({ timeout: 5_000 }).catch(() => {});
    await player.waitForFunction(() => {
      const c = document.querySelector<HTMLCanvasElement>("canvas[aria-hidden]:not(.hidden)");
      const w = window as unknown as { cardSeen?: string; cardSame?: number };
      const now = c?.toDataURL() ?? "";
      w.cardSame = now === w.cardSeen ? (w.cardSame ?? 0) + 1 : 0;
      w.cardSeen = now;
      return w.cardSame >= 3;
    }, null, { polling: 200, timeout: 10_000 });
    await capture(watching, "player-timeline-preview");
    await player.mouse.move(720, 300);
    await player.getByRole("button", { name: "Change source" }).click();
    const sources = player.getByRole("dialog", { name: "Choose a source" });
    await sources.waitFor();
    await capture(watching, "player-sources");
    await sources.getByRole("button", { name: "Close" }).click();
    await sources.waitFor({ state: "hidden" });
    await at_(1);
    await player.getByRole("button", { name: /^Play \(/ }).click();
    await player.getByText("Skipped intro").waitFor({ timeout: 15_000 });
    await player.getByRole("button", { name: /^Pause/ }).click();
    await at_(12);
    await capture(watching, "player-skipped-intro");
    // The keyboard: A opens Automatic (Playback since speed joined it). Turning off "Play next episode" keeps Up next
    // from counting down below.
    await player.keyboard.press("a");
    const automatic = player.getByRole("dialog", { name: /^(Automatic|Playback)$/ });
    await automatic.waitFor();
    await capture(watching, "player-automatic");
    await automatic.getByRole("switch").nth(2).click();
    await player.keyboard.press("Escape");
    await automatic.waitFor({ state: "hidden" });
    // Subtitles: OpenSubtitles here, and a line on the file's own tracks (the stand-in file has three), which only
    // Krida for Windows shows.
    await player.getByRole("button", { name: "Subtitles (C)" }).click();
    const subtitles = player.getByRole("dialog", { name: "Subtitles" });
    await subtitles.waitFor();
    await subtitles.getByText("Looking for subtitles…").waitFor({ state: "hidden" });
    await capture(watching, "player-subtitles");
    await player.keyboard.press("Escape");
    await subtitles.waitFor({ state: "hidden" });
    // Back leaves the film's room (leaving by reloading would keep it, and the next Play would switch it instead).
    await player.getByRole("button", { name: "Back", exact: true }).click();
    await player.waitForURL((url) => !url.pathname.startsWith("/watch/"));
    // A show: its seeded spot (10:00) is past the end of the one-minute test video, so Resume lands at the end, where
    // Up next offers the next episode. With "Play next episode" off, it waits instead of counting down.
    // In-app navigation, as a click would: a reload here would cut the connection before Back's leave reaches the
    // backend, keeping the film's room open.
    await player.evaluate((path) => {
      history.pushState(null, "", path);
      dispatchEvent(new PopStateEvent("popstate"));
    }, `/title/series/${shows[16].id}`);
    await player.getByRole("button", { name: "Resume S1 E2", exact: true }).click({ timeout: 30_000 });
    await player.getByRole("heading", { name: shows[16].name }).first().waitFor({ timeout: 60_000 });
    await player.getByRole("button", { name: "Play now", exact: true }).waitFor({ timeout: 60_000 });
    await capture(watching, "player-up-next");
    await watching.context.close();
    await desktop.context.close();

    const phone = await open({ width: 390, height: 844 });
    await signIn(phone.page, base, profiles[0]);
    await phone.page.getByRole("heading", { level: 2 }).nth(2).waitFor({ timeout: 60_000 });
    await capture(phone, "phone-home");
    // Settings on a phone is a list of sections, each on its own page.
    for (const [step, path] of [["phone-settings", "/settings"], ["phone-settings-playback", "/settings/playback"]]) {
      await phone.page.goto(`${base}${path}`, { waitUntil: "domcontentloaded" });
      await settingsReady(phone.page);
      await capture(phone, step);
    }
    await phone.context.close();

    // The same phone held sideways: the nav is a rail at the left, and Play is on the first screen.
    const sideways = await open({ width: 844, height: 390 });
    await signIn(sideways.page, base, profiles[0]);
    await sideways.page.getByRole("heading", { level: 2 }).nth(2).waitFor({ timeout: 60_000 });
    await capture(sideways, "phone-sideways-home");
    await sideways.page.goto(`${base}/title/movie/${movies[16].id}`, { waitUntil: "domcontentloaded" });
    await titlePage(sideways.page);
    await capture(sideways, "phone-sideways-title");
    await sideways.context.close();

    // A party in two browsers: one starts it and invites the other, who joins from the invite; then a message.
    const host = await open({ width: 1440, height: 900 });
    const guest = await open({ width: 1440, height: 900 });
    await signIn(host.page, base, profiles[0]);
    await signIn(guest.page, base, profiles[1]);
    await host.page.getByRole("button", { name: `Watch with ${profiles[1].name}` }).click();
    // The older walk's button started the party in a sheet; `--base` runs this walk on those commits too.
    const offered = host.page.getByRole("complementary", { name: "Party" }).getByRole("button", { name: `Invite ${profiles[1].name}` });
    const sheet = host.page.getByRole("dialog", { name: "Start a watch party" });
    await offered.or(sheet).first().waitFor({ timeout: 5000 }).catch(() => {});
    if (await offered.isVisible()) await offered.click();
    else if (await sheet.isVisible()) await sheet.getByRole("button", { name: `Start and invite ${profiles[1].name}` }).click();
    await guest.page.getByText("invited you to a party").waitFor({ timeout: 30_000 });
    await capture(guest, "party-invite");
    await guest.page.getByRole("region", { name: /Notifications/ }).getByRole("button", { name: "Join", exact: true }).click();
    await host.page.getByText(`You and ${profiles[1].name} are here`).waitFor({ timeout: 30_000 });
    await capture(host, "party-host");
    await host.page.getByRole("textbox", { name: "Message" }).fill("Ready when you are");
    await host.page.getByRole("button", { name: "Send", exact: true }).click();
    await guest.page.getByText("Ready when you are", { exact: true }).first().waitFor({ timeout: 30_000 });
    await capture(guest, "party-guest-chat");
    await host.context.close();
    await guest.context.close();
  } catch (error) {
    // Every open page as it was when the step failed, to see why without rerunning.
    for (const [i, o] of opened.entries()) await o.page.screenshot({ path: join(out, `failed-${i}.png`) }).catch(() => {});
    console.log(`A step failed; screenshots of the open pages are in ${out}/failed-*.png`);
    throw error;
  } finally {
    await browser.close();
  }
  return captures;

  async function capture(where: Opened, step: string) {
    await settle(where.page, network);
    const aria = normalize(await where.page.locator("body").ariaSnapshot());
    writeFileSync(join(out, `${step}.aria.yml`), aria);
    writeFileSync(join(out, `${step}.png`), await stableScreenshot(where.page));
    const images = await where.page.evaluate(() => [...document.images].flatMap((img) => {
      const r = img.getBoundingClientRect();
      const visible = r.bottom > 0 && r.top < innerHeight && r.width > 0 && getComputedStyle(img).opacity !== "0";
      return visible ? [{ src: img.currentSrc, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }] : [];
    }));
    captures.push({ step, aria, errors: where.errors.splice(0), images });
  }
}

type Opened = { context: BrowserContext; page: Page; errors: string[] };
let contexts = 0;

export async function openContext(newContext: (options: object) => Promise<BrowserContext>, viewport: { width: number; height: number }, network: Network, clock = true): Promise<Opened> {
  const context = await newContext({ viewport, locale: "en-US", timezoneId: "America/New_York", reducedMotion: "reduce", serviceWorkers: "block" });
  await context.addInitScript(freeze(0x2f6b9a1d + contexts++));
  await network.attach(context);
  // Time runs normally from when the store was recorded, so relative times in recorded data never drift.
  // The video player's timers can't run on a fake clock, so the player is walked in a browser without one.
  if (clock) await context.clock.install({ time: network.recordedAt });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return { context, page, errors };
}

/**
 * Signs in the way the build does: signed out, it shows the landing page or the sign-in screen (captured as "gate"), then the QA sign-in
 * page takes the profile's name and password. A base from before accounts had a profile list with passwords instead.
 */
async function signIn(page: Page, base: string, profile: Profile, capture?: (step: string) => Promise<void>) {
  // The first load of a fresh checkout waits for Vite to bundle dependencies.
  await page.goto(base, { waitUntil: "domcontentloaded", timeout: 180_000 });
  const button = page.getByRole("button", { name: profile.name, exact: true });
  // Signed out, / is the landing page now; before it, the sign-in screen.
  const signedOut = page
    .getByText("Sign in to pick a profile", { exact: false })
    .or(page.getByText("This build has no sign-in set up", { exact: false }))
    .or(page.getByRole("heading", { name: "Press play on anything", level: 1 }));
  await button.or(signedOut).first().waitFor({ timeout: 60_000 });
  await capture?.("gate");
  if (await button.isVisible()) {
    await button.click();
    await page.getByRole("textbox", { name: "Password" }).fill(profile.password);
    await capture?.("gate-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    // Signed in once the gate is gone (a sideways phone shows no wordmark to wait for).
    await page.getByRole("textbox", { name: "Password" }).waitFor({ state: "detached", timeout: 60_000 });
    return;
  }
  await page.goto(`${base}/qa`, { waitUntil: "domcontentloaded" });
  await page.getByRole("textbox", { name: "QA profile" }).fill(profile.name);
  await page.getByRole("textbox", { name: "Password" }).fill(profile.password);
  await capture?.("gate-password");
  await page.getByRole("button", { name: "Sign in as QA profile" }).click();
  // Signed in once the QA page has moved on to the app. (The button's name changes while it signs in, so the button
  // going away isn't enough: a page opened then cancels the sign-in.)
  await page.waitForURL((url) => url.pathname !== "/qa", { timeout: 60_000 });
}

/** Waits until nothing is loading: no request in flight for 750 ms, every image on screen loaded, fonts ready. */
export async function settle(page: Page, network: Network) {
  const until = Date.now() + 30_000;
  let quietSince = Date.now();
  let last = "";
  while (Date.now() < until) {
    if (network.busy) quietSince = Date.now();
    else if (Date.now() - quietSince > 750) {
      // What's on screen: every image's source, whether it's loaded and how opaque it is. Null until all are loaded.
      const now = await page.evaluate(async () => {
        await document.fonts.ready;
        // Lazy images below the fold never load, so only those on screen have to be done.
        const onScreen = [...document.images].filter((img) => {
          const r = img.getBoundingClientRect();
          return r.bottom > 0 && r.top < innerHeight && r.width > 0;
        });
        if (!onScreen.every((img) => img.complete)) return null;
        await Promise.all(onScreen.map((img) => img.decode().catch(() => {})));
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return onScreen.map((img) => `${img.currentSrc} ${getComputedStyle(img).opacity}`).join("\n");
      }).catch(() => null);
      // Loaded isn't shown yet: artwork stays transparent until React handles its load event. Two reads alike means
      // nothing is still changing.
      if (now !== null && now === last) break;
      last = now ?? "";
    }
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(300);
}

/**
 * A screenshot taken twice alike. Chrome can report a big backdrop decoded and shown while it hasn't painted it yet,
 * so one screenshot may catch an empty tile.
 */
async function stableScreenshot(page: Page) {
  let last = await page.screenshot();
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(400);
    const next = await page.screenshot();
    if (next.equals(last)) return next;
    last = next;
  }
  return last;
}

function slug(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
