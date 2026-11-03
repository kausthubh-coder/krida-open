// npm run dev                     this checkout's app on its own port, on its own local Convex backend. Backend edits
//                                 hot-reload there and nowhere else.
// npm run dev -- --shared         the app against the shared dev deployment from .env.local. Pushes nothing.
// node scripts/dev.mjs stop       stops what `npm run dev` started here, by the PIDs it recorded.
// node scripts/dev.mjs remove     stops dev, then removes this worktree with its backend (git refuses unsaved work).
// node scripts/dev.mjs convex …   the Convex CLI against this checkout's backend (run, data, env, logs).
// PORT=… still overrides the port.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { convexArgs, devFile, mainCheckout, root, runningDev, setup, SHARED_DEV } from "./setup.mjs";

const [command, ...rest] = process.argv.slice(2);
const stopTree = (pid) => {
  if (!pid) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore" });
  else try { process.kill(-pid, "SIGTERM"); } catch { /* already gone */ }
};

function stop() {
  const dev = runningDev();
  if (!dev) console.log("Dev isn't running in this checkout.");
  else {
    stopTree(dev.pid);
    rmSync(devFile, { force: true });
    console.log(`Stopped dev at ${dev.url} (PID ${dev.pid}).`);
  }
  return Boolean(dev);
}

if (command === "stop") {
  stop();
} else if (command === "remove") {
  // git worktree remove leaves the .claude/skills junction (and so the folder) behind, so it goes first.
  const main = mainCheckout();
  if (!main || resolve(main) === resolve(root)) throw new Error("This is the main checkout; only worktrees can be removed.");
  // The backend lets go of its database a moment after it dies.
  if (stop()) await new Promise((r) => setTimeout(r, 2000));
  const link = join(root, ".claude/skills");
  if (existsSync(link) && lstatSync(link).isSymbolicLink()) unlinkSync(link);
  process.chdir(main);
  // Without --force, git refuses a worktree with changes or untracked files.
  const removed = spawnSync("git", ["worktree", "remove", root], { stdio: "inherit" });
  if (removed.status !== 0) {
    process.exitCode = 1;
    console.log("Not removed. Rerun npm run setup in it to restore the .claude/skills link.");
  } else {
    for (let i = 0; i < 20 && existsSync(root); i++) {
      try { rmSync(root, { recursive: true, force: true }); } catch { await new Promise((r) => setTimeout(r, 250)); }
    }
    console.log(existsSync(root)
      ? `Git removed the worktree, but ${root} is still there: something (a shell's working directory?) holds it open. Delete it once that ends.`
      : `Removed ${root}. Its branch is still there: git -C ${main} branch -d <branch>.`);
  }
} else if (command === "convex") {
  await setup();
  const { command: node, args, options } = convexArgs(rest);
  process.exitCode = spawnSync(node, args, { ...options, stdio: "inherit" }).status ?? 1;
} else {
  const shared = command === "--shared";
  const dev = runningDev();
  if (dev) throw new Error(`Dev is already running here at ${dev.url} (PID ${dev.pid}). Stop it with node scripts/dev.mjs stop.`);
  const state = await setup();
  const port = Number(process.env.PORT) || state.port;
  const children = [];
  const start = (label, cmd, args, options) => {
    const child = spawn(cmd, args, { ...options, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
    const prefix = (chunk) => process.stdout.write(chunk.toString().replace(/^(?=.)/gm, `[${label}] `));
    child.stdout.on("data", prefix);
    child.stderr.on("data", prefix);
    child.on("exit", (code) => {
      console.log(`[${label}] exited with code ${code}; stopping dev`);
      shutdown(code ?? 1);
    });
    children.push(child);
    return child;
  };
  let stopping = false;
  const shutdown = (code) => {
    if (stopping) return;
    stopping = true;
    for (const child of children) stopTree(child.pid);
    rmSync(devFile, { force: true });
    process.exit(code);
  };
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));

  const viteEnv = { ...process.env, PORT: String(port), VITE_KRIDA_PREVIEW: "" };
  let backend = `shared ${SHARED_DEV} (from .env.local; functions are whatever was pushed last)`;
  if (!shared) {
    const convexUrl = `http://127.0.0.1:${state.backendPort}`;
    backend = `own local Convex ${convexUrl}`;
    // Watches convex/ like `npx convex dev`, but pushes to this checkout's backend only.
    const { command: node, args, options } = convexArgs(["dev", "--local-cloud-port", String(state.backendPort), "--local-site-port", String(state.backendPort + 1)]);
    start("convex", node, args, options);
    // Variables already in the environment beat .env.local, so the browser talks to this backend.
    Object.assign(viteEnv, { VITE_CONVEX_URL: convexUrl, VITE_CONVEX_SITE_URL: `http://127.0.0.1:${state.backendPort + 1}` });
  }
  start("vite", process.execPath, [join(root, "node_modules/vite/bin/vite.js")], { cwd: root, env: viteEnv });
  const url = `http://localhost:${port}`;
  writeFileSync(devFile, `${JSON.stringify({ pid: process.pid, url, backend, children: children.map((c) => c.pid) }, null, 2)}\n`);
  console.log(`Krida dev: ${url} on ${backend}.${shared ? "" : " Profiles Worktree-QA-one and Worktree-QA-two, password in .krida.local/worktree.json."}`);
}
