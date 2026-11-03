// Puts mpv.exe in src-tauri/mpv/ for the app to bundle: a pinned build from shinchiro/mpv-winbuild-cmake, fetched
// once. Needs 7z on PATH to unpack it. Bump MPV_TAG and MPV_FILE together to update mpv.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const MPV_TAG = "20261018";
const MPV_FILE = "mpv-x86_64-20261018-git-01e2533f31.7z";

// A Mac plays through Homebrew's libmpv instead (src-tauri/src/mpv_mac.rs), unless it's building the Windows app
// (scripts/release.ts, --windows).
if (process.platform === "darwin" && !process.argv.includes("--windows")) process.exit(0);

const dir = fileURLToPath(new URL("../src-tauri/mpv/", import.meta.url));
const exe = join(dir, "mpv.exe");
const stamp = join(dir, "VERSION");

if (existsSync(exe) && existsSync(stamp)) process.exit(0);
mkdirSync(dir, { recursive: true });
const url = `https://github.com/shinchiro/mpv-winbuild-cmake/releases/download/${MPV_TAG}/${MPV_FILE}`;
console.log(`Fetching mpv ${MPV_TAG}…`);
const res = await fetch(url);
if (!res.ok) throw new Error(`mpv download answered ${res.status}: ${url}`);
const archive = join(dir, MPV_FILE);
writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
execFileSync("7z", ["e", "-y", `-o${dir}`, archive, "mpv.exe"], { stdio: "ignore" });
rmSync(archive);
if (!existsSync(exe)) throw new Error("The mpv archive had no mpv.exe");
writeFileSync(stamp, `${MPV_FILE}\n`);
console.log(`mpv ready: ${exe}`);
