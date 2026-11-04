import { describe, expect, test } from "vitest";
import { contextFor, mismatchOf, rankSources, sourceKey } from "../convex/lib/rank";

const listing = (filename: string, { cached = true, size = 2e9, addon = "Addon" } = {}) => ({
  name: `${cached ? "⚡" : ""}${addon} 1080p`,
  description: "",
  filename,
  size,
});

describe("contextFor", () => {
  test("keeps season 0, the specials", () => {
    expect(contextFor("series", "tt123:0:2")).toEqual({ type: "series", season: 0, episode: 2 });
    expect(contextFor("series", "tt123:1:7")).toEqual({ type: "series", season: 1, episode: 7 });
  });

  test("Kitsu ids have an episode and no season", () => {
    expect(contextFor("series", "kitsu:12:7")).toEqual({ type: "series", episode: 7 });
    expect(contextFor("movie", "tt123")).toEqual({ type: "movie" });
  });
});

describe("mismatchOf", () => {
  const kitsu = contextFor("series", "kitsu:12:7");

  test("Kitsu episodes catch other episode numbers either way", () => {
    expect(mismatchOf("Show.S01E08.1080p.mkv", kitsu)).toBe("Episode 8");
    expect(mismatchOf("Show.S01E07.1080p.mkv", kitsu)).toBeUndefined();
    expect(mismatchOf("[Group] Show - 09 [1080p].mkv", kitsu)).toBe("Episode 9");
    expect(mismatchOf("[Group] Show - 05 [1080p].mkv", kitsu)).toBe("Episode 5");
    expect(mismatchOf("[Group] Show - 07 [1080p].mkv", kitsu)).toBeUndefined();
  });

  test("later seasons may count on from the first, so only lower numbers are wrong there", () => {
    const s2 = { type: "series" as const, season: 2, episode: 3 };
    expect(mismatchOf("[Group] Show - 15 [1080p].mkv", s2)).toBeUndefined();
    expect(mismatchOf("[Group] Show - 02 [1080p].mkv", s2)).toBe("Episode 2");
  });

  test("season 0 files are specials and OADs by name, not spin-offs", () => {
    const special = contextFor("series", "tt123:0:2");
    expect(mismatchOf("Show.S00E02.Special.1080p.mkv", special)).toBeUndefined();
    expect(mismatchOf("Show.S00E02.OVA.1080p.mkv", special)).toBeUndefined();
    expect(mismatchOf("Show.S01E02.1080p.mkv", special)).toBe("Season 1");
    expect(mismatchOf("Show.S01E02.Special.1080p.mkv", { type: "series", season: 1, episode: 2 })).toBe("Special");
  });
});

describe("rankSources", () => {
  const ctx = { type: "series" as const, season: 1, episode: 2 };

  test("the same file from MediaFusion and Comet keeps both provider links", () => {
    const items = [
      listing("Dorothy 2026 2160p ÑF WEB DL DDP5.1 MULTi DV HDR H265-XDMovies", { size: 18_459_921_278, addon: "MediaFusion" }),
      listing("Dorothy 2026 2160p NF WEB DL DDP5.1 MULTi DV HDR H265-XDMovies.mkv", { size: 18_459_921_278, addon: "Comet" }),
      listing("Dorothy 2026 2160p NF WEB DL DDP5.1 MULTi DV HDR H265-XDMovies.mkv", { size: 19_000_000_000 }),
    ];
    const { options } = rankSources(items, { type: "movie" });
    expect(options.map(o => o.indices)).toEqual([[0, 1], [2]]);
  });

  test("a merged file plays its cached copy and keeps the others as fallbacks", () => {
    const items = [
      listing("Show.S01E02.1080p.mkv", { cached: false, addon: "First" }),
      listing("Show.S01E03.1080p.mkv"),
      listing("Show.S01E02.1080p.mkv", { cached: true, addon: "Second" }),
      listing("Show.S01E02.1080p.mkv", { cached: false, addon: "Third" }),
    ];
    const { options, pick } = rankSources(items, ctx);
    const merged = options.find((o) => o.filename === "Show.S01E02.1080p.mkv")!;
    expect(merged.cached).toBe(true);
    expect(merged.index).toBe(2);
    expect(merged.indices).toEqual([2, 0, 3]);
    expect(merged.key).toBe(sourceKey(items[2]));
    expect(merged.keys).toEqual([2, 0, 3].map((i) => sourceKey(items[i])));
    expect(pick?.index).toBe(2);
  });

  test("keys follow the file, not its position", () => {
    const a = listing("Show.S01E02.1080p.mkv");
    const b = listing("Show.S01E02.2160p.mkv", { size: 9e9 });
    const before = rankSources([a, b], ctx).options;
    const after = rankSources([b, a], ctx).options;
    expect(after.find((o) => o.key === before[0].key)?.filename).toBe(a.filename);
    expect(sourceKey(a)).not.toBe(sourceKey(b));
  });
});

describe("the screen it plays on", () => {
  const file = (filename: string, resolution: string) => ({ name: `⚡Addon ${resolution}`, description: "", filename, size: 8e9 });
  const hdr4k = file("Movie.2021.2160p.BluRay.HDR.x265.mkv", "2160p");
  const sdr1080 = file("Movie.2021.1080p.BluRay.x264.mkv", "1080p");
  const movie = { type: "movie" as const };
  const picked = (screen?: "sdr" | "hdr") => rankSources([hdr4k, sdr1080], { ...movie, screen }).pick?.filename;

  test("an SDR screen gets an SDR copy over a sharper HDR one, which the browser would show dark", () => {
    expect(picked("sdr")).toBe(sdr1080.filename);
  });

  test("an HDR screen, or one that hasn't said, keeps the sharper HDR file", () => {
    expect(picked("hdr")).toBe(hdr4k.filename);
    expect(picked(undefined)).toBe(hdr4k.filename);
  });

  test("an HDR screen prefers HDR between copies that are otherwise alike", () => {
    const sdr4k = file("Movie.2021.2160p.BluRay.x265.mkv", "2160p");
    expect(rankSources([sdr4k, hdr4k], { ...movie, screen: "hdr" }).pick?.filename).toBe(hdr4k.filename);
    expect(rankSources([hdr4k, sdr4k], { ...movie, screen: "sdr" }).pick?.filename).toBe(sdr4k.filename);
  });

  test("HLG counts as HDR", () => {
    const [hlg] = rankSources([file("Show.S01E01.2160p.iP.WEB-DL.HLG.HEVC.mkv", "2160p")], movie).options;
    expect(hlg.hdr).toEqual(["HLG"]);
  });
});

describe("Krida for Windows, which plays the original file", () => {
  const file = (filename: string, description: string) => ({ name: "⚡Addon 2160p", description, filename, size: undefined });
  const remux = file("Movie.2021.2160p.UHD.BluRay.REMUX.DV.HDR.HEVC.TrueHD.Atmos.mkv", "📦 58 GB (55 Mbps)");
  const encode = file("Movie.2021.2160p.WEB-DL.DDP5.1.HDR.x265.mkv", "📦 16 GB (18 Mbps)");
  const heavy = file("Movie.2021.2160p.UHD.BluRay.REMUX.DV.HDR.HEVC.TrueHD.Atmos.HEAVY.mkv", "📦 80 GB (75 Mbps)");
  const movie = { type: "movie" as const };
  const picked = (screen: "sdr" | "hdr" | "app", items = [encode, remux]) => rankSources(items, { ...movie, screen }).pick?.filename;

  test("the app gets the Dolby Vision remux the browser would struggle to convert", () => {
    expect(picked("app")).toBe(remux.filename);
    expect(picked("hdr")).toBe(encode.filename);
    expect(picked("sdr")).toBe(encode.filename);
  });

  test("in the app a file is as fast as the connection, not the conversion", () => {
    const [r, e] = rankSources([remux, encode], { ...movie, screen: "app" }).options;
    expect([r.speed, e.speed]).toEqual(["smooth", "smooth"]);
    expect(rankSources([remux], { ...movie, screen: "hdr" }).options[0].speed).toBe("buffer");
  });

  test("a file over 60 Mbps may buffer in the app, so a lighter remux wins", () => {
    expect(rankSources([heavy], { ...movie, screen: "app" }).options[0].speed).toBe("buffer");
    expect(picked("app", [heavy, remux])).toBe(remux.filename);
  });

  test("Dolby Vision alone costs nothing in the app, which reads its color data", () => {
    const dvOnly = file("Movie.2021.2160p.WEB-DL.DV.HEVC.mkv", "📦 16 GB (18 Mbps)");
    const hdr10 = file("Movie.2021.2160p.WEB-DL.HDR.HEVC.mkv", "📦 16 GB (18 Mbps)");
    expect(picked("app", [dvOnly, hdr10])).toBe(dvOnly.filename);
    expect(picked("hdr", [dvOnly, hdr10])).toBe(hdr10.filename);
  });

  test("your audio language still comes before picture", () => {
    const italian = file("Movie.2021.2160p.UHD.BluRay.REMUX.DV.HDR.HEVC.TrueHD.Atmos.ITA.mkv", "🌎 Italian\n📦 58 GB (55 Mbps)");
    const english = file("Movie.2021.2160p.WEB-DL.DDP5.1.HDR.x265.ENG.mkv", "🌎 English\n📦 16 GB (18 Mbps)");
    expect(rankSources([italian, english], { ...movie, screen: "app", audioLang: "eng" }).pick?.filename).toBe(english.filename);
  });

  test("a Dual Audio release that names its languages isn't taken for English and Japanese", () => {
    const named = file("Movie.2021.2160p.UHD.BluRay.REMUX.DV.HEVC.mkv", "Movie 2021\n🇷🇺 / 🇩🇪 Dual Audio\n📦 58 GB (55 Mbps)");
    const english = { ...file("Movie.2021.1080p.WEB-DL.DDP5.1.x264.ENG.mkv", "🌎 English\n📦 6 GB (8 Mbps)"), name: "⚡Addon 1080p" };
    const anime = file("Show.2021.1080p.WEB-DL.Dual.Audio.x264.mkv", "Show 2021 Dual Audio\n📦 6 GB (8 Mbps)");
    const ranked = rankSources([named, english], { ...movie, screen: "app", audioLang: "eng" });
    expect(ranked.options.map((o) => [o.resolution, o.languages]).sort()).toEqual([["1080p", ["English"]], ["2160p", ["Russian", "German", "Dual Audio"]]]);
    expect(ranked.pick?.filename).toBe(english.filename);
    expect(rankSources([anime], { ...movie, screen: "app", audioLang: "jpn" }).options[0]?.languages).toEqual(["Dual Audio"]);
  });
});
