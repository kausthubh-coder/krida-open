// Continue watching's Settings → Home choices: where a show's next episode follows from, and episodes not out yet.
import { describe, expect, test } from "vitest";
import type { Doc, Id } from "../convex/_generated/dataModel";
import { continueOf } from "../src/data/rows";
import { followingEpisode, type Meta } from "../src/data/cinemeta";
import { splitUpcoming } from "../src/features/home/nextUp";

let n = 0;
const play = (imdbId: string, season: number | undefined, episode: number | undefined, finished: boolean, updatedAt: number) =>
  ({
    _id: `p${++n}` as Id<"progress">, _creationTime: 0, profileId: "me" as Id<"profiles">, updatedAt, finished, position: finished ? 1500 : 300, duration: 1500,
    media: season === undefined
      ? { type: "movie", imdbId, videoId: imdbId, name: imdbId }
      : { type: "series", imdbId, videoId: `${imdbId}:${season}:${episode}`, season, episode, name: imdbId },
  }) as unknown as Doc<"progress">;

describe("after an episode, go on from", () => {
  // Watched up to S2E4, then went back for S1E3 last night.
  const progress = [play("tt1", 2, 4, true, 100), play("tt1", 1, 3, true, 200), play("tt1", 0, 9, true, 50), play("tt2", 1, 1, false, 150), play("tt3", undefined, undefined, true, 300)];
  const shown = (from?: "last" | "furthest") => continueOf({ progress, unwatched: [] }, from).map((r) => r.media.videoId);

  test("the last one watched: the rewatched episode", () => {
    expect(shown()).toEqual(["tt1:1:3", "tt2:1:1"]);
  });

  test("the furthest one: the furthest finished episode, specials aside, while one partway through stays put", () => {
    expect(shown("furthest")).toEqual(["tt1:2:4", "tt2:1:1"]);
  });
});

describe("episodes not out yet", () => {
  const now = Date.parse("2026-11-03T12:00:00Z");
  const meta = {
    id: "tt1", type: "series", name: "Show",
    videos: [
      { id: "tt1:1:1", season: 1, episode: 1, released: "2026-10-20T00:00:00Z" },
      { id: "tt1:1:2", season: 1, episode: 2, released: "2026-10-27T00:00:00Z" },
      { id: "tt1:1:3", season: 1, episode: 3, released: "2026-11-10T00:00:00Z" },
      { id: "tt1:0:1", season: 0, episode: 1 },
    ],
  } as Meta;

  test("the next episode is known, out or not", () => {
    expect(followingEpisode(meta, "tt1:1:1", now)).toEqual({ video: meta.videos![1], upcoming: false });
    expect(followingEpisode(meta, "tt1:1:2", now)).toEqual({ video: meta.videos![2], upcoming: true });
    expect(followingEpisode(meta, "tt1:1:3", now)).toBe(undefined);
  });

  test("stay in Continue watching, get a row of their own, or are left out", () => {
    const waiting = play("tt1", 1, 2, true, 10);
    const airing = play("tt4", 1, 1, true, 20);
    const next = new Map([[waiting._id as string, { video: meta.videos![2], upcoming: true }], [airing._id as string, { video: meta.videos![1], upcoming: false }]]);
    const ids = ({ current, upcoming }: ReturnType<typeof splitUpcoming>) => [current.map((r) => r.media.videoId), upcoming.map((r) => r.media.videoId)];
    expect(ids(splitUpcoming([waiting, airing], next, undefined))).toEqual([["tt1:1:2", "tt4:1:1"], []]);
    expect(ids(splitUpcoming([waiting, airing], next, "row"))).toEqual([["tt4:1:1"], ["tt1:1:2"]]);
    expect(ids(splitUpcoming([waiting, airing], next, "hide"))).toEqual([["tt4:1:1"], []]);
  });
});
