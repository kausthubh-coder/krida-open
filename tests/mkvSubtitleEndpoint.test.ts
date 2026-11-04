import { afterEach, beforeEach, expect, test, vi } from "vitest";
import frames from "../api/frames";
import { subtitleFile } from "./mkvFile";

const file = subtitleFile();
const BACKEND = "http://127.0.0.1:3987";
const keys: string[] = [];
beforeEach(() => {
  keys.length = 0;
  vi.stubEnv("VERCEL_ENV", "");
  vi.stubEnv("TORBOX_API_URL", "https://torbox-subs.test");
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin === BACKEND) {
      const { path, args } = JSON.parse(String(init?.body));
      const token = args[0].token;
      return Response.json({ status: "success", value: path === "profiles:me"
        ? token === "unknown" ? null : { _id: token, name: "QA" }
        : { debrid: { service: "torbox", key: token } } });
    }
    if (url.hostname === "torbox-subs.test") {
      const key = new Headers(init?.headers).get("authorization")!;
      keys.push(key);
      if (url.pathname === "/torrents/mylist") return Response.json({ success: true, data: key === "Bearer owner" ? [{ id: 1, files: [{ id: 1, size: file.length }] }] : [] });
      return Response.json({ success: true, data: "https://file-subs.test/movie" });
    }
    const range = new Headers(init?.headers).get("range")!;
    const [, a, b] = /^bytes=(\d+)-(\d+)$/.exec(range)!;
    return new Response(file.slice(Number(a), Number(b) + 1), { status: 206 });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const ask = (token: string, extra = "") => frames.fetch(new Request(`https://krida.test/api/frames?mode=subtitles&size=${file.length}${extra}`, {
  headers: { "x-krida-backend": BACKEND, "x-krida-session": token },
}));

test("subtitle mode lists and extracts only a file in the caller's TorBox", async () => {
  const owner = await ask("owner");
  expect(owner.status).toBe(200);
  expect((await owner.json()).tracks.map((t: { track: number }) => t.track)).toEqual([2, 3, 5, 6]);
  expect(owner.headers.get("vary")).toBe("x-krida-backend, x-krida-session");
  const cues = await ask("owner", "&track=2");
  expect((await cues.json()).cues).toEqual([
    { start: 0.125, end: 1.625, text: "Hello <i>world</i>" }, { start: 4.75, end: 6.25, text: "Second\nline" },
  ]);
  const stranger = await ask("stranger");
  expect([stranger.status, await stranger.json(), stranger.headers.get("cache-control")]).toEqual([200, null, "no-store"]);
  expect([...new Set(keys)]).toEqual(["Bearer owner", "Bearer stranger"]);
  expect((await ask("unknown")).status).toBe(401);
  expect((await ask("owner", "&track=-1")).status).toBe(400);
});
