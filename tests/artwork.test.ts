import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { clearCache } from "../server/cache";
import { animeBackdrop, artworkFor } from "../server/titles";

// The asking account's TMDB key (server/session.ts).
const keys = { tmdb: "fake-key" };

const ANIMATION = 16;
const show = (id: number, first_air_date: string, genre_ids = [ANIMATION]) => ({
  id, name: `Show ${id}`, first_air_date, genre_ids, poster_path: `/p${id}.jpg`, backdrop_path: `/b${id}.jpg`,
});
let results: ReturnType<typeof show>[] = [];
const searches: URL[] = [];

const kitsu = (year = "2026-") => artworkFor(keys, "kitsu:50764", "Kyouran Reijou Nia Liston", year, "series");

beforeEach(() => {
  clearCache();
  results = [];
  searches.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
    const url = new URL(input);
    searches.push(url);
    return Response.json({ results });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("artwork for anime known only to Kitsu", () => {
  test("is TMDB's when exactly one animated show from that year matches the name", async () => {
    results = [show(1, "2026-10-06"), show(2, "2019-04-01"), show(3, "2026-01-01", [18])];
    const art = await kitsu();
    expect(art.background).toBe("https://image.tmdb.org/t/p/w1280/b1.jpg");
    expect(searches[0].pathname).toBe("/3/search/tv");
    expect(searches[0].searchParams.get("query")).toBe("Kyouran Reijou Nia Liston");
  });

  test("is none when it's ambiguous, from another year, or the year is unknown", async () => {
    results = [show(1, "2026-10-06"), show(2, "2026-04-01")];
    expect(await kitsu()).toEqual({ poster: null, background: null });
    results = [show(1, "2024-10-06")];
    clearCache();
    expect(await kitsu()).toEqual({ poster: null, background: null });
    results = [show(1, "2026-10-06")];
    searches.length = 0;
    expect(await kitsu("")).toEqual({ poster: null, background: null });
    expect(searches).toEqual([]);
  });

  test("is remembered, so the same card doesn't ask TMDB again", async () => {
    results = [show(1, "2026-10-06")];
    await kitsu();
    searches.length = 0;
    expect((await kitsu()).background).toBe("https://image.tmdb.org/t/p/w1280/b1.jpg");
    expect(searches).toEqual([]);
  });
});

describe("backdrop for anime matched to TMDB by id", () => {
  let body: object = {};
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      searches.push(new URL(input));
      return Response.json(body);
    }));
  });
  const backdrop = (tmdbId: string) => animeBackdrop(keys, tmdbId, "series");

  test("is the best-voted wide one without text, else TMDB's default", async () => {
    body = {
      backdrop_path: "/default.jpg",
      images: { backdrops: [
        { file_path: "/ok.jpg", aspect_ratio: 1.78, vote_average: 5.2 },
        { file_path: "/best.jpg", aspect_ratio: 1.78, vote_average: 5.6 },
        { file_path: "/tall.jpg", aspect_ratio: 0.67, vote_average: 9 },
      ] },
    };
    expect(await backdrop("335790")).toBe("https://image.tmdb.org/t/p/w1280/best.jpg");
    expect(searches[0].pathname).toBe("/3/tv/335790");
    expect(searches[0].searchParams.get("include_image_language")).toBe("null");
    body = { backdrop_path: "/default.jpg", images: { backdrops: [] } };
    clearCache();
    expect(await backdrop("335790")).toBe("https://image.tmdb.org/t/p/w1280/default.jpg");
  });

  test("asks nothing for an id that isn't TMDB's", async () => {
    const answer = await (await import("../api/anime-backdrop")).default.fetch(new Request("http://x/api/anime-backdrop?tmdbId=../movie/1&type=series"));
    expect(answer.status).toBe(400);
    expect(searches).toEqual([]);
  });
});
