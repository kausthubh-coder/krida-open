// Which Convex functions read and write the most, from the deployment's recent logs, and the totals so far. Reads the
// dev backend through `npx convex logs`; --prod only with the owner's go (docs/ops.md). No browser, no profile.
//   node scripts/usage.mjs            # dev
//   node scripts/usage.mjs --prod     # production
//   node scripts/usage.mjs --prod --history 5000
// The free plan includes about 1 GB of database reads and writes a month and 1M function calls; the budget below
// is a thirtieth of that.
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const prod = args.includes("--prod");
const history = Number(args[args.indexOf("--history") + 1]) || 2000;
const BUDGET_MB_A_DAY = 33;

const convex = (...rest) => {
  const run = spawnSync("npx", ["convex", ...rest, ...(prod ? ["--prod"] : [])], { encoding: "utf8", shell: true, timeout: 120_000, maxBuffer: 256 * 1024 * 1024 });
  return run.stdout ?? "";
};

const totals = new Map();
let first = Infinity;
let last = 0;
for (const line of convex("logs", "--jsonl", "--success", "--history", String(history)).split("\n")) {
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    continue;
  }
  const usage = entry.usageStats;
  if (!usage || !entry.identifier) continue;
  first = Math.min(first, entry.timestamp);
  last = Math.max(last, entry.timestamp);
  const key = `${entry.udfType} ${entry.identifier.replace(/\.js:/, ":")}`;
  const t = totals.get(key) ?? { calls: 0, read: 0, written: 0, cached: 0 };
  t.calls++;
  t.read += usage.databaseIoReadBytes ?? 0;
  t.written += usage.databaseIoWriteBytes ?? 0;
  if (entry.cachedResult) t.cached++;
  totals.set(key, t);
}

const mb = (bytes) => (bytes / 1e6).toFixed(2).padStart(8);
const all = [...totals.values()].reduce((n, t) => n + t.read + t.written, 0);
const hours = (last - first) / 3600;
console.log(`${totals.size} functions over ${hours.toFixed(1)} h of logs (${prod ? "prod" : "dev"})\n`);
console.log("      MB   calls  share  function");
for (const [key, t] of [...totals].sort((a, b) => b[1].read + b[1].written - (a[1].read + a[1].written)).slice(0, 25))
  console.log(`${mb(t.read + t.written)} ${String(t.calls).padStart(7)} ${((100 * (t.read + t.written)) / Math.max(1, all)).toFixed(0).padStart(5)}%  ${key}`);
if (hours > 0) {
  const perDay = (all / 1e6) * (24 / hours);
  console.log(`\nAbout ${perDay.toFixed(1)} MB a day at this rate; the budget is ${BUDGET_MB_A_DAY} MB.`);
}
console.log(`\n${convex("deployment", "usage")}`);
