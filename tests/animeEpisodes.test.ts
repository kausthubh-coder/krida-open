import { describe, expect, test } from "vitest";
import { fillAnime, tmdbIdOf, type AnimeSources } from "../src/features/title/animeEpisodes";
import type { Meta } from "../src/data/cinemeta";

// What Kitsu's addon gives a show it has no IMDb id for: 23 expected episodes, all dated the premiere.
const kitsuMeta = (count = 23, released = "2026-10-05T00:00:00.000Z"): Meta => ({
  id: "kitsu:50990", type: "series", name: "Dark Summoner to Dekiteiru", poster: "https://media.kitsu.app/p.jpg",
  videos: Array.from({ length: count }, (_, i) => ({
    id: `kitsu:50990:${i + 1}`, title: `Episode ${i + 1}`, season: 1, episode: i + 1, released,
  })),
});
const at = (iso: string) => Date.parse(iso) / 1000;
const sources: AnimeSources = {
  anilist: { episodes: 12, schedule: Array.from({ length: 12 }, (_, i) => ({ episode: i + 1, airingAt: at("2026-10-04T16:20:00Z") + i * 7 * 86400 })) },
  anizip: {
    episodeCount: 4,
    mappings: { themoviedb_id: "335790" },
    images: [{ coverType: "Poster", url: "https://tvdb/poster.jpg" }, { coverType: "Fanart", url: "https://tvdb/fanart.jpg" }],
    episodes: {
      "1": { title: { en: "The Dark Summoner and the Stubborn Priest" }, overview: "They hook up anyway.", image: "https://tvdb/e1.jpg", airDateUtc: "2026-10-04T16:15:00Z" },
      "2": { title: { en: null, "x-jat": "Judgement" }, image: null, airDateUtc: "2026-10-11T16:15:00Z" },
    },
  },
};

describe("filling a Kitsu-only anime", () => {
  test("takes titles, stills and overviews from ani.zip and air times from AniList", () => {
    const [e1, e2, e3] = fillAnime(kitsuMeta(), sources, null).videos!;
    expect(e1).toMatchObject({ id: "kitsu:50990:1", name: "The Dark Summoner and the Stubborn Priest", overview: "They hook up anyway.", thumbnail: "https://tvdb/e1.jpg", released: "2026-10-04T16:20:00.000Z" });
    expect(e2).toMatchObject({ name: "Judgement", released: "2026-10-11T16:20:00.000Z" });
    expect(e2.thumbnail).toBeUndefined();
    expect(e3).toMatchObject({ title: "Episode 3", released: "2026-10-18T16:20:00.000Z" });
  });

  test("ends a guessed list where AniList's does, but keeps a list Kitsu really dated", () => {
    expect(fillAnime(kitsuMeta(), sources, null).videos).toHaveLength(12);
    const dated = kitsuMeta(23);
    dated.videos = dated.videos!.map((v, i) => ({ ...v, released: new Date(Date.UTC(2026, 9, 4 + 7 * i)).toISOString() }));
    expect(fillAnime(dated, sources, null).videos).toHaveLength(23);
  });

  test("drops guessed dates no one confirms, and counts the furthest episode when AniList has no total", () => {
    const [, , e3] = fillAnime(kitsuMeta(), { anizip: sources.anizip }, null).videos!;
    expect(e3.released).toBeUndefined();
    expect(fillAnime(kitsuMeta(), { anilist: { episodes: null, schedule: sources.anilist!.schedule.slice(0, 8) } }, null).videos).toHaveLength(8);
  });

  test("uses TMDB's backdrop, then TVDB's fanart, by ani.zip's TMDB id", () => {
    expect(fillAnime(kitsuMeta(), sources, "https://tmdb/b.jpg").background).toBe("https://tmdb/b.jpg");
    expect(fillAnime(kitsuMeta(), sources, null).background).toBe("https://tvdb/fanart.jpg");
    expect(fillAnime(kitsuMeta(), { anilist: sources.anilist }, null).background).toBeUndefined();
    expect(tmdbIdOf(sources)).toBe("335790");
    expect(tmdbIdOf({ anizip: { mappings: { themoviedb_id: null } } })).toBeNull();
  });
});
