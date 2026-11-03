import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { clearCache } from "../server/cache";
import { personIdFor, personPage } from "../server/people";

// The asking account's TMDB key (server/session.ts).
const keys = { tmdb: "fake-key" };

type Credit = Record<string, unknown>;
const credit = (id: number, extra: Credit = {}): Credit => ({
  id, media_type: "movie", title: `Title ${id}`, poster_path: "/p.jpg", vote_count: 100, vote_average: 7.46, release_date: "2010-05-01", ...extra,
});
const show = (id: number, extra: Credit = {}): Credit => ({
  id, media_type: "tv", name: `Show ${id}`, poster_path: "/p.jpg", vote_count: 100, vote_average: 7.46, first_air_date: "2008-01-20", ...extra,
});

let person: Record<string, unknown> | null;
let titleCredits: { cast: Credit[]; crew: Credit[] };
let searched: Credit[];
const asked: string[] = [];

beforeEach(() => {
  clearCache();
  asked.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
    const url = new URL(input);
    asked.push(url.pathname);
    if (url.pathname.endsWith("/external_ids")) return Response.json({ imdb_id: `tt${url.pathname.split("/").at(-2)}` });
    if (url.pathname.startsWith("/3/find/")) return Response.json({ movie_results: [{ id: 157336 }], tv_results: [] });
    if (url.pathname === "/3/movie/157336/credits") return Response.json(titleCredits);
    if (url.pathname === "/3/search/person") return Response.json({ results: searched });
    if (url.pathname.startsWith("/3/person/")) return person ? Response.json(person) : new Response("{}", { status: 404 });
    throw new Error(`Unexpected ${url}`);
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("finding a person by name", () => {
  test("a title's own credits pick the person, not the better-known namesake", async () => {
    titleCredits = { cast: [{ id: 7, name: "Michael Caine" }], crew: [{ id: 525, name: "Christopher Nolan", job: "Director" }] };
    searched = [{ id: 999, name: "Christopher Nolan", popularity: 90 }];
    expect(await personIdFor(keys, "Christopher Nolan", "tt0816692")).toBe(525);
    expect(asked).not.toContain("/3/search/person");
  });

  test("a name the title doesn't list, or no title, falls back to the most popular exact match", async () => {
    titleCredits = { cast: [], crew: [] };
    searched = [{ id: 1, name: "Chris Nolan", popularity: 99 }, { id: 2, name: "Christopher Nolan", popularity: 3 }, { id: 3, name: "Christopher Nolan", popularity: 40 }];
    expect(await personIdFor(keys, "Christopher Nolan", "tt0816692")).toBe(3);
    expect(await personIdFor(keys, "Christopher Nolán")).toBe(3);
  });

  test("nobody by that name is null", async () => {
    searched = [];
    expect(await personIdFor(keys, "Zzqx Nobody")).toBeNull();
  });
});

describe("a person's page", () => {
  test("groups what they did, what they're known for first, without appearances as themselves", async () => {
    person = {
      id: 17419, name: "Bryan Cranston", known_for_department: "Acting", birthday: "1956-03-07", deathday: null,
      place_of_birth: "Hollywood", profile_path: "/b.jpg", biography: " An actor. ",
      combined_credits: {
        cast: [
          show(1, { character: "Walter White", episode_count: 62, vote_count: 900 }),
          credit(2, { character: "Shannon (uncredited)", vote_count: 500 }),
          show(3, { genre_ids: [10767], character: "Guest", episode_count: 9 }),
          credit(4, { character: "Himself" }),
          show(5, { character: "Doctor", episode_count: 1 }),
          credit(6, { character: "Extra", vote_count: 3 }),
          credit(7, { character: "No poster", poster_path: null }),
        ],
        crew: [
          show(1, { job: "Director", vote_count: 900 }),
          credit(8, { job: "Director", vote_count: 50 }),
          credit(9, { job: "Producer" }),
        ],
      },
    };
    expect(await personPage(keys, 17419)).toEqual({
      id: 17419,
      name: "Bryan Cranston",
      role: "Actor",
      photo: "https://image.tmdb.org/t/p/w500/b.jpg",
      bio: "An actor.",
      born: "1956-03-07",
      died: undefined,
      place: "Hollywood",
      groups: [
        {
          title: "Actor",
          titles: [
            { id: "tt1", type: "series", name: "Show 1", poster: "https://image.tmdb.org/t/p/w342/p.jpg", year: "2008", rating: 7.5, character: "Walter White" },
            { id: "tt2", type: "movie", name: "Title 2", poster: "https://image.tmdb.org/t/p/w342/p.jpg", year: "2010", rating: 7.5, character: "Shannon" },
          ],
        },
        {
          title: "Director",
          titles: [
            { id: "tt1", type: "series", name: "Show 1", poster: "https://image.tmdb.org/t/p/w342/p.jpg", year: "2008", rating: 7.5, character: undefined },
            { id: "tt8", type: "movie", name: "Title 8", poster: "https://image.tmdb.org/t/p/w342/p.jpg", year: "2010", rating: 7.5, character: undefined },
          ],
        },
        // Producer had one title: a row of one is left out.
      ],
    });
  });

  test("nobody at that id is null", async () => {
    person = null;
    expect(await personPage(keys, 1)).toBeNull();
  });
});
