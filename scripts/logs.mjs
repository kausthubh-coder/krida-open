// What failed in people's browsers and apps (convex/logs.ts), newest first: Cinemeta, /api, Play, the player, uncaught
// errors. Read-only. The owner gave a standing go for --prod on this script (docs/ops.md).
//   node scripts/logs.mjs                        # this checkout's local backend
//   node scripts/logs.mjs --qa                   # the QA app (npm run qa -- up)
//   node scripts/logs.mjs --dev                  # the shared dev backend
//   node scripts/logs.mjs --prod                 # production
//   node scripts/logs.mjs --prod --hours 6 --kind meta --limit 100 --json
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { convexArgs, root } from "./setup.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const hours = Number(option("--hours", 24));
const kind = option("--kind", undefined);
const limit = Number(option("--limit", 50));
const query = JSON.stringify({ since: Date.now() - hours * 3_600_000, limit, ...(kind && { kind }) });

// The QA app's backend (`npm run qa -- up`), by its URL and admin key.
const qa = () => {
  const { adminKey } = JSON.parse(readFileSync(join(root, ".qa/backend/.convex/local/default/config.json"), "utf8"));
  const { convexUrl } = JSON.parse(readFileSync(join(root, ".qa/session.json"), "utf8"));
  return ["--url", convexUrl, "--admin-key", adminKey];
};
const target = args.includes("--prod") ? ["--prod"] : args.includes("--dev") ? [] : args.includes("--qa") ? qa() : null;
// Dev and prod go through the CLI as the repo knows it (.env.local names dev); local through this checkout's backend.
const { command, args: cli, options } = target
  ? { command: process.execPath, args: [join(root, "node_modules/convex/bin/main.js")], options: { cwd: root } }
  : convexArgs([]);
const run = spawnSync(command, [...cli, "run", ...(target ?? []), "logs:recent", query], { ...options, encoding: "utf8", timeout: 120_000 });
if (run.status !== 0) {
  console.error(run.stderr || run.stdout);
  process.exit(1);
}
const rows = JSON.parse(run.stdout);
if (args.includes("--json")) {
  console.log(JSON.stringify(rows, null, 2));
} else if (!rows.length) {
  console.log(`Nothing failed in the last ${hours} h${kind ? ` of kind ${kind}` : ""}.`);
} else {
  for (const row of rows.reverse()) {
    const when = new Date(row.at).toISOString().replace("T", " ").slice(0, 19);
    console.log(`${when}  ${row.kind.padEnd(9)} ${row.profile ?? "-"} · ${row.platform} · ${row.build ?? "dev"} · ${row.page}`);
    console.log(`  ${row.message}`);
    if (row.detail) console.log(`  ${row.detail.split("\n").slice(0, 4).join("\n  ")}`);
  }
}
