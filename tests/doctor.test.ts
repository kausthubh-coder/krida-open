import { expect, test } from "vitest";
import { checkEnv, lockDrift, mainCheckout, missingApiKeys } from "../scripts/lib/doctor.ts";

const lock = {
  packages: {
    "": { version: "0.0.0" },
    "node_modules/convex": { version: "1.46.0" },
    "node_modules/react": { version: "19.2.8" },
    "node_modules/@esbuild/linux-x64": { version: "0.27.0", optional: true },
  },
};

test("lockDrift names each package whose installed version differs or is missing", () => {
  const installed = { packages: { "node_modules/convex": { version: "1.45.1" } } };
  expect(lockDrift(lock, installed)).toEqual(["convex wants 1.46.0, has 1.45.1", "react wants 19.2.8, has nothing"]);
});

test("lockDrift passes an install that matches, without other platforms' optional packages", () => {
  const installed = { packages: { "node_modules/convex": { version: "1.46.0" }, "node_modules/react": { version: "19.2.8" } } };
  expect(lockDrift(lock, installed)).toEqual([]);
});

test("lockDrift reports everything when npm left no record of node_modules", () => {
  expect(lockDrift(lock, undefined)).toEqual(["convex wants 1.46.0, has nothing", "react wants 19.2.8, has nothing"]);
});

const dev = {
  CONVEX_DEPLOYMENT: "dev:fastidious-oyster-35 # team: k, project: krida",
  VITE_CONVEX_URL: "https://fastidious-oyster-35.convex.cloud",
  VITE_CONVEX_SITE_URL: "https://fastidious-oyster-35.convex.site",
};

test("checkEnv accepts the dev deployment", () => {
  expect(checkEnv(dev)).toEqual({ ok: true, detail: "uses fastidious-oyster-35 dev" });
});

test("checkEnv refuses any Convex variable that names production", () => {
  expect(checkEnv({ ...dev, VITE_CONVEX_SITE_URL: "https://industrious-axolotl-949.convex.site" })).toEqual({
    ok: false,
    detail: "points at production (industrious-axolotl-949); worktrees use dev only",
  });
});

test("checkEnv refuses a local or other deployment and says what it found", () => {
  expect(checkEnv({ CONVEX_DEPLOYMENT: "anonymous:anonymous-agent", VITE_CONVEX_URL: "http://127.0.0.1:3210" })).toEqual({
    ok: false,
    detail: "CONVEX_DEPLOYMENT and VITE_CONVEX_URL must name dev (fastidious-oyster-35); found anonymous:anonymous-agent and 127.0.0.1",
  });
  expect(checkEnv({ CONVEX_DEPLOYMENT: "dev:fastidious-oyster-35" })).toEqual({ ok: false, detail: "VITE_CONVEX_URL is missing or not a URL" });
});

test("missingApiKeys lists the /api keys that are unset", () => {
  expect(missingApiKeys({ ...dev, TMDB_API_KEY: "k" })).toEqual(["MDBLIST_API_KEY"]);
  expect(missingApiKeys({ ...dev, TMDB_API_KEY: "k", MDBLIST_API_KEY: "m" })).toEqual([]);
});

test("mainCheckout reads the first worktree from git's porcelain output", () => {
  const porcelain = "worktree C:/dev/krida\nHEAD 29b95ff\nbranch refs/heads/main\n\nworktree C:/t3/krida/t3-1\nHEAD 6568793\nbranch refs/heads/t3/x\n";
  expect(mainCheckout(porcelain)).toBe("C:/dev/krida");
  expect(mainCheckout("")).toBeUndefined();
});
