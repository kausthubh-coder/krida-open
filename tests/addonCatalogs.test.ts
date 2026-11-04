import { afterEach, describe, expect, test, vi } from "vitest";
import { proxiedUrl, proxyAddon } from "../server/addonProxy";
import { released, toRowItem } from "../src/data/addons";
import { stremioAddonUrls, stremioProblem } from "../src/features/settings/stremioImport";

afterEach(() => vi.unstubAllGlobals());

describe("the addon proxy", () => {
  test("passes manifests, catalogs, metadata and subtitles of public https addons", () => {
    for (const url of [
      "https://v3-cinemeta.strem.io/manifest.json",
      "https://v3-cinemeta.strem.io/catalog/movie/top.json",
      "https://v3-cinemeta.strem.io/catalog/movie/top/genre=Drama&skip=100.json",
      "https://anime-kitsu.strem.fun/meta/series/kitsu%3A1.json",
      "https://opensubtitles-v3.strem.io/subtitles/movie/tt1/videoHash=a&videoSize=1.json",
    ])
      expect(proxiedUrl(url).toString()).toBe(url);
  });

  test("refuses streams, private networks, plain http and other paths", () => {
    for (const url of [
      "https://torrentio.strem.fun/torbox=k/stream/movie/tt1.json",
      "https://192.168.1.2/manifest.json",
      "https://10.0.0.1/manifest.json",
      "http://addon.example/manifest.json",
      "https://addon.example/admin",
      "https://user:pass@addon.example/manifest.json",
      "not a link",
    ])
      expect(() => proxiedUrl(url)).toThrow(/Only public https addons|Not an addon resource|Not a link/);
  });

  test("follows a redirect to another public addon, and refuses one into a private network", async () => {
    const asked: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: URL) => {
      asked.push(String(url));
      if (url.host === "old.example") return new Response(null, { status: 301, headers: { location: "https://new.example/manifest.json" } });
      if (url.host === "evil.example") return new Response(null, { status: 302, headers: { location: "https://169.254.169.254/latest/meta-data" } });
      return Response.json({ id: "moved" });
    }));
    expect(await proxyAddon("https://old.example/manifest.json")).toEqual({ id: "moved" });
    await expect(proxyAddon("https://evil.example/manifest.json")).rejects.toThrow("evil.example redirected somewhere Krida won't follow");
    expect(asked).toEqual(["https://old.example/manifest.json", "https://new.example/manifest.json", "https://evil.example/manifest.json"]);
  });
});

describe("a catalog's titles", () => {
  test("become Home cards: anime as shows, IMDb's rating, the year", () => {
    expect(toRowItem({ id: "kitsu:1", type: "anime", name: "Cowboy Bebop", poster: "https://p/1.jpg", releaseInfo: "1998-1999", imdbRating: "8.9", genres: ["Action", "Sci-Fi", "Drama", "Space"] }, "anime")).toEqual({
      id: "kitsu:1", type: "series", name: "Cowboy Bebop", poster: "https://p/1.jpg", background: undefined, logo: undefined, year: "1998",
      description: undefined, rating: 8.9, genres: ["Action", "Sci-Fi", "Drama"],
    });
  });

  test("ids Krida can't open and kinds it doesn't play are left out", () => {
    expect(toRowItem({ id: "tmdb:603", type: "movie", name: "The Matrix" }, "movie")).toBe(null);
    expect(toRowItem({ id: "tt0111161", type: "channel", name: "A channel" }, "channel")).toBe(null);
    expect(toRowItem({ id: "tt0111161", name: "The Shawshank Redemption", poster: "javascript:alert(1)" }, "movie")?.poster).toBe(undefined);
  });

  test("a title from next year isn't out yet", () => {
    const now = new Date("2026-11-03");
    expect([released({ year: "2027" }, now), released({ year: "2026" }, now), released({}, now)]).toEqual([false, true, true]);
  });
});

describe("Stremio's sign-in errors", () => {
  test("say what's wrong in Krida's words", () => {
    expect(stremioProblem({ message: "User not found", wrongEmail: true })).toBe("Stremio has no account with that email.");
    expect(stremioProblem({ message: "Wrong passphrase", wrongPass: true })).toBe("That password isn’t right for this Stremio account.");
    expect(stremioProblem({ message: "Too many requests" })).toBe("Stremio said: Too many requests");
    expect(stremioProblem(undefined)).toBe("Stremio didn’t answer as expected. Try again.");
  });
});

describe("importing from a Stremio account", () => {
  /** api.strem.io as stubbed here: the shape of a real answer is `{ result }` or `{ error }` (checked 3 Nov 2026 for errors). */
  const stremio = (answers: Record<string, unknown>) => {
    const calls: { method: string; body: any }[] = [];
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      const method = String(input).replace("https://api.strem.io/api/", "");
      calls.push({ method, body: JSON.parse(String(init?.body)) });
      return Response.json(answers[method] ?? { result: { success: true } });
    });
    return calls;
  };

  test("signs in, reads the collection's links and signs out again", async () => {
    const calls = stremio({
      login: { result: { authKey: "auth-1", user: { email: "me@example.com" } } },
      addonCollectionGet: {
        result: {
          addons: [
            { transportUrl: "https://v3-cinemeta.strem.io/manifest.json", manifest: { id: "com.linvo.cinemeta" } },
            { transportUrl: "https://torrentio.strem.fun/torbox=k/manifest.json", manifest: { id: "com.stremio.torrentio.addon" } },
          ],
          lastModified: "2026-11-01T00:00:00.000Z",
        },
      },
    });
    expect(await stremioAddonUrls(" me@example.com ", "pw")).toEqual(["https://v3-cinemeta.strem.io", "https://torrentio.strem.fun/torbox=k"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual([
      { method: "login", body: { type: "Login", email: "me@example.com", password: "pw", facebook: false } },
      { method: "addonCollectionGet", body: { type: "AddonCollectionGet", authKey: "auth-1", update: true } },
      { method: "logout", body: { type: "Logout", authKey: "auth-1" } },
    ]);
  });

  test("a wrong password stops at sign-in and says so", async () => {
    const calls = stremio({ login: { error: { code: 3, message: "Wrong passphrase", wrongPass: true } } });
    await expect(stremioAddonUrls("me@example.com", "nope")).rejects.toThrow("That password isn’t right for this Stremio account.");
    expect(calls.map((c) => c.method)).toEqual(["login"]);
  });
});
