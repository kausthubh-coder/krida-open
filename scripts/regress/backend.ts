import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { start, waitFor, type Started } from "../lib/proc.ts";

export type Backend = { url: string; siteUrl: string; adminKey: string; pid: number | undefined; stop: () => void };

const LINKED = ["convex", "shared", "node_modules"];

/**
 * A throwaway Convex backend on this machine, running `tree`'s functions with empty tables. It never talks to the dev
 * or production deployments: `workDir` holds its own .env.local and data, and links to the tree's code.
 */
export async function startLocalBackend(tree: string, workDir: string, log?: string): Promise<Backend> {
  removeWorkDir(workDir);
  mkdirSync(workDir, { recursive: true });
  for (const name of LINKED) symlinkSync(resolve(tree, name), join(workDir, name), "junction");
  for (const name of ["package.json", "tsconfig.json"]) copyFileSync(join(tree, name), join(workDir, name));

  // Without a CONVEX_DEPLOYMENT, anonymous mode creates a local deployment in workDir/.convex.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("CONVEX_")));
  const backend: Started = start(process.execPath, [join(tree, "node_modules/convex/bin/main.js"), "dev", "--typecheck", "disable", "--codegen", "disable", "--tail-logs", "disable"], {
    cwd: workDir,
    env: { ...env, CONVEX_AGENT_MODE: "anonymous" },
    log,
  });
  try {
    await waitFor("the local Convex backend", () => backend.output().includes("Convex functions ready"), 180_000, backend);
    const local = parseEnv(readFileSync(join(workDir, ".env.local"), "utf8"));
    const url = local.VITE_CONVEX_URL ?? "";
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) throw new Error(`Expected a local backend URL, got ${url}`);
    const config = JSON.parse(readFileSync(join(workDir, ".convex/local/default/config.json"), "utf8")) as { adminKey: string };
    return {
      url,
      siteUrl: local.VITE_CONVEX_SITE_URL ?? "",
      adminKey: config.adminKey,
      pid: backend.child.pid,
      stop: () => {
        backend.stop();
        removeWorkDir(workDir);
      },
    };
  } catch (error) {
    backend.stop();
    throw error;
  }
}

/** Sets environment variables on a backend started by startLocalBackend (the stand-in providers' URLs and keys). */
export function setBackendEnv(tree: string, workDir: string, vars: Record<string, string>) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("CONVEX_")));
  for (const [name, value] of Object.entries(vars)) {
    const r = spawnSync(process.execPath, [join(tree, "node_modules/convex/bin/main.js"), "env", "set", name, value], {
      cwd: workDir, env: { ...env, CONVEX_AGENT_MODE: "anonymous" }, encoding: "utf8", timeout: 60_000,
    });
    if (r.status !== 0) throw new Error(`Couldn't set ${name} on the local backend: ${r.stderr || r.stdout}`);
  }
}

/** Unlinks the junctions before deleting, so nothing ever recurses into the tree's own convex/ or node_modules/. */
export function removeWorkDir(workDir: string) {
  if (!existsSync(workDir)) return;
  for (const name of readdirSync(workDir)) {
    const path = join(workDir, name);
    if (lstatSync(path).isSymbolicLink()) unlinkSync(path);
  }
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(workDir, { recursive: true, force: true });
      return;
    } catch (error) {
      // Windows releases the backend's sqlite file a moment after the process ends.
      if (attempt >= 20) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
}
