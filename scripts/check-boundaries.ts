// node scripts/check-boundaries.ts [--fix]   (part of npm run check:ci)
//
// Keeps the vertical slices honest, so a change that looks right from one file is right for the whole app:
// - a feature (src/features/<name>/), and the app shell (src/app/, src/main.tsx), import a feature only through its
//   index.ts, which lists exactly what the rest of the app uses from it;
// - shared code (src/ui/, src/data/) never imports a feature;
// - shared/ and convex/lib/ never import React, the web app or Vercel code, so other platforms can reuse them;
// - only the Simkl outbox (convex/lib/simklOutbox.ts) builds a /sync/history/remove request, which deletes a title with
//   every play: built from partial data elsewhere, it wiped real history three times (080d1e6, 450dbdd, 1cda4f7);
// - a page loaded after start-up (a feature's page.ts) is imported nowhere else;
// - icons use only the weights the build keeps (regular, bold, fill).
// --fix rewrites a deep import of another feature to its index.ts, then rebuilds every feature's index.ts from what
// the rest of the app imports from it.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../", import.meta.url));
process.chdir(repo);
const fix = process.argv.includes("--fix");

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "_generated") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(resolve(path));
  }
  return out;
}

function resolveImport(from: string, spec: string): string | undefined {
  const base = resolve(dirname(from), spec);
  const tries = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx"), base.replace(/\.js$/, ".ts")];
  return tries.find((p) => existsSync(p) && statSync(p).isFile());
}

const rel = (p: string) => relative(repo, p).split(sep).join("/");
const relSpec = (from: string, to: string) => {
  const r = relative(dirname(from), to).split(sep).join("/").replace(/\.tsx?$/, "").replace(/\/index$/, "");
  return r.startsWith(".") ? r : `./${r}`;
};
const featureOf = (p: string) => /^src\/features\/([^/]+)\//.exec(rel(p))?.[1];
const isIndex = (p: string) => /^src\/features\/[^/]+\/index\.ts$/.test(rel(p));
const IMPORT = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])([^"']+)\2/g;
const checked = () => [resolve("src/main.tsx"), ...walk("src/app"), ...walk("src/features"), ...walk("src/ui"), ...walk("src/data"), ...walk("shared"), ...walk("convex/lib")];

const problems: string[] = [];
let rewritten = 0;
for (const file of checked()) {
  const source = readFileSync(file, "utf8");
  const here = rel(file);
  const mine = featureOf(file);
  const next = source.replace(IMPORT, (match, lead: string, quote: string, spec: string) => {
    if (here.startsWith("shared/") || here.startsWith("convex/lib/")) {
      if (/^(react|react-dom|react-router)(\/|$)/.test(spec) || /(^|\/)(src|server|api)\//.test(spec))
        problems.push(`${here} imports ${spec}: shared/ and convex/lib/ stay free of React, the web app and Vercel code. Move the code that needs it into src/ or server/.`);
      return match;
    }
    if (!spec.startsWith(".")) return match;
    const target = resolveImport(file, spec);
    const theirs = target && featureOf(target);
    if (!target || !theirs || theirs === mine) return match;
    if (!mine && !here.startsWith("src/app/") && here !== "src/main.tsx") {
      problems.push(`${here} imports ${rel(target)}: shared code (src/ui, src/data) can't depend on a feature. Move what both need into src/ui or src/data.`);
      return match;
    }
    if (isIndex(target)) return match;
    if (!fix) {
      problems.push(`${here} imports ${rel(target)}: import features/${theirs} through its index.ts, not a file inside it. \`node scripts/check-boundaries.ts --fix\` rewrites the import and the index.`);
      return match;
    }
    rewritten++;
    return `${lead}${quote}${relSpec(file, resolve(repo, "src/features", theirs, "index.ts"))}${quote}`;
  });
  if (next !== source) writeFileSync(file, next);
}

// Every feature's index.ts: exactly the names the rest of the app imports from it, each from the file declaring it.
const NAMED = /import\s+(type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g;
// A lazy route: import("../features/x").then((m) => ({ default: m.Page })).
const LAZY = /import\(\s*["']([^"']+)["']\s*\)\.then\(\(?(\w+)\)?\s*=>\s*\(\{\s*default:\s*\2\.(\w+)/g;
const DECLARED = /^export\s+(?:default\s+)?(?:async\s+)?(function|const|let|class|type|interface|enum)\s+(\w+)/gm;
for (const feature of existsSync("src/features") ? readdirSync("src/features") : []) {
  const folder = resolve("src/features", feature);
  if (!statSync(folder).isDirectory()) continue;
  const index = join(folder, "index.ts");
  const declared = new Map<string, { file: string; type: boolean }>();
  for (const file of walk(folder)) {
    if (file === index) continue;
    for (const [, kind, name] of readFileSync(file, "utf8").matchAll(DECLARED)) declared.set(name, { file, type: kind === "type" || kind === "interface" });
  }
  const used = new Set<string>();
  for (const file of checked().concat(walk("tests"))) {
    if (featureOf(file) === feature) continue;
    for (const [, , names, spec] of readFileSync(file, "utf8").matchAll(NAMED)) {
      if (!spec.startsWith(".") || resolveImport(file, spec) !== index) continue;
      for (const n of names.split(",")) {
        const name = n.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0];
        if (name) used.add(name);
      }
    }
    for (const [, spec, , name] of readFileSync(file, "utf8").matchAll(LAZY))
      if (spec.startsWith(".") && resolveImport(file, spec) === index) used.add(name);
  }
  const byFile = new Map<string, string[]>();
  for (const name of [...used].sort()) {
    const d = declared.get(name);
    if (!d) {
      problems.push(`src/features/${feature}/index.ts: something imports ${name}, which no file in features/${feature} exports.`);
      continue;
    }
    if (!byFile.has(d.file)) byFile.set(d.file, []);
    byFile.get(d.file)!.push(d.type ? `type ${name}` : name);
  }
  const lines = [...byFile].sort(([a], [b]) => a.localeCompare(b)).map(([file, names]) => `export { ${names.join(", ")} } from "${relSpec(index, file)}";`);
  const want = lines.length ? `// What the rest of the app uses from features/${feature}. Rebuilt by \`node scripts/check-boundaries.ts --fix\`.\n${lines.join("\n")}\n` : "";
  const have = existsSync(index) ? readFileSync(index, "utf8") : "";
  if (want === have) continue;
  if (fix) {
    if (want) writeFileSync(index, want);
  } else {
    problems.push(`src/features/${feature}/index.ts doesn't list exactly what the app imports from it. Run \`node scripts/check-boundaries.ts --fix\`.`);
  }
}

for (const file of [...walk("convex"), ...walk("src"), ...walk("server"), ...walk("shared")]) {
  if (rel(file) === "convex/lib/simklOutbox.ts") continue;
  const source = readFileSync(file, "utf8");
  // Comments may name it; code may not.
  const code = source.replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm, "$1");
  if (code.includes("/sync/history/remove"))
    problems.push(`${rel(file)} builds a /sync/history/remove request. Queue the change with enqueue() from convex/lib/simklOutbox.ts, the one place that decides what Simkl may delete.`);
}

// A page loaded after start-up (a feature's page.ts) is only imported there: one static import puts it back in the first load.
const STATIC = /(?:\bfrom\s*|\bimport\s+)["']([^"']+)["']/g;
const lazyPages = new Map<string, string>();
for (const page of walk("src/features").filter((p) => p.endsWith(`${sep}page.ts`)))
  for (const [, spec] of readFileSync(page, "utf8").matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) {
    const target = resolveImport(page, spec);
    if (target) lazyPages.set(target, rel(page));
  }
for (const file of [resolve("src/main.tsx"), ...walk("src")])
  for (const [, spec] of readFileSync(file, "utf8").matchAll(STATIC)) {
    const target = spec.startsWith(".") ? resolveImport(file, spec) : undefined;
    if (target && lazyPages.has(target))
      problems.push(`${rel(file)} imports ${rel(target)}, which loads after start-up through ${lazyPages.get(target)}. Import what it needs from another file instead.`);
  }

// The build keeps only these icon weights (iconWeights in vite.config.ts); any other draws an empty icon.
for (const file of walk("src")) {
  const source = readFileSync(file, "utf8");
  if (!source.includes("@phosphor-icons/react")) continue;
  const weight = /["'](thin|light|duotone)["']/.exec(source)?.[1];
  if (weight)
    problems.push(`${rel(file)} uses the "${weight}" icon weight, which the build drops. Use regular, bold or fill, or add it to ICON_WEIGHTS in vite.config.ts.`);
}

// Vercel's Hobby plan deploys at most 12 functions, one per file in api/; a 13th builds and then fails to deploy.
const functions = readdirSync(resolve("api")).filter((f) => /\.(ts|js)$/.test(f));
if (functions.length > 12)
  problems.push(`api/ has ${functions.length} endpoints; Vercel's free plan deploys at most 12. Add the new one to an existing endpoint, as /api/frames?ticket is.`);

if (rewritten) console.log(`Rewrote ${rewritten} imports to go through a feature's index.ts.`);
if (problems.length) {
  for (const p of problems) console.log(`FAIL ${p}`);
  console.log(`\n${problems.length} boundary problems.`);
  process.exitCode = 1;
} else console.log("PASS feature boundaries");
