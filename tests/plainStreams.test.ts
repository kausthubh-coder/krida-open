/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import schema from "../convex/schema";
import { sha256 } from "../convex/lib/auth";
import { sourceKey } from "../convex/lib/rank";
import { toStream } from "../shared/stremio";
import { containerOf } from "../shared/formats";
import { playsIn } from "../src/features/player/playsIn";

/*
 * An addon's plain web video (an https link to an MP4 or an .m3u8, no torrent and no debrid service) plays as it does
 * in Stremio and Nuvio: with no debrid key at all, and with TorBox beside the torrents TorBox plays.
 */

const modules = import.meta.glob(["../convex/**/*.ts", "../convex/**/*.js", "!../convex/**/*.d.ts"]);
const film = { type: "movie" as const, imdbId: "tt100", videoId: "tt100", name: "Film" };

const FREE = "https://free.invalid";
const MP4 = "https://cdn.invalid/films/Film.2024.720p.WEB.mp4";
const M3U8 = "https://cdn.invalid/films/film/master.m3u8";
const HASH = "b".repeat(40);
const raw = {
  mp4: { name: "Free\n720p", title: "Film.2024.720p.WEB.mp4", url: MP4, behaviorHints: { filename: "Film.2024.720p.WEB.mp4" } },
  hls: { name: "Free\n480p", title: "Film.2024.480p.WEB (HLS)", url: M3U8 },
  torrent: { name: "Free\n1080p", title: "Film.2024.1080p.WEB-DL.mkv 👤 50", infoHash: HASH, behaviorHints: { filename: "Film.2024.1080p.WEB-DL.mkv", videoSize: 2e9 } },
};
const keyOf = (s: object) => sourceKey(toStream(s)!);
const manifest = (url: string) => ({
  id: `test.${url}`, name: "Free streams", version: "1.0.0", types: ["movie"], resources: [{ name: "stream", types: ["movie"], idPrefixes: ["tt"] }], catalogs: [],
});

const fetched: string[] = [];
let listed: object[] = [];

beforeEach(() => {
  // The stream job rooms.create books runs only when a test lets it, never beside the one a test runs itself.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  fetched.length = 0;
  listed = [raw.mp4, raw.hls, raw.torrent];
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const url = String(input);
    fetched.push(url);
    if (url.endsWith("/stream/movie/tt100.json")) return Response.json({ streams: listed });
    if (url === MP4) return new Response("x", { status: 206, headers: { "content-type": "video/mp4" } });
    if (url === M3U8) return new Response("#EXTM3U\n", { headers: { "content-type": "application/vnd.apple.mpegurl" } });
    if (url.includes("/torrents/mylist"))
      return Response.json({ success: true, data: [{ id: 9, hash: HASH, files: [{ id: 3, size: 2e9, short_name: "Film.2024.1080p.WEB-DL.mkv", mimetype: "video/x-matroska" }] }] });
    if (url.includes("/stream/createstream")) return Response.json({ success: true, data: { presigned_token: "fresh", domain: "https://tb.invalid", metadata: {} } });
    return new Response(null, { status: 404 });
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * "me" in an account with `debrid` (none by default) and the free addon at `addonUrl`; "friend" and "stranger" in
 * another account with TorBox.
 */
async function setup({ debrid, addonUrl = FREE }: { debrid?: { service: "torbox"; key: string }; addonUrl?: string } = {}) {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    const account = async (name: string, keys?: { service: "torbox"; key: string }) => {
      const accountId = await ctx.db.insert("accounts", { name, createdAt: now });
      if (keys) await ctx.db.insert("accountKeys", { accountId, debrid: keys, updatedAt: now });
      return accountId;
    };
    const profile = async (name: string, accountId: Id<"accounts">, token: string) => {
      const profileId = await ctx.db.insert("profiles", { name, hue: 145, order: 0, failedAttempts: 0, prefs: { audioLang: "eng", sounds: false }, accountId });
      await ctx.db.insert("sessions", { profileId, tokenHash: await sha256(token), createdAt: now });
      return profileId;
    };
    const mine = await account("Mine", debrid);
    const other = await account("Other", { service: "torbox", key: "their-key" });
    const me = await profile("Me", mine, "me");
    const friend = await profile("Friend", other, "friend");
    await profile("Stranger", other, "stranger");
    await ctx.db.insert("addons", { profileId: me, url: addonUrl, manifest: manifest(addonUrl), enabled: true, order: 0, installedAt: now });
    return { me, friend };
  });
  const room = (roomId: Id<"rooms">) => t.run(async (ctx) => (await ctx.db.get(roomId))!);
  const streamOf = async (roomId: Id<"rooms">) => {
    const { streamId } = await room(roomId);
    return await t.run(async (ctx) => (await ctx.db.get(streamId!))!);
  };
  /** Runs the room's stream job now, for `key` or Krida's pick, as the scheduler would. */
  const prepare = async (roomId: Id<"rooms">, key?: string) => {
    const { jobId } = await room(roomId);
    await t.action(internal.engine.prepare, { roomId, jobId: jobId!, key, startAt: 0 });
    return await room(roomId);
  };
  /** The next job in the same room, as picking another source starts. */
  const again = async (roomId: Id<"rooms">) => t.run(async (ctx) => {
    const { jobId } = (await ctx.db.get(roomId))!;
    await ctx.db.patch(roomId, { jobId: jobId! + 1, status: "preparing" });
  });
  return { t, ...ids, room, streamOf, prepare, again };
}

describe("with no debrid key", () => {
  test("a plain web video from an addon plays as it is, and its torrents can't be picked", async () => {
    const { t, room, streamOf } = await setup();
    expect((await t.query(api.onboarding.status, { token: "me" }))?.play).toBe(true);
    const roomId = await t.mutation(api.rooms.create, { token: "me", media: film, screen: "sdr" });
    // The job it booked to start now; the room's later sweeps stay booked.
    vi.advanceTimersByTime(0);
    await t.finishInProgressScheduledFunctions();
    const after = await room(roomId);
    expect([after.status, after.error]).toEqual(["ready", undefined]);
    expect((await streamOf(roomId)).direct).toEqual({ link: MP4, container: "mp4", audio: [], plain: true });
    expect(fetched.some((u) => u.includes("torbox"))).toBe(false);
    const stream = (await t.query(api.rooms.get, { token: "me", roomId }))!.stream!;
    expect([stream.direct, stream.ownFile]).toEqual([{ container: "mp4", audio: [] }, true]);
    expect(playsIn(stream, { app: false, canPlay: () => false })).toEqual({ mode: "file" });
    expect(playsIn(stream, { app: true, canPlay: () => false })).toEqual({ mode: "mpv" });
    expect(await t.action(api.desktop.fileLink, { token: "me", streamId: after.streamId! })).toBe(MP4);

    const ranked = await t.action(api.sources.listRanked, { token: "me", type: "movie", videoId: "tt100", screen: "sdr" });
    expect([ranked.pick, ranked.direct, ranked.noDebrid]).toEqual([0, true, true]);
    expect(ranked.options.map((o) => [o.index, o.unavailable ?? false, o.needsDebrid ?? false])).toEqual([[0, false, false], [1, false, false], [2, true, true]]);
  });

  test("an .m3u8 plays as HLS", async () => {
    const { t, prepare, streamOf } = await setup();
    const roomId = await t.mutation(api.rooms.create, { token: "me", media: film });
    expect((await prepare(roomId, keyOf(raw.hls))).status).toBe("ready");
    expect((await streamOf(roomId)).direct).toEqual({ link: M3U8, container: "hls", audio: [], plain: true });
    const stream = (await t.query(api.rooms.get, { token: "me", roomId }))!.stream!;
    expect(playsIn(stream, { app: false, canPlay: () => false })).toEqual({ mode: "hls" });
  });

  test("a list of torrents only says it needs a debrid service, without asking one", async () => {
    listed = [raw.torrent];
    const { t, prepare } = await setup();
    const roomId = await t.mutation(api.rooms.create, { token: "me", media: film });
    const after = await prepare(roomId);
    expect([after.status, after.error]).toEqual(["error", "These sources need a debrid service. Add one in Settings → Connections."]);
    expect(fetched).toEqual([`${FREE}/stream/movie/tt100.json`]);
  });

  test("a torrent picked by hand says why it can't play", async () => {
    const { t, prepare } = await setup();
    const roomId = await t.mutation(api.rooms.create, { token: "me", media: film });
    const after = await prepare(roomId, keyOf(raw.torrent));
    expect([after.status, after.error]).toEqual(["error", "This copy is a torrent, which needs a debrid service. Add one in Settings → Connections."]);
  });

  test("with no stream addon either, Play still says up front what it needs", async () => {
    const { t } = await setup();
    await t.run(async (ctx) => {
      for (const a of await ctx.db.query("addons").collect()) await ctx.db.delete(a._id);
    });
    expect((await t.query(api.onboarding.status, { token: "me" }))?.play).toBe(false);
    await expect(t.mutation(api.rooms.create, { token: "me", media: film })).rejects.toEqual(
      expect.objectContaining({ data: { code: "NEEDS_DEBRID", message: "Playing needs a debrid service. Add one in Settings → Connections." } }),
    );
  });
});

describe("with TorBox", () => {
  test("a plain web video plays from its link, and a torrent through TorBox", async () => {
    const { t, prepare, again, streamOf } = await setup({ debrid: { service: "torbox", key: "my-key" } });
    const roomId = await t.mutation(api.rooms.create, { token: "me", media: film });
    expect((await prepare(roomId, keyOf(raw.mp4))).status).toBe("ready");
    const plain = await streamOf(roomId);
    expect([plain.direct, plain.torrentId]).toEqual([{ link: MP4, container: "mp4", audio: [], plain: true }, undefined]);
    expect(fetched.some((u) => u.includes("/torrents/"))).toBe(false);

    await again(roomId);
    expect((await prepare(roomId, keyOf(raw.torrent))).status).toBe("ready");
    const torrent = await streamOf(roomId);
    expect([torrent.direct, torrent.torrentId, torrent.fileId, torrent.presignedToken]).toEqual([undefined, 9, 3, "fresh"]);
    const stream = (await t.query(api.rooms.get, { token: "me", roomId }))!.stream!;
    // The app still plays TorBox's original file in mpv.
    expect([stream.ownFile, playsIn(stream, { app: true, canPlay: () => true })]).toEqual([true, { mode: "mpv" }]);
  });

  test("an external player gets a plain video's own link", async () => {
    const { t } = await setup({ debrid: { service: "torbox", key: "my-key" } });
    expect(await t.action(api.sources.fileLink, { token: "me", type: "movie", videoId: "tt100", key: keyOf(raw.mp4) })).toEqual({ url: MP4 });
  });
});

describe("in a party", () => {
  /** A TorBox host's party playing the free addon's .m3u8, with a friend from another account in it. */
  async function party(addonUrl?: string) {
    const s = await setup({ debrid: { service: "torbox", key: "my-key" }, addonUrl });
    const roomId = await s.t.mutation(api.rooms.createParty, { token: "me", inviteIds: [], media: film });
    await s.t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("roomMembers", { roomId, profileId: s.friend, joinedAt: now, lastSeenAt: now, buffering: false, position: 0, left: false });
    });
    const { streamId } = await s.prepare(roomId, keyOf(raw.hls));
    const playlist = async (token: string) => {
      const res = await s.t.fetch(`/hls/playlist.m3u8?s=${streamId}&a=0&t=${token}`, { redirect: "manual" });
      return [res.status, res.headers.get("location")];
    };
    return { ...s, roomId, streamId: streamId!, playlist };
  }

  test("everyone in the room gets a plain video's link; nobody outside it", async () => {
    const { t, roomId, streamId, playlist } = await party();
    const theirs = (await t.query(api.rooms.get, { token: "friend", roomId }))!.stream!;
    expect([theirs.ownFile, playsIn(theirs, { app: false, canPlay: () => true })]).toEqual([true, { mode: "hls" }]);
    expect([await playlist("me"), await playlist("friend"), await playlist("stranger"), await playlist("nobody")]).toEqual([
      [302, M3U8], [302, M3U8], [403, null], [401, null],
    ]);
    expect([
      await t.action(api.desktop.fileLink, { token: "friend", streamId }),
      await t.action(api.desktop.fileLink, { token: "stranger", streamId }),
    ]).toEqual([M3U8, null]);
  });

  test("a link on the host of an addon whose link holds its settings stays with the host's account", async () => {
    const { t, roomId, streamId, streamOf, playlist } = await party("https://cdn.invalid/settings-abc123");
    expect((await streamOf(roomId)).direct).toEqual({ link: M3U8, container: "hls", audio: [] });
    expect((await t.query(api.rooms.get, { token: "friend", roomId }))!.stream!.ownFile).toBe(false);
    expect([await playlist("me"), await playlist("friend")]).toEqual([[302, M3U8], [403, null]]);
    expect(await t.action(api.desktop.fileLink, { token: "friend", streamId })).toBe(null);
  });

  test("someone who left stops getting it", async () => {
    const { t, friend, playlist } = await party();
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("roomMembers").withIndex("by_profile", (q) => q.eq("profileId", friend)).unique())!;
      await ctx.db.patch(row._id, { left: true, swept: false });
    });
    expect(await playlist("friend")).toEqual([403, null]);
  });
});

describe("HLS links", () => {
  test("are known by their type or their .m3u8", () => {
    expect([
      containerOf("application/vnd.apple.mpegurl"),
      containerOf("application/x-mpegURL"),
      containerOf(null, "https://cdn.invalid/live/index.m3u8?token=x"),
      containerOf("video/mp4", "https://cdn.invalid/a.m3u8"),
    ]).toEqual(["hls", "hls", "hls", "mp4"]);
  });
});
