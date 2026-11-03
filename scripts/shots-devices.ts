import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Page } from "playwright-core";
import { launchBrowser } from "./lib/browser.ts";
import { checks, qaSession, signIn } from "./lib/qa.ts";
import { Network } from "./regress/network.ts";

// Every main screen on phones, tablets and computers, with each phone's real screen edges: Chrome is told the safe
// areas (the Dynamic Island or notch, the home bar, a sideways phone's camera side), so env(safe-area-inset-*) reads
// what an installed iPhone or Android app gets, and the camera and home bar are drawn on the shot in magenta.
// Each shot also checks that nothing scrolls sideways and that no control sits under the camera or home bar where
// it can't be pressed (fixed controls always; anything at the top of a page that hasn't scrolled).
// Run against the QA app (`npm run qa -- up`); shots and findings.json go to .artifacts/devices/.
// Usage: node scripts/shots-devices.ts [device name …]

type Insets = { top: number; right: number; bottom: number; left: number };
type Device = { name: string; width: number; height: number; mobile: boolean; insets: Insets; camera?: "island" | "notch" | "hole"; side?: "left" };

const none = { top: 0, right: 0, bottom: 0, left: 0 };
const DEVICES: Device[] = [
  { name: "iphone-se", width: 375, height: 667, mobile: true, insets: { ...none, top: 20 } },
  { name: "iphone-15-pro", width: 393, height: 852, mobile: true, insets: { ...none, top: 59, bottom: 34 }, camera: "island" },
  { name: "iphone-15-pro-max", width: 430, height: 932, mobile: true, insets: { ...none, top: 59, bottom: 34 }, camera: "island" },
  { name: "iphone-15-pro-sideways", width: 852, height: 393, mobile: true, insets: { top: 0, right: 59, bottom: 21, left: 59 }, camera: "island", side: "left" },
  { name: "iphone-13-mini", width: 375, height: 812, mobile: true, insets: { ...none, top: 50, bottom: 34 }, camera: "notch" },
  { name: "pixel-8", width: 412, height: 915, mobile: true, insets: { ...none, top: 32, bottom: 24 }, camera: "hole" },
  { name: "galaxy-fold-closed", width: 344, height: 882, mobile: true, insets: { ...none, top: 28, bottom: 16 }, camera: "hole" },
  { name: "ipad-mini", width: 744, height: 1133, mobile: true, insets: { ...none, top: 24, bottom: 20 } },
  { name: "ipad-pro-sideways", width: 1366, height: 1024, mobile: true, insets: { ...none, top: 24, bottom: 20 } },
  { name: "laptop-small", width: 1024, height: 640, mobile: false, insets: none },
  { name: "mac-1440", width: 1440, height: 900, mobile: false, insets: none },
  { name: "desktop-1920", width: 1920, height: 1080, mobile: false, insets: none },
  { name: "ultrawide", width: 2560, height: 1080, mobile: false, insets: none },
];
const only = process.argv.slice(2);
const devices = only.length ? DEVICES.filter((d) => only.includes(d.name)) : DEVICES;

const { movies, shows } = JSON.parse(readFileSync(new URL("./regress/titles.json", import.meta.url), "utf8")) as Record<string, { id: string; name: string }[]>;
const s = qaSession();
const network = new Network(".artifacts/regress/network", false);
const browser = await launchBrowser();
const findings: Record<string, Record<string, string[]>> = {};
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
let failed = false;

for (const d of devices) {
  const out = `.artifacts/devices/${d.name}`;
  mkdirSync(out, { recursive: true });
  const context = await browser.newContext({
    viewport: { width: d.width, height: d.height },
    screen: { width: d.width, height: d.height },
    isMobile: d.mobile,
    hasTouch: d.mobile,
    deviceScaleFactor: 2,
    serviceWorkers: "block",
    ...(d.mobile && d.name.startsWith("i") ? { userAgent: IPHONE } : {}),
  });
  await network.attach(context);
  const page = await context.newPage();
  const { check, finish } = checks(page);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setSafeAreaInsetsOverride" as never, { insets: d.insets } as never);
  findings[d.name] = {};

  const shot = async (name: string) => {
    await page.waitForTimeout(1200);
    await drawEdges(page, d);
    await page.screenshot({ path: `${out}/${name}.png` });
    const problems = await page.evaluate(audit, d.insets);
    findings[d.name]![name] = problems;
    check(`${d.name} ${name}: fits and clears the screen's edges`, problems.length === 0, problems.join("; "));
  };

  await signIn(page, s.url, s.profiles[0]!);
  await page.getByRole("heading", { level: 2 }).nth(1).waitFor({ timeout: 60_000 });
  await shot("home");
  await page.evaluate(() => scrollBy(0, 900));
  await shot("home-rows");
  await page.goto(`${s.url}/title/movie/${movies[16]!.id}`);
  await page.getByRole("heading", { name: movies[16]!.name }).first().waitFor({ timeout: 30_000 });
  await shot("title-movie");
  await page.goto(`${s.url}/title/series/${shows[16]!.id}`);
  await page.getByRole("heading", { name: shows[16]!.name }).first().waitFor({ timeout: 30_000 });
  await page.evaluate(() => scrollBy(0, 700));
  await shot("title-show-episodes");
  await page.goto(`${s.url}/search?q=${encodeURIComponent(movies[0]!.name)}`);
  await page.getByRole("link", { name: new RegExp(movies[0]!.name) }).first().waitFor({ timeout: 30_000 });
  await shot("search");
  await page.goto(`${s.url}/library`);
  await page.getByRole("navigation", { name: "Library" }).first().waitFor({ timeout: 30_000 });
  await shot("library");
  await page.goto(`${s.url}/settings/addons`);
  await page.getByRole("heading", { name: "Addons" }).first().waitFor({ timeout: 30_000 });
  await shot("settings-addons");
  await page.goto(`${s.url}/title/movie/${movies[16]!.id}`);
  await page.getByRole("button", { name: "Play", exact: true }).first().click();
  await page.waitForURL(/\/watch\//, { timeout: 30_000 });
  await page.waitForFunction(() => (document.querySelector("video")?.readyState ?? 0) >= 3, null, { timeout: 60_000 }).catch(() => {});
  // Wake the controls clear of the middle, where a tap would press play or a skip.
  await page.mouse.move(d.width / 2, d.height * 0.25);
  if (d.mobile) await page.touchscreen.tap(d.width / 2, d.height * 0.25);
  await shot("player");
  await context.close();
  try {
    finish();
  } catch (error) {
    failed = true;
    console.error(String(error));
  }
}

writeFileSync(".artifacts/devices/findings.json", JSON.stringify(findings, null, 2));
network.save();
await browser.close();
if (failed) process.exit(1);

/** The camera and home bar, drawn over the page in magenta so a shot shows what they'd cover. */
async function drawEdges(page: Page, d: Device) {
  await page.evaluate(({ d }) => {
    document.getElementById("device-edges")?.remove();
    const layer = document.createElement("div");
    layer.id = "device-edges";
    layer.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647";
    const add = (css: string) => {
      const el = document.createElement("div");
      el.style.cssText = `position:absolute;background:#000;outline:1.5px solid #f0f;${css}`;
      layer.append(el);
    };
    const sideways = d.side === "left";
    if (d.camera === "island") add(sideways ? "left:11px;top:50%;width:37px;height:126px;margin-top:-63px;border-radius:20px" : "top:11px;left:50%;width:126px;height:37px;margin-left:-63px;border-radius:20px");
    if (d.camera === "notch") add("top:0;left:50%;width:210px;height:32px;margin-left:-105px;border-radius:0 0 20px 20px");
    if (d.camera === "hole") add("top:12px;left:50%;width:14px;height:14px;margin-left:-7px;border-radius:50%");
    if (d.insets.bottom) add(`bottom:8px;left:50%;width:${sideways ? 200 : 136}px;height:5px;margin-left:-${sideways ? 100 : 68}px;border-radius:3px;background:#fff`);
    document.body.append(layer);
  }, { d });
}

/** What's wrong on screen now: sideways scroll, and controls or text under the screen's edges. */
function audit(insets: Insets): string[] {
  const problems: string[] = [];
  const over = document.documentElement.scrollWidth - innerWidth;
  if (over > 0) problems.push(`scrolls sideways by ${over}px`);
  const fixedAncestor = (el: Element | null): boolean => {
    for (; el; el = el.parentElement) {
      const p = getComputedStyle(el).position;
      if (p === "fixed" || p === "sticky") return true;
    }
    return false;
  };
  /** The part of `el` not clipped away by a scrolling or clipping box around it. */
  const visibleRect = (el: Element) => {
    let r = el.getBoundingClientRect();
    for (let a = el.parentElement; a; a = a.parentElement) {
      const s = getComputedStyle(a);
      if (s.overflowX === "visible" && s.overflowY === "visible") continue;
      const c = a.getBoundingClientRect();
      const left = Math.max(r.left, c.left), top = Math.max(r.top, c.top);
      r = new DOMRect(left, top, Math.max(0, Math.min(r.right, c.right) - left), Math.max(0, Math.min(r.bottom, c.bottom) - top));
    }
    return r;
  };
  const atTop = scrollY < 2;
  const zones = [
    { name: "top", hit: (r: DOMRect) => insets.top > 0 && r.top < insets.top && r.bottom > 0, applies: (el: Element) => atTop || fixedAncestor(el) },
    { name: "bottom", hit: (r: DOMRect) => insets.bottom > 0 && r.bottom > innerHeight - insets.bottom && r.top < innerHeight, applies: fixedAncestor },
    { name: "left", hit: (r: DOMRect) => insets.left > 0 && r.left < insets.left && r.right > 0, applies: () => true },
    { name: "right", hit: (r: DOMRect) => insets.right > 0 && r.right > innerWidth - insets.right && r.left < innerWidth, applies: () => true },
  ];
  const seen = new Set<string>();
  for (const el of document.querySelectorAll("a, button, input, [role=button], [role=tab], [role=slider], h1, h2, h3, p, label")) {
    if (el.closest("#device-edges")) continue;
    const r = visibleRect(el);
    if (r.width < 2 || r.height < 2) continue;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || Number(style.opacity) === 0) continue;
    // Full-bleed artwork and rows that scroll sideways run under the edges on purpose; their text and controls don't.
    if (el.closest("[data-rail], [data-card]") && !fixedAncestor(el)) continue;
    for (const z of zones) {
      if (!z.hit(r) || !z.applies(el)) continue;
      const label = (el.getAttribute("aria-label") ?? el.textContent ?? el.tagName).trim().replace(/\s+/g, " ").slice(0, 40) || el.tagName;
      const key = `${z.name}: ${el.tagName.toLowerCase()} "${label}"`;
      if (!seen.has(key)) seen.add(key);
    }
  }
  return [...problems, ...[...seen].map((k) => `under the ${k}`)];
}
