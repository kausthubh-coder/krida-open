import { expect, test } from "vitest";
import { movieShares } from "../src/data/rows";
import type { Tables } from "../src/data/sync";

const play = (imdbId: string, updatedAt: number, position: number, finished = false) =>
  ({ media: { imdbId, type: "movie" }, updatedAt, position, duration: 100, finished }) as unknown as Tables["progress"][number];

test("a movie card shows its latest play, and nothing once that play finished", () => {
  const progress = [
    play("tt1", 1, 50),
    play("tt1", 3, 25),
    play("tt1", 2, 90),
    play("tt2", 5, 100, true),
    play("tt3", 1, 100, true),
    play("tt3", 2, 10),
  ];
  expect([...movieShares(progress)]).toEqual([
    ["tt1", 0.25],
    ["tt2", undefined],
    ["tt3", 0.1],
  ]);
});

test("every card reads one index per copy of the progress table", () => {
  const progress = [play("tt1", 1, 50)];
  expect(movieShares(progress)).toBe(movieShares(progress));
  expect(movieShares([...progress])).not.toBe(movieShares(progress));
});
