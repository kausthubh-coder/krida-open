// node scripts/check-colors.ts   (part of npm run check:ci)
//
// Krida's brand has no hue (docs/product-feel.md), yet warm golds came back four times (692e3ae, 47f481d, 1ea845e,
// 0d039ae), each written as a raw color in a component. Colors come from the tokens in src/styles.css. In src/, this
// fails on a hex, rgb or hsl color, and on an oklch() with a hue of its own. Allowed: near-neutral oklch() (the
// translucent whites and blacks glass is built from), and colors built from a profile's own hue (`${hue}`).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../", import.meta.url));
process.chdir(repo);

// Wrapped draws its shareable PNG on a canvas, which can't read CSS tokens. Don't add to this list; use a token.
const ALLOWED = new Set(["#191916", "#bdbbb3", "#f4f2eb"]);
const NEUTRAL_CHROMA = 0.02;

// A copy of ReactDrops' renderer, with its own defaults for a palette Krida never turns on (ui/glass/film.ts).
const COPIED = join("src", "ui", "glass", "soap");

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (path === COPIED) continue;
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

const COLOR = /oklch\(([^)]*)\)|#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\([^)]*\)/g;
const problems: string[] = [];
for (const file of walk("src")) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (/^\s*(\/\/|\*)/.test(line)) return;
    for (const match of line.matchAll(COLOR)) {
      const [literal, oklch] = match;
      if (ALLOWED.has(literal.toLowerCase())) continue;
      if (oklch !== undefined) {
        if (oklch.includes("${")) continue;
        const chroma = Number(oklch.trim().split(/[\s_/]+/)[1]);
        if (Number.isFinite(chroma) && chroma <= NEUTRAL_CHROMA) continue;
      }
      // A hex in a URL fragment or an id isn't a color.
      if (literal.startsWith("#") && !/["'`\s(:,[]#[0-9a-fA-F]{3,8}\b/.test(` ${line}`)) continue;
      problems.push(`${relative(repo, file).split(sep).join("/")}:${i + 1} uses ${literal}. Use a token from src/styles.css (fg, fg-muted, fg-faint, accent, line, overlay, success, warning, danger, movie, show, anime); the brand has no hue.`);
    }
  });
}

if (problems.length) {
  for (const p of problems) console.log(`FAIL ${p}`);
  process.exitCode = 1;
} else console.log("PASS no raw colors outside the tokens");
