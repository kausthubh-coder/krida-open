// The landing page's cold load for a signed-out visitor, from a production build served like Vercel (brotli, immutable
// assets): LCP, which element it was, and the bytes of JavaScript, CSS and images that came over the wire. Each run is
// a new browser context (empty cache), on a phone profile (Slow 4G: 150 ms, 1.6 Mbps down, 4x slower CPU) and on a
// desktop with no throttling. Each run is paired with one where this browser has signed in before (the hint
// src/data/hint.ts reads), which loads the whole app and draws the same page from it, alternating so neither side gets
// the warmer machine. Counts failed requests and checks the page drew its heading. Prints medians and every run.
//   npx vite build && node scripts/perf-landing.ts [--runs 5]
import http from "node:http";
import zlib from "node:zlib";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { launchBrowser } from "./lib/browser.ts";

const runsArg = process.argv.indexOf("--runs");
const RUNS = runsArg < 0 ? 5 : Number(process.argv[runsArg + 1]);
const types: Record<string, string> = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json",
  ".woff2": "font/woff2", ".png": "image/png", ".webp": "image/webp", ".webmanifest": "application/manifest+json",
};
const files = new Map<string, { body: Buffer; type: string; br: Buffer | null }>();
const walk = (dir: string) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else {
      const body = readFileSync(p);
      const type = types[extname(p)] ?? "application/octet-stream";
      files.set("/" + p.slice("dist/".length), { body, type, br: /text|javascript|json|svg/.test(type) ? zlib.brotliCompressSync(body) : null });
    }
  }
};
walk("dist");
const server = http.createServer((req, res) => {
  const path = new URL(req.url!, "http://x").pathname;
  const f = files.get(path) ?? files.get("/index.html")!;
  const br = f.br && /\bbr\b/.test(String(req.headers["accept-encoding"] ?? ""));
  res.writeHead(200, {
    "content-type": f.type,
    "cache-control": path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
    ...(br ? { "content-encoding": "br" } : {}),
  });
  res.end(br ? f.br : f.body);
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

type Run = { lcp: number; element: string; js: number; css: number; img: number; requests: string[]; failed: number; drawn: boolean };
const browser = await launchBrowser({ headless: true });

async function once(phone: boolean, app: boolean): Promise<Run> {
  const context = await browser.newContext(
    phone ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 900 } },
  );
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  if (phone) {
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 });
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  }
  // Bytes on the wire per request, by what kind it is.
  const kinds = new Map<string, string>();
  const bytes = { js: 0, css: 0, img: 0 };
  const requests: string[] = [];
  let failed = 0;
  cdp.on("Network.responseReceived", (e) => {
    kinds.set(e.requestId, e.type);
    if (e.response.status >= 400) failed++;
  });
  cdp.on("Network.loadingFailed", (e) => {
    if (!e.canceled) failed++;
  });
  cdp.on("Network.loadingFinished", (e) => {
    const kind = kinds.get(e.requestId);
    if (kind === "Script") bytes.js += e.encodedDataLength;
    else if (kind === "Stylesheet") bytes.css += e.encodedDataLength;
    else if (kind === "Image") bytes.img += e.encodedDataLength;
  });
  cdp.on("Network.requestWillBeSent", (e) => requests.push(e.request.url.replace(base, "")));
  if (app) await page.addInitScript(() => localStorage.setItem("krida.signedIn", "1"));
  await page.addInitScript(() => {
    (window as unknown as { __lcp: { t: number; el: string } }).__lcp = { t: 0, el: "" };
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as (PerformanceEntry & { element?: Element })[])
        (window as unknown as { __lcp: { t: number; el: string } }).__lcp = { t: entry.startTime, el: entry.element ? `${entry.element.tagName.toLowerCase()} ${(entry.element.textContent ?? "").slice(0, 30) || (entry.element as HTMLImageElement).currentSrc?.split("/").pop() || ""}` : "" };
    }).observe({ type: "largest-contentful-paint", buffered: true });
  });
  await page.goto(base + "/", { waitUntil: "load", timeout: 120_000 });
  const drawn = await page.getByRole("heading", { name: "Press play on anything", level: 1 }).waitFor({ timeout: 60_000 }).then(() => true, () => false);
  await page.waitForTimeout(phone ? 4000 : 2000);
  // LCP is final once the person interacts; a click on nothing ends it.
  await page.mouse.click(5, 5);
  const lcp = await page.evaluate(() => (window as unknown as { __lcp: { t: number; el: string } }).__lcp);
  await context.close();
  return { lcp: Math.round(lcp.t), element: lcp.el, ...bytes, requests, failed, drawn };
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
const report = (label: string, runs: Run[]) => {
  console.log(`  ${label}: LCP median ${median(runs.map((r) => r.lcp))} ms (runs: ${runs.map((r) => r.lcp).join(", ")}), element: ${runs[0].element}`);
  console.log(`    JS ${kb(median(runs.map((r) => r.js)))}, CSS ${kb(median(runs.map((r) => r.css)))}, images ${kb(median(runs.map((r) => r.img)))} over the wire (median); ${runs.filter((r) => r.drawn).length}/${runs.length} drew the page, ${runs.reduce((n, r) => n + r.failed, 0)} failed requests`);
};
for (const phone of [true, false]) {
  const landing: Run[] = [];
  const app: Run[] = [];
  for (let i = 0; i < RUNS; i++) {
    landing.push(await once(phone, false));
    app.push(await once(phone, true));
  }
  console.log(`\n${phone ? "Phone, Slow 4G + 4x CPU" : "Desktop, no throttling"} (${RUNS} runs each, cold cache, alternating)`);
  report("Landing only (never signed in here)", landing);
  report("Whole app (signed in here before)", app);
  console.log(`    Landing-only scripts: ${landing[0].requests.filter((u) => u.endsWith(".js")).join(" ")}`);
}
await browser.close();
server.close();
