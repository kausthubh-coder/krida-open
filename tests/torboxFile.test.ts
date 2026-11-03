import { afterEach, expect, test, vi } from "vitest";
import { resolveToTorbox, SourceError } from "../convex/lib/providers";

const API = "https://torbox.test/v1/api";
const episode5 = { type: "series" as const, season: 1, episode: 5, name: "Example" };

/** A season pack in TorBox: episode 1 first, and the biggest file is episode 3. */
const pack = {
  id: 7,
  hash: "a".repeat(40),
  files: [
    { id: 0, short_name: "Example.S01E01.1080p.mkv", size: 2_000, mimetype: "video/x-matroska" },
    { id: 1, short_name: "Example.S01E02.1080p.mkv", size: 2_100, mimetype: "video/x-matroska" },
    { id: 2, short_name: "Example.S01E03.1080p.mkv", size: 2_900, mimetype: "video/x-matroska" },
    { id: 3, short_name: "Example.S01E04.1080p.mkv", size: 2_200, mimetype: "video/x-matroska" },
    { id: 4, short_name: "Example.S01E05.1080p.mkv", size: 2_300, mimetype: "video/x-matroska" },
    { id: 5, short_name: "Example.S01.NFO.txt", size: 10, mimetype: "text/plain" },
  ],
};

/** The addon's link redirects once to `location`; TorBox lists `torrents`. */
function torbox(location: string, torrents = [pack]) {
  vi.stubEnv("TORBOX_API_URL", API);
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url.startsWith(`${API}/torrents/mylist`)) return Response.json({ success: true, data: torrents });
    if (url.startsWith("https://addon.test/")) return new Response(null, { status: 302, headers: { location } });
    return new Response("not found", { status: 404 });
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

test("a link naming the torrent but not the file plays the episode, not the pack's first file", async () => {
  torbox(`https://api.torbox.app/v1/api/torrents/requestdl?torrent_id=7&redirect=true`);
  const source = { url: "https://addon.test/play/1", name: "TB", description: "", filename: "Example.S01.1080p" };
  expect(await resolveToTorbox("key", source, episode5)).toEqual({ torrentId: 7, fileId: 4, hash: pack.hash });
});

test("a pack the addon gave no file name or size for plays the episode, not its biggest file", async () => {
  torbox(`https://store-1.tb-cdn.io/dl/${pack.hash}/x`);
  const source = { url: "https://addon.test/play/2", name: "TB", description: "" };
  expect(await resolveToTorbox("key", source, episode5)).toEqual({ torrentId: 7, fileId: 4, hash: pack.hash });
});

test("anime numbering inside a pack finds the episode too", async () => {
  const anime = {
    id: 8,
    hash: "b".repeat(40),
    files: [1, 2, 3].map((n) => ({ id: n, short_name: `[Group] Example - 0${n} [1080p].mkv`, size: 1_000 * n, mimetype: "video/x-matroska" })),
  };
  torbox(`https://store-1.tb-cdn.io/dl/${anime.hash}/x`, [anime]);
  const source = { url: "https://addon.test/play/3", name: "TB", description: "" };
  expect(await resolveToTorbox("key", source, { type: "series", episode: 2, name: "Example" })).toEqual({ torrentId: 8, fileId: 2, hash: anime.hash });
});

test("a pack without the episode fails, so the next source is tried instead of the wrong episode playing", async () => {
  torbox(`https://store-1.tb-cdn.io/dl/${pack.hash}/x`);
  const source = { url: "https://addon.test/play/4", name: "TB", description: "" };
  await expect(resolveToTorbox("key", source, { ...episode5, episode: 9 })).rejects.toThrow(
    new SourceError("This source doesn't have this episode", "wrongFile"),
  );
});

test("the addon's own file id, size and name still win", async () => {
  torbox(`https://api.torbox.app/v1/api/torrents/requestdl?torrent_id=7&file_id=2&redirect=true`);
  expect(await resolveToTorbox("key", { url: "https://addon.test/play/5", name: "TB", description: "" }, episode5))
    .toEqual({ torrentId: 7, fileId: 2, hash: undefined });
  torbox(`https://store-1.tb-cdn.io/dl/${pack.hash}/x`);
  expect(await resolveToTorbox("key", { url: "https://addon.test/play/6", name: "TB", description: "", size: 2_100 }, episode5))
    .toEqual({ torrentId: 7, fileId: 1, hash: pack.hash });
});

test("a movie plays the biggest video file", async () => {
  const movie = {
    id: 9,
    hash: "c".repeat(40),
    files: [
      { id: 0, short_name: "Sample.mkv", size: 50, mimetype: "video/x-matroska" },
      { id: 1, short_name: "Film.2020.1080p.mkv", size: 9_000, mimetype: "video/x-matroska" },
    ],
  };
  torbox(`https://store-1.tb-cdn.io/dl/${movie.hash}/x`, [movie]);
  expect(await resolveToTorbox("key", { url: "https://addon.test/play/7", name: "TB", description: "" }, { type: "movie" }))
    .toEqual({ torrentId: 9, fileId: 1, hash: movie.hash });
});
