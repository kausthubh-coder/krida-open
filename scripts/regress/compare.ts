import { readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { launchBrowser } from "../lib/browser.ts";
import type { Capture, Shown } from "./walk.ts";

export type StepResult = { step: string; aria: "same" | "changed" | "missing" | "new"; pixels: number; diff: string[]; errors: string[] };

/** Share of pixels allowed to differ before a step counts as visually changed (anti-aliasing, video frames). */
export const PIXEL_TOLERANCE = 0.002;

/** Lines only in `a` (-) or only in `b` (+), in order: a plain longest-common-subsequence diff. */
export function lineDiff(a: string, b: string): string[] {
  const x = a.split("\n");
  const y = b.split("\n");
  const lcs = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i--)
    for (let j = y.length - 1; j >= 0; j--) lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) (i++, j++);
    else if (j < y.length && (i === x.length || lcs[i][j + 1] >= lcs[i + 1][j])) out.push(`+ ${y[j++]}`);
    else out.push(`- ${x[i++]}`);
  }
  return out;
}

export async function compare(base: Capture[], next: Capture[], baseDir: string, nextDir: string, reportDir: string): Promise<StepResult[]> {
  const browser = await launchBrowser({ headless: true });
  const page = await browser.newPage();
  const results: StepResult[] = [];
  try {
    for (const b of base) {
      const n = next.find((c) => c.step === b.step);
      if (!n) {
        results.push({ step: b.step, aria: "missing", pixels: 1, diff: [], errors: [] });
        continue;
      }
      const diff = lineDiff(b.aria, n.aria);
      // The same file in the same box on both sides is the same picture, even when Chrome hadn't painted it yet
      // (it can report a big backdrop decoded and shown before it draws it). A moved box or another file still counts.
      const same = b.images.filter((i) => n.images.some((j) => j.src === i.src && j.x === i.x && j.y === i.y && j.w === i.w && j.h === i.h));
      const pixels = await pixelDiff(page, join(baseDir, `${b.step}.png`), join(nextDir, `${b.step}.png`), join(reportDir, `${b.step}.diff.png`), same);
      const newErrors = n.errors.filter((e) => !b.errors.includes(e));
      results.push({ step: b.step, aria: diff.length ? "changed" : "same", pixels, diff, errors: newErrors });
    }
    for (const n of next) if (!base.some((b) => b.step === n.step)) results.push({ step: n.step, aria: "new", pixels: 0, diff: [], errors: n.errors });
  } finally {
    await browser.close();
  }
  writeFileSync(join(reportDir, "report.html"), report(results, baseDir, nextDir, reportDir));
  return results;
}

export const failed = (r: StepResult) => r.aria !== "same" || r.pixels > PIXEL_TOLERANCE || r.errors.length > 0;

/** Share of pixels that differ by more than a little in any channel; writes a picture with them in red. */
async function pixelDiff(page: import("playwright-core").Page, a: string, b: string, out: string, same: Shown[]): Promise<number> {
  const url = (file: string) => `data:image/png;base64,${readFileSync(file).toString("base64")}`;
  const { share, png } = await page.evaluate(async ([ua, ub, boxes]) => {
    const load = (src: string) => new Promise<HTMLImageElement>((resolve) => { const img = new Image(); img.onload = () => resolve(img); img.src = src; });
    const [ia, ib] = await Promise.all([load(ua), load(ub)]);
    const w = Math.max(ia.width, ib.width);
    const h = Math.max(ia.height, ib.height);
    const pixels = (img: HTMLImageElement) => {
      const c = new OffscreenCanvas(w, h);
      const ctx = c.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      return ctx.getImageData(0, 0, w, h);
    };
    const pa = pixels(ia);
    const pb = pixels(ib);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d")!;
    const out = ctx.createImageData(w, h);
    let changed = 0;
    const skip = new Uint8Array(w * h);
    for (const box of boxes as { x: number; y: number; w: number; h: number }[])
      for (let y = Math.max(0, box.y); y < Math.min(h, box.y + box.h); y++)
        skip.fill(1, y * w + Math.max(0, box.x), y * w + Math.min(w, box.x + box.w));
    for (let i = 0; i < pa.data.length; i += 4) {
      if (skip[i / 4]) {
        out.data.set([80, 80, 160, 60], i);
        continue;
      }
      const d = Math.max(Math.abs(pa.data[i] - pb.data[i]), Math.abs(pa.data[i + 1] - pb.data[i + 1]), Math.abs(pa.data[i + 2] - pb.data[i + 2]));
      if (d > 24) {
        changed++;
        out.data.set([255, 0, 0, 255], i);
      } else {
        const g = (pa.data[i] + pa.data[i + 1] + pa.data[i + 2]) / 3;
        out.data.set([g, g, g, 60], i);
      }
    }
    ctx.putImageData(out, 0, 0);
    return { share: changed / (w * h), png: canvas.toDataURL("image/png") };
  }, [url(a), url(b), same] as const);
  writeFileSync(out, Buffer.from(png.split(",")[1], "base64"));
  return share;
}

const escape = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);

function report(results: StepResult[], baseDir: string, nextDir: string, reportDir: string) {
  const rel = (dir: string, file: string) => relative(reportDir, join(dir, file)).replaceAll("\\", "/");
  const bad = results.filter(failed);
  const rows = results.map((r) => `
    <section class="${failed(r) ? "bad" : "ok"}">
      <h2>${failed(r) ? "Changed" : "Same"}: ${escape(r.step)}</h2>
      <p>Accessibility tree: ${r.aria}. Pixels changed: ${(r.pixels * 100).toFixed(2)}%.${r.errors.length ? ` New page errors: ${escape(r.errors.join("; "))}` : ""}</p>
      ${r.diff.length ? `<pre>${escape(r.diff.slice(0, 200).join("\n"))}${r.diff.length > 200 ? "\n…" : ""}</pre>` : ""}
      ${r.aria === "missing" || r.aria === "new" ? "" : `<div class="shots">
        <figure><img src="${rel(baseDir, `${r.step}.png`)}"><figcaption>Base</figcaption></figure>
        <figure><img src="${rel(nextDir, `${r.step}.png`)}"><figcaption>This change</figcaption></figure>
        <figure><img src="${rel(reportDir, `${r.step}.diff.png`)}"><figcaption>Difference in red</figcaption></figure>
      </div>`}
    </section>`).join("");
  return `<!doctype html><meta charset="utf-8"><title>Krida regress</title>
<style>
  body { font: 14px/1.5 system-ui, sans-serif; margin: 24px; background: #111; color: #eee; }
  h1 { font-size: 20px; } h2 { font-size: 15px; margin: 0 0 4px; }
  section { border: 1px solid #333; border-radius: 8px; padding: 12px; margin: 12px 0; }
  section.bad { border-color: #c44; } section.ok { opacity: .75; }
  .shots { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
  img { width: 100%; border: 1px solid #333; } figure { margin: 0; } figcaption { color: #999; }
  pre { background: #000; padding: 8px; overflow: auto; max-height: 320px; }
</style>
<h1>${bad.length ? `${bad.length} of ${results.length} steps changed` : `All ${results.length} steps match the base`}</h1>
${rows}`;
}
