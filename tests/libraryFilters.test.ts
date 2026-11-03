import { describe, expect, test } from "vitest";
import { activeFilters, filtersLabel, genreIndex, matchesFilters, NO_FILTERS } from "../src/features/library/filters";

const dune = { id: "tt15239678", type: "movie" as const, year: "2024", rating: 9 };
const aot = { id: "kitsu:7442", type: "series" as const, year: "2013" };

describe("Library filters", () => {
  test("genres share one set of names across sources", () => {
    const index = genreIndex([{ id: dune.id, genres: ["Science Fiction", "Action & Adventure"] }, { id: aot.id, genres: ["Action", "Sports"] }]);
    expect(index.get(dune.id)).toEqual(["Sci-Fi", "Action", "Adventure"]);
    expect(index.get(aot.id)).toEqual(["Action", "Sport"]);
  });

  test("type, genre, decade and score combine; a title without genres yet doesn't match a genre", () => {
    const index = genreIndex([{ id: dune.id, genres: ["Sci-Fi"] }]);
    const sciFi = { ...NO_FILTERS, genres: ["Sci-Fi"] };
    expect(matchesFilters(sciFi, index)(dune)).toBe(true);
    expect(matchesFilters(sciFi, index)(aot)).toBe(false);
    expect(matchesFilters({ ...NO_FILTERS, format: "anime", era: "2010" })(aot)).toBe(true);
    expect(matchesFilters({ ...NO_FILTERS, format: "series" })(aot)).toBe(false);
    expect(matchesFilters({ ...NO_FILTERS, score: "high" })(dune)).toBe(true);
    expect(filtersLabel({ format: "movie", genres: ["Sci-Fi"], era: "2020", score: "high" })).toBe("Movies · Sci-Fi · 2020s · Scored 8 and up");
  });

  test("several genres keep titles that have all of them, like Search", () => {
    const index = genreIndex([{ id: dune.id, genres: ["Science Fiction", "Action & Adventure"] }, { id: aot.id, genres: ["Action", "Drama"] }]);
    const both = { ...NO_FILTERS, genres: ["Sci-Fi", "Action"] };
    expect(matchesFilters(both, index)(dune)).toBe(true);
    expect(matchesFilters(both, index)(aot)).toBe(false);
    expect(activeFilters(both)).toBe(1);
    expect(filtersLabel(both)).toBe("Sci-Fi + Action");
  });
});
