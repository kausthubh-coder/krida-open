import { afterEach, describe, expect, test, vi } from "vitest";
import { parseRating, publicScores } from "../src/ui/scoreValues";
import { mdbBatch } from "../shared/mdblist";

describe("publicScores", () => {
  test("formats each source the way it shows itself, in a fixed order", () => {
    const scores = publicScores({ score: 86, imdb: 8.4, tomatoes: 92, popcorn: 95, metacritic: 79, letterboxd: 4.4, tmdb: 8.2 });
    expect(scores.map((s) => [s.source, s.value])).toEqual([
      ["imdb", "8.4"],
      ["tomatoes", "92%"],
      ["popcorn", "95%"],
      ["metacritic", "79"],
      ["letterboxd", "4.4"],
      ["tmdb", "8.2"],
    ]);
    expect(scores.find((s) => s.source === "letterboxd")?.spoken).toBe("Letterboxd 4.4 out of 5");
  });

  test("Cinemeta's IMDb rating wins so the number never changes once MDBList answers", () => {
    expect(publicScores(undefined, { imdb: 8.5 })).toEqual([expect.objectContaining({ source: "imdb", value: "8.5" })]);
    expect(publicScores({ imdb: 8.4 }, { imdb: 8.5 })[0].value).toBe("8.5");
    expect(publicScores({ imdb: 8.4 })[0].value).toBe("8.4");
  });

  test("anime leads with MyAnimeList, and labels Kitsu's own score as Kitsu", () => {
    const scores = publicScores({ imdb: 8.9, mal: 9.31, tomatoes: 100 }, { kitsu: 8.9, anime: true });
    expect(scores.map((s) => [s.source, s.value])).toEqual([["mal", "9.3"], ["imdb", "8.9"], ["tomatoes", "100%"], ["kitsu", "8.9"]]);
  });

  test("leaves out missing and empty ratings", () => {
    expect(publicScores({ imdb: 0, tomatoes: undefined })).toEqual([]);
    expect(publicScores(null)).toEqual([]);
  });

  test("parseRating reads Cinemeta's text", () => {
    expect(parseRating("8.4")).toBe(8.4);
    expect(parseRating("7,9")).toBe(7.9);
    expect(parseRating("")).toBeUndefined();
    expect(parseRating(undefined)).toBeUndefined();
    expect(parseRating("N/A")).toBeUndefined();
  });
});

describe("mdbBatch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  test("keeps TMDB's score out of 10 whichever scale MDBList sends", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify([
      { ids: { imdb: "tt1", tmdb: 1 }, score: 86, ratings: [{ source: "tmdb", value: 82 }, { source: "letterboxd", value: 8.8 }] },
      { ids: { imdb: "tt2" }, ratings: [{ source: "tmdb", value: 7.6 }, { source: "myanimelist", value: 9.31 }] },
    ])));
    const [a, b] = await mdbBatch("test-key", "movie", ["tt1", "tt2"]);
    expect(a.ratings).toEqual({ score: 86, tmdb: 8.2, letterboxd: 4.4 });
    expect(b.ratings).toEqual({ tmdb: 7.6, mal: 9.31 });
  });
});
