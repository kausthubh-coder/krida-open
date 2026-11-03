import { describe, expect, test } from "vitest";
import {
  addonBase, catalogRowKey, extraPath, genresOf, importableUrls, isRow, isSearchable, mergeStreams, parseManifest, resourceUrl, serves,
  suggestionBase, toStream,
} from "../shared/stremio";
import { parseSource } from "../convex/lib/parse";

describe("an addon's link", () => {
  test("a manifest link, a stremio:// link and a bare address all become the addon's base", () => {
    expect(addonBase(" https://v3-cinemeta.strem.io/manifest.json ")).toBe("https://v3-cinemeta.strem.io");
    expect(addonBase("stremio://torrentio.strem.fun/torbox=abc/manifest.json")).toBe("https://torrentio.strem.fun/torbox=abc");
    expect(addonBase("anime-kitsu.strem.fun/")).toBe("https://anime-kitsu.strem.fun");
    expect(addonBase("http://127.0.0.1:4000/addon/manifest.json?x=1")).toBe("http://127.0.0.1:4000/addon");
  });

  test("something that isn't a link says what to paste", () => {
    expect(() => addonBase("")).toThrow("Paste the addon’s link first.");
    expect(() => addonBase("https://exa mple.com/manifest.json")).toThrow("That isn’t a link. Paste the addon’s manifest link, ending in manifest.json.");
    expect(() => addonBase("https://user:pass@example.com/manifest.json")).toThrow("Links with a user name and password in them aren’t supported.");
    expect(() => addonBase("ftp://example.com/manifest.json")).toThrow("Addons need a web link (https://).");
  });

  test("resource URLs follow Stremio's routes, extras encoded with skip last", () => {
    const base = "https://addon.example/cfg";
    expect(resourceUrl(base, "stream", "series", "tt123:1:2")).toBe("https://addon.example/cfg/stream/series/tt123%3A1%3A2.json");
    expect(resourceUrl(base, "catalog", "movie", "top", { skip: 100, genre: "Sci-Fi & Fantasy" })).toBe(
      "https://addon.example/cfg/catalog/movie/top/genre=Sci-Fi%20%26%20Fantasy&skip=100.json",
    );
    expect(resourceUrl(base, "catalog", "movie", "top", { search: "", skip: undefined })).toBe("https://addon.example/cfg/catalog/movie/top.json");
    expect(extraPath({ skip: 20, search: "dune" })).toBe("search=dune&skip=20");
  });
});

describe("a manifest", () => {
  const cinemeta = {
    id: "com.linvo.cinemeta", version: "3.0.13", name: "Cinemeta", description: "The official addon for movie and series catalogs",
    types: ["movie", "series"], idPrefixes: ["tt"], resources: ["catalog", "meta", "addon_catalog"],
    catalogs: [
      { type: "movie", id: "top", name: "Popular", extra: [{ name: "genre", options: ["Action", "Drama"] }, { name: "search" }, { name: "skip" }] },
      { type: "movie", id: "imdbRating", name: "Featured", extra: [{ name: "genre", options: ["Action"], isRequired: true }] },
      { type: "series", id: "search-only", name: "Search", extra: [{ name: "search", isRequired: true }] },
    ],
    behaviorHints: { configurable: true },
  };

  test("is kept with every resource spelled out and its catalogs' extras", () => {
    expect(parseManifest(cinemeta)).toEqual({
      ok: true,
      manifest: {
        id: "com.linvo.cinemeta", name: "Cinemeta", version: "3.0.13", description: "The official addon for movie and series catalogs",
        types: ["movie", "series"],
        resources: [
          { name: "catalog", types: ["movie", "series"], idPrefixes: ["tt"] },
          { name: "meta", types: ["movie", "series"], idPrefixes: ["tt"] },
          { name: "addon_catalog", types: ["movie", "series"], idPrefixes: ["tt"] },
        ],
        catalogs: [
          { type: "movie", id: "top", name: "Popular", extra: [{ name: "genre", options: ["Action", "Drama"] }, { name: "search" }, { name: "skip" }] },
          { type: "movie", id: "imdbRating", name: "Featured", extra: [{ name: "genre", isRequired: true, options: ["Action"] }] },
          { type: "series", id: "search-only", name: "Search", extra: [{ name: "search", isRequired: true }] },
        ],
        configurable: true,
      },
    });
  });

  test("an object resource keeps its own types and id prefixes", () => {
    const parsed = parseManifest({ id: "x", name: "X", version: "1", types: ["movie", "series", "anime"], resources: [{ name: "stream", types: ["movie", "series"], idPrefixes: ["tt", "kitsu"] }], catalogs: [] });
    expect(parsed.ok && parsed.manifest.resources).toEqual([{ name: "stream", types: ["movie", "series"], idPrefixes: ["tt", "kitsu"] }]);
  });

  test("old-style catalog extras are read", () => {
    const parsed = parseManifest({ id: "x", name: "X", resources: ["catalog"], types: ["movie"], catalogs: [{ type: "movie", id: "s", extraSupported: ["search", "skip"], extraRequired: ["search"] }] });
    expect(parsed.ok && parsed.manifest.catalogs).toEqual([{ type: "movie", id: "s", name: "s", extra: [{ name: "search", isRequired: true }, { name: "skip" }] }]);
    expect(parsed.ok && parsed.manifest.version).toBe("0.0.0");
  });

  test("something that isn't a manifest says why", () => {
    expect(parseManifest(null)).toEqual({ ok: false, message: "That link didn’t give an addon manifest." });
    expect(parseManifest({ name: "X" })).toEqual({ ok: false, message: "That manifest has no id or name, so it isn’t a Stremio addon." });
    expect(parseManifest({ id: "x", name: "X", resources: [] })).toEqual({ ok: false, message: "X doesn’t say what it serves (its manifest lists no resources)." });
  });

  test("a manifest with hundreds of catalogs is cut to a hundred", () => {
    const catalogs = Array.from({ length: 140 }, (_, i) => ({ type: "movie", id: `c${i}`, name: `Catalog ${i}` }));
    const parsed = parseManifest({ id: "x", name: "X", resources: ["catalog"], types: ["movie"], catalogs });
    expect(parsed.ok && parsed.manifest.catalogs.length).toBe(100);
  });

  test("says which catalogs are rows, which answer a search, and their genres", () => {
    const parsed = parseManifest(cinemeta);
    if (!parsed.ok) throw new Error(parsed.message);
    const [popular, featured, search] = parsed.manifest.catalogs;
    expect([isRow(popular), isRow(featured), isRow(search)]).toEqual([true, false, false]);
    expect([isSearchable(popular), isSearchable(featured), isSearchable(search)]).toEqual([true, false, true]);
    expect(genresOf(popular)).toEqual(["Action", "Drama"]);
    // Torrentio lists your debrid downloads as "other": nothing Krida opens.
    expect(isRow({ type: "other", id: "torbox", name: "TorBox WebDL" })).toBe(false);
    expect(catalogRowKey("com.linvo.cinemeta", popular)).toBe("addon:com.linvo.cinemeta:movie:top");
  });

  test("an addon answers only the types and id prefixes it lists", () => {
    const parsed = parseManifest({ id: "x", name: "X", types: ["movie", "series"], resources: [{ name: "stream", types: ["series"], idPrefixes: ["kitsu:"] }, "meta"] });
    if (!parsed.ok) throw new Error(parsed.message);
    expect(serves(parsed.manifest, "stream", "series", "kitsu:1:2")).toBe(true);
    expect(serves(parsed.manifest, "stream", "series", "tt1:1:2")).toBe(false);
    expect(serves(parsed.manifest, "stream", "movie", "kitsu:1")).toBe(false);
    // No id prefixes listed: any id.
    expect(serves(parsed.manifest, "meta", "movie", "tt1")).toBe(true);
  });
});

describe("streams", () => {
  test("Torrentio's marks become Krida's: cached, seeders, size", () => {
    expect(toStream({
      name: "Torrentio\n4k [TB+]", title: "Dune.2021.2160p.mkv\n👤 12 💾 1.5 GB ⚙️ 1337x", url: "https://torrentio.strem.fun/resolve/torbox/k/abc",
      behaviorHints: { filename: "Dune.2021.2160p.mkv", bingeGroup: "torrentio|4k" },
    })).toEqual({
      url: "https://torrentio.strem.fun/resolve/torbox/k/abc", name: "⚡ Torrentio\n4k", description: "Dune.2021.2160p.mkv\n👥 12 📦 1.5 GB ⚙️ 1337x",
      filename: "Dune.2021.2160p.mkv", size: 1_500_000_000, bingeGroup: "torrentio|4k",
    });
  });

  test("the source sheet names the addon without its cached mark", () => {
    const s = toStream({ name: "Torrentio\n4k [TB+]", title: "x.mkv", url: "https://t.example/1" })!;
    expect(parseSource(s.name, s.description, s.filename, s.size)).toMatchObject({ addon: "Torrentio", cached: true, resolution: "2160p" });
  });

  test("Comet's cached mark and its own size", () => {
    expect(toStream({ name: "[TB⚡] Comet 2160p", description: "📄 x.mkv", url: "https://comet.example/p", behaviorHints: { videoSize: 42 } })).toEqual({
      url: "https://comet.example/p", name: "⚡ Comet 2160p", description: "📄 x.mkv", size: 42,
    });
  });

  test("a torrent-only stream becomes a magnet; one for another app is dropped", () => {
    expect(toStream({ name: "Torrentio\n1080p", title: "x", infoHash: "ABCDEF0123456789ABCDEF0123456789ABCDEF01" })?.url).toBe(
      "magnet:?xt=urn:btih:abcdef0123456789abcdef0123456789abcdef01",
    );
    expect(toStream({ name: "Trailer", ytId: "abc" })).toBe(null);
    expect(toStream({ name: "Site", externalUrl: "https://example.com" })).toBe(null);
  });

  test("several addons merge in order, each link once", () => {
    const s = (url: string) => ({ url, name: url, description: "" });
    expect(mergeStreams([[s("a"), s("b")], [s("b"), s("c")]]).map((x) => x.url)).toEqual(["a", "b", "c"]);
    expect(mergeStreams([[s("a"), s("b")], [s("c")]], 2).map((x) => x.url)).toEqual(["a", "b"]);
  });
});

describe("suggestions", () => {
  test("Torrentio takes the debrid service and key in its path", () => {
    expect(suggestionBase("torrentio", { service: "realdebrid", key: "rd/key" })).toBe("https://torrentio.strem.fun/realdebrid=rd%2Fkey");
  });

  test("Comet's settings are base64 JSON with no slash to split the path", () => {
    for (const key of ["a", "abc???", "zz>>>?", "key-with/slash", "ü?é"]) {
      const base = suggestionBase("comet", { service: "torbox", key });
      const config = base.replace("https://comet.elfhosted.com/", "");
      expect(config.includes("/")).toBe(false);
      expect(JSON.parse(atob(config)).debridServices).toEqual([{ service: "torbox", apiKey: key }]);
    }
  });
});

describe("importing a Stremio account", () => {
  test("reads the collection's links, leaving out local ones and repeats", () => {
    const body = {
      result: {
        addons: [
          { transportUrl: "https://v3-cinemeta.strem.io/manifest.json", manifest: { id: "com.linvo.cinemeta" }, flags: { official: true, protected: true } },
          { transportUrl: "http://127.0.0.1:11470/local-addon/manifest.json", manifest: { id: "org.stremio.local" } },
          { transportUrl: "https://torrentio.strem.fun/torbox=k/manifest.json", manifest: { id: "com.stremio.torrentio.addon" } },
          { transportUrl: "https://torrentio.strem.fun/torbox=k/manifest.json" },
          { manifest: { id: "no.link" } },
        ],
      },
    };
    expect(importableUrls(body)).toEqual(["https://v3-cinemeta.strem.io", "https://torrentio.strem.fun/torbox=k"]);
  });

  test("an error answer gives nothing", () => {
    expect(importableUrls({ error: { code: 1, message: "Session does not exist" } })).toEqual([]);
  });
});
