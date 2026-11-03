import { beforeEach, describe, expect, test, vi } from "vitest";
import { choiceFor, recallSubtitles, rememberSubtitles, startingSubtitles } from "../src/features/player/subtitleMemory";

// Two episodes of one show: different files, different OpenSubtitles ids, the same languages.
const episode1 = {
  file: [
    { id: "file:1", lang: "eng", title: "Full" },
    { id: "file:2", lang: "spa" },
    { id: "file:3", title: "Commentary" },
  ],
  online: [
    { id: "os-11", url: "https://subs.invalid/11.srt", lang: "eng" },
    { id: "os-12", url: "https://subs.invalid/12.srt", lang: "fre" },
  ],
};
const episode2 = {
  file: [
    { id: "file:1", lang: "spa" },
    { id: "file:2", lang: "eng", title: "Full" },
    { id: "file:3", title: "Commentary" },
  ],
  online: [
    { id: "os-21", url: "https://subs.invalid/21.srt", lang: "fre" },
    { id: "os-22", url: "https://subs.invalid/22.srt", lang: "eng" },
  ],
};

describe("subtitles carried to the next episode", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
  });

  test("English picked from the file in episode 1 starts episode 2 on its English track", () => {
    rememberSubtitles("me", "tt1", choiceFor("file:1", episode1.file, episode1.online)!);
    expect(startingSubtitles(recallSubtitles("me", "tt1"), undefined, episode2.file, episode2.online)).toBe("file:2");
  });

  test("French from OpenSubtitles starts the next episode on its French file", () => {
    rememberSubtitles("me", "tt1", choiceFor("os-12", episode1.file, episode1.online)!);
    expect(startingSubtitles(recallSubtitles("me", "tt1"), undefined, episode2.file, episode2.online)).toBe("os-21");
  });

  test("a language the next episode lacks falls back to the profile's, else none", () => {
    rememberSubtitles("me", "tt1", choiceFor("file:2", episode1.file, episode1.online)!);
    expect(recallSubtitles("me", "tt1")).toEqual({ lang: "spa" });
    expect(startingSubtitles(recallSubtitles("me", "tt1"), "eng", [], episode2.online)).toBe("os-22");
    expect(startingSubtitles(recallSubtitles("me", "tt1"), undefined, [], episode2.online)).toBe(null);
  });

  test("while OpenSubtitles loads, a remembered language waits instead of showing the profile's", () => {
    rememberSubtitles("me", "tt1", choiceFor("os-12", episode1.file, episode1.online)!);
    expect(startingSubtitles(recallSubtitles("me", "tt1"), "eng", episode2.file, undefined)).toBe(null);
  });

  test("in the browser, a language picked in Krida for Windows comes from OpenSubtitles", () => {
    rememberSubtitles("me", "tt1", choiceFor("file:1", episode1.file, episode1.online)!);
    expect(startingSubtitles(recallSubtitles("me", "tt1"), undefined, [], episode2.online)).toBe("os-22");
  });

  test("turning them off keeps them off, even with a profile language", () => {
    rememberSubtitles("me", "tt1", choiceFor(null, episode1.file, episode1.online)!);
    expect(recallSubtitles("me", "tt1")).toEqual({ off: true });
    expect(startingSubtitles(recallSubtitles("me", "tt1"), "eng", episode2.file, episode2.online)).toBe(null);
  });

  test("a track with no language is matched by its number, else the profile's language", () => {
    rememberSubtitles("me", "tt1", choiceFor("file:3", episode1.file, episode1.online)!);
    expect(recallSubtitles("me", "tt1")).toEqual({ track: "file:3" });
    expect(startingSubtitles(recallSubtitles("me", "tt1"), "eng", episode2.file, episode2.online)).toBe("file:3");
    expect(startingSubtitles(recallSubtitles("me", "tt1"), "eng", [], episode2.online)).toBe("os-22");
  });

  test("each title and each profile keeps its own choice", () => {
    rememberSubtitles("me", "tt1", { lang: "fre" });
    rememberSubtitles("friend", "tt1", { off: true });
    expect(recallSubtitles("me", "tt1")).toEqual({ lang: "fre" });
    expect(recallSubtitles("friend", "tt1")).toEqual({ off: true });
    expect(recallSubtitles("me", "tt2")).toBe(undefined);
    expect(startingSubtitles(undefined, "eng", episode2.file, episode2.online)).toBe("file:2");
    expect(startingSubtitles(undefined, undefined, episode2.file, episode2.online)).toBe(null);
  });

  test("only the 100 most recent titles are kept", () => {
    const now = vi.spyOn(Date, "now");
    for (let i = 0; i <= 100; i++) {
      now.mockReturnValue(1000 + i);
      rememberSubtitles("me", `tt${i}`, { lang: "eng" });
    }
    now.mockRestore();
    expect(recallSubtitles("me", "tt0")).toBe(undefined);
    expect(recallSubtitles("me", "tt1")).toEqual({ lang: "eng" });
    expect(recallSubtitles("me", "tt100")).toEqual({ lang: "eng" });
  });

  test("a damaged store reads as nothing remembered", () => {
    localStorage.setItem("krida.subtitles", "{not json");
    expect(recallSubtitles("me", "tt1")).toBe(undefined);
  });
});

describe("a second subtitle language", () => {
  test("is used only when the first has none, once the online list is in", () => {
    // Episode 2 has French and English; nothing in Hindi.
    expect(startingSubtitles(undefined, "hin", episode2.file, episode2.online, "fre")).toBe("os-21");
    expect(startingSubtitles(undefined, "eng", episode2.file, episode2.online, "fre")).toBe("file:2");
    expect(startingSubtitles(undefined, "hin", [], undefined, "fre")).toBe(null);
    expect(startingSubtitles(undefined, "hin", episode2.file, episode2.online, "kor")).toBe(null);
  });
});
