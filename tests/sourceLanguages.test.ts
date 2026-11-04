import { describe, expect, test } from "vitest";
import { parseSource } from "../convex/lib/parse";

describe("a release's languages from other addons", () => {
  test("Torrentio's flags and its Multi Audio become languages, and AIOStreams' field still wins", () => {
    expect(parseSource("Torrentio\n4k", "Shawshank.2160p.mkv\n👤 41 💾 26.8 GB ⚙️ RuTracker\nMulti Audio / 🇬🇧 / 🇷🇺 / 🇮🇹", undefined, undefined).languages)
      .toEqual(["English", "Russian", "Italian", "Multi"]);
    expect(parseSource("Comet", "Film.1080p.mkv\n🇯🇵 Dual Audio", undefined, undefined).languages).toEqual(["Japanese", "Dual Audio"]);
    expect(parseSource("AIO", "🌎 French | German\n🇬🇧", undefined, undefined).languages).toEqual(["French", "German"]);
    expect(parseSource("Torrentio", "Film.2160p.DTS-HD.MA.5.1.mkv\n👤 9", undefined, undefined).languages).toEqual([]);
  });
});
