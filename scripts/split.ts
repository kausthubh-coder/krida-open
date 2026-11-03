// node scripts/split.ts <file> <newFile>=<Name>,<Name> [<newFile>=<Name>,...]
//
// Moves top-level declarations out of a big file into new files beside it, without changing what any of them do:
// - each new file gets the original file's imports plus imports of the declarations it uses from the other parts;
// - a declaration another part now uses is exported (it was module-private before);
// - files that imported a moved name import it from its new home, and feature index files are rebuilt
//   (check-boundaries --fix);
// - unused imports are removed with TypeScript's own organize-imports (remove-unused mode, so order is kept).
// The comment above a declaration moves with it. Run `npm run typecheck`, `npm run lint` and `npm run regress` after.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repo = fileURLToPath(new URL("../", import.meta.url));
process.chdir(repo);

const [fileArg, ...parts] = process.argv.slice(2);
if (!fileArg || parts.length === 0) {
  console.log("Usage: node scripts/split.ts <file> <newFile>=<Name>,<Name> [...]");
  process.exit(1);
}
const original = resolve(fileArg);
const dir = dirname(original);
const ext = extname(original);
const targets = new Map<string, string>(); // declared name -> absolute new file
for (const part of parts) {
  const [file, names] = part.split("=");
  const path = resolve(dir, file.includes(".") ? file : `${file}${ext}`);
  if (existsSync(path)) throw new Error(`${relative(repo, path)} already exists`);
  for (const name of names.split(",").map((n) => n.trim()).filter(Boolean)) targets.set(name, path);
}

const text = readFileSync(original, "utf8");
const kindOf = (f: string) => (f.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
const sf = ts.createSourceFile(original, text, ts.ScriptTarget.Latest, true, kindOf(original));

function declaredNames(s: ts.Statement): string[] {
  if ((ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s) || ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s) || ts.isEnumDeclaration(s)) && s.name) return [s.name.text];
  if (ts.isVariableStatement(s)) return s.declarationList.declarations.flatMap((d) => (ts.isIdentifier(d.name) ? [d.name.text] : []));
  return [];
}

const imports = sf.statements.filter(ts.isImportDeclaration);
const body = sf.statements.filter((s) => !ts.isImportDeclaration(s));
const home = new Map<ts.Statement, string>();
const declaredIn = new Map<string, string>(); // top-level name -> file it lives in after the split
for (const s of body) {
  const names = declaredNames(s);
  const moved = names.map((n) => targets.get(n)).find(Boolean);
  home.set(s, moved ?? original);
  for (const n of names) declaredIn.set(n, moved ?? original);
}
for (const name of targets.keys()) if (!declaredIn.has(name)) throw new Error(`${name} isn't a top-level declaration in ${fileArg}`);

function usedNames(node: ts.Node, out = new Set<string>()) {
  if (ts.isIdentifier(node)) out.add(node.text);
  // forEachChild stops at the first callback that returns something, so this one returns nothing.
  ts.forEachChild(node, (child) => {
    usedNames(child, out);
  });
  return out;
}

const isExported = (s: ts.Statement) => ts.canHaveModifiers(s) && !!ts.getModifiers(s)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
const specifierTo = (from: string, to: string) => {
  const r = relative(dirname(from), to).split(sep).join("/").replace(/\.(tsx?)$/, "");
  return r.startsWith(".") ? r : `./${r}`;
};

// Which names each file needs from the others, and which names must now be exported.
const files = [...new Set([original, ...targets.values()])];
const needs = new Map<string, Map<string, Set<string>>>(files.map((f) => [f, new Map()]));
const mustExport = new Set<string>();
for (const s of body) {
  const mine = home.get(s)!;
  for (const name of usedNames(s)) {
    const theirs = declaredIn.get(name);
    if (!theirs || theirs === mine || declaredNames(s).includes(name)) continue;
    const m = needs.get(mine)!;
    if (!m.has(theirs)) m.set(theirs, new Set());
    m.get(theirs)!.add(name);
    mustExport.add(name);
  }
}

function statementText(s: ts.Statement) {
  const full = text.slice(s.getFullStart(), s.getEnd()).replace(/^\s*\n/, "");
  if (!mustExport.has(declaredNames(s)[0] ?? "") || isExported(s)) return full;
  // Add `export` before the declaration keyword, after its leading comment.
  const lead = s.getStart() - s.getFullStart() - (text.slice(s.getFullStart(), s.getEnd()).length - full.length);
  return `${full.slice(0, lead)}export ${full.slice(lead)}`;
}

// Types are imported with `type` (verbatimModuleSyntax).
const typeNames = new Set(body.filter((s) => ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s)).flatMap(declaredNames));
// The original imports, with relative paths rebased for a file in another folder.
const importsFor = (file: string) => imports.map((i) => {
  const source = text.slice(i.getStart(), i.getEnd());
  const spec = (i.moduleSpecifier as ts.StringLiteral).text;
  if (!spec.startsWith(".") || dirname(file) === dir) return source;
  let moved = relative(dirname(file), resolve(dir, spec)).split(sep).join("/");
  if (!moved.startsWith(".")) moved = `./${moved}`;
  return source.replace(`"${spec}"`, `"${moved}"`);
}).join("\n");
for (const file of files) {
  const own = body.filter((s) => home.get(s) === file).map(statementText);
  const sibling = [...needs.get(file)!].map(([from, names]) => `import { ${[...names].sort().map((n) => (typeNames.has(n) ? `type ${n}` : n)).join(", ")} } from "${specifierTo(file, from)}";`);
  // The comment at the top of the original file stays there.
  const header = file === original ? text.slice(0, sf.statements[0]?.getStart() ?? 0) : "";
  writeFileSync(file, `${header}${[importsFor(file), ...sibling].filter(Boolean).join("\n")}\n\n${own.join("\n\n").trim()}\n`);
}

// Importers elsewhere: a named import of a moved name now comes from its new file.
function walk(d: string, out: string[] = []): string[] {
  for (const name of readdirSync(d)) {
    if (name === "node_modules" || name === "_generated") continue;
    const p = join(d, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(resolve(p));
  }
  return out;
}
const resolvesTo = (from: string, spec: string) =>
  [spec, `${spec}.ts`, `${spec}.tsx`].map((s) => resolve(dirname(from), s)).some((p) => p === original);
const touched = new Set<string>(files);
for (const file of [...walk("src"), ...walk("tests"), ...walk("convex")]) {
  if (files.includes(file)) continue;
  const source = readFileSync(file, "utf8");
  const isf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kindOf(file));
  let next = source;
  const edits: { start: number; end: number; text: string }[] = [];
  for (const st of isf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || !resolvesTo(file, st.moduleSpecifier.text)) continue;
    const named = st.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named) || st.importClause?.name) continue;
    const groups = new Map<string, string[]>();
    for (const el of named.elements) {
      const name = (el.propertyName ?? el.name).text;
      const dest = declaredIn.get(name) ?? original;
      if (!groups.has(dest)) groups.set(dest, []);
      groups.get(dest)!.push(source.slice(el.getStart(), el.getEnd()));
    }
    if (groups.size === 1 && groups.has(original)) continue;
    const typeOnly = st.importClause?.isTypeOnly ? "type " : "";
    const spec = st.moduleSpecifier.text;
    const lines = [...groups].map(([dest, els]) => `import ${typeOnly}{ ${els.join(", ")} } from "${dest === original ? spec : specifierTo(file, dest)}";`);
    edits.push({ start: st.getStart(), end: st.getEnd(), text: lines.join("\n") });
  }
  for (const e of edits.sort((a, b) => b.start - a.start)) next = next.slice(0, e.start) + e.text + next.slice(e.end);
  if (next !== source) {
    writeFileSync(file, next);
    touched.add(file);
  }
}

// Drop the imports each file no longer uses, with TypeScript's own organize-imports, keeping their order.
const config = ts.getParsedCommandLineOfConfigFile(resolve("tsconfig.app.json"), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} })!;
const service = ts.createLanguageService({
  getCompilationSettings: () => config.options,
  getScriptFileNames: () => [...new Set([...config.fileNames.map((f) => resolve(f)), ...touched])],
  getScriptVersion: () => "0",
  getScriptSnapshot: (f) => (existsSync(f) ? ts.ScriptSnapshot.fromString(readFileSync(f, "utf8")) : undefined),
  getCurrentDirectory: () => repo,
  getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
  fileExists: ts.sys.fileExists,
  readFile: ts.sys.readFile,
  readDirectory: ts.sys.readDirectory,
  directoryExists: ts.sys.directoryExists,
  getDirectories: ts.sys.getDirectories,
});
// The repo's style, so rewritten imports read like the rest.
const FORMAT: ts.FormatCodeSettings = {
  indentSize: 2, tabSize: 2, convertTabsToSpaces: true, newLineCharacter: "\n", semicolons: ts.SemicolonPreference.Insert,
  insertSpaceAfterCommaDelimiter: true, insertSpaceAfterOpeningAndBeforeClosingNonemptyBraces: true,
};
// One program for every file: removing a file's unused imports can't change what another file uses.
const edits = new Map((process.env.SPLIT_KEEP_IMPORTS ? [] : [...touched]).map((file) =>
  [file, service.organizeImports({ type: "file", fileName: file, mode: ts.OrganizeImportsMode.RemoveUnused }, FORMAT, undefined)]));
for (const [file, changes] of edits) {
  let source = readFileSync(file, "utf8");
  for (const change of changes)
    for (const edit of [...change.textChanges].sort((a, b) => b.span.start - a.span.start))
      source = source.slice(0, edit.span.start) + edit.newText + source.slice(edit.span.start + edit.span.length);
  // A multi-line import keeps one name per line after names are removed from it.
  source = source.replace(/^import (type )?\{\n([\s\S]*?)\n\} from/gm, (_m, type: string | undefined, names: string) =>
    `import ${type ?? ""}{\n${names.split(",").map((n) => n.trim()).filter(Boolean).map((n) => `  ${n},`).join("\n")}\n} from`);
  // An import of types only is `import type`: `import { type A }` still leaves an empty runtime import, which can
  // make a cycle between the split files.
  source = source.replace(/^import \{([^}]*)\} from ("[^"]+");$/gm, (whole, names: string, spec: string) => {
    const list = names.split(",").map((n) => n.trim()).filter(Boolean);
    return list.length && list.every((n) => n.startsWith("type ")) ? `import type { ${list.map((n) => n.slice(5)).join(", ")} } from ${spec};` : whole;
  });
  writeFileSync(file, source);
}
spawnSync(process.execPath, [join(repo, "scripts/check-boundaries.ts"), "--fix"], { stdio: "inherit" });
console.log(`Split ${basename(original)} into ${files.map((f) => relative(repo, f)).join(", ")}; updated ${touched.size - files.length} importers.`);
