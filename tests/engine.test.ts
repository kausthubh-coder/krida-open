/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import schema from "../convex/schema";
import { sourceKey } from "../convex/lib/rank";
import { sha256 } from "../convex/lib/auth";
import { SlowSource, SourceError } from "../convex/lib/providers";
import { whyNoneStarted } from "../convex/engine";
import { listKey } from "../convex/sources";
import { originFrom } from "../convex/lib/addons";

const modules = import.meta.glob(["../convex/**/*.ts", "../convex/**/*.js", "!../convex/**/*.d.ts"]);
const videoId = "tt123:1:2";
const media = { type: "series" as const, imdbId: "tt123", videoId, season: 1, episode: 2, name: "Example" };
const item = (n: number) => ({
  url: `https://addon.invalid/play/${n}`,
  name: "⚡Addon 1080p",
  description: "",
  filename: `Example.S01E02.Copy${n}.1080p.mkv`,
  size: (n + 1) * 1e9,
});
const fetched: string[] = [];
/** The account the fixture's host is in, whose TorBox the streams belong to. */
let accountId: Id<"accounts"> | undefined;

/** The stream addon the fixture's host has installed. */
const STREAMS = "https://streams.invalid";
const streamManifest = (name = "Test streams") => ({
  id: `test.${name}`, name, version: "1.0.0", types: ["movie", "series"], resources: [{ name: "stream", types: ["movie", "series"], idPrefixes: ["tt"] }], catalogs: [],
});
const installStreams = (ctx: { db: any }, profileId: Id<"profiles">, url = STREAMS, name?: string) =>
  ctx.db.insert("addons", { profileId, url, manifest: streamManifest(name), enabled: true, order: url === STREAMS ? 0 : 1, installedAt: Date.now() });
/** The key of a list found by the fixture's host: its account and its one stream addon. */
const keyFor = (type: string, id: string) =>
  listKey(type, id, originFrom(accountId, [{ url: STREAMS, enabled: true, manifest: streamManifest() } as unknown as Doc<"addons">]).scope);

beforeEach(() => {
  fetched.length = 0;
  accountId = undefined;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  // Every source fails, so a test sees which ones were tried and in what order.
  vi.stubGlobal("fetch", async (url: string | URL) => {
    fetched.push(String(url));
    return new Response("{}", { status: 500 });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** The host account's debrid key; null for none. */
type Debrid = { service: "torbox" | "realdebrid"; key: string } | null;

async function fixture(audioLang = "eng", items = [item(0), item(1)], debrid: Debrid = { service: "torbox", key: "fake-key" }) {
  const t = convexTest(schema, modules);
  const roomId = await t.run(async (ctx) => {
    accountId = await ctx.db.insert("accounts", { name: "Engine", createdAt: Date.now() });
    await ctx.db.insert("accountKeys", { accountId, debrid: debrid ?? undefined, updatedAt: Date.now() });
    const profileId = await ctx.db.insert("profiles", {
      name: "Engine test", hue: 145, passwordHash: "unused", salt: "unused", order: 0,
      failedAttempts: 0, prefs: { audioLang, sounds: false }, accountId,
    });
    // Sources come from this addon (its lists are put in place by each test).
    await installStreams(ctx, profileId);
    const now = Date.now();
    return await ctx.db.insert("rooms", {
      hostId: profileId, kind: "solo", media, status: "preparing", requestedBy: profileId, jobId: 1,
      playback: { playing: false, position: 0, anchorAt: now, seq: 0 }, createdAt: now, lastActiveAt: now,
    });
  });
  const file = await t.run(async (ctx) => await ctx.storage.store(new Blob([JSON.stringify(items)])));
  await t.mutation(internal.sources.putList, { key: keyFor("series", videoId), file });
  const hostId = (await t.run(async (ctx) => await ctx.db.get(roomId)))!.hostId;
  return { t, roomId, hostId };
}

const room = (t: ReturnType<typeof convexTest>, roomId: Id<"rooms">) => t.run(async (ctx) => await ctx.db.get(roomId));
const tried = () => fetched.filter((u) => u.startsWith("https://addon.invalid/")).map((u) => Number(u.split("/").pop()));
const streamFor = (rankedFor?: string) => ({
  torrentId: 1, fileId: 1, presignedToken: "unused", domain: "https://unused.invalid", audios: [],
  videoId, sourceIndex: 0, rankedFor, createdAt: Date.now(), accountId,
});

describe("a picked source", () => {
  test("a failed 4K copy offers 1080p without silently downgrading", async () => {
    const fourK = { ...item(0), name: "⚡Addon 2160p", filename: "Example.S01E02.2160p.mkv" };
    const hd = item(1);
    const { t, roomId } = await fixture("eng", [fourK, hd]);
    vi.stubGlobal("fetch", async (input: string | URL) => {
      fetched.push(String(input));
      return new Response(null, { status: 404 });
    });
    await t.action(internal.engine.prepare, { roomId, jobId: 1, index: 0, key: sourceKey(fourK), startAt: 0 });
    expect(tried()).toEqual([0]);
    expect(await room(t, roomId)).toMatchObject({
      status: "error",
      error: "That copy had a broken link.",
      errorDetail: "addon.invalid answered 404",
      sourceFallback: { index: 1, key: sourceKey(hd), resolution: "1080p" },
    });
  });

  test("a 404 retries the same file through another provider and keeps the position", async () => {
    const first = { ...item(0), filename: "Example S01E02 1080p WEB DL", size: 2e9 };
    const second = { ...item(1), filename: "Example.S01E02.1080p.WEB-DL.mkv", size: 2e9 };
    const { t, roomId } = await fixture("eng", [first, second]);
    await t.run(async ctx => { await ctx.db.patch(roomId, { playback: { playing: false, position: 72, anchorAt: Date.now(), seq: 1 } }); });
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = String(input);
      fetched.push(url);
      if (url === first.url) return new Response(null, { status: 404 });
      if (url === second.url) return new Response(null, { status: 302, headers: { location: "https://api.torbox.app/v1/api/torrents/requestdl?torrent_id=9&file_id=3" } });
      if (url.includes("/stream/createstream")) return Response.json({ success: true, data: { presigned_token: "fresh", domain: "https://cdn.invalid", metadata: {} } });
      return new Response(null, { status: 404 });
    });
    await t.action(internal.engine.prepare, { roomId, jobId: 1, index: 0, key: sourceKey(first), startAt: 72 });
    const after = await room(t, roomId);
    expect(after?.status).toBe("ready");
    expect(after?.playback.position).toBe(72);
    const stream = await t.run(async ctx => await ctx.db.query("streams").unique());
    expect([stream?.torrentId, stream?.fileId, stream?.sourceIndex]).toEqual([9, 3, 1]);
    // The next request skips only the broken provider.
    await t.run(async ctx => { await ctx.db.patch(roomId, { jobId: 2, status: "preparing" }); });
    fetched.length = 0;
    await t.action(internal.engine.prepare, { roomId, jobId: 2, index: 0, key: sourceKey(first), startAt: 72 });
    expect(tried()).toEqual([1]);
    expect((await room(t, roomId))?.status).toBe("ready");
  });

  test("is found by its key after the list comes back in another order", async () => {
    const { t, roomId } = await fixture("eng", [item(1), item(0)]);
    await t.action(internal.engine.prepare, { roomId, jobId: 1, index: 0, key: sourceKey(item(0)), startAt: 0 });
    expect(tried()[0]).toBe(0);
    expect((await room(t, roomId))?.status).toBe("error");
  });

  test("that is no longer listed fails instead of playing whatever took its place", async () => {
    const { t, roomId } = await fixture();
    await t.action(internal.engine.prepare, { roomId, jobId: 1, index: 0, key: sourceKey(item(7)), startAt: 0 });
    expect(tried()).toEqual([]);
    expect((await room(t, roomId))?.error).toMatch(/isn’t listed anymore/);
  });

  test("from an older tab, by position only, still plays that position", async () => {
    const { t, roomId } = await fixture();
    await t.action(internal.engine.prepare, { roomId, jobId: 1, index: 1, startAt: 0 });
    expect(tried()).toEqual([1]);
  });
});

describe("prepared streams", () => {
  test("start at once for the same languages", async () => {
    const { t, roomId } = await fixture("eng");
    const streamId = await t.run(async (ctx) => await ctx.db.insert("streams", streamFor("eng|")));
    await t.action(internal.engine.prepare, { roomId, jobId: 1, startAt: 0 });
    expect(tried()).toEqual([]);
    expect((await room(t, roomId))?.streamId).toBe(streamId);
  });

  test("ranked for other languages, or none, are not reused", async () => {
    const { t, roomId } = await fixture("jpn");
    await t.run(async (ctx) => {
      await ctx.db.insert("streams", streamFor("eng|"));
      await ctx.db.insert("streams", streamFor(undefined));
    });
    await t.action(internal.engine.prepare, { roomId, jobId: 1, startAt: 0 });
    expect(tried()).toEqual([0, 1]);
    expect((await room(t, roomId))?.status).toBe("error");
  });

  test("files that look like another episode are still tried when nothing else is listed", async () => {
    const other = (n: number) => ({ ...item(n), filename: `Example.S01E05.Copy${n}.1080p.mkv` });
    const { t, roomId } = await fixture("eng", [other(0), other(1)]);
    await t.action(internal.engine.prepare, { roomId, jobId: 1, startAt: 0 });
    expect(tried()).toEqual([0, 1]);
  });
});

describe("the screen", () => {
  const sdrFile = { ...item(0), filename: "Example.S01E02.1080p.WEB-DL.x264.mkv" };
  const hdrFile = { ...item(1), name: "⚡Addon 2160p", filename: "Example.S01E02.2160p.WEB-DL.HDR.x265.mkv" };

  test("an SDR screen tries the SDR copy first, an HDR one the HDR file", async () => {
    const sdr = await fixture("eng", [hdrFile, sdrFile]);
    await sdr.t.action(internal.engine.prepare, { roomId: sdr.roomId, jobId: 1, startAt: 0, screen: "sdr" });
    // `tried` reports each file's URL number: the SDR file is /0, the HDR one /1.
    expect(tried()[0]).toBe(0);
    fetched.length = 0;
    const hdr = await fixture("eng", [hdrFile, sdrFile]);
    await hdr.t.action(internal.engine.prepare, { roomId: hdr.roomId, jobId: 1, startAt: 0, screen: "hdr" });
    expect(tried()[0]).toBe(1);
  });

  test("a stream prepared for one kind of screen isn't handed to the other", async () => {
    const { t, roomId } = await fixture("eng");
    const forHdr = await t.run(async (ctx) => await ctx.db.insert("streams", streamFor("eng|#hdr")));
    await t.action(internal.engine.prepare, { roomId, jobId: 1, startAt: 0, screen: "sdr" });
    expect(tried()).toEqual([0, 1]);
    expect((await room(t, roomId))?.streamId).toBeUndefined();
    const forSdr = await t.run(async (ctx) => await ctx.db.insert("streams", streamFor("eng|#sdr")));
    await t.run(async (ctx) => { await ctx.db.patch(roomId, { jobId: 2, status: "preparing" }); });
    fetched.length = 0;
    await t.action(internal.engine.prepare, { roomId, jobId: 2, startAt: 0, screen: "sdr" });
    expect(tried()).toEqual([]);
    expect((await room(t, roomId))?.streamId).toBe(forSdr);
    expect(forHdr).not.toBe(forSdr);
  });
});

describe("streams from earlier", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const torbox = (ok: boolean) => {
    vi.stubGlobal("fetch", async (url: string | URL) => {
      fetched.push(String(url));
      if (ok && String(url).includes("/stream/createstream"))
        return Response.json({ success: true, data: {
          presigned_token: "fresh", domain: "https://cdn.invalid",
          metadata: { subtitles: [{ index: 2, codec: "ass", language: "eng", title: "Full" }, { index: 3, codec: "ass", language: "eng", title: "Signs" }] },
        } });
      return new Response("{}", { status: 500 });
    });
  };
  const earlier = (t: ReturnType<typeof convexTest>, age: number) =>
    t.run(async (ctx) => await ctx.db.insert("streams", { ...streamFor("eng|"), torrentId: 5, fileId: 6, createdAt: Date.now() - age }));

  test("restart the same file with one TorBox call instead of searching again", async () => {
    torbox(true);
    const { t, roomId } = await fixture("eng");
    const streamId = await earlier(t, 2 * DAY);
    await t.action(internal.engine.prepare, { roomId, jobId: 1, startAt: 0 });
    expect(tried()).toEqual([]);
    expect(fetched.filter((u) => u.includes("/stream/createstream"))).toEqual([
      expect.stringContaining("id=5&file_id=6"),
    ]);
    expect((await room(t, roomId))?.streamId).toBe(streamId);
    const stream = await t.run(async (ctx) => await ctx.db.get(streamId));
    expect(stream?.presignedToken).toBe("fresh");
    expect(Date.now() - stream!.createdAt).toBeLessThan(DAY);
    // Streams prepared before the file's subtitles were kept get them now.
    expect(stream?.subtitles).toEqual([
      { language: "eng", title: "Full", codec: "ass" },
      { language: "eng", title: "Signs", codec: "ass" },
    ]);
  });

  test("whose file TorBox no longer has are found again", async () => {
    torbox(false);
    const { t, roomId } = await fixture("eng");
    await earlier(t, 2 * DAY);
    await t.action(internal.engine.prepare, { roomId, jobId: 1, startAt: 0 });
    expect(tried()).toEqual([0, 1]);
  });

  test("not started in a month are swept and not restarted", async () => {
    const t = convexTest(schema, modules);
    const old = await earlier(t, 31 * DAY);
    const recent = await earlier(t, 2 * DAY);
    const claim = await t.mutation(internal.engine.claimBuild, { videoId, rankedFor: "eng|" });
    expect(claim.earlier?._id).toBe(recent);
    await t.mutation(internal.engine.sweep, {});
    const left = await t.run(async (ctx) => (await ctx.db.query("streams").collect()).map((s) => s._id));
    expect(left).toEqual([recent]);
    expect(left).not.toContain(old);
  });
});

describe("the next episode", () => {
  // AIOStreams tags each stream "addon|resolution|quality|release group"; the tag is the same on every episode.
  const tagged = (n: number, episode: number, group: string) => ({
    url: `https://addon.invalid/play/${n}`,
    name: "⚡Addon 1080p",
    description: "",
    behaviorHints: { filename: `Example.S01E0${episode}.Copy${n}.1080p-${group}.mkv`, videoSize: (n + 1) * 1e9, bingeGroup: `aio|1080p|WEB-DL|${group}` },
  });
  const episode3 = { ...media, videoId: "tt123:1:3", episode: 3 };
  // Every copy plays: AIOStreams lists episode 3, and each addon link leads to a TorBox file.
  const playable = () => {
    vi.stubGlobal("fetch", async (url: string | URL) => {
      const u = String(url);
      fetched.push(u);
      if (u.endsWith("/api/v1/user")) return Response.json({ data: { encryptedPassword: "enc" } });
      if (u.includes("/stream/series/tt123%3A1%3A3.json"))
        return Response.json({ streams: [tagged(0, 3, "XEBEC"), tagged(1, 3, "NTb")] });
      if (u.startsWith("https://addon.invalid/play/"))
        return new Response(null, { status: 302, headers: { location: `https://api.torbox.app/v1/api/dl?torrent_id=9&file_id=${u.split("/").pop()}` } });
      if (u.includes("/stream/createstream"))
        return Response.json({ success: true, data: { presigned_token: "fresh", domain: "https://cdn.invalid", metadata: {} } });
      return new Response("{}", { status: 500 });
    });
  };
  const next = async (t: ReturnType<typeof convexTest>, roomId: Id<"rooms">, jobId: number) => {
    await t.run(async (ctx) => { await ctx.db.patch(roomId, { media: episode3, jobId, status: "preparing" }); });
    fetched.length = 0;
    await t.action(internal.engine.prepare, { roomId, jobId, startAt: 0 });
  };

  test("plays a copy from the release group someone picked on the episode before", async () => {
    playable();
    const ep2 = [tagged(0, 2, "XEBEC"), tagged(1, 2, "NTb")].map(({ behaviorHints: { filename, videoSize, bingeGroup }, ...rest }) =>
      ({ ...rest, filename, size: videoSize, bingeGroup }));
    const { t, roomId } = await fixture("eng", ep2);
    // Krida's pick is the XEBEC copy (/0); the person picks NTb (/1) instead.
    await t.action(internal.engine.prepare, { roomId, jobId: 1, index: 1, key: sourceKey(ep2[1]), startAt: 0 });
    expect(await room(t, roomId)).toMatchObject({ status: "ready", binge: { show: "tt123", group: "aio|1080p|WEB-DL|NTb" } });
    await next(t, roomId, 2);
    expect(tried()).toEqual([1]);
    expect(await room(t, roomId)).toMatchObject({
      status: "ready",
      source: { bingeGroup: "aio|1080p|WEB-DL|NTb", filename: "Example.S01E03.Copy1.1080p-NTb.mkv" },
      // Krida's own pick for episode 3 leaves the choice in place for episode 4.
      binge: { show: "tt123", group: "aio|1080p|WEB-DL|NTb" },
    });
  });

  test("without a pick, or with a group this list lacks, Krida's own pick plays", async () => {
    playable();
    const { t, roomId } = await fixture("eng");
    await next(t, roomId, 2);
    expect(tried()).toEqual([0]);
    await t.run(async (ctx) => { await ctx.db.patch(roomId, { binge: { show: "tt123", group: "aio|1080p|WEB-DL|FLUX" } }); });
    await next(t, roomId, 3);
    expect(tried()).toEqual([0]);
  });

  test("a group picked on another show isn't used", async () => {
    playable();
    const { t, roomId } = await fixture("eng");
    await t.run(async (ctx) => { await ctx.db.patch(roomId, { binge: { show: "tt999", group: "aio|1080p|WEB-DL|NTb" } }); });
    await next(t, roomId, 2);
    expect(tried()).toEqual([0]);
  });

  test("picking a copy with no group lets Krida pick again", async () => {
    playable();
    const { t, roomId } = await fixture("eng");
    await t.run(async (ctx) => { await ctx.db.patch(roomId, { binge: { show: "tt123", group: "aio|1080p|WEB-DL|NTb" } }); });
    await t.action(internal.engine.prepare, { roomId, jobId: 1, index: 1, key: sourceKey(item(1)), startAt: 0 });
    const after = await room(t, roomId);
    expect(after?.status).toBe("ready");
    expect(after?.binge).toBeUndefined();
  });
});

describe("builds in flight", () => {
  test("one claim at a time per episode and languages; a dead one expires", async () => {
    const t = convexTest(schema, modules);
    const key = { videoId, rankedFor: "eng|" };
    const first = await t.mutation(internal.engine.claimBuild, key);
    expect(first).toMatchObject({ claimed: true });
    expect(await t.mutation(internal.engine.claimBuild, key)).toMatchObject({ claimed: false, stream: null });
    expect(await t.mutation(internal.engine.claimBuild, { videoId, rankedFor: "" })).toMatchObject({ claimed: true });
    await t.mutation(internal.engine.releaseBuild, { ...key, claimId: first.claimId! });
    expect(await t.mutation(internal.engine.claimBuild, key)).toMatchObject({ claimed: true });
    await t.run(async (ctx) => {
      for (const b of await ctx.db.query("streamBuilds").collect()) await ctx.db.patch(b._id, { startedAt: 0 });
    });
    expect(await t.mutation(internal.engine.claimBuild, key)).toMatchObject({ claimed: true });
  });

  test("an expired build cannot release its replacement's claim", async () => {
    const t = convexTest(schema, modules);
    const key = { videoId, rankedFor: "eng|" };
    const first = await t.mutation(internal.engine.claimBuild, key);
    await t.run(async (ctx) => { await ctx.db.patch(first.claimId!, { startedAt: 0 }); });
    const replacement = await t.mutation(internal.engine.claimBuild, key);
    await t.mutation(internal.engine.releaseBuild, { ...key, claimId: first.claimId! });
    expect(await t.mutation(internal.engine.claimBuild, key)).toMatchObject({ claimed: false });
    expect(await t.run(async (ctx) => await ctx.db.get(replacement.claimId!))).not.toBeNull();
  });

  test("a warm-up leaves a build already under way alone", async () => {
    const { t, hostId } = await fixture();
    const claim = await t.mutation(internal.engine.claimBuild, { videoId, rankedFor: "", accountId });
    await t.action(internal.engine.warm, { media, keysFrom: hostId });
    expect(fetched).toEqual([]);
    // With nothing under way it builds, and lets go of its claim when done.
    await t.mutation(internal.engine.releaseBuild, { videoId, rankedFor: "", claimId: claim.claimId!, accountId });
    await t.action(internal.engine.warm, { media, keysFrom: hostId });
    expect(tried()).toEqual([0, 1]);
    expect(await t.run(async (ctx) => await ctx.db.query("streamBuilds").collect())).toEqual([]);
  });
});

describe("a build under way", () => {
  test("a Play waiting on it shows the step it has reached", async () => {
    const { t, roomId } = await fixture("");
    const claim = await t.mutation(internal.engine.claimBuild, { videoId, rankedFor: "", accountId });
    await t.mutation(internal.engine.buildStep, { claimId: claim.claimId!, step: "Adding to TorBox…" });
    const prepare = t.action(internal.engine.prepare, { roomId, jobId: 1, startAt: 0 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await room(t, roomId))?.step).toBe("Adding to TorBox…");
    // When the warm-up lets go without a stream, the Play builds for itself.
    await t.mutation(internal.engine.releaseBuild, { videoId, rankedFor: "", claimId: claim.claimId!, accountId });
    await prepare;
    expect(tried()).toEqual([0, 1]);
  });
});

describe("a slow copy", () => {
  // The first copy's service holds its redirect, as StremThru did for a minute while adding a file to TorBox; the
  // second answers at once.
  const stub = (secondHangs = false) => {
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      fetched.push(String(url));
      if (String(url) === "https://addon.invalid/play/0" || (secondHangs && String(url) === "https://addon.invalid/play/1"))
        return await new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
      if (String(url) === "https://addon.invalid/play/1")
        return new Response(null, { status: 302, headers: { location: "https://api.torbox.app/v1/api/dl?torrent_id=9&file_id=3" } });
      if (String(url).includes("/stream/createstream"))
        return Response.json({ success: true, data: { presigned_token: "fresh", domain: "https://cdn.invalid", metadata: {} } });
      return new Response("{}", { status: 500 });
    });
  };
  const logs = (t: ReturnType<typeof convexTest>) =>
    t.run(async (ctx) => (await ctx.db.query("clientLogs").collect()).map(({ kind, message, page, platform }) => ({ kind, message, page, platform })));

  test("is given up on after 15 s, the next copy plays, and the slow service is logged", async () => {
    stub();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true });
    const { t, roomId } = await fixture();
    const prepare = t.action(internal.engine.prepare, { roomId, jobId: 1, startAt: 0 });
    await vi.advanceTimersByTimeAsync(14_000);
    expect(tried()).toEqual([0]);
    expect((await room(t, roomId))?.stepNote).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2_000);
    await prepare;
    vi.useRealTimers();
    expect(tried()).toEqual([0, 1]);
    const after = await room(t, roomId);
    expect(after?.status).toBe("ready");
    const stream = await t.run(async (ctx) => await ctx.db.query("streams").unique());
    expect(stream?._id).toBe(after?.streamId);
    expect([stream?.torrentId, stream?.fileId, stream?.sourceIndex]).toEqual([9, 3, 1]);
    expect(await logs(t)).toEqual([
      { kind: "source", message: "addon.invalid took 15 s to reach TorBox", page: videoId, platform: "server" },
    ]);
  });

  test("while it's trying the next copy, the loading screen says why", async () => {
    stub(true);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true });
    const { t, roomId } = await fixture();
    const prepare = t.action(internal.engine.prepare, { roomId, jobId: 1, startAt: 0 });
    await vi.advanceTimersByTimeAsync(16_000);
    const during = await room(t, roomId);
    expect([during?.step, during?.stepNote]).toEqual(["Adding to TorBox…", "That copy was slow. Trying another."]);
    // The last copy has no one to hand over to, so it waits as long as its service takes.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tried()).toEqual([0, 1]);
    expect((await room(t, roomId))?.status).toBe("preparing");
    vi.useRealTimers();
    // Its fetch never answers; the test leaves it waiting.
    void prepare.catch(() => {});
  });
});

describe("source lists", () => {
  const addonAsked = () => fetched.filter((u) => u.startsWith(`${STREAMS}/stream/movie/`)).length;
  const stubAddon = (status = 200) => {
    vi.stubGlobal("fetch", async (url: string | URL) => {
      fetched.push(String(url));
      await new Promise((resolve) => setTimeout(resolve, 300));
      return status === 200 ? Response.json({ streams: [item(0)] }) : new Response("{}", { status });
    });
  };
  /** A session for the fixture's host, or for a new profile with the same stream addon in an account of its own. */
  const signedIn = async (t: ReturnType<typeof convexTest>, host?: Id<"profiles">) => {
    const token = "warm-token";
    const profileId = await t.run(async (ctx) => {
      let id = host;
      if (!id) {
        accountId = await ctx.db.insert("accounts", { name: "Warm", createdAt: Date.now() });
        id = await ctx.db.insert("profiles", {
          name: "Warm test", hue: 145, passwordHash: "unused", salt: "unused", order: 0, failedAttempts: 0, prefs: { audioLang: "eng", sounds: false }, accountId,
        });
        await installStreams(ctx, id);
      }
      await ctx.db.insert("sessions", { profileId: id, tokenHash: await sha256(token), createdAt: Date.now() });
      return id;
    });
    return { token, profileId, listKey: keyFor("movie", "tt999") };
  };

  test("a 404 is unavailable in the picker until its list is refreshed", async () => {
    const { t, roomId, hostId } = await fixture();
    const { token } = await signedIn(t, hostId);
    vi.stubGlobal("fetch", async (input: string | URL) => {
      fetched.push(String(input));
      return new Response(null, { status: 404 });
    });
    await t.action(internal.engine.prepare, { roomId, jobId: 1, index: 0, startAt: 0 });
    const request = { token, type: "series" as const, videoId };
    const failed = await t.action(api.sources.listRanked, request);
    expect(failed.pick).toBe(1);
    expect(failed.options.map(o => [o.index, o.unavailable === true])).toEqual([[0, true], [1, false]]);
    stubAddon();
    const refreshed = await t.action(api.sources.listRanked, { ...request, refresh: true });
    expect(refreshed.pick).toBe(0);
    expect(refreshed.options.map(o => [o.index, o.unavailable === true])).toEqual([[0, false]]);
    expect(JSON.stringify(refreshed)).not.toContain("https://addon.invalid");
  });

  test("are fetched once when a prefetch and a Play ask at the same time", async () => {
    stubAddon();
    const t = convexTest(schema, modules);
    const { profileId, listKey } = await signedIn(t);
    await Promise.all([
      t.action(internal.sources.prefetch, { type: "movie", videoId: "tt999", profileId }),
      t.action(internal.sources.prefetch, { type: "movie", videoId: "tt999", profileId }),
    ]);
    expect(addonAsked()).toBe(1);
    const [items, status] = await t.run(async (ctx) => {
      const list = await ctx.db.query("sourceLists").withIndex("by_key", (q) => q.eq("key", listKey)).unique();
      // The list is a file, so checking it reads a few bytes of the database.
      expect(list?.items).toBeUndefined();
      const blob = list?.file ? await ctx.storage.get(list.file) : null;
      return [blob ? JSON.parse(await blob.text()) : null, await ctx.db.query("sourceFetches").withIndex("by_key", (q) => q.eq("key", listKey)).unique()] as const;
    });
    expect(items).toHaveLength(1);
    expect(status?.fetchingSince).toBeUndefined();
  });

  test("a failed fetch lets go, so the next request tries again at once", async () => {
    stubAddon(503);
    const t = convexTest(schema, modules);
    const { profileId, listKey } = await signedIn(t);
    await t.action(internal.sources.prefetch, { type: "movie", videoId: "tt999", profileId });
    expect(await t.mutation(internal.sources.claimList, { key: listKey })).toHaveProperty("claimedAt");
  });

  test("opening a title fetches only what isn't fresh or already on its way", async () => {
    stubAddon();
    const t = convexTest(schema, modules);
    const { token, profileId, listKey } = await signedIn(t);
    const scheduled = () => t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).length);
    await t.mutation(api.sources.warm, { token, type: "movie", videoId: "tt999" });
    expect(await scheduled()).toBe(1);
    // On its way: a second page open doesn't ask again.
    const claim = await t.mutation(internal.sources.claimList, { key: listKey });
    await t.mutation(api.sources.warm, { token, type: "movie", videoId: "tt999" });
    expect(await scheduled()).toBe(1);
    // Fresh: nor does one after it arrived.
    await t.mutation(internal.sources.releaseList, { key: listKey, ...(claim as { claimedAt: number }) });
    await t.action(internal.sources.prefetch, { type: "movie", videoId: "tt999", profileId });
    await t.mutation(api.sources.warm, { token, type: "movie", videoId: "tt999" });
    expect(await scheduled()).toBe(1);
  });

  test("a profile without a stream addon fetches nothing, and Play says what to install", async () => {
    stubAddon();
    const { t, roomId, hostId } = await fixture();
    await t.run(async (ctx) => {
      for (const a of await ctx.db.query("addons").collect()) await ctx.db.delete(a._id);
    });
    const { token } = await signedIn(t, hostId);
    await t.mutation(api.sources.warm, { token, type: "movie", videoId: "tt999" });
    expect(await t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).length)).toBe(0);
    await t.action(internal.engine.prepare, { roomId, jobId: 1, startAt: 0 });
    expect(fetched).toEqual([]);
    expect((await room(t, roomId))?.error).toBe("Install a stream addon in Settings → Addons to find sources.");
  });
});

describe("old source lists", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const put = (t: ReturnType<typeof convexTest>, key: string, age: number) =>
    t.run(async (ctx) => {
      const fetchedAt = Date.now() - age;
      const file = await ctx.storage.store(new Blob([JSON.stringify([item(0)])]));
      await ctx.db.insert("sourceLists", { key, file, fetchedAt });
      await ctx.db.insert("sourceFetches", { key, fetchedAt });
    });
  const keys = (t: ReturnType<typeof convexTest>) =>
    t.run(async (ctx) => [
      (await ctx.db.query("sourceLists").collect()).map((l) => l.key).sort(),
      (await ctx.db.query("sourceFetches").collect()).map((l) => l.key).sort(),
    ]);

  test("are dropped after two days with their status and their file", async () => {
    const t = convexTest(schema, modules);
    await put(t, "movie:old", 3 * DAY);
    await put(t, "movie:new", DAY);
    const files = () => t.run(async (ctx) => (await ctx.db.system.query("_storage").collect()).length);
    expect(await files()).toBe(2);
    await t.mutation(internal.sources.sweep, {});
    expect(await keys(t)).toEqual([["movie:new"], ["movie:new"]]);
    expect(await files()).toBe(1);
  });

  test("a full batch books the next one", async () => {
    const t = convexTest(schema, modules);
    for (let i = 0; i < 21; i++) await put(t, `movie:old${i}`, 3 * DAY);
    await t.mutation(internal.sources.sweep, {});
    expect((await keys(t))[0]).toHaveLength(1);
    const scheduled = await t.run(async (ctx) => await ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.map((f) => f.name)).toEqual(["sources:sweep"]);
  });
});

describe("when Play fails", () => {
  test("it says how many copies were tried and what went wrong with them", async () => {
    const { t, roomId } = await fixture();
    await t.action(internal.engine.prepare, { roomId, jobId: 1, startAt: 0 });
    expect(tried()).toEqual([0, 1]);
    expect((await room(t, roomId))?.error).toBe("Krida tried 2 copies and all of them had broken links.");
  });

  test("one copy picked by hand says what went wrong with it", async () => {
    const { t, roomId } = await fixture();
    await t.action(internal.engine.prepare, { roomId, jobId: 1, index: 1, startAt: 0 });
    expect((await room(t, roomId))?.error).toBe("That copy had a broken link.");
  });

  test("copies that failed for different reasons are counted by reason, most first", () => {
    const slow = new SlowSource("stremthru.elfhosted.com", 15_000);
    const notCached = new SourceError("This source didn't reach TorBox. It may not be cached.", "notCached");
    const broken = new SourceError("The source answered 404", "brokenLink");
    expect(whyNoneStarted([slow, notCached, slow, broken])).toBe(
      "Krida tried 4 copies: 2 were too slow, 1 wasn’t ready on TorBox and 1 had a broken link.",
    );
  });

  test("when TorBox turned every copy down, it gives TorBox's own words", () => {
    const refused = new SourceError("TorBox: Your plan has hit its download limit.", "torbox");
    expect(whyNoneStarted([refused, refused])).toBe("TorBox: Your plan has hit its download limit.");
  });

  test("the failure goes in the failure log", async () => {
    const { t, roomId } = await fixture();
    await t.action(internal.engine.prepare, { roomId, jobId: 1, index: 1, startAt: 0 });
    const logs = await t.run(async (ctx) => (await ctx.db.query("clientLogs").collect()).map(({ kind, message, page, platform }) => ({ kind, message, page, platform })));
    expect(logs).toEqual([{ kind: "play", message: "That copy had a broken link.", page: videoId, platform: "server" }]);
  });
});

describe("when the addons give no list", () => {
  const rateLimited = () => new Response("{}", { status: 429 });
  const down = () => new Response("Bad gateway", { status: 502 });
  const listed = () => Response.json({ streams: [item(0)] });
  const asked = () => fetched.filter((u) => u.includes("/stream/series/")).length;
  /** The addons answer each list request with the next answer; every source's link fails. */
  const stub = (...answers: (() => Response)[]) => {
    vi.stubGlobal("fetch", async (url: string | URL) => {
      fetched.push(String(url));
      if (String(url).includes("/stream/series/")) return answers.shift()!();
      return new Response("{}", { status: 500 });
    });
  };
  const roomWithoutList = async (olderList?: number) => {
    const { t, roomId } = await fixture();
    await t.run(async (ctx) => {
      for (const l of await ctx.db.query("sourceLists").collect()) await ctx.db.delete(l._id);
      for (const s of await ctx.db.query("sourceFetches").collect()) await ctx.db.delete(s._id);
      if (olderList === undefined) return;
      const file = await ctx.storage.store(new Blob([JSON.stringify([item(0)])]));
      const fetchedAt = Date.now() - olderList;
      await ctx.db.insert("sourceLists", { key: keyFor("series", videoId), file, fetchedAt });
      await ctx.db.insert("sourceFetches", { key: keyFor("series", videoId), fetchedAt });
    });
    return { t, roomId };
  };
  const play = async (t: ReturnType<typeof convexTest>, roomId: Id<"rooms">) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true });
    const prepare = t.action(internal.engine.prepare, { roomId, jobId: 1, startAt: 0 });
    await vi.advanceTimersByTimeAsync(5_000);
    await prepare;
    vi.useRealTimers();
  };

  test("a rate limit asks once more, then says the addon is busy, and isn't kept as an empty list", async () => {
    stub(rateLimited, rateLimited);
    const { t, roomId } = await roomWithoutList();
    await play(t, roomId);
    expect(asked()).toBe(2);
    expect((await room(t, roomId))?.error).toBe("Test streams is busy right now. Try again in a minute.");
    expect(await t.mutation(internal.sources.claimList, { key: keyFor("series", videoId) })).toHaveProperty("claimedAt");
  });

  test("addons that all failed are named", async () => {
    stub(down, down, down, down);
    const { t, roomId, hostId } = await fixture();
    await t.run(async (ctx) => {
      for (const l of await ctx.db.query("sourceLists").collect()) await ctx.db.delete(l._id);
      await installStreams(ctx, hostId, "https://more.invalid", "More streams");
    });
    await play(t, roomId);
    expect(asked()).toBe(4);
    expect((await room(t, roomId))?.error).toBe("Your addons didn’t answer (Test streams, More streams). Try again in a minute.");
  });

  test("one addon failing costs only its own sources", async () => {
    stub(down, listed);
    const { t, roomId, hostId } = await fixture();
    await t.run(async (ctx) => {
      for (const l of await ctx.db.query("sourceLists").collect()) await ctx.db.delete(l._id);
      await installStreams(ctx, hostId, "https://more.invalid", "More streams");
    });
    await play(t, roomId);
    expect(asked()).toBe(2);
    expect(tried()).toEqual([0]);
  });

  test("while it asks again, the loading screen says so, and a second answer is used", async () => {
    stub(down, listed);
    const { t, roomId } = await roomWithoutList();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true });
    const prepare = t.action(internal.engine.prepare, { roomId, jobId: 1, startAt: 0 });
    await vi.advanceTimersByTimeAsync(500);
    const during = await room(t, roomId);
    expect([during?.step, during?.stepNote]).toEqual(["Finding sources…", "Your addons didn’t answer. Asking again…"]);
    await vi.advanceTimersByTimeAsync(5_000);
    await prepare;
    vi.useRealTimers();
    expect(asked()).toBe(2);
    expect(tried()).toEqual([0]);
  });

  test("when it still doesn't answer, the list from earlier is used and the screen says so", async () => {
    stub(down, down);
    const { t, roomId } = await roomWithoutList(3 * 60 * 60 * 1000);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true });
    // The first copy's link hangs, so the screen can be read while it's being tried.
    vi.stubGlobal("fetch", ((inner) => async (url: string | URL, init?: RequestInit) =>
      String(url) === "https://addon.invalid/play/0" ? (fetched.push(String(url)), await new Promise<Response>((resolve) => setTimeout(() => resolve(new Response("{}", { status: 500 })), 2_000))) : inner(url, init))(fetch));
    const prepare = t.action(internal.engine.prepare, { roomId, jobId: 1, startAt: 0 });
    await vi.advanceTimersByTimeAsync(3_000);
    const during = await room(t, roomId);
    expect([during?.step, during?.stepNote]).toEqual(["Adding to TorBox…", "Your addons aren’t answering, so Krida is using the sources they found earlier."]);
    await vi.advanceTimersByTimeAsync(5_000);
    await prepare;
    vi.useRealTimers();
    expect(tried()).toEqual([0]);
    expect((await room(t, roomId))?.error).toBe("That copy had a broken link.");
  });

  test("with no list from earlier, it says the addon isn't answering", async () => {
    stub(down, down);
    const { t, roomId } = await roomWithoutList();
    await play(t, roomId);
    expect((await room(t, roomId))?.error).toBe("Test streams isn’t answering right now. Try again in a few minutes.");
  });
});

describe("whose keys play", () => {
  test("a host without a debrid service hears what to add, and nothing is asked", async () => {
    const { t, roomId } = await fixture("eng", [item(0)], null);
    await t.action(internal.engine.prepare, { roomId, jobId: 1, startAt: 0 });
    expect(fetched).toEqual([]);
    expect((await room(t, roomId))?.error).toBe("Add a debrid service in Settings → Connections to play here.");
  });

  test("TorBox is asked with the host account's key, and the stream is kept in that account", async () => {
    const { t, roomId } = await fixture("eng", [item(0)], { service: "torbox", key: "host-key" });
    const auth: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      fetched.push(url);
      if (url.startsWith("https://addon.invalid/")) return new Response(null, { status: 302, headers: { location: "https://api.torbox.app/v1/api/torrents/requestdl?torrent_id=9&file_id=3" } });
      if (url.includes("introdb")) return new Response("{}", { status: 404 });
      auth.push(new Headers(init?.headers).get("authorization") ?? "");
      return Response.json({ success: true, data: { presigned_token: "p", domain: "https://cdn.invalid", metadata: {} } });
    });
    await t.action(internal.engine.prepare, { roomId, jobId: 1, startAt: 0 });
    expect((await room(t, roomId))?.status).toBe("ready");
    expect(auth).toEqual(["Bearer host-key"]);
    const stream = await t.run(async (ctx) => await ctx.db.query("streams").unique());
    expect(stream?.accountId).toBe(accountId);
  });

  test("a stream prepared in one account isn't handed to another", async () => {
    const { t } = await fixture("eng");
    const mine = await t.run(async (ctx) => await ctx.db.insert("streams", streamFor("eng|")));
    const other = await t.run(async (ctx) => await ctx.db.insert("accounts", { name: "Other", createdAt: Date.now() }));
    const theirs = await t.mutation(internal.engine.claimBuild, { videoId, rankedFor: "eng|", accountId: other });
    expect([theirs.stream, theirs.claimed]).toEqual([null, true]);
    const ours = await t.mutation(internal.engine.claimBuild, { videoId, rankedFor: "eng|", accountId });
    expect(ours.stream?._id).toBe(mine);
  });

  test("sources come from the host's stream addons, kept per account and set of addons", async () => {
    const { t, roomId, hostId } = await fixture("eng", [], { service: "torbox", key: "host-key" });
    await t.run(async (ctx) => {
      for (const l of await ctx.db.query("sourceLists").collect()) await ctx.db.delete(l._id);
      // Doesn't list tt ids, so it isn't asked.
      await ctx.db.insert("addons", {
        profileId: hostId, url: "https://anime.invalid", enabled: true, order: 1, installedAt: Date.now(),
        manifest: { ...streamManifest("Anime only"), resources: [{ name: "stream", types: ["series"], idPrefixes: ["kitsu:"] }] },
      });
      // Turned off, so it isn't asked either.
      await ctx.db.insert("addons", { profileId: hostId, url: "https://off.invalid", enabled: false, order: 2, installedAt: Date.now(), manifest: streamManifest("Off") });
    });
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = String(input);
      fetched.push(url);
      if (url.startsWith(`${STREAMS}/stream/`))
        return Response.json({ streams: [{ name: "Torrentio\n1080p", title: "Example.S01E02.1080p.WEB-DL.mkv\n👤 12 💾 1.5 GB ⚙️ 1337x", url: "https://addon.invalid/play/4", behaviorHints: { filename: "Example.S01E02.1080p.WEB-DL.mkv" } }] });
      return new Response("{}", { status: 500 });
    });
    await t.action(internal.engine.prepare, { roomId, jobId: 1, startAt: 0 });
    expect(fetched.filter((u) => !u.includes("introdb")).slice(0, 2)).toEqual([`${STREAMS}/stream/series/tt123%3A1%3A2.json`, "https://addon.invalid/play/4"]);
    const scope = originFrom(accountId, await t.run(async (ctx) => await ctx.db.query("addons").collect())).scope;
    const keys = await t.run(async (ctx) => (await ctx.db.query("sourceLists").collect()).map((l) => l.key));
    expect(keys).toEqual([`${scope}:series:${videoId}`]);
    // Another set of addons is another list.
    expect(scope).not.toBe(keyFor("series", videoId).split(":")[0]);
  });
});

describe("another debrid service", () => {
  const rd = { service: "realdebrid" as const, key: "rd-key" };
  const mkv = { ...item(0), name: "⚡Torrentio 1080p", filename: "Example.S01E02.1080p.WEB-DL.DTS.x264.mkv" };
  const mp4 = { ...item(1), name: "⚡Torrentio 720p", filename: "Example.S01E02.720p.WEB-DL.AAC.x264.mp4" };
  /** The addon redirects each link to the debrid service's file, which answers one byte as a file does. */
  const debrid = (placeholder = false) =>
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = String(input);
      fetched.push(url);
      const n = url.startsWith("https://addon.invalid/play/") ? url.split("/").pop() : undefined;
      if (n === "0") return new Response(null, { status: 302, headers: { location: placeholder ? "https://addon.invalid/videos/downloading_v2.mp4" : "https://cdn.rd.invalid/d/AB/Example.S01E02.1080p.mkv" } });
      if (n === "1") return new Response(null, { status: 302, headers: { location: "https://cdn.rd.invalid/d/CD/Example.S01E02.720p.mp4" } });
      if (url.startsWith("https://cdn.rd.invalid/")) return new Response("x", { status: 206, headers: { "content-type": "application/octet-stream" } });
      return new Response("{}", { status: 404 });
    });

  test("plays the addon's link as it is, with no TorBox, keeping what the browser needs to know", async () => {
    debrid();
    const { t, roomId } = await fixture("eng", [mkv, mp4], rd);
    await t.action(internal.engine.prepare, { roomId, jobId: 1, startAt: 0, screen: "app" });
    expect((await room(t, roomId))?.status).toBe("ready");
    expect(fetched.filter((u) => u.includes("torbox"))).toEqual([]);
    const stream = await t.run(async (ctx) => await ctx.db.query("streams").unique());
    expect([stream?.direct, stream?.torrentId, stream?.videoCodec, stream?.accountId]).toEqual([
      { link: "https://addon.invalid/play/0", container: "mkv", audio: ["DTS"] },
      undefined,
      "H.264",
      accountId,
    ]);
  });

  test("a browser tries the MP4 copy first; the app keeps Krida's pick", async () => {
    debrid();
    const browser = await fixture("eng", [mkv, mp4], rd);
    await browser.t.action(internal.engine.prepare, { roomId: browser.roomId, jobId: 1, startAt: 0, screen: "sdr" });
    expect(tried()).toEqual([1]);
    fetched.length = 0;
    const app = await fixture("eng", [mkv, mp4], rd);
    await app.t.action(internal.engine.prepare, { roomId: app.roomId, jobId: 1, startAt: 0, screen: "app" });
    expect(tried()).toEqual([0]);
  });

  test("the addon's 'downloading' video isn't played as if it were the film", async () => {
    debrid(true);
    const { t, roomId } = await fixture("eng", [mkv], rd);
    await t.action(internal.engine.prepare, { roomId, jobId: 1, startAt: 0, screen: "app" });
    expect((await room(t, roomId))?.error).toBe("That copy wasn’t ready on your debrid service.");
  });

  test("a torrent has no link to follow without TorBox", async () => {
    debrid();
    const magnet = { ...item(0), url: "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567" };
    const { t, roomId } = await fixture("eng", [magnet], rd);
    await t.action(internal.engine.prepare, { roomId, jobId: 1, startAt: 0, screen: "app" });
    expect((await room(t, roomId))?.error).toBe("That copy was a torrent, which needs TorBox.");
    expect(fetched.filter((u) => !u.includes("introdb"))).toEqual([]);
  });

  test("a direct stream from earlier is checked again rather than restarted on TorBox", async () => {
    debrid();
    const { t, roomId } = await fixture("eng", [mkv], rd);
    await t.run(async (ctx) => {
      await ctx.db.insert("streams", {
        direct: { link: "https://addon.invalid/play/1", container: "mp4" }, audios: [], videoId, sourceIndex: 1, rankedFor: "eng|",
        createdAt: Date.now() - 4 * 60 * 60 * 1000, accountId,
      });
    });
    await t.action(internal.engine.prepare, { roomId, jobId: 1, startAt: 0 });
    expect((await room(t, roomId))?.status).toBe("ready");
    expect(fetched.filter((u) => !u.includes("introdb"))).toEqual(["https://addon.invalid/play/1", "https://cdn.rd.invalid/d/CD/Example.S01E02.720p.mp4"]);
  });
});

describe("an MKV picked in a browser", () => {
  test("isn't started again on its own there, while the app still resumes on it", async () => {
    const { t } = await fixture("eng", [item(0)], { service: "realdebrid", key: "rd" });
    await t.run(async (ctx) => {
      await ctx.db.insert("streams", { direct: { link: "https://addon.invalid/play/0", container: "mkv" }, audios: [], videoId, rankedFor: "eng|#sdr", createdAt: Date.now(), accountId });
    });
    const browser = await t.mutation(internal.engine.claimBuild, { videoId, rankedFor: "eng|#sdr", accountId, playableOnly: true });
    expect([browser.stream, browser.claimed]).toEqual([null, true]);
    await t.run(async (ctx) => {
      for (const b of await ctx.db.query("streamBuilds").collect()) await ctx.db.delete(b._id);
    });
    const app = await t.mutation(internal.engine.claimBuild, { videoId, rankedFor: "eng|#sdr", accountId });
    expect(app.stream?.direct?.container).toBe("mkv");
  });
});

describe("hidden words", () => {
  test("a profile's 'Hide sources containing' leaves those copies out of Krida's pick", async () => {
    const cam = { ...item(0), name: "⚡Addon 1080p", filename: "Example.S01E02.1080p.HDCAM.x264.mkv", size: 5e9 };
    const web = { ...item(1), filename: "Example.S01E02.720p.WEB-DL.x264.mkv" };
    const { t, roomId, hostId } = await fixture("eng", [cam, web]);
    await t.run(async (ctx) => {
      const profile = (await ctx.db.get(hostId))!;
      await ctx.db.patch(hostId, { prefs: { ...profile.prefs, sourceFilter: "CAM | hdcam|TS" } });
    });
    await t.action(internal.engine.prepare, { roomId, jobId: 1, startAt: 0 });
    expect(tried()).toEqual([1]);
  });
});
