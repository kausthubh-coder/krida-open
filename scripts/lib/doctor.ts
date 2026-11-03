// The checks behind `npm run doctor`, as plain functions so tests can call them with real-shaped inputs.

export const DEV_DEPLOYMENT = "fastidious-oyster-35";
export const PROD_DEPLOYMENT = "industrious-axolotl-949";

/** The keys /api needs in dev (vite.config.ts runs api/ with them). Without them Home, Search and Title pages are empty. */
export const API_KEYS = ["TMDB_API_KEY", "MDBLIST_API_KEY"] as const;

type Lock = { packages?: Record<string, { version?: string; optional?: boolean; dev?: boolean }> };

/**
 * Packages whose installed version differs from package-lock.json. `installed` is npm's own record of node_modules
 * (node_modules/.package-lock.json). Optional packages for other platforms are never installed, so they don't count.
 */
export function lockDrift(lock: Lock, installed: Lock | undefined): string[] {
  const have = installed?.packages ?? {};
  const drift: string[] = [];
  for (const [path, want] of Object.entries(lock.packages ?? {})) {
    if (!path.startsWith("node_modules/") || !want.version) continue;
    const got = have[path]?.version;
    if (got === want.version) continue;
    if (got === undefined && want.optional) continue;
    drift.push(`${path.slice("node_modules/".length)} wants ${want.version}, has ${got ?? "nothing"}`);
  }
  return drift;
}

export type EnvVerdict = { ok: boolean; detail: string };

/** .env.local must point `npx convex dev` and the browser at the dev deployment, and nothing at production. */
export function checkEnv(env: Record<string, string | undefined>): EnvVerdict {
  if (Object.entries(env).some(([key, value]) => key.includes("CONVEX") && value?.includes(PROD_DEPLOYMENT))) {
    return { ok: false, detail: `points at production (${PROD_DEPLOYMENT}); worktrees use dev only` };
  }
  let host = "";
  try {
    host = new URL(env.VITE_CONVEX_URL ?? "").hostname;
  } catch {
    return { ok: false, detail: "VITE_CONVEX_URL is missing or not a URL" };
  }
  const deployment = env.CONVEX_DEPLOYMENT?.split(/\s/)[0];
  if (deployment === `dev:${DEV_DEPLOYMENT}` && host === `${DEV_DEPLOYMENT}.convex.cloud`) return { ok: true, detail: `uses ${DEV_DEPLOYMENT} dev` };
  return { ok: false, detail: `CONVEX_DEPLOYMENT and VITE_CONVEX_URL must name dev (${DEV_DEPLOYMENT}); found ${deployment ?? "none"} and ${host}` };
}

export function missingApiKeys(env: Record<string, string | undefined>): string[] {
  return API_KEYS.filter((key) => !env[key]);
}

/** The main checkout is the first entry of `git worktree list --porcelain`. */
export function mainCheckout(porcelain: string): string | undefined {
  return /^worktree (.+)$/m.exec(porcelain)?.[1]?.trim();
}
