// npm run regress [-- --base <ref>] [--offline] [--walk-only]
//
// Proves a change leaves what people see the same. Walks every screen twice, on the base commit (default HEAD) and on
// this working tree, each against its own throwaway local Convex backend seeded with the same two QA profiles, with
// all outside data answered from one store. Fails when any step's accessibility tree differs, more than a sliver of
// pixels change, or a new page error appears. Report: .artifacts/regress/report.html. Never touches dev or production.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, symlinkSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { freePort, start, waitFor } from "../lib/proc.ts";
import { setBackendEnv, startLocalBackend } from "./backend.ts";
import { compare, failed, PIXEL_TOLERANCE } from "./compare.ts";
import { Network } from "./network.ts";
import { standInAddon, startProviders, type Providers } from "./providers.ts";
import { seed } from "./seed.ts";
import { walk, type Capture } from "./walk.ts";

const repo = fileURLToPath(new URL("../../", import.meta.url));
process.chdir(repo);
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};
const baseRef = arg("--base") ?? "HEAD";
const offline = process.argv.includes("--offline");
// Walks only this working tree, to try a new or changed step without the base run and the comparison.
const walkOnly = process.argv.includes("--walk-only");
const out = resolve(".artifacts/regress");
// The QA account's TMDB and MDBList keys. The live site's /api answers only signed-in accounts, so each side's own
// /api records what the store lacks (network.ts), asking with these: the environment's, else .env.test.local's, else
// .env.local's. A full store needs none (placeholders then), and keys never reach the store's names.
const keyFiles = [".env.test.local", ".env.local"].filter((f) => existsSync(f)).map((f) => parseEnv(readFileSync(f, "utf8")));
const apiKey = (name: string) => process.env[name] || keyFiles.find((env) => env[name])?.[name];
const keys = { tmdb: apiKey("TMDB_API_KEY"), mdblist: apiKey("MDBLIST_API_KEY") };
const baseTree = join(out, "base-tree");

const git = (...args: string[]) => {
  const r = spawnSync("git", args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

const baseSha = git("rev-parse", "--verify", `${baseRef}^{commit}`);
if (git("show", `${baseSha}:package-lock.json`) !== readFileSync("package-lock.json", "utf8").replace(/\r\n/g, "\n").trim())
  throw new Error(`package-lock.json differs from ${baseRef}; both builds share this checkout's node_modules, so compare against a commit with the same dependencies.`);

function checkoutBase() {
  removeBase();
  git("worktree", "add", "--detach", baseTree, baseSha);
  symlinkSync(resolve("node_modules"), join(baseTree, "node_modules"), "junction");
}

/** Only ever removes the worktree this script made, at its own path. */
function removeBase() {
  if (existsSync(join(baseTree, "node_modules"))) unlinkSync(join(baseTree, "node_modules"));
  if (existsSync(baseTree)) git("worktree", "remove", "--force", baseTree);
  git("worktree", "prune");
}

async function run(side: "base" | "next", tree: string, network: Network, providers: Providers): Promise<Capture[]> {
  console.log(`\n${side === "base" ? `Base ${baseSha.slice(0, 8)}` : "This working tree"}: starting a local backend`);
  const backend = await startLocalBackend(tree, join(out, side, "backend"));
  try {
    setBackendEnv(tree, join(out, side, "backend"), providers.env);
    const profiles = await seed(backend.url, backend.adminKey, keys, standInAddon(providers.url));
    const port = await freePort();
    const vite = start(process.execPath, [join(repo, "scripts/regress/vite-server.ts")], {
      cwd: tree,
      // No Clerk: its sign-in widget talks to Clerk's servers, which the store can't replay. The walk signs in at /qa.
      // The stand-in TorBox answers /api/frame, as in the QA app.
      env: { ...process.env, ...providers.env, PORT: String(port), KRIDA_REPO: repo, VITE_CONVEX_URL: backend.url, VITE_CONVEX_SITE_URL: backend.siteUrl, VITE_KRIDA_PREVIEW: "", VITE_CLERK_PUBLISHABLE_KEY: "" },
    });
    try {
      await waitFor("the dev server", () => vite.output().includes("ready http"), 60_000, vite);
      console.log(`Walking http://127.0.0.1:${port}`);
      const captures = await walk(`http://127.0.0.1:${port}`, profiles, network, join(out, side, "shots"));
      console.log(`${captures.length} steps captured`);
      return captures;
    } finally {
      vite.stop();
    }
  } finally {
    backend.stop();
  }
}

const network = new Network(join(out, "network"), offline);
if (!offline && !keys.tmdb) console.log("No TMDB_API_KEY (environment, .env.test.local or .env.local): /api answers the store lacks are recorded as refusals.");
// Stream addon, TorBox and IntroDB stand-ins, so the walk can play a title.
const providers = await startProviders(join(out, "media"));
try {
  if (walkOnly) {
    const captures = await run("next", repo, network, providers);
    console.log(`Walked ${captures.map((c) => c.step).join(", ")}. Shots: ${join(out, "next", "shots")}`);
  } else await compareWithBase();
} finally {
  network.save();
  removeBase();
  await providers.stop();
}

async function compareWithBase() {
  checkoutBase();
  const base = await run("base", baseTree, network, providers);
  network.save();
  const next = await run("next", repo, network, providers);
  network.save();
  const results = await compare(base, next, join(out, "base", "shots"), join(out, "next", "shots"), out);
  for (const r of results)
    console.log(`${failed(r) ? "CHANGED" : "same   "} ${r.step}${r.aria !== "same" ? ` (accessibility tree ${r.aria}, ${r.diff.length} lines)` : ""}${r.pixels > PIXEL_TOLERANCE ? ` (${(r.pixels * 100).toFixed(2)}% pixels)` : ""}${r.errors.length ? ` (new page errors: ${r.errors.join("; ")})` : ""}`);
  if (network.recorded.length) console.log(`\nRecorded ${network.recorded.length} new responses into .artifacts/regress/network.`);
  if (network.missing.length) console.log(`\n${network.missing.length} requests weren't in the store (--offline): ${network.missing.slice(0, 5).join(", ")}`);
  const changed = results.filter(failed);
  console.log(`\n${changed.length ? `FAIL ${changed.length} of ${results.length} steps changed` : `PASS all ${results.length} steps match ${baseRef}`}. Report: ${join(out, "report.html")}`);
  process.exitCode = changed.length ? 1 : 0;
}
