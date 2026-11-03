import { describe, expect, test } from "vitest";
import { buildStats, events, franchiseOf, localParts, watchedEnough, type Facts, type StatTitle } from "../convex/lib/stats";
import { assemble } from "../convex/wrapped";
import { expandWatchedAt } from "../convex/lib/simkl";

const now = Date.parse("2026-10-07T20:00:00Z");
const DAY = 86_400_000;
const at = (iso: string) => Date.parse(iso);
const title = (extra: Partial<StatTitle> & { id: string }): StatTitle => ({
  type: "series", name: extra.id, anime: false, status: "completed", events: [], ...extra,
});
// Episodes a real evening apart: one every 25 minutes from `start`.
const evening = (id: string, start: string, n: number, from = 1) =>
  Array.from({ length: n }, (_, i) => ({ t: at(start) + i * 25 * 60_000, key: `${id}:1:${from + i}` }));
const stats = (titles: StatTitle[], facts = new Map<string, Facts>(), timeZone?: string) => buildStats({ now, titles, facts, timeZone });

describe("what counts as watched", () => {
  test.each([
    [{ type: "movie", status: "completed" }, true],
    [{ type: "movie", status: "watching" }, false],
    [{ type: "series", status: "watching", watchedEpisodes: 1, totalEpisodes: 195 }, false],
    [{ type: "series", status: "watching", watchedEpisodes: 3, totalEpisodes: 195 }, true],
    [{ type: "series", status: "dropped", watchedEpisodes: 2, totalEpisodes: 4 }, true],
    [{ type: "series", status: "dropped", watchedEpisodes: 2, totalEpisodes: 12 }, false],
    [{ type: "series", status: "completed", watchedEpisodes: 1, totalEpisodes: 1 }, true],
    [{ type: "series", status: "plantowatch" }, false],
  ] as const)("%o → %s", (t, expected) => expect(watchedEnough(t)).toBe(expected));
});

describe("franchises", () => {
  test.each(["Attack on Titan", "Attack on Titan Season 2", "Attack on Titan Season 3 (part 1)", "Attack on Titan Final Season",
    "Attack on Titan The Final Season", "Attack on Titan: The Final Season Part 2"])("%s", (name) => expect(franchiseOf(name)).toBe("attack on titan"));
  test("different shows stay apart", () => expect(franchiseOf("Naruto Shippuden")).not.toBe(franchiseOf("Naruto")));
});

describe("bulk marking", () => {
  test("episodes marked a second apart count toward totals, not toward when you watched", () => {
    const marked = title({ id: "kitsu:1", anime: true, runtime: 25, events: Array.from({ length: 8 }, (_, i) => ({ t: at("2026-05-10T18:27:12Z") + i * 1000, key: `kitsu:1:1:${i + 1}` })) });
    const s = stats([marked]);
    const all = s.periods[0];
    expect(all.minutes).toBe(200);
    expect(all.bulkMinutes).toBe(200);
    expect(all.months.every((m) => m.anime === 0)).toBe(true);
    expect(s.periods.find((p) => p.key === "2026")!.minutes).toBe(0);
    expect(all.sessions).toBe(0);
  });

  test("a real evening of episodes lands in its month and on the clock", () => {
    const show = title({ id: "tt1", runtime: 25, events: evening("tt1", "2026-04-24T03:00:00Z", 4) });
    const all = stats([show]).periods[0];
    expect(all.bulkMinutes).toBe(0);
    expect(all.months.find((m) => m.month === "2026-04")!.show).toBe(100);
    expect(all.sessions).toBe(1);
    // The first episode ended at 03:00 UTC, so the session started 25 minutes earlier.
    expect(all.clock[2]).toBe(1);
  });

  test("movies logged within minutes of each other are a bulk import; a lone movie is real", () => {
    const logged = ["tt10", "tt11", "tt12"].map((id, i) => title({ id, type: "movie", runtime: 120, events: [{ t: at("2025-05-11T10:00:00Z") + i * 30_000, key: id }] }));
    const real = title({ id: "tt13", type: "movie", runtime: 100, events: [{ t: at("2025-07-02T02:00:00Z"), key: "tt13" }] });
    const evs = events([...logged, real], new Map());
    expect(evs.filter((e) => e.bulk).map((e) => e.title.id)).toEqual(["tt10", "tt11", "tt12"]);
    expect(evs.find((e) => e.title.id === "tt13")!.bulk).toBe(false);
  });

  test("a date without a time counts for its month but not the clock", () => {
    const movie = title({ id: "tt2", type: "movie", runtime: 90, events: [{ t: at("2026-06-08T00:00:00Z"), key: "tt2" }] });
    const all = stats([movie]).periods[0];
    expect(all.months.find((m) => m.month === "2026-06")!.movie).toBe(90);
    expect(all.sessions).toBe(0);
  });

  test("unknown runtimes use a typical one and say so", () => {
    const all = stats([title({ id: "tt3", type: "movie", events: [{ t: at("2026-03-01T20:00:00Z"), key: "tt3" }] })]).periods[0];
    expect(all.minutes).toBe(120);
    expect(all.estimatedShare).toBe(1);
  });
});

describe("time zones", () => {
  test("date-only marks keep their calendar month in a western time zone", () => {
    const movie = title({ id: "tt11", type: "movie", runtime: 100, events: [{ key: "tt11", t: at("2026-01-01T00:00:00Z") }] });
    const result = stats([movie], new Map(), "America/New_York");
    expect(result.periods.find((p) => p.key === "2026")!.months[0].movie).toBe(100);
    expect(result.periods[0].sessions).toBe(0);
  });
  test("hours are local to the profile", () => {
    expect(localParts(at("2026-04-24T03:00:00Z"), "America/Chicago").hour).toBe(22);
    const show = title({ id: "tt1", runtime: 25, events: evening("tt1", "2026-04-24T03:25:00Z", 2) });
    expect(stats([show], new Map(), "America/Chicago").periods[0].clock[22]).toBe(1);
  });
});

describe("streaks and gaps", () => {
  test("the longest binge is one title on consecutive days", () => {
    const show = title({ id: "kitsu:5", name: "Naruto", anime: true, runtime: 23,
      events: [...evening("kitsu:5", "2026-03-01T01:00:00Z", 8), ...evening("kitsu:5", "2026-03-02T01:00:00Z", 6, 9), ...evening("kitsu:5", "2026-03-20T01:00:00Z", 2, 15)] });
    const binge = stats([show]).periods.find((p) => p.key === "2026")!.binge!;
    expect(binge).toMatchObject({ name: "Naruto", episodes: 14, days: 2 });
  });

  test("the longest quiet stretch is measured between real watches", () => {
    const a = title({ id: "tt1", type: "movie", runtime: 100, events: [{ t: at("2026-06-08T02:00:00Z"), key: "tt1" }] });
    const b = title({ id: "tt2", type: "movie", runtime: 100, events: [{ t: at("2026-08-24T02:00:00Z"), key: "tt2" }] });
    const s = stats([a, b]);
    expect(s.periods.find((p) => p.key === "2026")!.gap).toMatchObject({ days: 77 });
    expect(s.insights.find((i) => i.key === "gap")!.title).toBe("Eleven weeks without a watch logged.");
  });
});

describe("insights", () => {
  test("unknown countries cannot support an every-film claim", () => {
    const films = Array.from({ length: 5 }, (_, i) => title({ id: `tt${i}`, type: "movie", score: 10, events: [{ key: `tt${i}` }] }));
    const facts = new Map(films.slice(0, 4).map((t): [string, Facts] => [t.id, { genres: ["Drama"], cast: [], director: [], country: "India" }]));
    expect(stats(films, facts).insights.some((i) => i.key === "tensCountry")).toBe(false);
  });
  const aot = ["Attack on Titan", "Attack on Titan Season 2", "Attack on Titan Season 3 (part 1)", "Attack on Titan Season 3 (part 2)",
    "Attack on Titan Final Season", "Attack on Titan The Final Season"].map((name, i) => title({ id: `kitsu:${100 + i}`, name, anime: true, score: 10, watchedEpisodes: 12 }));
  const others = Array.from({ length: 13 }, (_, i) => title({ id: `tt9${i}`, name: ["Up", "Jersey", "Fidaa", "Majili", "Dookudu", "Maharaja", "Ninnu Kori", "Mazaka", "Dragon", "Court", "Mathu Vadalara", "Lucky Baskhar", "Tourist Family"][i], type: "movie", score: 10, events: [{ key: `tt9${i}` }] }));

  test("one franchise holding your 10s", () => {
    const tens = stats([...aot, ...others]).insights.find((i) => i.key === "tens")!;
    expect(tens.title).toBe("Six of your nineteen 10s are Attack on Titan.");
    expect(tens.detail).toBe("Nothing else has more than one.");
    expect(tens.ref?.id).toBe("kitsu:100");
  });

  test("a show stopped a few episodes from the end", () => {
    const st = title({ id: "tt4574334", name: "Stranger Things", status: "watching", watchedEpisodes: 39, totalEpisodes: 42, lastWatchedAt: at("2026-01-18T03:00:00Z") });
    const insight = stats([st]).insights.find((i) => i.key === "almost")!;
    expect(insight.title).toBe("Stranger Things is three episodes from the end.");
    expect(insight.detail).toBe("You stopped on January 18 and haven’t been back.");
  });

  test("a show you're still in the middle of this week isn't nagged about", () => {
    const st = title({ id: "tt1", name: "Fresh", status: "watching", watchedEpisodes: 9, totalEpisodes: 10, lastWatchedAt: now - 2 * DAY });
    expect(stats([st]).insights.find((i) => i.key === "almost")).toBeUndefined();
  });

  test("the oldest thing on your list", () => {
    const berserk = title({ id: "kitsu:24", name: "Berserk", status: "plantowatch", addedAt: at("2024-10-03T00:00:00Z") });
    const s = stats([berserk]);
    expect(s.planned).toMatchObject({ count: 1, oldest: { name: "Berserk" } });
    expect(s.insights.find((i) => i.key === "plan")!.title).toBe("Berserk has been on your list for two years.");
  });

  test("finish rate counts finished against stopped, not shows in progress lately", () => {
    const anime = [
      ...Array.from({ length: 19 }, (_, i) => title({ id: `kitsu:${i}`, anime: true, status: "completed", watchedEpisodes: 12 })),
      title({ id: "kitsu:90", anime: true, status: "dropped", watchedEpisodes: 3 }),
      title({ id: "kitsu:91", anime: true, status: "watching", watchedEpisodes: 4, lastWatchedAt: now - DAY }),
    ];
    const s = stats(anime);
    expect(s.finish).toMatchObject({ animeStarted: 20, animeFinished: 19 });
    expect(s.insights.find((i) => i.key === "finish")!.title).toBe("19 of 20 settled anime are finished.");
    expect(s.persona.name).toBe("The Finisher");
  });

  test("every film 10 from one country", () => {
    const films = ["tt1", "tt2", "tt3", "tt4"].map((id) => title({ id, type: "movie", score: 10, events: [{ key: id }] }));
    const hollywood = title({ id: "tt5", type: "movie", score: 9, events: [{ key: "tt5" }] });
    const fact = (country: string): Facts => ({ genres: ["Drama"], cast: [], director: [], country });
    const facts = new Map<string, Facts>([...films.map((f): [string, Facts] => [f.id, fact("India")]), ["tt5", fact("United States")]]);
    const insight = stats([...films, hollywood], facts).insights.find((i) => i.key === "tensCountry")!;
    expect(insight.title).toBe("Every film you’ve given a 10 is from India.");
    expect(insight.detail).toBe("Your best from anywhere else is a 9.");
  });
});

describe("you and your friend", () => {
  const mine = Array.from({ length: 6 }, (_, i) => title({ id: `tt${i}`, type: "movie", score: 8, events: [{ key: `tt${i}` }] }));
  test("agreement stays locked until five titles are scored by both", () => {
    const s = buildStats({ now, titles: mine, facts: new Map(), friend: { name: "Ravi", hue: 145, scores: new Map([["tt0", 9]]), togetherMinutes: 130, parties: 1 } });
    expect(s.friend).toMatchObject({ bothScored: 1, agreement: undefined, togetherMinutes: 130, parties: 1 });
    expect(s.friend!.ask.length).toBe(5);
  });
  test("with five, it shows agreement and the biggest split", () => {
    const theirs = new Map([["tt0", 8], ["tt1", 9], ["tt2", 7], ["tt3", 8], ["tt4", 3]]);
    const s = buildStats({ now, titles: mine, facts: new Map(), friend: { name: "Ravi", hue: 145, scores: theirs, togetherMinutes: 0, parties: 0 } });
    expect(s.friend).toMatchObject({ bothScored: 5, agreement: 0.8, split: { id: "tt4", mine: 8, theirs: 3 } });
  });
});

describe("assembling history", () => {
  const rest = { feedback: [], viewing: [], library: [], unwatched: [] as [string, number][] };
  const tracked = {
    id: "tt1", type: "series" as const, name: "Show", status: "completed" as const, watchedEpisodes: 2, runtime: 40,
    watchedAt: "1:1@" + Math.floor(at("2026-05-01T02:00:00Z") / 1000).toString(36) + ",1:2@" + Math.floor(at("2026-05-01T02:45:00Z") / 1000).toString(36),
    lastWatchedAt: at("2026-05-01T02:45:00Z"),
  };

  test("per-episode times round-trip", () => {
    expect(expandWatchedAt(tracked.watchedAt)).toEqual([{ key: "1:1", t: at("2026-05-01T02:00:00Z") }, { key: "1:2", t: at("2026-05-01T02:45:00Z") }]);
  });

  test("Krida's own playback replaces Simkl's record of the same episode", () => {
    const progress = [{ imdbId: "tt1", type: "series" as const, name: "Show", season: 1, episode: 2, position: 1500, duration: 2400, finished: false,
      startedAt: at("2026-05-01T02:30:00Z"), updatedAt: at("2026-05-01T02:55:00Z") }];
    const [t] = assemble([tracked], progress, rest);
    expect(t.events).toHaveLength(2);
    expect(t.events.find((e) => e.key === "tt1:1:2")).toMatchObject({ krida: true, minutes: 25 });
  });

  test("didn't watch it hides history from before, but watching it later brings it back", () => {
    expect(assemble([tracked], [], { ...rest, unwatched: [["tt1", now]] })).toEqual([]);
    const later = [{ imdbId: "tt1", type: "series" as const, name: "Show", season: 1, episode: 1, position: 600, duration: 2400, finished: false,
      startedAt: now + DAY, updatedAt: now + DAY }];
    expect(assemble([tracked], later, { ...rest, unwatched: [["tt1", now]] }).map((t) => t.events.length)).toEqual([1]);
  });

  test("a scored title with no other history still counts as seen", () => {
    const [t] = assemble([], [], { ...rest, feedback: [{ id: "tt7", type: "movie", name: "Rated", score: 8 }] });
    expect(t).toMatchObject({ status: "completed", score: 8 });
  });

  test("partial episode dates keep undated episodes and deduplicate local playback", () => {
    const mixed = { ...tracked, watchedEpisodes: 3, watched: "1:1-3", watchedAt: tracked.watchedAt.split(",")[0] };
    const progress = [{ imdbId: "tt1", type: "series" as const, name: "Show", season: 1, episode: 2,
      position: 2400, duration: 2400, finished: true, startedAt: now, updatedAt: now }];
    const [t] = assemble([mixed], progress, rest);
    expect(t.events).toHaveLength(3);
    expect(t.events.filter((e) => e.t === undefined)).toHaveLength(1);
    expect(stats([t]).periods[0].minutes).toBe(120);
  });

  test("local episode counts accumulate and partial movies are not finished movies", () => {
    const progress = [1, 2, 3].map((episode) => ({ imdbId: "tt8", type: "series" as const, name: "Show", season: 1, episode,
      position: 2400, duration: 2400, finished: true, startedAt: now, updatedAt: now }));
    const [t] = assemble([], progress, rest);
    expect(t.watchedEpisodes).toBe(3);
    expect(watchedEnough(t)).toBe(true);
    const [movie] = assemble([], [{ ...progress[0], imdbId: "tt9", type: "movie", finished: false }], rest);
    expect(stats([movie]).periods[0]).toMatchObject({ movies: 0, minutes: 40 });
  });
});
