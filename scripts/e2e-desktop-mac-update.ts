// Krida for Mac updating itself: two release copies of a renamed test app ("Krida Update Test", so the Krida in use
// is never touched), 0.9.0 and 0.9.1, each with mpv bundled. The older one, opened with KRIDA_UPDATE_URL pointing at a
// latest.json served here, finds the newer as it opens, before anything has played, checks its signature, replaces
// itself and opens again on it. Signed with open Krida's update key in ~/.krida-open, as releases are.
// Usage: npm run qa -- up; node scripts/e2e-desktop-mac-update.ts [outDir]   (takes about 10 minutes: two release builds)
import { execFileSync, spawn } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { checks, qaSession } from "./lib/qa.ts";

const repo = resolve(import.meta.dirname, "..");
const desktop = join(repo, "desktop");
const out = resolve(process.argv[2] ?? `${repo}/.artifacts/desktop-mac-update`);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const key = join(homedir(), ".krida-open/krida-open-updater.key");
const PORT = 9453;
const NAME = "Krida Update Test";
const OLD = { version: "0.9.0", notes: "The copy that updates" };
const NEW = { version: "0.9.1", notes: "Updated as it opened" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => boolean, ms: number) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(500)) if (ok()) return true;
  return false;
};
const { check, finish } = checks();

const build = (v: typeof OLD) => {
  const conf = join(out, `conf-${v.version}.json`);
  writeFileSync(conf, JSON.stringify({ productName: NAME, identifier: "app.krida.updatetest", version: v.version, plugins: { updater: { dangerousInsecureTransportProtocol: true } } }));
  execFileSync("npx", ["tauri", "build", "--bundles", "app", "--config", conf], { cwd: desktop, stdio: "inherit", env: { ...process.env, KRIDA_RELEASE_NOTES: v.notes } });
  const app = join(out, v.version, `${NAME}.app`);
  cpSync(join(desktop, `src-tauri/target/release/bundle/macos/${NAME}.app`), app, { recursive: true });
  execFileSync("node", ["scripts/bundle-mac.mjs", app], { cwd: desktop, stdio: "inherit" });
  return app;
};
const newer = build(NEW);
const older = build(OLD);

// The update, packed and signed as scripts/release.ts does it.
const tarball = join(out, "update.app.tar.gz");
execFileSync("tar", ["--no-mac-metadata", "-czf", tarball, "-C", join(newer, ".."), `${NAME}.app`], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
execFileSync("npx", ["tauri", "signer", "sign", "-f", key, "-p", "", tarball], { cwd: desktop, stdio: "inherit", env: { ...process.env, CI: "true" } });
const manifest = {
  version: NEW.version,
  notes: NEW.notes,
  pub_date: new Date().toISOString(),
  platforms: { "darwin-aarch64": { signature: readFileSync(`${tarball}.sig`, "utf8"), url: `http://127.0.0.1:${PORT}/update.app.tar.gz` } },
};
const asked: string[] = [];
const server = createServer((req, res) => {
  asked.push(req.url ?? "");
  if (req.url === "/latest.json") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(manifest));
  if (req.url === "/update.app.tar.gz") return res.writeHead(200).end(readFileSync(tarball));
  res.writeHead(404).end();
});
await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r));

// The older copy, installed where it can replace itself, opened on the QA app's sign-in.
const installed = join(out, "Applications", `${NAME}.app`);
cpSync(older, installed, { recursive: true });
const plist = () => execFileSync("defaults", ["read", join(installed, "Contents/Info"), "CFBundleShortVersionString"], { encoding: "utf8" }).trim();
check("the older copy is installed", plist() === OLD.version, plist());
const running = () => execFileSync("pgrep", ["-f", join(installed, "Contents/MacOS")], { encoding: "utf8" }).trim().split("\n").filter(Boolean).map(Number);
const first = spawn(join(installed, "Contents/MacOS/krida"), [], {
  env: { ...process.env, KRIDA_URL: qaSession().url, KRIDA_UPDATE_URL: `http://127.0.0.1:${PORT}/latest.json`, KRIDA_SILENT: "1", KRIDA_WINDOW_POS: "-3000,0" },
  stdio: "ignore",
  detached: true,
});
const pgrep = () => {
  try {
    return running();
  } catch {
    return [];
  }
};

check("it asks for latest.json, then the update", await until(() => asked.join(",") === "/latest.json,/update.app.tar.gz", 120_000), asked.join(","));
check("it replaces itself with the newer copy", await until(() => plist() === NEW.version, 60_000), plist());
check("it opens again on it", await until(() => pgrep().some((pid) => pid !== first.pid), 30_000), JSON.stringify({ first: first.pid, now: pgrep() }));
check("the first one has closed", await until(() => !pgrep().includes(first.pid!), 30_000), JSON.stringify(pgrep()));
const binary = readFileSync(join(installed, "Contents/MacOS/krida"), "latin1");
check("the copy running carries the new notes", binary.includes(NEW.notes) && !binary.includes(OLD.notes));
check("and still carries its own mpv", execFileSync("ls", [join(installed, "Contents/Frameworks")], { encoding: "utf8" }).includes("libmpv.2.dylib"));

for (const pid of pgrep()) process.kill(pid);
server.close();
finish();
