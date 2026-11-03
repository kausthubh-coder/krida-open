// npm run qa -- up | down | status
//
// up: a Krida you can drive, on this machine, with this checkout's code. A throwaway local Convex backend runs this
// tree's functions, two QA profiles get a seeded library (scripts/regress/seed.ts), and Vite serves the app with hot
// reload. Writes .qa/session.json (URL, profiles, PIDs), which browser scripts read. Never touches dev or production.
// Play works too: stand-ins for a stream addon (installed on both profiles), TorBox and IntroDB serve a one-minute test
// video.
// /api asks TMDB and MDBList with the keys of the signed-in profile's account. Both QA profiles are in the account "QA",
// seeded with TMDB_API_KEY and MDBLIST_API_KEY from .env.local when it has them (placeholders otherwise: pages that show
// catalog rows load empty) and a TorBox key the stand-ins accept.
// up --real: no stand-ins, no keys and no addons. Add real keys in Settings → Connections and addons in Settings →
// Addons; Play then asks those addons, the real TorBox and IntroDB, and previews read the real file.
// down: stops what `up` started, by PID, and deletes the backend's data. Logs stay in .qa/.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { isRunning, start, stopTree, waitFor, freePort } from "./lib/proc.ts";
import { qaSession, SESSION_FILE, type QaSession } from "./lib/qa.ts";
import { removeWorkDir, setBackendEnv, startLocalBackend } from "./regress/backend.ts";
import { providerEnv, standInAddon } from "./regress/providers.ts";
import { seed } from "./regress/seed.ts";

const repo = fileURLToPath(new URL("../", import.meta.url));
const dir = resolve(repo, ".qa");
const command = process.argv[2];
const real = process.argv.includes("--real");

if (command === "up") {
  if (existsSync(SESSION_FILE)) {
    const s = qaSession();
    if (Object.values(s.pids).some((pid) => pid && isRunning(pid))) throw new Error(`A QA app is already up at ${s.url}. Run \`npm run qa -- down\` first.`);
    rmSync(SESSION_FILE);
  }
  mkdirSync(dir, { recursive: true });
  console.log("Starting a local Convex backend with this checkout's functions…");
  const backend = await startLocalBackend(repo, join(dir, "backend"), join(dir, "backend.log"));
  let vitePid: number | undefined;
  let providersPid: number | undefined;
  try {
    let standIns: Record<string, string> = {};
    let streamAddon: string | undefined;
    if (!real) {
      // Stand-ins for a stream addon, TorBox and IntroDB, so Play works with a one-minute test video.
      const providers = start(process.execPath, [join(repo, "scripts/regress/providers-server.ts"), join(repo, ".artifacts/regress/media")], {
        cwd: repo, env: process.env, log: join(dir, "providers.log"),
      });
      providersPid = providers.child.pid;
      await waitFor("the stand-in providers", () => providers.output().includes("providers http"), 120_000, providers);
      const base = /providers (\S+)/.exec(providers.output())![1];
      standIns = providerEnv(base);
      streamAddon = standInAddon(base);
      setBackendEnv(repo, join(dir, "backend"), standIns);
    }
    const envFile = join(repo, ".env.local");
    const local = existsSync(envFile) ? parseEnv(readFileSync(envFile, "utf8")) : {};
    const profiles = await seed(backend.url, backend.adminKey, real ? "none" : {
      tmdb: process.env.TMDB_API_KEY ?? local.TMDB_API_KEY, mdblist: process.env.MDBLIST_API_KEY ?? local.MDBLIST_API_KEY,
    }, streamAddon);
    const port = Number(process.env.PORT) || await freePort();
    const vite = start(process.execPath, [join(repo, "scripts/regress/vite-server.ts")], {
      cwd: repo,
      // /api/frame reads the stand-in TorBox too, and so does the frames Worker, which Vite runs under /frames-worker.
      env: {
        ...process.env, ...standIns, PORT: String(port), KRIDA_HMR: "1", VITE_CONVEX_URL: backend.url, VITE_CONVEX_SITE_URL: backend.siteUrl, VITE_KRIDA_PREVIEW: "",
        FRAMES_URL: `http://127.0.0.1:${port}/frames-worker`, FRAMES_SECRET: "qa",
      },
      log: join(dir, "vite.log"),
    });
    vitePid = vite.child.pid;
    await waitFor("the dev server", () => vite.output().includes("ready http"), 60_000, vite);
    const session: QaSession = { url: `http://127.0.0.1:${port}`, convexUrl: backend.url, siteUrl: backend.siteUrl, profiles, pids: { backend: backend.pid, vite: vitePid, providers: providersPid }, tree: repo };
    writeFileSync(SESSION_FILE, `${JSON.stringify(session, null, 2)}\n`);
    console.log(`\nKrida is up at ${session.url}`);
    for (const p of profiles) console.log(`  profile ${p.name}, password ${p.password}`);
    console.log(`Backend ${backend.url} (local, throwaway). Logs in .qa/. Stop with: npm run qa -- down`);
  } catch (error) {
    stopTree(vitePid);
    stopTree(providersPid);
    backend.stop();
    throw error;
  }
} else if (command === "down") {
  if (!existsSync(SESSION_FILE)) {
    console.log("No QA app is up.");
  } else {
    const s = qaSession();
    stopTree(s.pids.vite);
    stopTree(s.pids.providers);
    stopTree(s.pids.backend);
    rmSync(SESSION_FILE);
    console.log(`Stopped the QA app at ${s.url}.`);
  }
  await new Promise((r) => setTimeout(r, 500));
  removeWorkDir(join(dir, "backend"));
} else if (command === "status") {
  if (!existsSync(SESSION_FILE)) {
    console.log("No QA app is up. Start one with `npm run qa -- up`.");
  } else {
    const s = qaSession();
    const answers = await fetch(s.url).then((r) => r.ok, () => false);
    console.log(`${answers ? "UP" : "DOWN"} ${s.url} (backend ${s.convexUrl}; vite PID ${s.pids.vite} ${s.pids.vite && isRunning(s.pids.vite) ? "running" : "gone"}, backend PID ${s.pids.backend} ${s.pids.backend && isRunning(s.pids.backend) ? "running" : "gone"})`);
    for (const p of s.profiles) console.log(`  profile ${p.name}, password ${p.password}`);
    process.exitCode = answers ? 0 : 1;
  }
} else {
  console.log("Usage: npm run qa -- up [--real] | down | status");
  process.exitCode = 1;
}
