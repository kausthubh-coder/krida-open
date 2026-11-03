import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { clearCache } from "../server/cache";
import { search as answerSearch, searchPage as answerPage, type SearchCursor } from "../server/search";

// The asking account's TMDB key (server/session.ts).
const keys = { tmdb: "fake-key" };
const search = async (q: string) => (await answerSearch(keys, q)).found;
const searchPage = async (q: string, cursor: SearchCursor) => (await answerPage(keys, q, cursor)).found;

type Page = { results: Record<string, unknown>[]; total_pages: number };
const requests: URL[] = [];
/** TMDB external-id lookups and every other outbound request (Cinemeta, Kitsu). */
const lookups: string[] = [];
const others: URL[] = [];
/** TMDB ids that have no IMDb id. */
const noImdb = new Set<string>();
let answer: (url: URL) => Page;
const item = (id: number, kind = "movie") => ({
  id, media_type: kind, title: `Title ${id}`, name: `Title ${id}`, poster_path: "/poster.jpg", vote_count: 100, vote_average: 7,
});
const pageOf = (url: URL) => Number(url.searchParams.get("page"));

beforeEach(() => {
  clearCache();
  requests.length = 0;
  lookups.length = 0;
  others.length = 0;
  noImdb.clear();
  answer = () => ({ results: [], total_pages: 0 });
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/external_ids")) {
      const id = url.pathname.split("/").at(-2)!;
      lookups.push(id);
      return Response.json({ imdb_id: noImdb.has(id) ? null : `tt${id}` });
    }
    if (url.pathname.includes("/discover/") || url.pathname === "/3/search/multi") {
      requests.push(url);
      return Response.json(answer(url));
    }
    others.push(url);
    return Response.json({ metas: [] });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("search pagination", () => {
  test("keeps every opening movie and show, then advances their cursors independently", async () => {
    answer = (url) => {
      if (url.pathname.endsWith("/multi")) return { results: [], total_pages: 0 };
      const tv = url.pathname.endsWith("/tv");
      const page = pageOf(url);
      return { results: Array.from({ length: 20 }, (_, i) => item((tv ? 1000 : 0) + page * 20 + i, tv ? "tv" : "movie")), total_pages: tv ? 2 : 4 };
    };
    const first = await search("telugu 2010s");
    expect(first.genre?.results).toHaveLength(80);
    expect(first.nextCursor).toEqual({ movie: 3, tv: null, multi: null });
    const later = await searchPage("telugu 2010s", first.nextCursor!);
    expect(later.results).toHaveLength(40);
    expect(later.nextCursor).toBeNull();
    expect(new Set([...first.genre!.results, ...later.results].map((r) => r.id)).size).toBe(120);
    const discover = requests.filter((url) => url.pathname.includes("/discover/"));
    expect(discover.filter((url) => url.pathname.endsWith("/tv")).map(pageOf)).toEqual([1, 2]);
    expect(discover.filter((url) => url.pathname.endsWith("/movie")).map(pageOf)).toEqual([1, 2, 3, 4]);
    for (const url of discover) {
      expect(url.searchParams.get("with_original_language")).toBe("te");
      expect(url.searchParams.get(url.pathname.endsWith("/movie") ? "primary_release_date.gte" : "first_air_date.gte")).toBe("2010-01-01");
    }
  });

  test("retains continuation when a batch has no usable posters", async () => {
    answer = (url) => ({ results: [{ ...item(pageOf(url)), poster_path: null }], total_pages: 5 });
    const first = await search("telugu movies");
    expect(first.genre).toBeNull();
    expect(first.nextCursor).toEqual({ movie: 3, tv: null, multi: null });
    const later = await searchPage("telugu movies", first.nextCursor!);
    expect(later.results).toEqual([]);
    expect(later.nextCursor).toEqual({ movie: 5, tv: null, multi: null });
  });

  test("a failed second page keeps the first and the next batch retries the page that failed", async () => {
    let failing = true;
    answer = (url) => {
      if (pageOf(url) === 4 && failing) throw new Error("Controlled outage");
      return { results: [item(pageOf(url))], total_pages: 4 };
    };
    const kept = await searchPage("telugu movies", { movie: 3, tv: null, multi: null });
    expect(kept.results.map((r) => r.id)).toEqual(["tt3"]);
    expect(kept.nextCursor).toEqual({ movie: 4, tv: null, multi: null });
    failing = false;
    const retried = await searchPage("telugu movies", kept.nextCursor!);
    expect(retried.results.map((r) => r.id)).toEqual(["tt4"]);
    expect(retried.nextCursor).toBeNull();
  });

  test("a failing first page rejects the batch so the same cursor can be retried", async () => {
    answer = () => { throw new Error("Controlled outage"); };
    await expect(searchPage("telugu movies", { movie: 3, tv: null, multi: null }))
      .rejects.toThrow("Controlled outage");
  });

  test("title searches continue after the first two pages without the old 36-title truncation", async () => {
    answer = (url) => ({ results: Array.from({ length: 20 }, (_, i) => item(pageOf(url) * 20 + i)), total_pages: 3 });
    const first = await search("star wars");
    expect(first.results).toHaveLength(40);
    expect(first.nextCursor).toEqual({ movie: null, tv: null, multi: 3 });
    const later = await searchPage("star wars", first.nextCursor!);
    expect(later.results).toHaveLength(20);
    expect(later.nextCursor).toBeNull();
    expect(requests.map(pageOf)).toEqual([1, 2, 3]);
  });

  test("stops at TMDB's page limit and rejects invalid pages", async () => {
    answer = () => ({ results: [], total_pages: 700 });
    expect((await searchPage("star wars", { movie: null, tv: null, multi: 499 })).nextCursor).toBeNull();
    expect(requests.map(pageOf)).toEqual([499, 500]);
    for (const multi of [0, 501, 1.5]) {
      await expect(searchPage("star wars", { movie: null, tv: null, multi })).rejects.toThrow("Invalid search page");
    }
  });
});

describe("search lookups", () => {
  test("titles without an IMDb id are remembered for a week instead of asked about each search", async () => {
    noImdb.add("2");
    answer = (url) => ({ results: url.pathname.endsWith("/multi") ? [item(1), item(2), item(3)] : [], total_pages: 1 });
    const first = await search("star wars");
    expect(first.results.map((r) => r.id)).toEqual(["tt1", "tt3"]);
    expect([...lookups].sort()).toEqual(["1", "2", "3"]);
    lookups.length = 0;
    const again = await search("star wars saga");
    expect(again.results.map((r) => r.id)).toEqual(["tt1", "tt3"]);
    expect(lookups).toEqual([]);
    // A week later TMDB is asked again, once, about the title it had no id for.
    vi.useFakeTimers({ now: Date.now() + 8 * 24 * 60 * 60 * 1000, toFake: ["Date"] });
    await search("star wars");
    expect(lookups).toEqual(["2"]);
    lookups.length = 0;
    await search("star wars");
    expect(lookups).toEqual([]);
  });

  test("a failed lookup is not remembered as a title without an IMDb id", async () => {
    answer = (url) => ({ results: url.pathname.endsWith("/multi") ? [item(5)] : [], total_pages: 1 });
    const working = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      if (new URL(input).pathname.endsWith("/external_ids")) throw new Error("Controlled outage");
      return working(input);
    }));
    expect((await search("star wars")).results).toEqual([]);
    vi.stubGlobal("fetch", working);
    expect((await search("star wars")).results.map((r) => r.id)).toEqual(["tt5"]);
  });

  test("tag searches skip title lookups they can't use and keep what one discover call found", async () => {
    let showsDown = true;
    answer = (url) => {
      if (url.pathname.endsWith("/tv") && showsDown) throw new Error("Controlled outage");
      const page = pageOf(url);
      return { results: Array.from({ length: 20 }, (_, i) => item(page * 20 + i)), total_pages: 3 };
    };
    const opened = await answerSearch(keys, "telugu comedy");
    const first = opened.found;
    expect(first.genre?.results).toHaveLength(40);
    expect(first.nextCursor).toEqual({ movie: 3, tv: 1, multi: null });
    // Shows were missing: kept only briefly, so the next search has them again.
    expect(opened.partial).toBe(true);
    expect(requests.some((url) => url.pathname.endsWith("/multi"))).toBe(false);
    expect(others).toEqual([]);
    // The shows that failed come with the next batch, from their first page.
    showsDown = false;
    requests.length = 0;
    const later = await searchPage("telugu comedy", first.nextCursor!);
    expect(requests.filter((url) => url.pathname.endsWith("/tv")).map(pageOf)).toEqual([1, 2]);
    expect(later.nextCursor).toEqual({ movie: null, tv: 3, multi: null });
    // When every discover call fails, the search says so rather than showing nothing.
    answer = () => { throw new Error("Controlled outage"); };
    await expect(search("telugu drama")).rejects.toThrow("Controlled outage");
  });

  test("a search where every source answered is complete; TMDB not answering fails it", async () => {
    answer = (url) => ({ results: url.pathname.endsWith("/multi") ? [item(1)] : [], total_pages: 1 });
    expect((await answerSearch(keys, "star wars")).partial).toBe(false);
    answer = () => { throw new Error("Controlled outage"); };
    await expect(answerSearch(keys, "star trek")).rejects.toThrow("Controlled outage");
  });

  test("a one-genre tag search still finds a title of that name, from one TMDB page", async () => {
    answer = (url) =>
      url.pathname.endsWith("/multi")
        ? { results: [{ ...item(7), title: "Scary Movie" }, item(8)], total_pages: 5 }
        : { results: [], total_pages: 0 };
    const found = await search("scary movie");
    expect(found.results.map((r) => r.name)).toEqual(["Scary Movie"]);
    expect(requests.filter((url) => url.pathname.endsWith("/multi"))).toHaveLength(1);
    expect(others).toEqual([]);
  });
});

describe("tag searches when TMDB fails part of the way", () => {
  const discoverPage = (url: URL): Page => {
    const tv = url.pathname.endsWith("/tv");
    const page = pageOf(url);
    return { results: Array.from({ length: 5 }, (_, i) => item((tv ? 1000 : 0) + page * 10 + i, tv ? "tv" : "movie")), total_pages: 4 };
  };

  test("keeps page 1 when page 2 fails and points the cursor at page 2", async () => {
    answer = (url) => {
      if (url.pathname.endsWith("/discover/movie") && pageOf(url) === 2) throw new Error("Controlled outage");
      return url.pathname.endsWith("/multi") ? { results: [], total_pages: 0 } : discoverPage(url);
    };
    const first = await search("telugu comedy");
    const ids = first.genre!.results.map((r) => r.id);
    expect(ids.filter((id) => Number(id.slice(2)) < 1000)).toEqual(["tt10", "tt11", "tt12", "tt13", "tt14"]);
    expect(ids.filter((id) => Number(id.slice(2)) >= 1000)).toHaveLength(10);
    expect(first.nextCursor).toEqual({ movie: 2, tv: 3, multi: null });
    answer = discoverPage;
    const later = await searchPage("telugu comedy", first.nextCursor!);
    expect(later.results.map((r) => r.id)).toContain("tt20");
  });

  test("shows the kind that answered when the other fails, and retries it from page 1", async () => {
    answer = (url) => {
      if (url.pathname.endsWith("/discover/tv")) throw new Error("Controlled outage");
      return url.pathname.endsWith("/multi") ? { results: [], total_pages: 0 } : discoverPage(url);
    };
    const first = await search("telugu comedy");
    expect(first.genre!.results).toHaveLength(10);
    expect(first.genre!.results.every((r) => r.type === "movie")).toBe(true);
    expect(first.nextCursor).toEqual({ movie: 3, tv: 1, multi: null });
  });

  test("fails when every kind fails, so the page can say so and retry", async () => {
    answer = (url) => {
      if (url.pathname.includes("/discover/")) throw new Error("Controlled outage");
      return { results: [], total_pages: 0 };
    };
    await expect(search("telugu comedy")).rejects.toThrow("Controlled outage");
  });
});
