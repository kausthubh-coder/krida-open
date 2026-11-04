// Krida for Mac on a real TorBox account: the QA account gets the keys from .env.test.local (never printed), the
// first QA profile installs Torrentio from the suggestions (set up with that key), and the app opens a room for The
// Shawshank Redemption picked for the app. mpv must play the original file from TorBox's CDN (not its HLS), 4K, with
// sound, and keep playing. The file's link carries the key, so only its host is printed.
// Needs the QA app with no stand-ins (npm run qa -- up --real), TMDB_API_KEY, MDBLIST_API_KEY and TORBOX_API_KEY in
// .env.test.local, and a debug build
// (cd desktop && npx tauri build --debug --bundles app). The key stays on the QA app's throwaway backend.
// Usage: node scripts/e2e-desktop-real.ts [outDir]
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { assertLocal, checks, convexSignIn, qaSession } from "./lib/qa.ts";

const out = process.argv[2] ?? ".artifacts/desktop-real";
mkdirSync(out, { recursive: true });
const repo = join(import.meta.dirname, "..");
const app = join(repo, "desktop/src-tauri/target/debug/bundle/macos/Krida.app/Contents/MacOS/krida");
if (!existsSync(app)) throw new Error(`No ${app}: build it with cd desktop && npx tauri build --debug --bundles app`);
const env = parseEnv(readFileSync(join(repo, ".env.test.local"), "utf8"));
for (const name of ["TMDB_API_KEY", "MDBLIST_API_KEY", "TORBOX_API_KEY"]) if (!env[name]) throw new Error(`${name} is missing from .env.test.local`);
const s = qaSession();
assertLocal(s.url);
assertLocal(s.convexUrl);
const { adminKey } = JSON.parse(readFileSync(join(repo, ".qa/backend/.convex/local/default/config.json"), "utf8")) as { adminKey: string };
const admin = new ConvexHttpClient(s.convexUrl);
(admin as unknown as { setAdminAuth(key: string): void }).setAdminAuth(adminKey);
const client = new ConvexHttpClient(s.convexUrl);
const ref = <T extends "query" | "mutation" | "action">(_kind: T, name: string) => makeFunctionReference<T>(name);
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

// All three keys, so the account is past onboarding and the app opens on the room, not a setup step.
await admin.mutation(ref("mutation", "accounts:setKeysFor"), {
  account: "QA", keys: { tmdb: env.TMDB_API_KEY, mdblist: env.MDBLIST_API_KEY, debrid: { service: "torbox", key: env.TORBOX_API_KEY! } },
});
const me = await convexSignIn(client, s.profiles[0]!);
let pid: number | undefined;
try {
  const installed = (await client.query(ref("query", "addons:list"), { token: me.token })) as { suggestion?: string }[];
  if (!installed.some((a) => a.suggestion === "torrentio"))
    check("Torrentio installs with the real TorBox key", ((await client.action(ref("action", "addons:installSuggestion"), { token: me.token, suggestion: "torrentio" })) as { ok: boolean }).ok);
  const roomId = (await client.mutation(ref("mutation", "rooms:create"), {
    token: me.token, media: { type: "movie", imdbId: "tt0111161", videoId: "tt0111161", name: "The Shawshank Redemption" }, screen: "app",
  })) as string;
  const next = `/watch/${roomId}`;
  const url = `${s.url}/qa?name=${encodeURIComponent(s.profiles[0]!.name)}&password=${encodeURIComponent(s.profiles[0]!.password)}&next=${encodeURIComponent(next)}`;
  const child = spawn(app, [], {
    env: { ...process.env, KRIDA_URL: url, KRIDA_SILENT: "1", KRIDA_DATA_DIR: mkdtempSync(join(tmpdir(), "krida-real-")), KRIDA_WINDOW_SIZE: "1280,720" },
    stdio: "ignore",
  });
  pid = child.pid!;
  const socketDir = process.env.TMPDIR ?? tmpdir();
  let socket: string | undefined;
  let path: unknown = null;
  let time: unknown = null;
  // A real file can take a while: TorBox may have to add the torrent first.
  for (let i = 0; i < 240; i++) {
    await sleep(1000);
    socket ??= readdirSync(socketDir).filter((f) => f.startsWith(`krida-mpv-${pid}-`)).map((f) => join(socketDir, f)).at(-1);
    if (!socket) continue;
    path = await mpv(socket, "path");
    time = await mpv(socket, "time-pos");
    if (typeof path === "string" && typeof time === "number" && time > 5) break;
  }
  const host = typeof path === "string" && /^https?:\/\//.test(path) ? new URL(path).host : String(path);
  check("mpv plays the original file from TorBox's CDN, not its HLS", typeof path === "string" && path.startsWith("https://") && !/playlist\.m3u8/.test(path), host);
  const [w, codec, audio] = [await mpv(socket!, "width"), await mpv(socket!, "video-codec"), await mpv(socket!, "audio-codec-name")];
  check("it's the 4K picture, with sound", typeof w === "number" && w >= 3800 && typeof audio === "string" && audio.length > 0, `${w} wide, ${codec}, ${audio}`);
  const t1 = (await mpv(socket!, "time-pos")) as number;
  await sleep(10_000);
  const t2 = (await mpv(socket!, "time-pos")) as number;
  check("and it keeps playing", typeof t1 === "number" && typeof t2 === "number" && t2 - t1 > 7, `${t1?.toFixed?.(1)} s → ${t2?.toFixed?.(1)} s`);
} finally {
  if (pid) process.kill(pid);
  finish();
}
