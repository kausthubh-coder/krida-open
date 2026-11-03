import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import frames from "../api/frames";
import search from "../api/search";
import title from "../api/title";
import { clearCache } from "../server/cache";

/*
 * /api asks TMDB, MDBList and TorBox with the keys of the account whose session sent the request: server/session.ts
 * reads them from the Convex deployment the browser names (accounts.keys), here a stand-in that knows four sessions.
 */

const BACKEND = "http://127.0.0.1:3999";
const ACCOUNTS: Record<string, { tmdb?: string; mdblist?: string; debrid?: { service: string; key: string } } | null> = {
  "with-keys": { tmdb: "acct-tmdb", mdblist: "acct-mdb", debrid: { service: "torbox", key: "acct-torbox" } },
  "no-keys": {},
  "other-debrid": { tmdb: "acct-tmdb", debrid: { service: "realdebrid", key: "rd" } },
};
const asked: URL[] = [];

beforeEach(() => {
  clearCache();
  asked.length = 0;
  vi.stubEnv("VERCEL_ENV", "");
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin === BACKEND && url.pathname === "/api/query") {
      const { path, args } = JSON.parse(String(init?.body)) as { path: string; args: [{ token: string }] };
      const token = args[0].token;
      const known = token in ACCOUNTS;
      if (path === "profiles:me") return Response.json({ status: "success", value: known ? { _id: "p1", name: "QA" } : null });
      if (path === "accounts:keys") return Response.json({ status: "success", value: known ? ACCOUNTS[token] : null });
      throw new Error(`Unexpected query ${path}`);
    }
    asked.push(url);
    if (url.hostname === "api.themoviedb.org") return Response.json({ results: [], total_pages: 0 });
    if (url.hostname === "api.mdblist.com") return Response.json([{ ids: { imdb: "tt0111161" }, score: 90, ratings: [{ source: "imdb", value: 9.3 }] }]);
    if (url.hostname === "api.torbox.app") return Response.json({ success: true, data: [] });
    return Response.json({ metas: [] });
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const ask = (endpoint: { fetch(request: Request): Promise<Response> }, path: string, token?: string) =>
  endpoint.fetch(new Request(`https://krida.test${path}`, { headers: token ? { "x-krida-backend": BACKEND, "x-krida-session": token } : {} }));

describe("an /api request", () => {
  test("asks TMDB with the caller's account's key", async () => {
    const res = await ask(search, "/api/search?q=shawshank", "with-keys");
    expect(res.status).toBe(200);
    const tmdb = asked.filter((u) => u.hostname === "api.themoviedb.org");
    expect(tmdb.length).toBeGreaterThan(0);
    expect([...new Set(tmdb.map((u) => u.searchParams.get("api_key")))]).toEqual(["acct-tmdb"]);
  });

  test("without a TMDB key in the account, says to add one, isn't cached, and asks TMDB nothing", async () => {
    const res = await ask(search, "/api/search?q=shawshank", "no-keys");
    expect(res.status).toBe(403);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "Add your TMDB key in Settings → Connections to see titles.", needs: "tmdb" });
    expect(asked).toEqual([]);
  });

  test("without a session, or with an unknown one, is refused", async () => {
    expect((await ask(search, "/api/search?q=shawshank")).status).toBe(401);
    expect((await ask(search, "/api/search?q=shawshank", "stranger")).status).toBe(401);
    expect(asked).toEqual([]);
  });

  test("asks MDBList with the account's MDBList key, and without one says to add it", async () => {
    const res = await ask(title, "/api/title?id=tt0111161&type=movie", "with-keys");
    expect(res.status).toBe(200);
    expect(asked.map((u) => u.searchParams.get("apikey"))).toEqual(["acct-mdb"]);
    clearCache();
    asked.length = 0;
    const missing = await ask(title, "/api/title?id=tt0111161&type=movie", "other-debrid");
    expect([missing.status, (await missing.json()).needs]).toEqual([403, "mdblist"]);
    expect(asked).toEqual([]);
  });

  test("reads a film's file from the account's own TorBox, and needs TorBox for it", async () => {
    const res = await ask(frames, "/api/frames?size=123456", "with-keys");
    expect(res.status).toBe(200);
    expect(asked.map((u) => `${u.pathname} ${u.searchParams.get("bypass_cache")}`)).toEqual([
      "/v1/api/torrents/mylist false",
      "/v1/api/torrents/mylist true",
    ]);
    const other = await ask(frames, "/api/frames?size=123456", "other-debrid");
    expect([other.status, (await other.json()).needs]).toEqual([403, "torbox"]);
  });
});
