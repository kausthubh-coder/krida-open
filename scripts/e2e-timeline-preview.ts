// The picture above the timeline, read from the film's own file: the storyboard fills in from Play through the frames
// Worker (the QA app runs it under /frames-worker) with each keyframe asked for once, the picture at a time is the keyframe there (compared with the video's own frame), a spot already
// seen asks for nothing, the browser never sees TorBox's file link, a card never shows blank, the card stays on a
// phone's screen, and after a reload the pictures come from this device without asking the server. Uses the QA app's
// one-minute test video (its stand-in TorBox serves the same picture as an MKV file).
// Usage: npm run qa -- up, then node scripts/e2e-timeline-preview.ts [outDir]
import { mkdirSync } from "node:fs";
import { launchBrowser } from "./lib/browser.ts";
import { checks, qaSession, signIn } from "./lib/qa.ts";

const out = process.argv[2] ?? ".artifacts/timeline-preview";
mkdirSync(out, { recursive: true });
const s = qaSession();
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const { check, finish } = checks(page);
const frames: string[] = [];
const viaWorker: boolean[] = [];
const seen: string[] = [];
page.on("request", (r) => {
  seen.push(r.url());
  if (/\/(api|frames-worker)\/frame\?/.test(r.url())) {
    frames.push(new URL(r.url()).searchParams.get("cluster")!);
    viaWorker.push(r.url().includes("/frames-worker/frame?"));
  }
});
await signIn(page, s.url, s.profiles[0]);
const play = async () => {
  await page.goto(`${s.url}/title/movie/tt0816692`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Play", exact: true }).first().click();
  await page.waitForURL(/\/watch\//);
  await page.waitForFunction(() => (document.querySelector("video")?.readyState ?? 0) >= 3, null, { timeout: 60_000 });
  await page.getByRole("button", { name: /^Pause/ }).click();
};
await play();
// The keyframes the file's index lists (every stand-in stream reports 1.2 GB, the size the stand-in file answers to).
const index = await page.evaluate(async (backend) => {
  const headers = { "x-krida-backend": backend, "x-krida-session": localStorage.getItem("krida.session") ?? "" };
  return (await fetch("/api/frames?size=1200000000", { headers })).json();
}, s.convexUrl);
const cues: number[] = (index?.points ?? []).map((p: number[]) => p[0] / 1000);
console.log("keyframes in the file's index:", cues.join(" "));
check("the file's index lists its keyframes", cues.length >= 10, String(cues.length));
const bar = (await page.getByRole("slider", { name: "Seek" }).boundingBox())!;
const duration = await page.evaluate(() => document.querySelector("video")!.duration);
const xAt = (t: number) => bar.x + (bar.width * t) / duration;
const y = bar.y + bar.height / 2;

// The storyboard starts at Play; a one-minute title gets 8 pictures.
const until = Date.now() + 15_000;
while (new Set(frames).size < 8 && Date.now() < until) await page.waitForTimeout(200);
check("the storyboard fills in from Play", new Set(frames).size >= 8, `${new Set(frames).size} keyframes`);
check("pictures come through the frames Worker", viaWorker.length > 0 && viaWorker.every(Boolean), `${viaWorker.filter(Boolean).length} of ${viaWorker.length}`);

const card = () => page.locator("canvas[aria-hidden]:not(.hidden)");
const pixels = () => page.evaluate(() => {
  const c = document.querySelector<HTMLCanvasElement>("canvas[aria-hidden]:not(.hidden)");
  if (!c) return null;
  const a = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
  let sum = 0;
  for (let i = 0; i < a.length; i += 4) sum += a[i] * 3 + a[i + 1] * 5 + a[i + 2] * 7 + (i % 997);
  return sum;
});
const settled = async () => {
  let last = await pixels();
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(150);
    const now = await pixels();
    if (now !== null && now === last) return;
    last = now;
  }
};
const snapshot = () => page.evaluate(() => {
  const c = document.querySelector<HTMLCanvasElement>("canvas[aria-hidden]")!;
  (window as unknown as { card: ImageData }).card = c.getContext("2d")!.getImageData(0, 0, c.width, c.height);
});
// Mean difference (0..255) between the kept card and the main video's frame.
const diff = () => page.evaluate(() => {
  const card = (window as unknown as { card: ImageData }).card;
  const v = document.querySelector("video")!;
  const o = document.createElement("canvas"); o.width = card.width; o.height = card.height;
  const ctx = o.getContext("2d")!; ctx.drawImage(v, 0, 0, o.width, o.height);
  const a = card.data;
  const b = ctx.getImageData(0, 0, o.width, o.height).data;
  let sum = 0; for (let i = 0; i < a.length; i += 4) sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
  return sum / (a.length / 4) / 3;
});
// Puts the video exactly at `t` (on the element: a click can't land on a frame) and waits for that frame.
const frameAt = (t: number) =>
  page.evaluate((t) => new Promise<number>((resolve) => {
    const v = document.querySelector("video")!;
    v.addEventListener("seeked", () => resolve(v.currentTime), { once: true });
    v.currentTime = t;
  }), t);
// The player's timeline runs a little off the file's own clock, so the closest frame in the first 0.3 s.
const closest = async (from: number) => {
  let best = Infinity;
  for (let k = 0; k < 8; k++) {
    await frameAt(from + k * 0.042);
    best = Math.min(best, await diff());
  }
  return best;
};

for (const t of [37, 19, 49]) {
  const began = Date.now();
  await page.mouse.move(xAt(t), y);
  let blank = false;
  while (!(await card().isVisible()) && Date.now() - began < 10_000) blank ||= (await pixels()) === 0;
  await card().waitFor({ timeout: 10_000 });
  check(`no blank card at ${t}s`, !blank && (await pixels()) !== 0);
  await settled();
  await page.screenshot({ path: `${out}/hover-${t}.png`, clip: { x: Math.max(0, xAt(t) - 160), y: bar.y - 160, width: 320, height: 190 } });
  await snapshot();
  // The keyframe at or before t, and the one before that, which the card must not be.
  const at = cues.filter((c) => c <= t).at(-1)!;
  const earlier = cues.filter((c) => c < at).at(-1) ?? 0;
  const right = await closest(at);
  const wrong = await closest(earlier);
  console.log(`t=${t}: against ${at}s ${right.toFixed(1)}, against ${earlier}s ${wrong.toFixed(1)}`);
  check(`the picture at ${t}s is the keyframe at ${at}s`, right < 2 && right * 3 < wrong, `${right.toFixed(1)} vs ${wrong.toFixed(1)}`);
  await page.mouse.move(720, 300);
}
await page.screenshot({ path: `${out}/player.png` });

check("each keyframe is asked for once", frames.length === new Set(frames).size, `${frames.length} requests for ${new Set(frames).size} keyframes`);
check("the browser never sees TorBox's file link", !seen.some((u) => u.includes("/dld/") || u.includes("requestdl")), seen.find((u) => u.includes("/dld/")) ?? "");
const before = frames.length;
for (const t of [37, 19, 49]) {
  await page.mouse.move(xAt(t), y);
  await card().waitFor();
  await page.waitForTimeout(300);
}
check("spots already seen ask for nothing", frames.length === before, String(frames.length - before));
await page.mouse.move(720, 300);

// After a reload the pictures are on this device: the bar has them without asking the server.
await page.goto(`${s.url}/`, { waitUntil: "domcontentloaded" });
frames.length = 0;
await play();
await page.mouse.move(xAt(43), y);
const reloadStart = Date.now();
await card().waitFor({ timeout: 5_000 });
console.log(`after a reload: a picture in ${Date.now() - reloadStart} ms`);
await page.waitForTimeout(1500);
check("after a reload the storyboard comes from this device", new Set(frames).size <= 2, `${new Set(frames).size} keyframes asked for`);
await page.mouse.move(720, 300);

await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(400);
const nb = (await page.getByRole("slider", { name: "Seek" }).boundingBox())!;
await page.mouse.move(nb.x + 2, nb.y + nb.height / 2);
await card().waitFor();
const box = (await card().boundingBox())!;
await page.screenshot({ path: `${out}/phone-start.png` });
check("the card stays inside a phone's screen", box.x >= 0 && box.x + box.width <= 390, JSON.stringify(box));

// With the Worker down, pictures come from Krida's server instead (a fresh browser, so nothing is kept yet).
const fresh = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const fallback = await fresh.newPage();
await fallback.route("**/frames-worker/**", (route) => route.abort());
const served: string[] = [];
fallback.on("request", (r) => {
  if (r.url().includes("/api/frame?")) served.push(new URL(r.url()).searchParams.get("cluster")!);
});
await signIn(fallback, s.url, s.profiles[0]);
await fallback.goto(`${s.url}/title/movie/tt0816692`, { waitUntil: "domcontentloaded" });
await fallback.getByRole("button", { name: "Play", exact: true }).first().click();
await fallback.waitForURL(/\/watch\//);
const fallbackUntil = Date.now() + 20_000;
while (new Set(served).size < 8 && Date.now() < fallbackUntil) await fallback.waitForTimeout(200);
check("with the Worker down, the storyboard comes from Krida's server", new Set(served).size >= 8, `${new Set(served).size} keyframes`);
await browser.close();
finish();
