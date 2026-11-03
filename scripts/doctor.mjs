// Is this checkout ready to run and verify Krida? `npm run doctor`, or `npm run doctor -- --fix` to copy a missing
// .env.local from the main checkout (only when that one points at dev). Read-only otherwise.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { checkEnv, lockDrift, mainCheckout, missingApiKeys } from "./lib/doctor.ts";

process.chdir(fileURLToPath(new URL("../", import.meta.url)));
const fix = process.argv.includes("--fix");
let failed = false;
function report(state, name, detail) {
  if (state === "FAIL") failed = true;
  console.log(`${state} ${name}: ${detail}`);
}
const readJson = (path) => {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
};
const readEnv = (path) => {
  try { return parseEnv(readFileSync(path, "utf8")); } catch { return undefined; }
};

// Dependencies: npm's record of node_modules against the lockfile, so a pull that changed the lockfile shows up here.
if (!existsSync("node_modules")) {
  report("FAIL", "Dependencies", "node_modules is missing; run npm ci");
} else {
  const drift = lockDrift(readJson("package-lock.json") ?? {}, readJson("node_modules/.package-lock.json"));
  report(drift.length ? "FAIL" : "PASS", "Dependencies", drift.length
    ? `${drift.length} differ from package-lock.json (${drift.slice(0, 3).join("; ")}${drift.length > 3 ? "; …" : ""}); run npm ci`
    : "node_modules matches package-lock.json");
}

// .env.local: T3 copies it into new worktrees, but not always. --fix copies the main checkout's when it is dev.
const main = mainCheckout(spawnSync("git", ["worktree", "list", "--porcelain"], { encoding: "utf8" }).stdout ?? "");
if (!existsSync(".env.local") && fix && main) {
  const source = join(main, ".env.local");
  const verdict = checkEnv(readEnv(source) ?? {});
  if (verdict.ok) {
    copyFileSync(source, ".env.local");
    console.log(`FIXED .env.local: copied from ${source}`);
  } else {
    console.log(`WARN .env.local: not copied; the main checkout's ${verdict.detail}`);
  }
}
const env = readEnv(".env.local");
if (!env) {
  report("FAIL", ".env.local", "missing; run `npm run doctor -- --fix` to copy the main checkout's, or `npx convex dev`");
} else {
  const verdict = checkEnv(env);
  report(verdict.ok ? "PASS" : "FAIL", ".env.local", verdict.detail);
  // Vite lets the shell's variables beat .env.local, so a cloud environment can hold the keys instead of the file.
  const missing = missingApiKeys({ ...env, ...process.env });
  if (missing.length) {
    report("WARN", "/api keys", `${missing.join(", ")} missing from .env.local and the environment: Home, Search and Title pages load empty in dev`);
  } else {
    report("PASS", "/api keys", "set");
  }
}

const port = Number(process.env.PORT) || (await import("./setup.mjs")).readState()?.port || 5173;
try {
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ port, exclusive: true }, () => server.close((error) => error ? reject(error) : resolve()));
  });
  report("PASS", "Dev port", `${port} is free`);
} catch (error) {
  report("FAIL", "Dev port", `${port} is unavailable (${error.code ?? "invalid port"}); pick another with PORT=`);
}

try {
  const url = new URL(env?.VITE_CONVEX_URL);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Invalid protocol");
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  await response.body?.cancel();
  // Convex's root can return 404 while the deployment is reachable.
  report("PASS", "Convex HTTP", `deployment answered HTTP ${response.status}`);
} catch {
  report("FAIL", "Convex HTTP", "VITE_CONVEX_URL is missing, invalid or unreachable");
}

// Browser scripts launch through scripts/lib/browser.ts: Chrome when it's installed, else Playwright's Chromium.
const browser = existsSync("node_modules/playwright-core") ? (await import("./lib/browser.ts")).findBrowser() : undefined;
report(browser ? "PASS" : "FAIL", "Browser", browser?.name ?? "no Chrome and no Playwright Chromium; install Chrome, or run node node_modules/playwright-core/cli.js install chromium");

const fetched = spawnSync("git", ["fetch", "origin"], { encoding: "utf8", timeout: 30_000 });
if (fetched.status !== 0) {
  console.log("WARN origin/main: git fetch failed; behind count unknown");
} else {
  const behind = (ref) => {
    const out = spawnSync("git", ["rev-list", "--count", `${ref}..origin/main`], { encoding: "utf8" });
    return out.status === 0 && /^\d+$/.test(out.stdout.trim()) ? Number(out.stdout.trim()) : undefined;
  };
  const count = behind("HEAD");
  console.log(count === undefined ? "WARN origin/main: behind count unavailable" : `${count > 0 ? "WARN" : "PASS"} origin/main: this branch is ${count} commits behind`);
  // New worktrees copy the main checkout's .env.local and start from it, so a stale main spreads.
  const mainBehind = behind("main");
  if (mainBehind) console.log(`WARN main: local main is ${mainBehind} commits behind origin/main; pull it in the main checkout`);
}

process.exitCode = failed ? 1 : 0;
// This checkout's own port, backend, dev server and skills link (scripts/setup.mjs).
await (await import("./setup.mjs")).worktreeDoctor();
