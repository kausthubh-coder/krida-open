// node scripts/move.ts <from> <to> [<from> <to> ...]
//
// Moves files with `git mv` and rewrites every relative import that points at them, and the moved files' own relative
// imports, so a move changes paths and nothing else. A directory as <from> moves every file under it. Keeps each
// import's style: an extension stays (".js" in shared/ and server/), a bare path stays bare, a folder import stays a
// folder import. Run `npm run typecheck` after; it fails on anything this missed.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../", import.meta.url));
process.chdir(repo);

const ROOTS = ["src", "tests", "scripts", "shared", "server", "api", "convex"];
const CODE = /\.(ts|tsx|mts|mjs|js)$/;
const SKIP = new Set(["node_modules", "_generated", "dist"]);

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (CODE.test(name)) out.push(resolve(path));
  }
  return out;
}

/** The file an import specifier points at, the way TypeScript (bundler and nodenext) would find it. */
function resolveImport(from: string, spec: string): string | undefined {
  const base = resolve(dirname(from), spec);
  // convex/_generated/api is a .js file with a .d.ts beside it.
  const tries = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.d.ts`, join(base, "index.ts"), join(base, "index.tsx")];
  if (/\.(js|mjs)$/.test(spec)) tries.push(base.replace(/\.m?js$/, ".ts"), base.replace(/\.m?js$/, ".tsx"));
  return tries.find((p) => existsSync(p) && statSync(p).isFile());
}

/** A specifier from `fromFile` to `target`, in the same style as `old`. */
function specifier(fromFile: string, target: string, old: string): string {
  let path = relative(dirname(fromFile), target).split(sep).join("/");
  if (!path.startsWith(".")) path = `./${path}`;
  const ext = extname(old);
  if (/^\.(js|mjs)$/.test(ext) && /\.tsx?$/.test(path)) return path.replace(/\.tsx?$/, ext);
  if (ext && extname(path) === ext) return path;
  const bare = path.replace(/\.(d\.ts|tsx?|mts|m?js)$/, "");
  // `import "./search"` that meant search/index.ts stays a folder import.
  if (!/\/index$/.test(old) && /\/index$/.test(bare)) return bare.replace(/\/index$/, "");
  return bare;
}

const args = process.argv.slice(2);
if (args.length === 0 || args.length % 2) {
  console.log("Usage: node scripts/move.ts <from> <to> [<from> <to> ...]");
  process.exit(1);
}

const moves = new Map<string, string>();
for (let i = 0; i < args.length; i += 2) {
  const from = resolve(args[i]);
  const to = resolve(args[i + 1]);
  if (!existsSync(from)) throw new Error(`${args[i]} doesn't exist`);
  if (statSync(from).isDirectory()) {
    for (const file of walk(from)) moves.set(file, join(to, relative(from, file)));
    // Assets (sounds, images) move with their folder too.
    for (const file of listAll(from)) if (!moves.has(file)) moves.set(file, join(to, relative(from, file)));
  } else moves.set(from, to);
}
for (const to of moves.values()) if (existsSync(to)) throw new Error(`${relative(repo, to)} already exists`);

function listAll(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) listAll(path, out);
    else out.push(resolve(path));
  }
  return out;
}

const IMPORT = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bvi\.mock\(\s*|\bnew URL\(\s*)(["'])(\.{1,2}\/[^"']*)\2/g;
let changed = 0;
for (const file of ROOTS.flatMap((root) => walk(root))) {
  const source = readFileSync(file, "utf8");
  const newFile = moves.get(file) ?? file;
  const next = source.replace(IMPORT, (match, lead: string, quote: string, spec: string) => {
    const target = resolveImport(file, spec);
    if (!target) return match;
    const newTarget = moves.get(target) ?? target;
    if (newTarget === target && newFile === file) return match;
    return `${lead}${quote}${specifier(newFile, newTarget, spec)}${quote}`;
  });
  if (next !== source) {
    writeFileSync(file, next);
    changed++;
  }
}

for (const [from, to] of moves) {
  mkdirSync(dirname(to), { recursive: true });
  const r = spawnSync("git", ["mv", from, to], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git mv ${relative(repo, from)}: ${r.stderr}`);
}
console.log(`Moved ${moves.size} files; rewrote imports in ${changed}.`);
