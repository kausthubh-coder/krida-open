import { describe, expect, test } from "vitest";
import { bestSubtitles, nextCueChange } from "../src/features/player/subtitles";

describe("when the line on screen next changes", () => {
  const cues = [
    { start: 1, end: 3, html: "one" },
    { start: 2, end: 4, html: "two" },
    { start: 6, end: 8, html: "three" },
  ];

  test("before the first cue, at its start", () => {
    expect(nextCueChange(cues, 0)).toBe(1);
  });

  test("while one shows, at its end, unless another starts first", () => {
    expect([nextCueChange(cues, 1.5), nextCueChange(cues, 2.5), nextCueChange(cues, 3.5)]).toEqual([2, 3, 4]);
  });

  test("in a gap, at the next start", () => {
    expect(nextCueChange(cues, 5)).toBe(6);
  });

  test("after the last cue ends, never", () => {
    expect([nextCueChange(cues, 7), nextCueChange(cues, 9), nextCueChange([], 0)]).toEqual([8, null, null]);
  });
});

describe("the subtitles picked for your language", () => {
  const file = [
    { id: "file:1", lang: "eng", title: "Signs & Songs" },
    { id: "file:2", lang: "eng", title: "Full" },
    { id: "file:3", lang: "spa", title: "Forced" },
  ];
  const online = [
    { id: "os-1", url: "https://subs.invalid/1.srt", lang: "spa" },
    { id: "os-2", url: "https://subs.invalid/2.srt", lang: "eng" },
  ];

  test("the file's own full track comes first, past its signs-only one", () => {
    expect(bestSubtitles("eng", file, online)).toBe("file:2");
  });

  test("a forced track alone in the file leaves the language to OpenSubtitles", () => {
    expect(bestSubtitles("spa", file, online)).toBe("os-1");
  });

  test("where the file's tracks can't play (the browser), OpenSubtitles", () => {
    expect(bestSubtitles("eng", [], online)).toBe("os-2");
  });

  test("nothing in the language, or OpenSubtitles still loading, is none", () => {
    expect(bestSubtitles("jpn", file, online)).toBe(null);
    expect(bestSubtitles("spa", file, undefined)).toBe(null);
  });
});
