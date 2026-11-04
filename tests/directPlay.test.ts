/// <reference types="vite/client" />
// Another debrid service's files: where each device plays them (the page, mpv, or elsewhere), the link each account
// may have, and handing a file to an external player.
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import schema from "../convex/schema";
import { sha256 } from "../convex/lib/auth";
import { listKey } from "../convex/sources";
import { originFrom } from "../convex/lib/addons";
import { sourceKey } from "../convex/lib/rank";
import { containerOf } from "../shared/formats";
import { playsIn, whyElsewhere } from "../src/features/player/playsIn";
import { m3u, platformOf, playerApps, playlistName } from "../src/features/play/playerLinks";

const modules = import.meta.glob(["../convex/**/*.ts", "../convex/**/*.js", "!../convex/**/*.d.ts"]);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a file's container", () => {
  test("comes from the server's type first, then the link, then the file's name", () => {
    expect(containerOf("video/x-matroska", "https://cdn.invalid/d/AB/film.mp4")).toBe("mkv");
    expect(containerOf("application/octet-stream", "https://cdn.invalid/d/AB/Film%20(2024).mp4?token=x")).toBe("mp4");
    expect(containerOf(null, "https://cdn.invalid/d/AB", "Film.2024.1080p.WEB-DL.m4v")).toBe("mp4");
    expect(containerOf("video/webm")).toBe("webm");
    expect(containerOf(undefined, "https://cdn.invalid/stream", undefined)).toBe(undefined);
  });
});

describe("where the room's stream plays", () => {
  const none = () => false;
  const all = () => true;
  const direct = (container: string, audio: string[] = ["AAC"], videoCodec = "H.264") => ({ direct: { container, audio }, videoCodec, ownFile: true });

  test("TorBox streams: HLS in a browser, mpv in the app, and HLS in the app for another account's room", () => {
    expect(playsIn({ ownFile: true }, { app: false, canPlay: none })).toEqual({ mode: "hls" });
    expect(playsIn({ ownFile: true }, { app: true, canPlay: none })).toEqual({ mode: "mpv" });
    expect(playsIn({ ownFile: false }, { app: true, canPlay: none })).toEqual({ mode: "hls" });
    // A server from before `ownFile` played every stream in mpv in the app.
    expect(playsIn({}, { app: true, canPlay: none })).toEqual({ mode: "mpv" });
  });

  test("another service's MP4 and WebM play in the page; MKV goes to mpv in the app and elsewhere in a browser", () => {
    expect(playsIn(direct("mp4"), { app: false, canPlay: none })).toEqual({ mode: "file" });
    expect(playsIn(direct("webm", ["Opus"], "VP9"), { app: false, canPlay: none })).toEqual({ mode: "file" });
    expect(playsIn(direct("mkv"), { app: false, canPlay: all })).toEqual({ mode: "elsewhere", why: "format" });
    expect(playsIn(direct("mkv"), { app: true, canPlay: none })).toEqual({ mode: "mpv" });
  });

  test("an MP4 with sound or picture this browser lacks plays elsewhere", () => {
    expect(playsIn(direct("mp4", ["DTS-HD"]), { app: false, canPlay: all })).toEqual({ mode: "elsewhere", why: "sound" });
    expect(playsIn(direct("mp4", ["DD+"]), { app: false, canPlay: none })).toEqual({ mode: "elsewhere", why: "sound" });
    expect(playsIn(direct("mp4", ["DD+"]), { app: false, canPlay: all })).toEqual({ mode: "file" });
    expect(playsIn(direct("mp4", ["AAC"], "HEVC"), { app: false, canPlay: none })).toEqual({ mode: "elsewhere", why: "picture" });
    expect(playsIn(direct("mp4", ["AAC"], "HEVC"), { app: false, canPlay: (t) => t.includes("hvc1") })).toEqual({ mode: "file" });
  });

  test("another account's direct file plays only for that account, in the app too", () => {
    const theirs = { ...direct("mp4"), ownFile: false };
    expect(playsIn(theirs, { app: false, canPlay: all })).toEqual({ mode: "elsewhere", why: "account" });
    expect(playsIn(theirs, { app: true, canPlay: all })).toEqual({ mode: "elsewhere", why: "account" });
    expect(playsIn(theirs, { app: false, native: true, canPlay: all })).toEqual({ mode: "elsewhere", why: "account" });
  });

  test("the Android app's own player takes what the page can't, and leaves the page what it can", () => {
    expect(playsIn(direct("mkv"), { app: false, native: true, canPlay: all })).toEqual({ mode: "native" });
    expect(playsIn(direct("mp4", ["DTS-HD"]), { app: false, native: true, canPlay: all })).toEqual({ mode: "native" });
    expect(playsIn(direct("mp4", ["AAC"], "HEVC"), { app: false, native: true, canPlay: none })).toEqual({ mode: "native" });
    expect(playsIn(direct("mp4"), { app: false, native: true, canPlay: none })).toEqual({ mode: "file" });
    // TorBox's own stream stays the page's HLS.
    expect(playsIn({ ownFile: true }, { app: false, native: true, canPlay: none })).toEqual({ mode: "hls" });
    // An app from before 1.4 offers other players, as a browser does.
    expect(playsIn(direct("mkv"), { app: false, native: false, canPlay: all })).toEqual({ mode: "elsewhere", why: "format" });
  });

  test("says why in words", () => {
    expect(whyElsewhere("format", direct("mkv"))).toBe("This copy is an MKV file, which browsers can’t play.");
    expect(whyElsewhere("sound", direct("mp4", ["TrueHD", "DD+"]))).toBe("Its sound (TrueHD, DD+) is a kind this browser can’t play.");
    expect(whyElsewhere("picture", direct("mp4", [], "HEVC"))).toBe("Its picture (HEVC) is a kind this browser can’t play.");
  });
});

describe("external players", () => {
  const url = "https://cdn.invalid/d/AB/Film (2024).mkv";

  test("each device gets the apps that take a link there", () => {
    const iPhone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15";
    const iPad = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15";
    expect([platformOf(iPhone), platformOf(iPad, 5), platformOf(iPad, 0), platformOf("Mozilla/5.0 (Linux; Android 15; Pixel 9)"), platformOf("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")])
      .toEqual(["ios", "ios", "mac", "android", "windows"]);
    const enc = encodeURIComponent(url);
    expect(playerApps(url, "ios")).toEqual([
      { name: "VLC", href: `vlc-x-callback://x-callback-url/stream?url=${enc}` },
      { name: "Infuse", href: `infuse://x-callback-url/play?url=${enc}` },
      { name: "Outplayer", href: "outplayer://https://cdn.invalid/d/AB/Film%20(2024).mkv" },
      { name: "SenPlayer", href: `senplayer://x-callback-url/play?url=${enc}` },
    ]);
    expect(playerApps(url, "android")).toEqual([
      { name: "VLC", href: "intent://cdn.invalid/d/AB/Film (2024).mkv#Intent;scheme=https;type=video/*;package=org.videolan.vlc;end" },
      { name: "MX Player", href: "intent://cdn.invalid/d/AB/Film (2024).mkv#Intent;scheme=https;type=video/*;package=com.mxtech.videoplayer.ad;end" },
      { name: "MX Player Pro", href: "intent://cdn.invalid/d/AB/Film (2024).mkv#Intent;scheme=https;type=video/*;package=com.mxtech.videoplayer.pro;end" },
      { name: "Just Player", href: "intent://cdn.invalid/d/AB/Film (2024).mkv#Intent;scheme=https;type=video/*;package=com.brouken.player;end" },
      { name: "Another app", href: "intent://cdn.invalid/d/AB/Film (2024).mkv#Intent;scheme=https;type=video/*;end" },
    ]);
    expect(playerApps(url, "mac").map((a) => a.name)).toEqual(["IINA", "Infuse"]);
    expect(playerApps(url, "windows")).toEqual([]);
  });

  test("the playlist names the film and its link, and its file name is safe", () => {
    expect(m3u(url, "Severance · S2 E1\n")).toBe(`#EXTM3U\n#EXTINF:-1,Severance · S2 E1 \n${url}\n`);
    expect(playlistName("Mission: Impossible / Dead Reckoning")).toBe("Mission Impossible Dead Reckoning.m3u");
  });
});

describe("the file's link", () => {
  const STREAMS = "https://streams.invalid";
  const manifest = { id: "test.streams", name: "Test streams", version: "1.0.0", types: ["movie"], resources: [{ name: "stream", types: ["movie"], idPrefixes: ["tt"] }], catalogs: [] };
  const film = { url: "https://addon.invalid/resolve/rd/abc/film.mkv", name: "⚡Torrentio 1080p", description: "", filename: "Film.2024.1080p.mkv", size: 2e9 };
  const mp4 = { url: "https://addon.invalid/resolve/rd/abc/film.mp4", name: "⚡Torrentio 720p", description: "", filename: "Film.2024.720p.WEB.mp4", size: 1e9 };

  async function fixture(service: "realdebrid" | "torbox" = "realdebrid") {
    const asked: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      const url = String(input);
      asked.push(url);
      if (url === film.url) return new Response(null, { status: 302, headers: { location: "https://cdn.rd.invalid/d/XY/Film.2024.1080p.mkv" } });
      if (url.startsWith("https://cdn.rd.invalid/")) return new Response("x", { status: 206 });
      return new Response("{}", { status: 404 });
    }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const t = convexTest(schema, modules);
    const ids = await t.run(async (ctx) => {
      const account = async (name: string, debrid: { service: "realdebrid" | "torbox"; key: string }) => {
        const accountId = await ctx.db.insert("accounts", { name, createdAt: Date.now() });
        await ctx.db.insert("accountKeys", { accountId, debrid, updatedAt: Date.now() });
        return accountId;
      };
      const profile = async (name: string, accountId: Id<"accounts">, token: string) => {
        const profileId = await ctx.db.insert("profiles", {
          name, hue: 145, passwordHash: "unused", salt: "unused", order: 0, failedAttempts: 0, prefs: { audioLang: "eng", sounds: false }, accountId,
        });
        await ctx.db.insert("sessions", { profileId, tokenHash: await sha256(token), createdAt: Date.now() });
        return profileId;
      };
      const mine = await account("Mine", { service, key: "my-key" });
      const other = await account("Other", { service: "torbox", key: "their-key" });
      const me = await profile("Me", mine, "me");
      const friend = await profile("Friend", other, "friend");
      await ctx.db.insert("addons", { profileId: me, url: STREAMS, manifest, enabled: true, order: 0, installedAt: Date.now() });
      const streamId = await ctx.db.insert("streams", {
        direct: { link: film.url, container: "mkv", audio: ["DTS"] }, videoCodec: "H.264", audios: [], videoId: "tt100", createdAt: Date.now(), accountId: mine,
      });
      const now = Date.now();
      const roomId = await ctx.db.insert("rooms", {
        hostId: me, hostAccountId: mine, kind: "solo", media: { type: "movie", imdbId: "tt100", videoId: "tt100", name: "Film" }, status: "ready", streamId,
        jobId: 1, playback: { playing: false, position: 0, anchorAt: now, seq: 0 }, createdAt: now, lastActiveAt: now,
      });
      for (const profileId of [me, friend])
        await ctx.db.insert("roomMembers", { roomId, profileId, joinedAt: now, lastSeenAt: now, buffering: false, position: 0, left: false });
      return { mine, me, streamId, roomId };
    });
    const list = await t.run(async (ctx) => await ctx.storage.store(new Blob([JSON.stringify([film, mp4])])));
    const key = listKey("movie", "tt100", originFrom(ids.mine, [{ url: STREAMS, enabled: true, manifest } as never]).scope);
    await t.run(async (ctx) => {
      await ctx.db.insert("sourceLists", { key, file: list, fetchedAt: Date.now() });
      await ctx.db.insert("sourceFetches", { key, fetchedAt: Date.now() });
    });
    return { t, asked, ...ids };
  }

  test("is the debrid service's file, followed afresh, for the stream's own account only", async () => {
    const { t, asked, streamId } = await fixture();
    expect(await t.action(api.desktop.fileLink, { token: "me", streamId })).toBe("https://cdn.rd.invalid/d/XY/Film.2024.1080p.mkv");
    expect(asked).toEqual([film.url, "https://cdn.rd.invalid/d/XY/Film.2024.1080p.mkv"]);
    expect(await t.action(api.desktop.fileLink, { token: "friend", streamId })).toBe(null);
  });

  test("the room tells each member what the file is and whether it's theirs, never its link", async () => {
    const { t, roomId } = await fixture();
    const mine = await t.query(api.rooms.get, { token: "me", roomId });
    const theirs = await t.query(api.rooms.get, { token: "friend", roomId });
    expect([mine?.stream?.direct, mine?.stream?.ownFile, theirs?.stream?.ownFile]).toEqual([{ container: "mkv", audio: ["DTS"] }, true, false]);
    expect(JSON.stringify(mine)).not.toContain("addon.invalid");
  });

  test("a browser's pick, for another service, is a file it plays; the app's is the sharpest", async () => {
    const { t } = await fixture();
    const ask = (screen: "sdr" | "app") => t.action(api.sources.listRanked, { token: "me", type: "movie", videoId: "tt100", screen });
    const browser = await ask("sdr");
    const app = await ask("app");
    expect([browser.pick, browser.direct, app.pick, app.direct]).toEqual([1, true, 0, undefined]);
  });

  test("a TorBox stream is the file's own for its TorBox account only, so another account's app plays the room's HLS", async () => {
    const { t, roomId, streamId } = await fixture("torbox");
    await t.run(async (ctx) => {
      await ctx.db.patch(streamId, { direct: undefined, torrentId: 7, fileId: 3, presignedToken: "p", domain: "https://cdn.invalid" });
    });
    const mine = (await t.query(api.rooms.get, { token: "me", roomId }))!.stream!;
    const theirs = (await t.query(api.rooms.get, { token: "friend", roomId }))!.stream!;
    expect([mine.ownFile, theirs.ownFile]).toEqual([true, false]);
    expect([playsIn(mine, { app: true, canPlay: () => true }), playsIn(theirs, { app: true, canPlay: () => true })]).toEqual([{ mode: "mpv" }, { mode: "hls" }]);
  });

  test("for an external player, one listed file's link, by its key", async () => {
    const { t } = await fixture();
    expect(await t.action(api.sources.fileLink, { token: "me", type: "movie", videoId: "tt100", key: sourceKey(film) })).toEqual({
      url: "https://cdn.rd.invalid/d/XY/Film.2024.1080p.mkv",
    });
    await expect(t.action(api.sources.fileLink, { token: "me", type: "movie", videoId: "tt100", key: "gone" })).rejects.toEqual(
      expect.objectContaining({ data: { code: "SOURCES", message: "That source isn’t listed anymore. Pick another one." } }),
    );
  });
});
