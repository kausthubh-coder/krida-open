// Makes a cloud session (Claude Code on the web, Codex Cloud) ready by itself. A cloud VM starts from a bare Linux
// clone: no global skills, no deps, no .env.local, no .claude/skills link, no Chrome.
//
//   Claude: the SessionStart hook in .claude/settings.json runs `node scripts/cloud.mjs`
//   Codex:  the environment's setup script is `CLOUD=1 node scripts/cloud.mjs`
//
// Local sessions don't set CLAUDE_CODE_REMOTE, CODEX_CI or CLOUD, so it exits at once there. stdout becomes the
// session's context, so only my rules and the last line go there; setup's output goes to stderr. Imports nothing from
// node_modules at load: it runs before the install.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.env.CLAUDE_CODE_REMOTE !== "true" && !process.env.CODEX_CI && process.env.CLOUD !== "1") process.exit(0);

const root = fileURLToPath(new URL("../", import.meta.url));
const problems = [];
const run = (command, stdout) => spawnSync(command, { cwd: root, shell: true, stdio: ["ignore", stdout, "inherit"] }).status === 0;

// 1. My global skills and rules. Its stdout (the rules) passes through to the session.
if (!run("curl -fsSL https://raw.githubusercontent.com/kausthubh-coder/skills/main/cloud/session.sh | bash", "inherit")) {
  problems.push("the global skills and rules didn't load");
}

// 2. Setup: .env.local for dev, npm ci, ports, the local Convex backend with QA profiles, the skills link, the doctor.
if (!run("node scripts/setup.mjs", process.stderr)) problems.push("setup or the doctor failed (run npm run setup)");

// 3. Commits under the name main's last commit has (mine): the VM commits as Claude, and Vercel's Hobby plan won't
// deploy a commit whose author isn't on the project, so a ship from here would land on main and never go live.
const author = (format) => spawnSync("git", ["log", "-1", `--format=${format}`, "origin/main"], { cwd: root, encoding: "utf8" }).stdout?.trim();
const [name, email] = [author("%an"), author("%ae")];
if (!name || !email || spawnSync("git", ["config", "user.name", name], { cwd: root }).status !== 0 || spawnSync("git", ["config", "user.email", email], { cwd: root }).status !== 0) {
  problems.push("couldn't set the git author, so Vercel won't deploy commits from here");
}

// 4. A browser for the e2e, shots and regress scripts. The VM's Chromium usually counts; the doctor reports it.
const { findBrowser } = await import("./lib/browser.ts").catch(() => ({ findBrowser: () => undefined }));
if (!findBrowser() && !run("node node_modules/playwright-core/cli.js install chromium", process.stderr)) {
  problems.push("no browser for the scripts, and installing Playwright's Chromium failed");
}

console.log(problems.length
  ? `cloud: krida NOT ready: ${problems.join("; ")}.`
  : "cloud: krida ready (deps, .env.local for dev, own local backend with QA profiles, skills, git author, browser). See ## Cloud sessions in AGENTS.md.");
