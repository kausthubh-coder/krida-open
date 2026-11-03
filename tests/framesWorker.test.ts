import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { signTicket } from "../server/frameTicket";
import { readIndex } from "../server/mkv";
import worker from "../workers/frames/index";
import { file, keyA } from "./mkvFile";

const API = "https://torbox.test/v1/api";
const bytes = file();
const size = bytes.length;
const env = { FRAMES_SECRET: "secret" };
let torbox: ReturnType<typeof vi.fn>;

// TorBox with one file, the test MKV, served by Range like TorBox's own links.
beforeEach(() => {
  vi.stubEnv("TORBOX_API_URL", API);
  torbox = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(`${API}/torrents/mylist`)) return Response.json({ success: true, data: [{ id: 1, files: [{ id: 1, size }] }] });
    if (url.startsWith(`${API}/torrents/requestdl`)) return Response.json({ success: true, data: "https://cdn.test/file" });
    const [, from, to] = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init?.headers).get("range") ?? "")!;
    return new Response(bytes.slice(Number(from), Number(to) + 1), { status: 206 });
  });
  vi.stubGlobal("fetch", torbox);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const place = async () => (await readIndex(async (from, to) => bytes.slice(from, to)))!.points[0];
const ask = (params: Record<string, string | number>, method = "GET", path = "/frame") =>
  worker.fetch(new Request(`https://frames.test${path}?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))}`, { method }), env);

describe("the frames Worker", () => {
  test("with a ticket for the file, answers its keyframe to any page", async () => {
    const [, cluster, relative] = await place();
    const res = await ask({ size, cluster, relative, track: 1, ...(await signTicket("secret", size, "key")) });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual(keyA);
  });

  test("reads the file with the TorBox key sealed in the ticket, and has none of its own", async () => {
    const [, cluster, relative] = await place();
    const res = await ask({ size, cluster, relative, track: 1, ...(await signTicket("secret", size, "account-key")) });
    expect(res.status).toBe(200);
    const asked = torbox.mock.calls.filter(([url]) => String(url).startsWith(API));
    expect(asked.map(([url, init]) => [String(url).replace(/\?.*/, ""), new Headers((init as RequestInit | undefined)?.headers).get("authorization")])).toEqual([
      [`${API}/torrents/mylist`, "Bearer account-key"],
      [`${API}/torrents/requestdl`, "Bearer account-key"],
    ]);
    expect(String(asked[1][0])).toContain("token=account-key");
  });

  test("refuses a ticket for another file, or none, without asking TorBox", async () => {
    const [, cluster, relative] = await place();
    expect((await ask({ size, cluster, relative, track: 1, ...(await signTicket("secret", size + 1, "key")) })).status).toBe(401);
    expect((await ask({ size, cluster, relative, track: 1 })).status).toBe(401);
    expect(torbox).toHaveBeenCalledTimes(0);
  });

  test("TorBox asking to slow down reaches the page as a 429 it can read the wait from", async () => {
    const [, cluster, relative] = await place();
    torbox.mockImplementation(async (input: string | URL) => {
      const url = String(input);
      if (url.startsWith(`${API}/torrents/mylist`)) return Response.json({ success: true, data: [{ id: 1, files: [{ id: 1, size }] }] });
      if (url.startsWith(`${API}/torrents/requestdl`)) return Response.json({ success: true, data: "https://cdn.test/file" });
      return new Response("slow down", { status: 429, headers: { "Retry-After": "30" } });
    });
    const res = await ask({ size, cluster, relative, track: 1, ...(await signTicket("secret", size, "key")) });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30");
    expect(res.headers.get("access-control-expose-headers")).toBe("Retry-After, X-Frames-Error");
  });

  test("a stretch of the file TorBox is too slow to serve is a 504, not a failing Worker", async () => {
    const [, cluster, relative] = await place();
    torbox.mockImplementation(async (input: string | URL) => {
      const url = String(input);
      if (url.startsWith(`${API}/torrents/mylist`)) return Response.json({ success: true, data: [{ id: 1, files: [{ id: 1, size }] }] });
      if (url.startsWith(`${API}/torrents/requestdl`)) return Response.json({ success: true, data: "https://cdn.test/file" });
      throw new DOMException("The operation timed out.", "TimeoutError");
    });
    const res = await ask({ size, cluster, relative, track: 1, ...(await signTicket("secret", size, "key")) });
    expect(res.status).toBe(504);
    expect(await res.json()).toEqual({ error: "TorBox took too long. Try again in a moment." });
  });

  test("TorBox refusing the file is marked as about the file; the Worker's own failure isn't", async () => {
    const [, cluster, relative] = await place();
    const ticket = await signTicket("secret", size, "key");
    torbox.mockImplementation(async (input: string | URL) => {
      const url = String(input);
      if (url.startsWith(`${API}/torrents/mylist`)) return Response.json({ success: true, data: [{ id: 1, files: [{ id: 1, size }] }] });
      if (url.startsWith(`${API}/torrents/requestdl`)) return Response.json({ success: true, data: "https://cdn.test/file" });
      return new Response("no", { status: 400 });
    });
    const refused = await ask({ size, cluster, relative, track: 1, ...ticket });
    expect([refused.status, refused.headers.get("x-frames-error")]).toEqual([502, "file"]);
    // TorBox's CDN not answering at all is TorBox's too.
    torbox.mockImplementation(async () => {
      throw new TypeError("fetch failed");
    });
    const unreachable = await ask({ size, cluster, relative, track: 1, ...ticket });
    expect([unreachable.status, unreachable.headers.get("x-frames-error")]).toEqual([502, "file"]);
    // A Worker deployed without FRAMES_SECRET.
    const broken = await worker.fetch(new Request(`https://frames.test/frame?${new URLSearchParams({ size: String(size), cluster: String(cluster), relative: String(relative), track: "1", expires: String(ticket.expires), ticket: ticket.ticket })}`), {} as typeof env);
    expect([broken.status, broken.headers.get("x-frames-error")]).toEqual([500, null]);
  });

  test("a malformed place is a bad request, and only GET /frame is answered", async () => {
    const ticket = await signTicket("secret", size, "key");
    expect((await ask({ size, cluster: -5, relative: -1, track: 1, ...ticket })).status).toBe(400);
    expect((await ask({ size, cluster: 0, relative: -1, track: 1, ...ticket }, "POST")).status).toBe(405);
    expect((await ask({ size, cluster: 0, relative: -1, track: 1, ...ticket }, "GET", "/other")).status).toBe(404);
  });
});
