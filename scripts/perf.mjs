// Times cold loads and everyday interactions in real Chrome against a local production build.
// Serves dist/ like Vercel (brotli, immutable assets) and times every Convex call from inside the page.
//   npx vite build
//   KRIDA_QA_TOKEN=<session of a disposable Perf-QA dev profile> node scripts/perf.mjs [--runs 3] [--play] [--only cold|interact|play]
import assert from "node:assert/strict";
import http from "node:http";
import zlib from "node:zlib";
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join, extname } from "node:path";
import { launchBrowser } from "./lib/browser.ts";
import { ConvexHttpClient } from "convex/browser";

const token = process.env.KRIDA_QA_TOKEN;
assert.ok(token, "Set KRIDA_QA_TOKEN for a disposable Perf-QA profile");
const convexUrl = readFileSync(".env.local", "utf8").match(/VITE_CONVEX_URL=(\S+)/)?.[1];
assert.ok(convexUrl && !convexUrl.includes("industrious-axolotl-949"), "Dev backend only");
assert.match((await new ConvexHttpClient(convexUrl).query("profiles:me", { token }))?.name ?? "", /^Perf-QA/);
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? fallback : process.argv[i + 1];
};
const RUNS = Number(arg("--runs", 3));
const PLAY = process.argv.includes("--play");
const ONLY = arg("--only"); // cold | interact | play
const out = ".artifacts/perf";
mkdirSync(out, { recursive: true });

// --- Static server: brotli for text, immutable /assets, SPA fallback -------------------------------
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".woff2": "font/woff2", ".mp3": "audio/mpeg", ".png": "image/png", ".webp": "image/webp", ".ico": "image/x-icon" };
const files = new Map();
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else {
      const body = readFileSync(p);
      const type = types[extname(p)] ?? "application/octet-stream";
      const text = /text|javascript|json|svg/.test(type);
      files.set("/" + p.slice("dist/".length).replaceAll("\\", "/"), { body, type, br: text ? zlib.brotliCompressSync(body) : null });
    }
  }
};
walk("dist");
const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  // PostHog under /relay, as vercel.json's rewrites give it, so a build that sends telemetry pays its real cost.
  if (path.startsWith("/relay/")) {
    const rest = req.url.slice("/relay".length);
    const host = /^\/(static|array)\//.test(rest) ? "https://us-assets.i.posthog.com" : "https://us.i.posthog.com";
    const body = req.method === "POST" ? Buffer.concat(await Array.fromAsync(req)) : undefined;
    const answer = await fetch(host + rest, { method: req.method, body, headers: { "content-type": req.headers["content-type"] ?? "text/plain" } }).catch(() => null);
    res.writeHead(answer?.status ?? 502, { "content-type": answer?.headers.get("content-type") ?? "text/plain" });
    return res.end(answer ? Buffer.from(await answer.arrayBuffer()) : "");
  }
  const f = files.get(path) ?? files.get("/index.html");
  const br = f.br && /\bbr\b/.test(req.headers["accept-encoding"] ?? "");
  res.writeHead(200, {
    "content-type": f.type,
    "cache-control": path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
    ...(br ? { "content-encoding": "br" } : {}),
  });
  res.end(br ? f.br : f.body);
});
await new Promise((r) => server.listen(4180, "127.0.0.1", r));
const base = "http://127.0.0.1:4180";

// --- In-page instrumentation ---------------------------------------------------------------------------
function instrument(session) {
  localStorage.setItem("krida.session", session);
  const log = (window.__cx = []);
  const pending = new Map();
  const Native = window.WebSocket;
  window.WebSocket = class extends Native {
    constructor(...a) {
      super(...a);
      this.addEventListener("message", (e) => {
        const t = performance.now();
        let m;
        try { m = JSON.parse(e.data); } catch { return; }
        if (m.type === "Transition")
          for (const mod of m.modifications) {
            const p = pending.get("q" + mod.queryId);
            if (p && p.end === undefined && (mod.type === "QueryUpdated" || mod.type === "QueryFailed")) {
              p.end = t;
              p.bytes = JSON.stringify(mod.value ?? mod.errorMessage ?? "").length;
              p.failed = mod.type === "QueryFailed";
            }
          }
        if (m.type === "MutationResponse" || m.type === "ActionResponse") {
          const p = pending.get(m.type[0] + m.requestId);
          if (p) Object.assign(p, { end: t, bytes: JSON.stringify(m.result ?? "").length, failed: !m.success });
        }
      });
    }
    send(data) {
      const t = performance.now();
      try {
        const m = JSON.parse(data);
        if (m.type === "ModifyQuerySet")
          for (const mod of m.modifications)
            if (mod.type === "Add") {
              const r = { kind: "query", fn: mod.udfPath, start: t };
              pending.set("q" + mod.queryId, r);
              log.push(r);
            }
        if (m.type === "Mutation" || m.type === "Action") {
          const r = { kind: m.type.toLowerCase(), fn: m.udfPath, start: t };
          pending.set(m.type[0] + m.requestId, r);
          log.push(r);
        }
      } catch {}
      return super.send(data);
    }
  };
  window.__input = 0;
  for (const ev of ["pointerdown", "keydown"]) addEventListener(ev, () => (window.__input = performance.now()), true);
  window.__long = [];
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push([e.startTime, e.duration]); }).observe({ type: "longtask", buffered: true });
  window.__lcp = 0;
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lcp = e.startTime; }).observe({ type: "largest-contentful-paint", buffered: true });
  window.__vis = (sel, root = document) =>
    [...root.querySelectorAll(sel)].some((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.top < innerHeight && r.bottom > 0 && getComputedStyle(e).visibility !== "hidden";
    });
  // Rendered at all, even below the fold (Home's poster rows start under a tall hero).
  window.__has = (sel, root = document) =>
    [...root.querySelectorAll(sel)].some((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  // The Watch page announces each preparing step ("Finding sources…") in a live region.
  window.__steps = [];
  new MutationObserver(() => {
    const text = [...document.querySelectorAll("span.sr-only[aria-live]")].map((e) => e.textContent).join(" ").trim();
    if (text && text !== window.__steps.at(-1)?.[1]) window.__steps.push([performance.now(), text]);
  }).observe(document, { subtree: true, childList: true, characterData: true });
  window.__h2 = (text) => [...document.querySelectorAll("main h2")].find((h) => h.textContent.trim() === text);
}

// Readiness checks, run in the page every frame; each returns performance.now() once true.
const READY = {
  shell: `__vis("header a[aria-label='Krida home']")`,
  hero: `__vis("section[aria-label='Featured']") || __vis("main h1")`,
  firstRow: `__has("main section[aria-labelledby] [data-rail] a[href^='/title/']")`,
  homeDone: `__has("main section[aria-labelledby] [data-rail] a[href^='/title/']") && !document.querySelector("main .skeleton")`,
  firstArt: `__has("main [data-rail] img.opacity-100")`,
  titleHead: `__vis("main h1") && !document.querySelector("main[aria-busy]")`,
  titlePlay: `[...document.querySelectorAll("main button")].some((b) => /^(Play|Resume)/.test(b.textContent.trim()))`,
  titleRatings: `__vis("ul[aria-label='Ratings']:not([aria-busy])")`,
  titleMore: `!!__h2("More like this")`,
  episodes: `__vis("section[aria-labelledby='episodes-heading'] li")`,
  suggest: `(() => { const l = document.querySelector("[role=listbox][aria-label=Suggestions]"); return !!l && l.querySelectorAll("[role=option]").length > 1 && !l.querySelector(".opacity-50") && !/Finding titles/.test(l.textContent); })()`,
  results: `__has("main a[href^='/title/']") && !document.querySelector("main [aria-busy='true'], main .skeleton") && !/Searching TMDB/.test(document.querySelector("main")?.textContent ?? "")`,
  browse: `__has("ol a[href^='/title/']")`,
  library: `__vis("main h1") && __has("main a[href^='/title/']") && !document.querySelector("main [aria-busy='true']")`,
  stats: `__vis("section[aria-label='Time watched']")`,
  gate: `__vis("main button, button") && /Who.s watching/.test(document.body.textContent)`,
  playerMounted: `!!document.querySelector("video")`,
  videoPlaying: `(() => { const v = document.querySelector("video"); return !!v && !v.paused && v.currentTime > 0 && v.readyState >= 3; })()`,
};
async function until(page, check, timeout = 30_000) {
  try {
    const h = await page.waitForFunction(`(${check}) ? performance.now() : false`, null, { polling: "raf", timeout });
    return await h.jsonValue();
  } catch {
    return null;
  }
}

// --- Browser ------------------------------------------------------------------------------------------
const browser = await launchBrowser({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const results = []; // { scenario, metric, ms, run }
const calls = {}; // scenario -> Convex call log of the last run
const bytes = {}; // scenario -> transferred bytes by kind
const record = (scenario, metric, ms, run) => results.push({ scenario, metric, ms: ms == null ? null : Math.round(ms), run });

async function newPage({ mobile = false, signedIn = true } = {}) {
  const context = await browser.newContext(
    mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 900 } },
  );
  await context.addInitScript(instrument, signedIn ? token : "");
  if (!signedIn) await context.addInitScript(() => localStorage.removeItem("krida.session"));
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  const kinds = new Map();
  const sizes = {};
  cdp.on("Network.responseReceived", (e) => kinds.set(e.requestId, `${e.type}:${new URL(e.response.url).host}`));
  cdp.on("Network.loadingFinished", (e) => {
    const k = kinds.get(e.requestId) ?? "other";
    sizes[k] ??= { n: 0, kb: 0 };
    sizes[k].n++;
    sizes[k].kb += e.encodedDataLength / 1024;
  });
  page.on("pageerror", (e) => console.log("  pageerror:", e.message));
  if (mobile) {
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 80, downloadThroughput: (10e6 / 8), uploadThroughput: (3e6 / 8) });
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  }
  return { context, page, sizes };
}
const convexLog = (page) => page.evaluate(() => window.__cx.map((c) => ({ ...c, ms: c.end == null ? null : c.end - c.start })));
const sinceInput = async (page, check, timeout) => {
  const t = await until(page, check, timeout);
  return t == null ? null : t - (await page.evaluate(() => window.__input));
};
const nav = (page) => page.evaluate(() => {
  const n = performance.getEntriesByType("navigation")[0];
  const fcp = performance.getEntriesByName("first-contentful-paint")[0];
  const tbt = window.__long.reduce((s, [, d]) => s + Math.max(0, d - 50), 0);
  return { ttfb: n.responseStart, domContentLoaded: n.domContentLoadedEventEnd, fcp: fcp?.startTime, lcp: window.__lcp, tbt };
});

// --- Cold loads: a fresh browser profile each run, so nothing is cached ---------------------------------
async function coldLoad(scenario, path, checks, opts = {}) {
  for (let run = 0; run < RUNS; run++) {
    const { context, page, sizes } = await newPage(opts);
    await page.goto(base + path, { waitUntil: "commit" });
    for (const [metric, check] of Object.entries(checks)) record(scenario, metric, await until(page, check, 45_000), run);
    await page.waitForTimeout(500);
    const n = await nav(page);
    for (const k of ["fcp", "lcp", "tbt"]) record(scenario, k, n[k], run);
    // Same profile again: the HTTP cache is warm, like opening Krida a second time.
    await page.reload({ waitUntil: "commit" });
    const last = Object.entries(checks).at(-1);
    record(scenario + " (repeat visit)", last[0], await until(page, last[1], 45_000), run);
    calls[scenario] = await convexLog(page);
    bytes[scenario] = sizes;
    await context.close();
  }
}
if (!ONLY || ONLY === "cold") {
console.log("Cold loads…");
await coldLoad("Open Krida signed out (profile picker)", "/", { gate: READY.gate }, { signedIn: false });
await coldLoad("Open Home", "/", { shell: READY.shell, hero: READY.hero, firstRow: READY.firstRow, firstArt: READY.firstArt, homeDone: READY.homeDone });
await coldLoad("Open Library", "/library?tab=list", { shell: READY.shell, library: READY.library });
await coldLoad("Open Search (Browse)", "/search", { shell: READY.shell, browse: READY.browse });
await coldLoad("Open a title link", "/title/movie/tt0816692", { shell: READY.shell, titleHead: READY.titleHead, titlePlay: READY.titlePlay, titleRatings: READY.titleRatings, titleMore: READY.titleMore });
await coldLoad("Open Home on a phone (4G, 4x slower CPU)", "/", { shell: READY.shell, firstRow: READY.firstRow, homeDone: READY.homeDone }, { mobile: true });

}

// --- Interactions in one session, like a real visit -------------------------------------------------------
if (!ONLY || ONLY === "interact") console.log("Interactions…");
for (let run = 0; run < RUNS && (!ONLY || ONLY === "interact"); run++) {
  const { context, page } = await newPage();
  await page.goto(base + "/");
  await until(page, READY.homeDone, 45_000);
  await page.waitForTimeout(1500);
  const header = page.locator("header");
  const goHome = async () => {
    await header.getByRole("link", { name: "Krida home" }).click();
    return sinceInput(page, READY.homeDone);
  };
  const mark = () => page.evaluate(() => window.__cx.length);
  const callsSince = async (from) => (await convexLog(page)).slice(from);

  // Click a poster (hovering first, like a mouse does, so prefetch runs).
  const hrefs = await page.$$eval("main section[aria-labelledby] [data-rail] a[href^='/title/']", (as) => [...new Set(as.map((a) => a.getAttribute("href")))]);
  const movies = hrefs.filter((h) => h.startsWith("/title/movie/"));
  const series = hrefs.filter((h) => h.startsWith("/title/series/"));
  const picks = [["movie", movies[run * 3]], ["series", series[run * 2]]].filter(([, h]) => h);
  for (const [type, href] of picks) {
    await page.evaluate(() => scrollTo(0, 0));
    const link = page.locator(`main [data-rail] a[href='${href}']`).first();
    await link.scrollIntoViewIfNeeded();
    await link.hover();
    await page.waitForTimeout(300);
    const from = await mark();
    await link.click({ force: true });
    const s = `Click a ${type} poster on Home`;
    record(s, "titleHead", await sinceInput(page, READY.titleHead), run);
    record(s, "titlePlay", await sinceInput(page, READY.titlePlay), run);
    record(s, "titleRatings", await sinceInput(page, READY.titleRatings, 20_000), run);
    record(s, "titleMore", await sinceInput(page, READY.titleMore, 20_000), run);
    if (type === "series") record(s, "episodes", await sinceInput(page, READY.episodes, 20_000), run);
    calls[s] = await callsSince(from);
    // Back to Home with the browser's back button.
    await page.evaluate(() => (window.__input = performance.now()));
    await page.goBack();
    record("Back to Home from a title", "homeDone", await sinceInput(page, READY.homeDone), run);
  }

  // Search from the top bar: suggestions while typing, then Enter for full results.
  const queries = [["a title", "interstellar"], ["anime", "frieren"], ["a person", "christopher nolan"], ["a mood", "telugu comedy"]];
  for (const [what, q] of queries) {
    if (run > 0 && what !== "a title") continue;
    const query = run ? `${q} ${["film", "movie"][run - 1]}` : q;
    const field = header.locator("[data-search-field]");
    await field.click();
    await field.fill("");
    const from = await mark();
    await field.pressSequentially(query, { delay: 90 });
    const s = `Search for ${what} in the top bar`;
    record(s, "suggestions", await sinceInput(page, READY.suggest, 30_000), run);
    await page.keyboard.press("Enter");
    record(s, "results", await sinceInput(page, READY.results, 30_000), run);
    calls[s] = await callsSince(from);
    if (what === "anime") {
      const top = page.locator("main a[href^='/title/']").first();
      await top.hover();
      await page.waitForTimeout(300);
      await top.click();
      record("Click a search result", "titleHead", await sinceInput(page, READY.titleHead), run);
      record("Click a search result", "titleMore", await sinceInput(page, READY.titleMore, 20_000), run);
    }
    record("Go Home from the logo", "homeDone", await goHome(), run);
  }

  // Library: open it, switch collections, open Stats.
  let from = await mark();
  await header.getByRole("link", { name: "Library", exact: true }).click();
  record("Open Library from the nav", "library", await sinceInput(page, READY.library), run);
  calls["Open Library from the nav"] = await callsSince(from);
  const lib = page.getByRole("navigation", { name: "Library" });
  for (const name of ["Watched", "Watching", "All"]) {
    await lib.getByRole("link", { name: new RegExp(`^${name}`) }).first().click();
    record(`Switch Library to ${name}`, "library", await sinceInput(page, READY.library), run);
  }
  from = await mark();
  await lib.getByRole("link", { name: /^Stats/ }).first().click();
  record("Open Library stats", "stats", await sinceInput(page, READY.stats, 30_000), run);
  calls["Open Library stats"] = await callsSince(from);
  record("Go Home from the logo", "homeDone", await goHome(), run);

  await context.close();
}

// --- Press Play and wait for the video to actually play (uses TorBox, so only with --play) -------------------
// Each way of pressing Play gets movies nobody has played in the last few hours, so nothing is prepared yet.
const PLAYS = [
  ["Press Play as soon as the page opens", { readMs: 0, restMs: 0 }, ["tt0133093", "tt0109830"]],
  ["Read the page 4 s, then tap Play", { readMs: 4000, restMs: 0, tap: true }, ["tt0468569", "tt1375666"]],
  ["Read the page 3 s, rest on Play 1 s, click", { readMs: 3000, restMs: 1000 }, ["tt0137523", "tt0110912"]],
];
for (const [s, { readMs, restMs, tap }, ids] of PLAY && (!ONLY || ONLY === "play") ? PLAYS : []) {
  for (const [run, id] of ids.entries()) {
    const { context, page } = await newPage();
    await page.goto(base + "/title/movie/" + id);
    await until(page, READY.titlePlay);
    await page.waitForTimeout(readMs);
    const from = await page.evaluate(() => window.__cx.length);
    const button = page.locator("main button").filter({ hasText: /^(Play|Resume)/ }).first();
    if (restMs) {
      await button.hover();
      await page.waitForTimeout(restMs);
    }
    // A tap: no hover first, so only the page's own source prefetch has helped.
    if (tap) await button.dispatchEvent("click");
    else await button.click();
    if (tap) await page.evaluate(() => (window.__input = performance.now()));
    record(s, "watchPage", await sinceInput(page, `location.pathname.startsWith("/watch/")`), run);
    record(s, "playerMounted", await sinceInput(page, READY.playerMounted, 120_000), run);
    record(s, "videoPlaying", await sinceInput(page, READY.videoPlaying, 60_000), run);
    const [input, steps] = await page.evaluate(() => [window.__input, window.__steps]);
    console.log(`  ${s} ${id}: ${steps.map(([t, text]) => `+${Math.round(t - input)} ${text}`).join(", ") || "no preparing steps"}`);
    calls[s] = (await convexLog(page)).slice(from);
    await context.close();
  }
}
await browser.close();
server.close();

// --- Report ----------------------------------------------------------------------------------------------
const median = (a) => {
  const s = a.filter((x) => x != null).sort((x, y) => x - y);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : null;
};
const groups = {};
for (const r of results) (groups[`${r.scenario}|${r.metric}`] ??= []).push(r.ms);
const table = Object.entries(groups).map(([k, v]) => {
  const [scenario, metric] = k.split("|");
  return { scenario, metric, median: median(v), max: Math.max(...v.filter((x) => x != null)), timeouts: v.filter((x) => x == null).length, runs: v };
});
writeFileSync(`${out}/results.json`, JSON.stringify({ table, calls, bytes, at: new Date().toISOString() }, null, 1));
for (const r of table) console.log(`${r.scenario.padEnd(46)} ${r.metric.padEnd(14)} median ${String(r.median).padStart(6)} ms   runs ${JSON.stringify(r.runs)}`);
console.log(`\nWrote ${out}/results.json`);
