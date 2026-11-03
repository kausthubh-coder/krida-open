import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { launchBrowser } from "./lib/browser.ts";

// The launch screens an iPhone shows while installed Krida opens. Safari doesn't make one from the manifest, so
// without these it opens on a white screen. Each is the page color with Krida's mark in the middle, one per screen
// size, and index.html names them between the splash markers.
// Usage: node scripts/make-splash.ts (after changing the mark or the page color, or for a new iPhone size)

// CSS width × height and pixel ratio of each iPhone screen, upright.
const SCREENS: [number, number, number][] = [
  [440, 956, 3], // 16 Pro Max, 17 Pro Max
  [430, 932, 3], // 14 Pro Max, 15 Plus, 15 Pro Max, 16 Plus
  [428, 926, 3], // 12 and 13 Pro Max, 14 Plus
  [420, 912, 3], // Air
  [414, 896, 3], // XS Max, 11 Pro Max
  [414, 896, 2], // XR, 11
  [402, 874, 3], // 16 Pro, 17, 17 Pro
  [393, 852, 3], // 14 Pro, 15, 15 Pro, 16
  [390, 844, 3], // 12, 13, 14, 16e
  [375, 812, 3], // X, XS, 11 Pro, 12 and 13 mini
  [375, 667, 2], // SE, 8
];
// The manifest's background color, so the launch screen and the first frame match.
const PAGE = "#151210";

// The favicon's two triangles, without its tile.
const mark = readFileSync("public/favicon.svg", "utf8").match(/<g [\s\S]*?<\/g>/)![0];
const html = (w: number, h: number) => `<!doctype html><html><body style="margin:0;background:${PAGE};width:${w}px;height:${h}px;display:grid;place-items:center">
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="10 14 42 36" width="88" height="75">${mark}</svg></body></html>`;

mkdirSync("public/splash", { recursive: true });
const browser = await launchBrowser();
const links: string[] = [];
for (const [w, h, ratio] of SCREENS) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: ratio });
  await page.setContent(html(w, h));
  const name = `/splash/${w * ratio}x${h * ratio}.png`;
  await page.screenshot({ path: `public${name}` });
  await page.close();
  links.push(
    `    <link rel="apple-touch-startup-image" media="(device-width: ${w}px) and (device-height: ${h}px) and (-webkit-device-pixel-ratio: ${ratio}) and (orientation: portrait)" href="${name}" />`,
  );
}
await browser.close();

const index = readFileSync("index.html", "utf8");
const start = "<!-- splash -->";
const end = "<!-- /splash -->";
if (!index.includes(start) || !index.includes(end)) throw new Error(`index.html needs ${start} and ${end} around the launch screens`);
writeFileSync("index.html", index.replace(new RegExp(`${start}[\\s\\S]*${end}`), `${start}\n${links.join("\n")}\n    ${end}`));
console.log(`Wrote ${SCREENS.length} launch screens to public/splash and their links to index.html.`);
