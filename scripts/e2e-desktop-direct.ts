// Krida for Mac plays another debrid service's file in mpv: the QA account on Real-Debrid (a stand-in key), the first
// QA profile with only the stand-in debrid addon, whose 1080p MKV redirects to the file as a debrid service's link
// does. The app opens on the room (signed in through /qa's URL), and mpv's own socket says what it plays. A picture of
// the app's window goes in the out folder. Puts the account back on the stand-in TorBox at the end.
// Needs the QA app (npm run qa -- up) and a debug build (cd desktop && npx tauri build --debug --bundles app).
//   node scripts/e2e-desktop-direct.ts [outDir]
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { assertLocal, checks, convexSignIn, qaSession } from "./lib/qa.ts";
import { standInDirectAddon } from "./regress/providers.ts";

const out = process.argv[2] ?? ".artifacts/playback";
mkdirSync(out, { recursive: true });
const repo = join(import.meta.dirname, "..");
const app = join(repo, "desktop/src-tauri/target/debug/bundle/macos/Krida.app/Contents/MacOS/krida");
if (!existsSync(app)) throw new Error(`No ${app}: build it with cd desktop && npx tauri build --debug --bundles app`);
const s = qaSession();
assertLocal(s.url);
assertLocal(s.convexUrl);
const providers = /providers (\S+)/.exec(readFileSync(join(repo, ".qa/providers.log"), "utf8"))![1];
const { adminKey } = JSON.parse(readFileSync(join(repo, ".qa/backend/.convex/local/default/config.json"), "utf8")) as { adminKey: string };
const admin = new ConvexHttpClient(s.convexUrl);
(admin as unknown as { setAdminAuth(key: string): void }).setAdminAuth(adminKey);
const client = new ConvexHttpClient(s.convexUrl);
const ref = <T extends "query" | "mutation" | "action">(_kind: T, name: string) => makeFunctionReference<T>(name);
const setDebrid = (service: "realdebrid" | "torbox", key: string) =>
  admin.mutation(ref("mutation", "accounts:setKeysFor"), { account: "QA", keys: { debrid: { service, key } } });
const { check, finish } = checks();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One property from mpv, through the socket the app opened for it. */
function mpv(socket: string, name: string) {
  return new Promise<unknown>((resolve) => {
    const c = connect(socket);
    let data = "";
    const done = (v: unknown) => {
      c.destroy();
      resolve(v);
    };
    c.on("data", (d) => {
      data += d;
      for (const line of data.split("\n")) {
        try {
          const m = JSON.parse(line) as { request_id?: number; data?: unknown };
          if (m.request_id === 7) return done(m.data ?? null);
        } catch {}
      }
    });
    c.on("error", () => done(null));
    c.write(`${JSON.stringify({ command: ["get_property", name], request_id: 7 })}\n`);
    setTimeout(() => done(null), 2000);
  });
}

const me = await convexSignIn(client, s.profiles[0]);
type Addon = { _id: string; url: string };
const addons = async () => (await client.query(ref("query", "addons:list"), { token: me.token })) as Addon[];
const direct = standInDirectAddon(providers);
let pid: number | undefined;
try {
  await setDebrid("realdebrid", "stand-in-real-debrid");
  if (!(await addons()).some((a) => a.url === direct)) await client.action(ref("action", "addons:install"), { token: me.token, url: `${direct}/manifest.json` });
  for (const a of await addons()) await client.mutation(ref("mutation", "addons:setEnabled"), { token: me.token, addonId: a._id, enabled: a.url === direct });
  // The room the app opens on: Night of the Living Dead, picked for the app, so Krida's pick is the 1080p MKV.
  const roomId = (await client.mutation(ref("mutation", "rooms:create"), {
    token: me.token, media: { type: "movie", imdbId: "tt0063350", videoId: "tt0063350", name: "Night of the Living Dead" }, screen: "app",
  })) as string;
  const next = `/watch/${roomId}`;
  const url = `${s.url}/qa?name=${encodeURIComponent(s.profiles[0].name)}&password=${encodeURIComponent(s.profiles[0].password)}&next=${encodeURIComponent(next)}`;
  const data = mkdtempSync(join(tmpdir(), "krida-direct-"));
  const child = spawn(app, [], {
    env: { ...process.env, KRIDA_URL: url, KRIDA_SILENT: "1", KRIDA_DATA_DIR: data, KRIDA_WINDOW_SIZE: "1280,720" },
    stdio: "ignore",
  });
  pid = child.pid!;
  const socketDir = process.env.TMPDIR ?? tmpdir();
  let socket: string | undefined;
  let path: unknown = null;
  let time: unknown = null;
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    socket ??= readdirSync(socketDir).filter((f) => f.startsWith(`krida-mpv-${pid}-`)).map((f) => join(socketDir, f)).at(-1);
    if (!socket) continue;
    path = await mpv(socket, "path");
    time = await mpv(socket, "time-pos");
    if (typeof path === "string" && typeof time === "number" && time > 3) break;
  }
  check("the app hands the debrid service's file to mpv", path === `${providers}/file/test.mkv`, String(path));
  const format = await mpv(socket!, "file-format");
  const codec = await mpv(socket!, "video-codec");
  check("mpv plays it, MKV and all", typeof time === "number" && time > 3 && format === "mkv", `${format}, ${codec}, at ${typeof time === "number" ? time.toFixed(1) : time} s`);
  await sleep(1500);
  // The app's window, by its window number (screencapture can't find it by name).
  const windows = execFileSync("swift", [join(import.meta.dirname, "lib/windows.swift"), String(pid)], { encoding: "utf8" })
    .trim().split("\n").map((l) => l.split(" ")).filter(([, layer, w]) => layer === "0" && Number(w) > 600);
  if (windows[0]) execFileSync("screencapture", ["-x", "-o", "-l", windows[0][0], join(out, "desktop-mac-mpv-direct.png")]);
  check("a picture of the app's window was taken", !!windows[0]);
} finally {
  if (pid) process.kill(pid);
  await setDebrid("torbox", "regress-torbox");
  for (const a of await addons()) {
    if (a.url === direct) await client.mutation(ref("mutation", "addons:remove"), { token: me.token, addonId: a._id });
    else await client.mutation(ref("mutation", "addons:setEnabled"), { token: me.token, addonId: a._id, enabled: true });
  }
  finish();
}
