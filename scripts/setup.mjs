// npm run setup: makes this checkout run on its own, next to every other worktree. Safe to rerun; when nothing is
// missing it takes seconds. In order: .env.local from the main checkout (dev values only; with none, the dev URLs and no
// keys), npm ci when node_modules is missing or older than the lockfile, a dev port and backend ports picked from a hash of this path, this checkout's own
// local Convex backend with two QA profiles, the .claude/skills link, then the doctor.
//
// State lives in .krida.local/ (ignored by git): worktree.json (ports, QA password), backend/ (the local Convex
// deployment's code pointer and data), dev.json (what `npm run dev` started, while it runs).
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const root = fileURLToPath(new URL("../", import.meta.url));
export const stateDir = join(root, ".krida.local");
export const backendDir = join(stateDir, "backend");
const stateFile = join(stateDir, "worktree.json");
export const devFile = join(stateDir, "dev.json");
export const PROD_DEPLOYMENT = "industrious-axolotl-949";
export const SHARED_DEV = "fastidious-oyster-35";
export const QA_PROFILES = [["Worktree-QA-one", 28], ["Worktree-QA-two", 205]];
// Vite ports come from 5200-5899, local Convex from 3300-3899 (cloud port even, site port the next one), so they stay
// clear of 5173 and of the backends `npm run qa` starts from 3210.
const VITE_PORTS = [5200, 700];
const BACKEND_PORTS = [3300, 300];

const readJson = (path) => {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
};
export const readState = () => readJson(stateFile);
const writeState = (state) => writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);

export function isRunning(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** What `npm run dev` started here, if it is still running. */
export function runningDev() {
  const dev = readJson(devFile);
  return dev && isRunning(dev.pid) ? dev : undefined;
}

/** The main checkout: the folder holding the shared .git. */
export function mainCheckout() {
  const out = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, encoding: "utf8" });
  return out.status === 0 ? dirname(out.stdout.trim()) : undefined;
}

/** The Convex CLI, run against this checkout's local backend. Never the shared dev or production deployment. */
export function convexArgs(args) {
  // CONVEX_* from the caller's shell could point the CLI at a cloud deployment; anonymous mode keeps it local.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("CONVEX_")));
  return { command: process.execPath, args: [join(root, "node_modules/convex/bin/main.js"), ...args], options: { cwd: backendDir, env: { ...env, CONVEX_AGENT_MODE: "anonymous" } } };
}
function convex(args) {
  const { command, args: all, options } = convexArgs(args);
  const out = spawnSync(command, all, { ...options, encoding: "utf8", timeout: 300_000 });
  return { ok: out.status === 0, output: `${out.stdout ?? ""}${out.stderr ?? ""}`.trim() };
}

// Windows lets a new listener share a port with one on another address (Vite on ::1, Convex on 0.0.0.0), so a test
// listen alone misses them. A port is free when nothing answers on either loopback address.
const answers = (port, host) => new Promise((done) => {
  const socket = connect({ port, host, timeout: 500 });
  socket.once("connect", () => { socket.destroy(); done(true); });
  socket.once("timeout", () => { socket.destroy(); done(false); });
  socket.once("error", () => done(false));
});
const portFree = async (port) => !(await answers(port, "127.0.0.1")) && !(await answers(port, "::1"));

/** Ports other worktrees of this repo already claimed, running or not. */
function claimedPorts() {
  const list = spawnSync("git", ["worktree", "list", "--porcelain"], { cwd: root, encoding: "utf8" }).stdout ?? "";
  const ports = new Set();
  for (const [, path] of list.matchAll(/^worktree (.+)$/gm)) {
    if (resolve(path.trim()) === resolve(root)) continue;
    const other = readJson(join(path.trim(), ".krida.local", "worktree.json"));
    for (const port of [other?.port, other?.backendPort, other?.backendPort + 1]) if (port) ports.add(port);
  }
  return ports;
}

async function pickPort([base, span], step, claimed) {
  const hash = createHash("sha1").update(realpathSync(root).toLowerCase()).digest().readUInt32BE(0);
  const slots = Math.floor(span / step);
  for (let i = 0; i < slots; i++) {
    const port = base + ((hash + i) % slots) * step;
    const ports = step === 2 ? [port, port + 1] : [port];
    if (ports.some((p) => claimed.has(p))) continue;
    if ((await Promise.all(ports.map(portFree))).every(Boolean)) return port;
  }
  throw new Error(`No free port in ${base}-${base + span}`);
}

/** Lines for `npm run doctor`: this checkout's port, backend, dev server and skills link. Sets a failing exit code. */
export async function worktreeDoctor() {
  const say = (state, name, detail) => {
    if (state === "FAIL") process.exitCode = 1;
    console.log(`${state} ${name}: ${detail}`);
  };
  const state = readState();
  if (!state) {
    say("FAIL", "Worktree", "no .krida.local/worktree.json; run npm run setup");
  } else {
    const clash = [state.port, state.backendPort].filter((port) => claimedPorts().has(port));
    say(clash.length ? "FAIL" : "PASS", "Worktree", clash.length
      ? `port ${clash.join(", ")} is also claimed by another worktree; delete .krida.local/worktree.json and run npm run setup`
      : `dev port ${state.port}, own backend http://127.0.0.1:${state.backendPort}`);
    const created = existsSync(join(backendDir, ".convex/local/default/config.json"));
    say(created && state.seeded ? "PASS" : "FAIL", "Backend", created && state.seeded
      ? `local Convex in .krida.local/backend with ${QA_PROFILES.map(([name]) => name).join(" and ")} (password in .krida.local/worktree.json); the shared ${SHARED_DEV} gets no pushes from here`
      : "not created yet; run npm run setup");
  }
  const dev = runningDev();
  console.log(dev ? `INFO Dev: running at ${dev.url} (PID ${dev.pid}); stop it with node scripts/dev.mjs stop` : "INFO Dev: not running; start it with npm run dev");
  const link = join(root, ".claude/skills");
  let linked = false;
  try { linked = lstatSync(link).isSymbolicLink() && realpathSync(link) === realpathSync(join(root, ".agents/skills")); } catch { /* missing */ }
  say(linked ? "PASS" : "FAIL", "Skills", linked ? ".claude/skills links to .agents/skills" : ".claude/skills is not a link to .agents/skills; run npm run setup");
}

/** Everything except the doctor. Returns this checkout's state. */
export async function setup() {
  mkdirSync(stateDir, { recursive: true });
  const main = mainCheckout();

  // 1. .env.local: dev values from the main checkout. A file that names production is never copied. With nothing to
  // copy (a cloud VM's lone clone), it names the shared dev deployment and holds no keys: those come from the
  // environment, which Vite reads before .env.local.
  const envFile = join(root, ".env.local");
  if (!existsSync(envFile)) {
    const source = main && resolve(main) !== resolve(root) ? join(main, ".env.local") : undefined;
    const text = source && existsSync(source) ? readFileSync(source, "utf8") : "";
    if (text.includes(PROD_DEPLOYMENT) || /^CONVEX_DEPLOY_KEY=prod:/m.test(text)) console.log(`WARN .env.local: not copied, ${source} names production`);
    else if (text) {
      copyFileSync(source, envFile);
      console.log(`setup: copied .env.local from ${main}`);
    } else {
      writeFileSync(envFile, [`CONVEX_DEPLOYMENT=dev:${SHARED_DEV}`, `VITE_CONVEX_URL=https://${SHARED_DEV}.convex.cloud`,
        `VITE_CONVEX_SITE_URL=https://${SHARED_DEV}.convex.site`, ""].join("\n"));
      console.log(`setup: wrote .env.local for the shared ${SHARED_DEV} dev (no keys; ${source ? `${source} is missing` : "no other checkout to copy from"})`);
    }
  }

  // 2. Dependencies: npm ci when node_modules is missing or the lockfile changed after the last install.
  const installed = join(root, "node_modules/.package-lock.json");
  if (!existsSync(installed) || statSync(join(root, "package-lock.json")).mtimeMs > statSync(installed).mtimeMs) {
    const dev = runningDev();
    if (dev) throw new Error(`Dependencies need npm ci, but dev is running here (PID ${dev.pid}). Run node scripts/dev.mjs stop first.`);
    console.log("setup: npm ci");
    const npm = spawnSync("npm ci --no-audit --no-fund", { cwd: root, stdio: "inherit", shell: true });
    if (npm.status !== 0) throw new Error("npm ci failed");
  }

  // 3. Ports, picked once and kept, so a running dev server never makes a rerun move them.
  let state = readState() ?? {};
  if (!state.port || !state.backendPort) {
    const claimed = claimedPorts();
    state.port ??= await pickPort(VITE_PORTS, 1, claimed);
    claimed.add(state.port);
    state.backendPort ??= await pickPort(BACKEND_PORTS, 2, claimed);
    state.password ??= randomBytes(9).toString("base64url");
    writeState(state);
  }

  // 4. This checkout's own Convex backend: a local deployment whose functions are this tree's convex/ folder. It runs
  // from .krida.local/backend so its .env.local never replaces the root one, which keeps pointing at the shared dev.
  mkdirSync(backendDir, { recursive: true });
  writeFileSync(join(backendDir, "convex.json"), `${JSON.stringify({ functions: "../../convex/" })}\n`);
  const convexVersion = readJson(join(root, "package.json"))?.dependencies?.convex;
  writeFileSync(join(backendDir, "package.json"), `${JSON.stringify({ private: true, type: "module", dependencies: { convex: convexVersion } })}\n`);
  if (!existsSync(join(backendDir, ".convex/local/default/config.json"))) {
    console.log(`setup: creating the local backend on port ${state.backendPort}`);
    const push = convex(["dev", "--once", "--typecheck", "disable", "--codegen", "disable", "--tail-logs", "disable",
      "--local-cloud-port", String(state.backendPort), "--local-site-port", String(state.backendPort + 1)]);
    if (!push.ok) throw new Error(`Couldn't create the local backend:\n${push.output.slice(-2000)}`);
    state.seeded = false;
    writeState(state);
  }
  if (!state.seeded) {
    // The CLI sometimes exits non-zero on Windows after the call succeeded (a libuv assertion at exit), so the
    // profile list decides, not the exit codes.
    for (const [name, hue] of QA_PROFILES) convex(["run", "profiles:add", JSON.stringify({ name, hue, password: state.password })]);
    const list = convex(["data", "profiles"]);
    const missing = QA_PROFILES.map(([name]) => name).filter((name) => !list.output.includes(name));
    if (missing.length) throw new Error(`Couldn't add ${missing.join(", ")} to the local backend:\n${list.output.slice(-2000)}`);
    state.seeded = true;
    writeState(state);
    console.log(`setup: added ${QA_PROFILES.map(([name]) => name).join(" and ")} to the local backend`);
  }

  // 5. Claude Code reads .claude/skills, Codex reads .agents/skills: one folder, linked.
  const link = join(root, ".claude/skills");
  // Checkouts from before the link have a real folder of pointer stubs; replace it.
  if (existsSync(link) && !lstatSync(link).isSymbolicLink() && readdirSync(link).every((name) => existsSync(join(root, ".agents/skills", name)))) {
    rmSync(link, { recursive: true });
  }
  if (existsSync(join(root, ".agents/skills")) && !existsSync(link)) {
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(join(root, ".agents/skills"), link, "junction");
    console.log("setup: linked .claude/skills to .agents/skills");
  }
  return state;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const state = await setup();
  const doctor = spawnSync(process.execPath, [join(root, "scripts/doctor.mjs")], { cwd: root, stdio: "inherit" });
  console.log(doctor.status === 0
    ? `\nReady. npm run dev serves http://localhost:${state.port} on its own backend http://127.0.0.1:${state.backendPort}.`
    : "\nNot ready: fix the FAIL lines above, then rerun npm run setup.");
  process.exitCode = doctor.status ?? 1;
}
