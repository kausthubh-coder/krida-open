import { describe, expect, test } from "vitest";
import { alsoMatching, normalizeTitle, pickTopResult } from "../src/features/search/components/topResult";
import { EMPTY_BATCHES, keepLoading } from "../src/features/search/components/paging";

type Item = { name: string; year?: string; type: "movie" | "series" };
const r = (name: string, year?: string, type: Item["type"] = "movie"): Item => ({ name, year, type });

const dune = [r("Dune: Part Two", "2024"), r("Dune", "2021"), r("Dune: Prophecy", "2024", "series"), r("Dune", "1984"), r("Jodorowsky's Dune", "2013")];

describe("pickTopResult", () => {
  test("an exact name leads, in the server's order among exact matches", () => {
    expect(pickTopResult("dune", dune)).toBe(dune[1]);
    expect(pickTopResult("  DUNE!  ", dune)).toBe(dune[1]);
  });

  test("a year picks that title, including a near-exact name and a typo", () => {
    expect(pickTopResult("dune 1984", dune)).toBe(dune[3]);
    expect(pickTopResult("dune 2024", dune)).toBe(dune[0]);
    expect(pickTopResult("Dune (2021)", dune)).toBe(dune[1]);
    const space = [r("Gravity", "2013"), r("Interstellar", "2014")];
    expect(pickTopResult("intersteller 2014", space)).toBe(space[1]);
    expect(pickTopResult("intersteller 2015", space)).toBeNull();
  });

  test("articles, punctuation, diacritics and spacing don't matter", () => {
    const office = [r("The Office", "2005", "series")];
    expect(pickTopResult("office", office)).toBe(office[0]);
    expect(pickTopResult("the office", office)).toBe(office[0]);
    expect(pickTopResult("amelie", [r("Amélie", "2001")])?.name).toBe("Amélie");
    expect(pickTopResult("spiderman", [r("Spider-Man", "2002")])?.name).toBe("Spider-Man");
    expect(normalizeTitle("తెలుగు")).toBe("తెలుగు");
  });

  test("titles that are numbers stay titles", () => {
    expect(pickTopResult("1917", [r("1917", "2019")])?.name).toBe("1917");
    expect(pickTopResult("blade runner 2049", [r("Blade Runner", "1982"), r("Blade Runner 2049", "2017")])?.year).toBe("2017");
  });

  test("broad searches have no top result", () => {
    const spider = [r("Spider-Man", "2002"), r("Spider-Man 2", "2004"), r("The Amazing Spider-Man", "2012"), r("Spider-Man: No Way Home", "2021"), r("Spider", "2002")];
    expect(pickTopResult("spider", spider)).toBeNull();
    expect(pickTopResult("isekai", [r("Isekai Quartet", "2019", "series")])).toBeNull();
    expect(pickTopResult("star", [r("Star Wars", "1977"), r("A Star Is Born", "2018")])).toBeNull();
    expect(pickTopResult("d", dune)).toBeNull();
    expect(pickTopResult("dune", [])).toBeNull();
  });

  test("tag searches and person searches have no top result", () => {
    expect(pickTopResult("love", [r("Love", "2015")])).toBeNull();
    expect(pickTopResult("telugu comedy", [r("Telugu Comedy", "2020")])).toBeNull();
    expect(pickTopResult("nolan", [r("Nolan", "2020")], { name: "Christopher Nolan" })).toBeNull();
    expect(pickTopResult("dune", dune, { name: "Denis Villeneuve" })).toBe(dune[1]);
  });
});

describe("alsoMatching", () => {
  test("lists other titles with the name, without the top one, up to four", () => {
    const also = alsoMatching("dune", dune, dune[1]);
    expect(also.map((x) => x.name)).toEqual(["Dune: Part Two", "Dune: Prophecy", "Dune", "Jodorowsky's Dune"]);
    expect(also).not.toContain(dune[1]);
    expect(alsoMatching("dune 1984", [...dune, r("Interstellar")], dune[3]).map((x) => x.year)).toEqual(["2024", "2021", "2024", "2013"]);
    expect(alsoMatching("dune", [dune[1], r("Interstellar")], dune[1])).toEqual([]);
  });
});

describe("keepLoading", () => {
  const all = () => true;
  const movies = (x: Item) => x.type === "movie";
  const batch = (n: number, type: Item["type"] = "movie") => Array.from({ length: n }, (_, i) => r(`T${i}`, undefined, type));

  test("the opening results and batches that add titles keep loading", () => {
    expect(keepLoading([], all)).toBe(true);
    expect(keepLoading([batch(20), batch(12)], all)).toBe(true);
    expect(keepLoading([batch(0), batch(20)], all)).toBe(true);
    expect(keepLoading([batch(20), batch(0)], all)).toBe(true);
  });

  test("stops after empty or near-empty batches in a row", () => {
    expect(keepLoading([batch(20), batch(0), batch(0)], all)).toBe(false);
    expect(keepLoading([batch(2), batch(3)], all)).toBe(false);
  });

  test("counts only what the filter shows, and resumes when the filter changes", () => {
    const shows = [batch(20), batch(20, "series"), batch(20, "series")];
    expect(keepLoading(shows, movies)).toBe(false);
    expect(keepLoading(shows, all)).toBe(true);
  });

  test("regression: a search whose later pages add nothing stops after a couple of batches, not at TMDB's 500 pages", () => {
    // The end of the list stays in view because nothing is added, so this is what the page would do.
    const batches: Item[][] = [];
    let requests = 0;
    while (requests < 250 && keepLoading(batches, movies)) {
      requests++;
      batches.push(batch(18, "series").concat(batch(1)));
    }
    expect(requests).toBe(EMPTY_BATCHES);
  });
});
