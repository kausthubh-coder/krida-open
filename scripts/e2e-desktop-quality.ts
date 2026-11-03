// Krida for Windows on a real TorBox stream of a 4K Dolby Vision film. For each source, the app alone first: what it
// really plays (3840 wide, decoded on the GPU, Dolby Vision applied), that it streams without stalling or dropping
// frames, the CPU it takes, and a paused frame compared with a correct render of the original, which ffmpeg
// (libplacebo, Dolby Vision mapped to SDR) reads straight from TorBox. Then a party with a browser (TorBox's HLS,
// headless Chrome): both play it together, and the frame each shows at the same moment is saved one above the other.
// Nothing is downloaded: ffmpeg reads the one frame it needs over the link.
// Quiet and out of the way like scripts/e2e-desktop.ts. Runs on the dev backend, so it needs this branch's functions
// there, `npm run dev -- --shared`, and two QA profiles on dev with KRIDA_QA_PASSWORD.
// Usage: node scripts/e2e-desktop-quality.ts <QA-one> <QA-two> [source index[:label] ...] (default: Krida's pick)
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { chromium, type Page } from "playwright-core";
import { launchBrowser } from "./lib/browser.ts";
import { baseUrl, checks, convexSignIn, convexUrls, qaProfiles, signIn } from "./lib/qa.ts";

// Node gives each of a host's addresses 250 ms to connect before failing over; on a busy Windows machine with no IPv6,
// reaching Convex can take longer, and every fetch then fails with ETIMEDOUT.
setDefaultAutoSelectFamilyAttemptTimeout(5000);

const repo = resolve(import.meta.dirname, "..");
const exe = resolve(process.env.KRIDA_EXE ?? `${repo}/desktop/src-tauri/target/debug/krida.exe`);
const out = resolve(repo, ".artifacts/desktop-quality");
const base = baseUrl();
const [pa, pb] = qaProfiles([process.argv[2], process.argv[3]]);
const picks = process.argv.slice(4);
const PORT = 9343;
const film = { type: "movie", imdbId: "tt15239678", videoId: "tt15239678", name: "Dune: Part Two", year: "2024" };
/** Where the frames are compared: mid-film, past the logos. */
const FRAME_AT = 600;
/** How long playback is watched for stalls, dropped frames and CPU. */
const WATCH_S = 45;
rmSync(out, { recursive: true, force: true });
// The app's own browser profile, outside the repo so the dev server's file watcher leaves it alone.
const webviewData = resolve(tmpdir(), "krida-e2e-webview");
rmSync(webviewData, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const { check, finish, watch } = checks();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ffmpeg = (args: string[]) => spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { encoding: "utf8", timeout: 300_000 });
// Compared as video is, in YUV: a window capture carries an alpha channel the reference doesn't, which would count.
const ssim = (a: string, b: string) =>
  Number(/All:([\d.]+)/.exec(spawnSync("ffmpeg", ["-hide_banner", "-i", a, "-i", b, "-lavfi", "[0]format=yuv420p[a];[1]format=yuv420p[b];[a][b]ssim", "-f", "null", "-"], { encoding: "utf8" }).stderr)?.[1] ?? NaN);
const capture = (pid: number, file: string) =>
  spawnSync("powershell", ["-NoProfile", "-File", resolve(repo, "desktop/scripts/capture.ps1"), "-ProcessId", String(pid), "-Out", file, "-Client"], { timeout: 60_000 });
const mpvCpu = () => {
  const r = spawnSync("powershell", ["-NoProfile", "-Command", "$p = Get-Process mpv; '{0} {1}' -f $p.TotalProcessorTime.TotalMilliseconds, [Environment]::ProcessorCount"], { encoding: "utf8" });
  const [ms, cores] = r.stdout.trim().split(" ").map(Number);
  return { ms, cores };
};

type Report = { name?: string; event?: string; value?: unknown; time?: number | null; at: number };
const log = (page: Page) => page.evaluate(() => (window as unknown as { __mpvLog: Report[] }).__mpvLog ?? []);
const last = (entries: Report[], name: string) => entries.filter((m) => m.name === name).at(-1)?.value;
const mpvTime = async (page: Page) => {
  const entries = await log(page);
  const t = entries.filter((m) => typeof m.time === "number").at(-1);
  const paused = last(entries, "pause") === true;
  return t ? (t.time as number) + (paused ? 0 : (Date.now() - t.at) / 1000) : 0;
};
const web = (page: Page) =>
  page.evaluate(() => {
    const v = document.querySelector("video");
    return v ? { t: v.currentTime, paused: v.paused, ready: v.readyState, w: v.videoWidth, h: v.videoHeight } : null;
  });
const until = async (fn: () => Promise<boolean>, timeout = 60_000) => {
  for (const end = Date.now() + timeout; Date.now() < end; await sleep(500)) if (await fn().catch(() => false)) return true;
  return false;
};
const press = async (page: Page, name: RegExp) => {
  await page.mouse.move(600, 300);
  await page.mouse.move(640, 380);
  await page.getByRole("button", { name }).click();
};

const client = new ConvexHttpClient(convexUrls().url);
const { token: tokenA } = await convexSignIn(client, pa);
const { _id: idB } = await convexSignIn(client, pb);
const listed = (await client.action(makeFunctionReference<"action">("sources:listRanked"), { token: tokenA, type: "movie", videoId: film.videoId, screen: "hdr" })) as {
  options: { index: number; key: string; resolution?: string; hdr: string[]; bitrate?: number; quality?: string; filename?: string }[];
  pick: number | null;
};
const sources = (picks.length ? picks : [`${listed.pick}:Krida's pick`]).map((p) => {
  const [index, label] = p.split(":");
  const option = listed.options.find((o) => o.index === Number(index))!;
  return { option, label: label ?? `source ${index}` };
});

const app = spawn(exe, [], {
  env: { ...process.env, KRIDA_URL: base, KRIDA_DATA_DIR: webviewData, KRIDA_WINDOW_POS: "-3000,0", KRIDA_SILENT: "1", WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
  stdio: "ignore",
});
const browser = await launchBrowser({ args: ["--mute-audio"] });
try {
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
  await until(async () => a.url().startsWith(base), 30_000);
  await signIn(a, base, pa);
  const b = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  watch(b, "web");
  await signIn(b, base, pb);

  const playingPast = async (t: number) => last(await log(a), "pause") === false && (await mpvTime(a)) > t;
  /** The app's window with the page hidden for a moment: only mpv's picture, without the paused player's controls. */
  const shoot = async (file: string) => {
    await a.evaluate(() => (document.body.style.visibility = "hidden"));
    await sleep(300);
    const r = capture(app.pid!, file);
    await a.evaluate(() => (document.body.style.visibility = ""));
    if (r.status !== 0) throw new Error(`Capturing the app's window failed: ${r.stderr || r.stdout || r.error}`);
  };
  for (const { option, label } of sources) {
    const name = `${label} (${option.resolution} ${option.hdr.join("+")} ${option.quality}, ${option.bitrate} Mbps)`;
    console.log(`\n${name}\n  ${option.filename}`);

    // ----- the app alone: streaming, smoothness, and its frame against the original
    const from = FRAME_AT - WATCH_S - 15;
    const solo = await client.mutation(makeFunctionReference<"mutation">("rooms:create"), { token: tokenA, media: film, startAt: from, sourceIndex: option.index, sourceKey: option.key, screen: "hdr" });
    const opened = Date.now();
    await a.goto(`${base}/watch/${solo}`, { waitUntil: "domcontentloaded" });
    check(`${label}: starts streaming`, await until(() => playingPast(from + 1), 240_000), `${((Date.now() - opened) / 1000).toFixed(0)} s from Play (TorBox prepares the stream first)`);
    const cpu0 = mpvCpu();
    const t0 = Date.now();
    await sleep(WATCH_S * 1000);
    const cpu1 = mpvCpu();
    const entries = await log(a);
    const params = (last(entries, "video-params") ?? {}) as Record<string, unknown>;
    const hwdec = String(last(entries, "hwdec-current") ?? "none");
    const stalls = entries.filter((m) => m.name === "paused-for-cache" && m.value === true && m.at > t0).length;
    const dropsAt = (name: string, before: number) => Number(entries.filter((m) => m.name === name && m.at < before).at(-1)?.value ?? 0);
    const drops = ["frame-drop-count", "decoder-frame-drop-count"].reduce((n, d) => n + dropsAt(d, Infinity) - dropsAt(d, t0), 0);
    const cpu = ((cpu1.ms - cpu0.ms) / (Date.now() - t0) / cpu0.cores) * 100;
    check(`${label}: the app plays the file's whole picture`, params.w === 3840, `${params.w}x${params.h} ${params.pixelformat}`);
    check(`${label}: the GPU decodes it`, /d3d11|dxva|nvdec|vulkan/.test(hwdec), hwdec);
    check(`${label}: Dolby Vision is applied`, params.colormatrix === "dolbyvision", `matrix ${params.colormatrix}, transfer ${params.gamma}`);
    check(`${label}: streams ${WATCH_S} s without stalling`, stalls === 0, `${stalls} stalls`);
    check(`${label}: plays smoothly`, drops <= 2, `${drops} frames dropped in ${WATCH_S} s`);
    console.log(`  mpv: ${cpu.toFixed(1)}% of the machine's CPU`);

    await press(a, /^Pause/);
    await until(async () => last(await log(a), "pause") === true, 20_000);
    await sleep(1500);
    const tApp = await mpvTime(a);
    const shot = resolve(out, `${option.index}-app-window.png`);
    await shoot(shot);
    // The picture's own shape (a scope film is wider than 16:9), cut out of the letterboxed window.
    const aspect = Number(params.aspect) || Number(params.w) / Number(params.h);
    const W = 2560;
    const H = Math.round(W / aspect / 2) * 2;
    const cut = (input: string, output: string) => ffmpeg(["-i", input, "-vf", `crop='min(iw,ih*${aspect})':'min(ih,iw/${aspect})',scale=${W}:${H}`, output]);
    const appPicture = resolve(out, `${option.index}-app.png`);
    cut(shot, appPicture);
    const soloRoom = (await client.query(makeFunctionReference<"query">("rooms:get"), { token: tokenA, roomId: solo })) as { stream?: { _id: string } };
    const link = (await client.action(makeFunctionReference<"action">("desktop:fileLink"), { token: tokenA, streamId: soloRoom.stream!._id })) as string;
    const reference = resolve(out, `${option.index}-original.png`);
    ffmpeg(["-init_hw_device", "vulkan", "-ss", tApp.toFixed(3), "-i", link, "-vf", `libplacebo=w=${W}:h=${H}:colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv:tonemapping=auto:apply_dolbyvision=1:format=yuv420p`, "-frames:v", "1", reference]);
    const score = ssim(appPicture, reference);
    check(`${label}: the app's frame matches the original`, score >= 0.9, `SSIM ${score.toFixed(3)} at ${tApp.toFixed(2)} s`);
    // The timeline's picture: the whole frame, as wide as the film. WebView2 once called only the top-left 1280x720 of
    // a 4K HEVC keyframe the picture, so the card showed that corner blown up at 16:9.
    const seek = (await a.getByRole("slider", { name: "Seek" }).boundingBox())!;
    await a.mouse.move(seek.x + seek.width / 2 - 5, seek.y + seek.height / 2);
    await a.mouse.move(seek.x + seek.width / 2, seek.y + seek.height / 2);
    const card = await a
      .waitForFunction(() => {
        const c = document.querySelector<HTMLCanvasElement>("canvas[aria-hidden]:not(.hidden)");
        return c && { w: c.width, h: c.height, png: c.toDataURL("image/png").split(",")[1] };
      }, null, { timeout: 60_000 })
      .then((h) => h.jsonValue())
      .catch(() => null);
    if (card) writeFileSync(resolve(out, `${option.index}-timeline-card.png`), Buffer.from(card.png, "base64"));
    check(`${label}: the timeline's picture is the whole frame`, !!card && Math.abs(card.w / card.h - aspect) < 0.05, card ? `${card.w}x${card.h}, film ${aspect.toFixed(2)}:1` : "no picture");
    await a.mouse.move(640, 300);

    // ----- with someone on the web: what each side shows at the same moment, side by side
    const party = await client.mutation(makeFunctionReference<"mutation">("rooms:createParty"), { token: tokenA, inviteIds: [idB], screen: "hdr" });
    await client.mutation(makeFunctionReference<"mutation">("rooms:playNow"), { token: tokenA, roomId: party, media: film, startAt: FRAME_AT, sourceIndex: option.index, sourceKey: option.key });
    await Promise.all([a.goto(`${base}/watch/${party}`, { waitUntil: "domcontentloaded" }), b.goto(`${base}/watch/${party}`, { waitUntil: "domcontentloaded" })]);
    const together = await until(async () => {
      const w = await web(b);
      return (await playingPast(FRAME_AT + 1)) && !!w && !w.paused && w.ready >= 3;
    }, 240_000);
    check(`${label}: app and web play it together`, together);
    await sleep(5000);
    await press(a, /^Pause/);
    await until(async () => last(await log(a), "pause") === true && (await web(b))?.paused === true, 20_000);
    await sleep(1500);
    const w = (await web(b))!;
    const tParty = await mpvTime(a);
    const partyShot = resolve(out, `${option.index}-party-app-window.png`);
    await shoot(partyShot);
    const appFrame = resolve(out, `${option.index}-party-app.png`);
    cut(partyShot, appFrame);
    const webFrame = resolve(out, `${option.index}-party-web-native.png`);
    const png = await b.evaluate(async () => {
      const v = document.querySelector("video")!;
      const c = new OffscreenCanvas(v.videoWidth, v.videoHeight);
      c.getContext("2d")!.drawImage(v, 0, 0);
      const bytes = new Uint8Array(await (await c.convertToBlob({ type: "image/png" })).arrayBuffer());
      let s = "";
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(s);
    });
    writeFileSync(webFrame, Buffer.from(png, "base64"));
    const sideBySide = resolve(out, `${option.index}-app-over-web.png`);
    ffmpeg(["-i", appFrame, "-i", webFrame, "-filter_complex", `[1]crop='min(iw,ih*${aspect})':'min(ih,iw/${aspect})',scale=${W}:${H}[web];[0][web]vstack`, sideBySide]);
    console.log(`  web gets ${w.w}x${w.h} from TorBox's HLS; the app (top, at ${tParty.toFixed(2)} s) and the web (bottom, at ${w.t.toFixed(2)} s): ${sideBySide}`);
    check(`${label}: app and web paused on the same moment`, Math.abs(tParty - w.t) < 1, `app ${tParty.toFixed(2)} s, web ${w.t.toFixed(2)} s`);
    await client.mutation(makeFunctionReference<"mutation">("rooms:stop"), { token: tokenA, roomId: party }).catch(() => {});
  }
} finally {
  finish();
  await browser.close();
  app.kill();
}
