import { describe, expect, test } from "vitest";
import { playPlan } from "../src/features/search/components/playPlan";
import type { Meta } from "../src/data/cinemeta";
import type { ProgressItem } from "../src/features/play/play";

const meta: Meta = {
  id: "tt123", name: "Example", type: "series",
  videos: [
    { id: "tt123:1:1", season: 1, episode: 1, released: "2020-01-01" },
    { id: "tt123:2:4", season: 2, episode: 4, released: "2021-01-01" },
    { id: "tt123:2:5", season: 2, episode: 5, released: "2999-01-01" },
  ],
};
const progress: ProgressItem = { videoId: "tt123:1:1", position: 720, duration: 2400, finished: false, updatedAt: 1 };

describe("Search playback selection", () => {
  test("starts the next Simkl episode when there is no local progress", () => {
    expect(playPlan(meta, [], { season: 2, episode: 4 })).toMatchObject({
      video: { id: "tt123:2:4" }, startAt: 0, label: "Play S2 E4",
    });
  });
  test("resumes unfinished local playback before advancing to Simkl", () => {
    expect(playPlan(meta, [progress], { season: 2, episode: 4 })).toMatchObject({
      video: { id: progress.videoId }, startAt: 720, label: "Resume S1 E1",
    });
  });
  test("does not select an unreleased Simkl episode", () => {
    expect(playPlan(meta, [], { season: 2, episode: 5 }).video?.id).toBe("tt123:1:1");
  });
  test("resumes a movie but starts a completed movie from zero", () => {
    const movie = { ...meta, type: "movie" as const };
    expect(playPlan(movie, [progress])).toMatchObject({ video: undefined, startAt: 720, label: "Resume" });
    expect(playPlan(movie, [{ ...progress, finished: true }])).toMatchObject({ startAt: 0, label: "Play" });
  });
});
