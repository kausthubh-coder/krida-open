// Krida for Windows on the QA app: the app plays the stand-in's test file in mpv under a see-through page (no HLS),
// the controls drive mpv, the Picture menu sets how mpv fits the picture, leaving the player stops it, and in a party with someone on the web (headless Chrome) the
// two start in step, a pause, a seek and a resume from either side reach the other. A film with black bars built in
// is trimmed once its bright picture settles them, never by an opening shot with dark edges, and the Picture menu's
// switch puts them back. The window has an ultrawide's shape, where those bars box the picture in on all four sides.
// Quiet and out of the way: mpv has no sound device (KRIDA_SILENT), the window sits off-screen and never takes focus,
// and Chrome is headless and muted. Pictures of the app's window come from desktop/scripts/capture.ps1, and of mpv's
// own window from mpv.
// Picture quality (spline36, deband and its switch), V and B, the fit remembered, and the app's section in Settings too.
// Open in full screen is saved by the app (scripts/e2e-desktop-fullscreen.ts checks the rest in Chrome).
// Usage: npm run qa -- up; cd desktop/src-tauri && cargo build; node scripts/e2e-desktop.ts [app.exe]
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { chromium, type Page } from "playwright-core";
import { launchBrowser } from "./lib/browser.ts";
import { checks, convexSignIn, qaSession, signIn } from "./lib/qa.ts";

const repo = resolve(import.meta.dirname, "..");
const exe = resolve(process.argv[2] ?? `${repo}/desktop/src-tauri/target/debug/krida.exe`);
const out = resolve(repo, ".artifacts/desktop-e2e");
const PORT = 9341;
// Beyond this the player itself seeks to catch up (src/features/player/playbackSync.ts).
const DRIFT_S = 2.5;
rmSync(out, { recursive: true, force: true });
// The app's own browser profile, outside the repo so the dev server's file watcher leaves it alone.
const webviewData = resolve(tmpdir(), "krida-e2e-webview");
rmSync(webviewData, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const s = qaSession();
const [pa, pb] = s.profiles;
const { movies } = JSON.parse(readFileSync(resolve(repo, "scripts/regress/titles.json"), "utf8"));
const film = movies[36];
const media = { type: "movie", imdbId: film.id, videoId: film.id, name: film.name, year: film.year, poster: film.poster };

const app = spawn(exe, [], {
  env: {
    ...process.env,
    KRIDA_URL: s.url,
    KRIDA_DATA_DIR: webviewData,
    KRIDA_WINDOW_POS: "-3000,0",
    KRIDA_WINDOW_SIZE: "1376,576",
    KRIDA_SILENT: "1",
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
  },
  stdio: "ignore",
});
const { check, finish, watch } = checks();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const capture = (name: string) =>
  spawnSync("powershell", ["-NoProfile", "-File", resolve(repo, "desktop/scripts/capture.ps1"), "-ProcessId", String(app.pid), "-Out", resolve(out, name)], { encoding: "utf8", timeout: 60_000 });

/** What mpv last said in the app: where it is now (counted on from its last report while playing) and whether it's paused. */
const mpv = (page: Page) =>
  page.evaluate(() => {
    const log = (window as unknown as { __mpvLog: { name?: string; event?: string; value?: unknown; time?: number | null; reason?: string; at: number }[] }).__mpvLog ?? [];
    let t: number | null = null, at = 0, paused: boolean | null = null, stopped = false;
    for (const m of log) {
      if (typeof m.time === "number") [t, at] = [m.time, m.at];
      if (m.name === "pause") paused = m.value === true;
      if (m.event === "end-file") stopped = m.reason === "stop";
      if (m.event === "file-loaded") stopped = false;
    }
    const now = t === null ? null : paused ? t : t + (Date.now() - at) / 1000;
    return { t: now === null ? null : Math.round(now * 100) / 100, paused, stopped, count: log.length };
  });
/** Asks the app's mpv itself, over the pipe the app talks to it on (desktop/src-tauri/src/mpv.rs); mpv's answers in order. */
const askMpv = (commands: unknown[][]) =>
  new Promise<unknown[]>((done, fail) => {
    // The newest mpv: the app numbers each one it starts.
    const pipe = readdirSync("\\\\.\\pipe\\")
      .filter((p) => p.startsWith(`krida-mpv-${app.pid}-`))
      .sort((x, y) => Number(x.split("-").at(-1)) - Number(y.split("-").at(-1)))
      .at(-1);
    if (!pipe) return fail(new Error("mpv's pipe isn't there"));
    const socket = connect(`\\\\.\\pipe\\${pipe}`);
    const got = new Map<number, unknown>();
    let rest = "";
    socket.on("connect", () => commands.forEach((command, i) => socket.write(`${JSON.stringify({ command, request_id: 9000 + i })}\n`)));
    socket.on("data", (chunk) => {
      const lines = (rest + chunk).split("\n");
      rest = lines.pop()!;
      for (const line of lines) {
        const m = JSON.parse(line) as { request_id?: number; data?: unknown };
        if (m.request_id !== undefined && m.request_id >= 9000) got.set(m.request_id - 9000, m.data);
      }
      if (got.size === commands.length) {
        socket.end();
        done(commands.map((_, i) => got.get(i)));
      }
    });
    socket.on("error", fail);
    socket.on("close", () => got.size < commands.length && fail(new Error("mpv's pipe closed before it answered")));
  });
const mpvProps = async (names: string[]) =>
  Object.fromEntries((await askMpv(names.map((n) => ["get_property", n]))).map((v, i) => [names[i], v]));
/** mpv's last few reports apart from time, for a failure's detail. */
const trail = (page: Page) =>
  page.evaluate(() =>
    ((window as unknown as { __mpvLog: { name?: string; event?: string; value?: unknown; reason?: string; time?: number | null; at: number }[] }).__mpvLog ?? [])
      .filter((m) => m.name !== "time-pos" && m.name !== "demuxer-cache-time")
      .slice(-12)
      .map((m) => `${m.at % 100_000} ${m.event ?? m.name}=${JSON.stringify(m.value ?? m.reason ?? null)}@${m.time}`)
      .join(" | "),
  );
const until = async (fn: () => Promise<boolean>, timeout = 30_000) => {
  for (const end = Date.now() + timeout; Date.now() < end; await sleep(250)) if (await fn().catch(() => false)) return true;
  return false;
};
const web = (page: Page) =>
  page.evaluate(() => {
    const v = document.querySelector("video");
    return v ? { t: Math.round(v.currentTime * 100) / 100, paused: v.paused, ready: v.readyState } : null;
  });
const showControls = async (page: Page) => {
  await page.mouse.move(600, 300);
  await page.mouse.move(640, 380);
};
// The controls hide a moment after the pointer rests, and a click as they fade lands on the picture: each press wakes
// them first.
const press = async (page: Page, name: string | RegExp) => {
  await showControls(page);
  await page.getByRole("button", { name, exact: typeof name === "string" }).click();
};
/** Clicks the timeline at `at` seconds of the one-minute test film. */
const seekTo = async (page: Page, at: number) => {
  await showControls(page);
  const bar = (await page.getByRole("slider", { name: "Seek" }).boundingBox())!;
  await page.mouse.click(bar.x + (bar.width * at) / 60, bar.y + bar.height / 2);
};

const browser = await launchBrowser({ args: ["--mute-audio"] });
try {
  // The app's page, through WebView2's DevTools port.
  let cdp = null;
  for (let i = 0; i < 120 && !cdp; i++) cdp = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`).catch(() => sleep(500).then(() => null));
  if (!cdp) throw new Error("The app's DevTools port never opened");
  const context = cdp.contexts()[0];
  await context.addInitScript(() => {
    const w = window as unknown as { __mpvLog: unknown[]; __TAURI__?: { event: { listen: (e: string, h: (e: { payload: object }) => void) => void } } };
    w.__mpvLog = [];
    const listen = () => (w.__TAURI__ ? w.__TAURI__.event.listen("mpv", (e) => w.__mpvLog.push({ ...e.payload, at: Date.now() })) : setTimeout(listen, 50));
    listen();
  });
  const a = context.pages()[0] ?? (await context.waitForEvent("page"));
  watch(a, "app");
  check("the start page moves on to Krida", await until(async () => a.url().startsWith(s.url)), a.url());
  await signIn(a, s.url, pa);
  check("the app tells the site it's the app", await a.evaluate(() => !!(window as { kridaDesktop?: unknown }).kridaDesktop));
  // Full screen. Really going full screen would take over the screen of whoever runs this, so the bridge's calls to
  // the window (kridaDesktop.fullscreen) are recorded instead of made; one real call that changes nothing (leaving
  // full screen) proves the site may make them.
  const permitted = await a.evaluate(() =>
    (window as unknown as { __TAURI__: { window: { getCurrentWindow: () => { setFullscreen: (on: boolean) => Promise<void> } } } }).__TAURI__.window
      .getCurrentWindow().setFullscreen(false).then(() => "allowed", (e) => `refused: ${e}`));
  check("the site may set the window's full screen", permitted === "allowed", permitted);
  const recordFullscreen = () =>
    a.evaluate(() => {
      const w = window as unknown as { __fullscreen: boolean[]; kridaDesktop: { fullscreen: (on: boolean) => void } };
      w.__fullscreen = [];
      w.kridaDesktop.fullscreen = (on) => void w.__fullscreen.push(on);
    });
  const fullscreen = (page: Page) =>
    page.evaluate(() => ({ page: !!document.fullscreenElement, window: (window as unknown as { __fullscreen: boolean[] }).__fullscreen.join(",") }));
  /** Full screen once the page and the window's calls have both settled on what's expected. */
  const settled = async (page: Page, on: boolean, calls: string) => {
    await until(async () => { const f = await fullscreen(page); return f.page === on && f.window === calls; }, 3000);
    return fullscreen(page);
  };
  await recordFullscreen();
  await a.keyboard.press("F11");
  const f11On = await settled(a, true, "true");
  check("F11 on Home takes the whole app full screen", f11On.page && f11On.window === "true", JSON.stringify(f11On));
  await a.keyboard.press("F11");
  const f11Off = await settled(a, false, "true,false");
  check("F11 again leaves full screen", !f11Off.page && f11Off.window === "true,false", JSON.stringify(f11Off));
  // Settings' Open in full screen, kept by the app in this run's own data folder, so the owner's choice stays as it is.
  const opens = await a.evaluate(async () => {
    const { invoke } = (window as unknown as { __TAURI__: { core: { invoke: <T>(c: string, a?: object) => Promise<T> } } }).__TAURI__.core;
    const before = await invoke<boolean>("open_fullscreen");
    await invoke("set_open_fullscreen", { on: true });
    const on = await invoke<boolean>("open_fullscreen");
    await invoke("set_open_fullscreen", { on: false });
    return { before, on, off: await invoke<boolean>("open_fullscreen") };
  }).catch((e) => ({ error: String(e) }));
  check("the app keeps Open in full screen", JSON.stringify(opens) === '{"before":false,"on":true,"off":false}', JSON.stringify(opens));
  const client = new ConvexHttpClient(s.convexUrl);
  const { token: tokenA } = await convexSignIn(client, pa);
  const { token: tokenB, _id: idB } = await convexSignIn(client, pb);

  // ----- alone: the film plays in mpv, under the page
  const solo = await client.mutation(makeFunctionReference<"mutation">("rooms:create"), { token: tokenA, media, screen: "sdr" });
  await a.goto(`${s.url}/watch/${solo}`, { waitUntil: "domcontentloaded" });
  check("mpv starts playing the film", await until(async () => { const m = await mpv(a); return m.paused === false && (m.t ?? 0) > 2; }, 90_000), JSON.stringify(await mpv(a)));
  const page = await a.evaluate(() => ({
    hls: document.querySelector("video")?.currentSrc ?? null,
    see: document.documentElement.hasAttribute("data-desktop-video"),
    body: getComputedStyle(document.body).backgroundColor,
    html: getComputedStyle(document.documentElement).backgroundColor,
  }));
  check("the page's <video> loads nothing: no HLS", page.hls === "", JSON.stringify(page));
  check("the page is see-through over the picture", page.see && page.body === "rgba(0, 0, 0, 0)" && page.html === "rgba(0, 0, 0, 0)", JSON.stringify(page));
  // Above a target's black of 0, mpv raises everything near black, which an OLED shows (docs/desktop.md, "Blacks").
  const { "video-target-params": target } = await mpvProps(["video-target-params"]);
  check("mpv doesn't raise the picture's blacks", (target as { "min-luma"?: number })["min-luma"] === 0, JSON.stringify(target));
  await showControls(a);
  await sleep(600);
  capture("solo-playing.png");

  await recordFullscreen();
  await press(a, "Full screen (F)");
  const playerOn = await settled(a, true, "true");
  check("the player's Full screen button takes the app full screen", playerOn.page && playerOn.window === "true", JSON.stringify(playerOn));
  await a.keyboard.press("Escape");
  const playerOff = await settled(a, false, "true,false");
  check("Esc leaves full screen", !playerOff.page && playerOff.window === "true,false", JSON.stringify(playerOff));

  await press(a, /^Pause/);
  check("Pause pauses mpv", await until(async () => (await mpv(a)).paused === true), await trail(a));
  await seekTo(a, 30);
  check("the timeline seeks mpv to about 0:30", await until(async () => Math.abs(((await mpv(a)).t ?? 0) - 30) < 2), JSON.stringify(await mpv(a)));
  const shown = await a.getByText(/^0:(29|30|31)$/).first().isVisible().catch(() => false);
  check("the controls show mpv's time", shown);
  await press(a, /^Play \(/);
  check("Play plays mpv again", await until(async () => (await mpv(a)).paused === false), await trail(a));
  capture("solo-seeked.png");

  // The Picture menu sets how mpv fits the picture, read back from mpv itself (it answers video-unscaled's yes and no
  // as true and false), with mpv's own picture of its window for each.
  const fitIs = (want: Record<string, unknown>) => until(async () => JSON.stringify(await mpvProps(Object.keys(want))) === JSON.stringify(want), 5000);
  for (const [row, want] of [
    [/^Crop/, { panscan: 1, keepaspect: true, "video-unscaled": false }],
    [/^Stretch/, { panscan: 0, keepaspect: false, "video-unscaled": false }],
    [/^Original/, { panscan: 0, keepaspect: true, "video-unscaled": true }],
    [/^Fit/, { panscan: 0, keepaspect: true, "video-unscaled": false }],
  ] as const) {
    await press(a, "Picture (V)");
    await a.getByRole("button", { name: row }).click();
    const name = String(row).slice(2, -1).toLowerCase();
    check(`Picture: ${name} sets mpv's fit`, await fitIs(want), JSON.stringify(await mpvProps(Object.keys(want))));
    await a.keyboard.press("Escape");
    await sleep(300);
    await askMpv([["screenshot-to-file", resolve(out, `fit-${name}.png`), "window"]]);
  }
  // V steps through the same fits, and the one chosen is remembered on this computer for the next film.
  await showControls(a);
  await a.keyboard.press("v");
  check("V moves on to Crop", await fitIs({ panscan: 1, keepaspect: true }), JSON.stringify(await mpvProps(["panscan", "keepaspect"])));
  check("and the fit is remembered", (await a.evaluate(() => localStorage.getItem("krida.fit"))) === "crop");
  for (let i = 0; i < 3; i++) await a.keyboard.press("v");
  check("three more presses come back round to Fit", await fitIs({ panscan: 0, keepaspect: true, "video-unscaled": false }), JSON.stringify(await mpvProps(["panscan", "keepaspect", "video-unscaled"])));

  // mpv scales with spline36 and evens out banding unless the Picture menu's switch turns it off, which is remembered.
  check("mpv scales the picture with spline36 and debands it", await fitIs({ scale: "spline36", cscale: "spline36", deband: true }), JSON.stringify(await mpvProps(["scale", "cscale", "deband"])));
  await press(a, "Picture (V)");
  check("the Picture menu names its keys", await a.getByText("next fit").isVisible());
  await a.getByRole("switch", { name: /^Smooth colour banding/ }).click();
  check("switching banding off turns mpv's deband off", await fitIs({ deband: false }), JSON.stringify(await mpvProps(["deband"])));
  check("and is remembered", (await a.evaluate(() => localStorage.getItem("krida.deband"))) === "off");
  await a.getByRole("switch", { name: /^Smooth colour banding/ }).click();
  check("switching it on again debands", await fitIs({ deband: true }), JSON.stringify(await mpvProps(["deband"])));
  await a.keyboard.press("Escape");

  // Three quick skips back (skipping.ts): the first lands at once, the other two gather into one seek after the last,
  // the timeline goes straight to where they aim, the shown time never runs forward again on the way (the room's
  // answer to the first used to pull the picture back to it), and no spinner flashes over skips that land at once.
  // From 0:45, so they land after the stand-in's intro (0:02 to 0:12), which would skip itself.
  await seekTo(a, 45);
  await until(async () => Math.abs(((await mpv(a)).t ?? 0) - 45) < 2);
  // The player's keys, not the focused timeline's own 5-second steps.
  await a.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const before = (await mpv(a)).t ?? 0;
  await a.evaluate(() => {
    const w = window as unknown as { __skip: { shown: number; spinner: boolean }[]; __skipFrom: number; __skipTimer: number; __mpvLog: unknown[] };
    w.__skip = [];
    w.__skipFrom = w.__mpvLog.length;
    w.__skipTimer = window.setInterval(() => w.__skip.push({
      shown: Number(document.querySelector('[role="slider"][aria-label="Seek"]')?.getAttribute("aria-valuenow")),
      spinner: !!document.querySelector('[role="status"][aria-label="Loading"]'),
    }), 30);
  });
  for (let i = 0; i < 3; i++) {
    await a.keyboard.press("ArrowLeft");
    await sleep(60);
  }
  await sleep(2500);
  const skipped = await a.evaluate(() => {
    const w = window as unknown as { __skip: { shown: number; spinner: boolean }[]; __skipFrom: number; __skipTimer: number; __mpvLog: { event?: string }[] };
    clearInterval(w.__skipTimer);
    return { samples: w.__skip, seeks: w.__mpvLog.slice(w.__skipFrom).filter((m) => m.event === "seek").length };
  });
  const forwardAgain = skipped.samples.some((x, i) => i > 0 && x.shown - skipped.samples[i - 1].shown > 1.5);
  const after = (await mpv(a)).t ?? 0;
  const shownPath = `${skipped.seeks} seeks, shown ${[...new Set(skipped.samples.map((x) => x.shown))].join(" → ")}, mpv ${before.toFixed(1)} → ${after.toFixed(1)}`;
  check("three quick skips back seek twice, land 30 s back and never bounce", skipped.seeks === 2 && !forwardAgain && Math.abs(after - (before - 30)) < 4, shownPath);
  check("the timeline shows where quick skips aim at once", skipped.samples.slice(0, 10).some((x) => Math.abs(x.shown - (before - 30)) < 2), shownPath);
  check("a skip that lands at once shows no spinner", !skipped.samples.some((x) => x.spinner), `${skipped.samples.filter((x) => x.spinner).length * 30} ms of spinner`);

  // The test film has no black bars built in: its first picture lit to the edges settles that, and mpv shows it whole.
  const crop = async () => String((await mpvProps(["video-crop"]))["video-crop"]);
  await press(a, "Picture (V)");
  const whole = await until(async () => (await a.getByText("No bars built in").isVisible()) && (await crop()) === "", 20_000);
  check("a film with no bars built in is left whole", whole, await crop());
  await a.keyboard.press("Escape");

  await press(a, "Back");
  check("leaving the player stops mpv", await until(async () => (await mpv(a)).stopped));
  check("the page is solid again", await until(() => a.evaluate(() => !document.documentElement.hasAttribute("data-desktop-video") && getComputedStyle(document.documentElement).backgroundColor !== "rgba(0, 0, 0, 0)")));

  // ----- a film with black bars built in: the app's own pick, the 2160p source, whose file is a 2.39:1 film in a
  // 1080p frame (scripts/regress/providers.ts). From 0:12 a shot lit only between dark sky and ground leaves a band in
  // a film's shape (2.76:1); the film fades in at 0:26, is bright from 0:30 and dark again from 1:10 to 1:16. Bars
  // settle once they've held for 20 seconds of film. mpv's own pictures of its window show each stage.
  const at = (t: number) => until(async () => ((await mpv(a)).t ?? 0) >= t, 60_000);
  const shoot = (name: string) => askMpv([["screenshot-to-file", resolve(out, name), "window"]]);
  const wide = await client.mutation(makeFunctionReference<"mutation">("rooms:create"), { token: tokenA, media, screen: "app", startAt: 12 });
  await a.goto(`${s.url}/watch/${wide}`, { waitUntil: "domcontentloaded" });
  check("the app plays its pick, the film with bars built in", await at(13) && String((await mpvProps(["path"])).path).includes("/dld/3"), JSON.stringify(await mpvProps(["path"])));
  await at(24);
  await shoot("bars-dark-edges.png");
  check("its opening shot, lit only between dark sky and ground, isn't taken for bars", (await crop()) === "", await crop());
  await at(40);
  await shoot("bars-before.png");
  check("nor are the film's first bright seconds: the bars wait to settle", (await crop()) === "", await crop());
  check("then mpv trims the bars, down to the film's own picture", await until(async () => (await crop()) === "1920x804+0+138", 20_000), `${await crop()} at ${(await mpv(a)).t}`);
  await sleep(1500);
  await shoot("bars-after.png");
  await press(a, "Picture (V)");
  check("the Picture menu says the bars are trimmed", await a.getByText("Trimmed the built-in bars").waitFor({ timeout: 5000 }).then(() => true, () => false));
  await a.keyboard.press("Escape");
  await at(73);
  await shoot("bars-dark-scene.png");
  check("a dark scene leaves the trim as it was", (await crop()) === "1920x804+0+138", await crop());
  // The switch puts the bars back, is remembered, and trims again at once, without looking again.
  await press(a, "Picture (V)");
  await a.getByRole("switch", { name: /^Trim black bars/ }).click();
  check("switching trimming off puts the bars back", await until(async () => (await crop()) === "" && (await a.getByText("Built-in bars stay").isVisible()), 5000), await crop());
  check("and is remembered", (await a.evaluate(() => localStorage.getItem("krida.trimBars"))) === "off");
  await a.getByRole("switch", { name: /^Trim black bars/ }).click();
  check("switching it on trims them again at once", await until(async () => (await crop()) === "1920x804+0+138", 5000), await crop());
  await a.keyboard.press("Escape");
  // B does the same from the keyboard.
  await showControls(a);
  await a.keyboard.press("b");
  check("B puts the bars back", await until(async () => (await crop()) === "", 5000), await crop());
  await a.keyboard.press("b");
  check("and B again trims them", await until(async () => (await crop()) === "1920x804+0+138", 5000), await crop());
  await press(a, "Back");
  await until(async () => (await mpv(a)).stopped);

  // Settings has the app's own section: its version, where updates stand (a debug build has them off), and the same
  // picture settings as the Picture menu, as they were left.
  await a.goto(`${s.url}/settings/app`, { waitUntil: "domcontentloaded" });
  const section = a.locator("section", { has: a.getByRole("heading", { name: "Krida for Windows" }) });
  check("Settings shows the app's version and its updates", await section.getByText(/^Version \d+\.\d+\.\d+$/).waitFor({ timeout: 10_000 }).then(async () => (await section.getByText("Updates are off in this build.").isVisible())), await section.innerText().catch(() => "no section"));
  check("and its picture settings as they were left", (await section.getByLabel("Picture").inputValue()) === "fit" && (await section.getByRole("switch", { name: /^Trim black bars/ }).isChecked()) && (await section.getByRole("switch", { name: /^Smooth colour banding/ }).isChecked()));
  await section.scrollIntoViewIfNeeded();
  capture("settings.png");

  // ----- a party with someone on the web
  const b = await (await browser.newContext({ viewport: { width: 1280, height: 760 } })).newPage();
  watch(b, "web");
  await signIn(b, s.url, pb);
  const party = await client.mutation(makeFunctionReference<"mutation">("rooms:createParty"), { token: tokenA, media, inviteIds: [idB], screen: "sdr" });
  void tokenB;
  await Promise.all([a.goto(`${s.url}/watch/${party}`, { waitUntil: "domcontentloaded" }), b.goto(`${s.url}/watch/${party}`, { waitUntil: "domcontentloaded" })]);
  const bothPlaying = await until(async () => {
    const [ma, wb] = [await mpv(a), await web(b)];
    return ma.paused === false && (ma.t ?? 0) > 1 && !!wb && !wb.paused && wb.ready >= 3;
  }, 120_000);
  check("app and web both start playing", bothPlaying, JSON.stringify({ app: await mpv(a), web: await web(b) }));
  await sleep(4000);
  let [ma, wb] = [await mpv(a), await web(b)];
  check("they play in step", ma.t !== null && !!wb && Math.abs(ma.t - wb.t) < DRIFT_S, JSON.stringify({ app: ma, web: wb }));
  await showControls(a);
  capture("party-app.png");
  await b.screenshot({ path: resolve(out, "party-web.png") });

  // The web pauses: the app pauses.
  await press(b, /^Pause/);
  check("the app pauses when the web does", await until(async () => (await mpv(a)).paused === true));

  // The app seeks to 0:40: the web lands there too.
  await seekTo(a, 40);
  check("the web follows the app's seek to 0:40", await until(async () => Math.abs(((await web(b))?.t ?? 0) - 40) < 1.5), JSON.stringify({ app: await mpv(a), web: await web(b) }));
  check("the web is told the app skipped ahead", await b.getByText(/skipped to 0:4\d/).first().waitFor({ timeout: 10_000 }).then(() => true, () => false));

  // The app plays: both run, in step.
  await press(a, /^Play \(/);
  check("the web resumes when the app plays", await until(async () => (await web(b))?.paused === false));
  await sleep(3000);
  [ma, wb] = [await mpv(a), await web(b)];
  check("still in step after resuming", ma.t !== null && !!wb && !ma.paused && !wb.paused && Math.abs(ma.t - wb.t) < DRIFT_S, JSON.stringify({ app: ma, web: wb }));
  capture("party-resumed.png");
} finally {
  finish();
  await browser.close();
  app.kill();
}
