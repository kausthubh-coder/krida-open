/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import { sha256 } from "../convex/lib/auth";
import { enqueue } from "../convex/lib/simklOutbox";
import { buildStats } from "../convex/lib/stats";
import type { Doc } from "../convex/_generated/dataModel";

const modules = import.meta.glob(["../convex/**/*.ts", "../convex/**/*.js", "!../convex/**/*.d.ts"]);
const token = "test-session";
const now = Date.parse("2026-10-07T20:00:00Z");
const movie = { id: "tt0047478", type: "movie" as const, name: "Seven Samurai" };

async function fixture() {
  const t = convexTest(schema, modules);
  const profileId = await t.run(async (ctx) => {
    const profileId = await ctx.db.insert("profiles", {
      name: "Test", hue: 145, passwordHash: "unused", salt: "unused", order: 0,
      failedAttempts: 0, prefs: { audioLang: "en", sounds: false },
    });
    await ctx.db.insert("sessions", { profileId, tokenHash: await sha256(token), createdAt: now });
    await ctx.db.insert("connections", {
      profileId, provider: "simkl", accessToken: "fake-token", scope: "media:read media:write", writeBack: true, connectedAt: now,
    });
    return profileId;
  });
  let external = 1;
  const tracked = (extra: Partial<Doc<"tracked">> & { id: string }) => t.run(async (ctx) =>
    await ctx.db.insert("tracked", { profileId, source: "simkl", externalId: external++, type: "movie", name: extra.id, status: "completed", ...extra }));
  const outbox = () => t.run(async (ctx) => await ctx.db.query("syncOutbox").collect());
  return { t, profileId, tracked, outbox };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); vi.stubEnv("SIMKL_CLIENT_ID", "fake-client"); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("to rate", () => {
  test("marking a partially watched movie Done adds it to the rating backlog", async () => {
    const { t } = await fixture();
    await t.mutation(api.progress.save, { token,
      media: { imdbId: movie.id, videoId: movie.id, type: movie.type, name: movie.name },
      position: 1800, duration: 9300 });
    await t.mutation(api.library.setStatus, { token, item: movie, state: "completed" });
    expect((await t.query(api.library.toRate, { token })).items).toMatchObject([{ id: movie.id, status: "completed" }]);
  });

  test("one episode of a show doesn't count; three do; scored titles are done", async () => {
    const { t, tracked } = await fixture();
    await tracked({ id: "tt0386676", type: "series", name: "The Office", status: "watching", watchedEpisodes: 1, totalEpisodes: 195, lastWatchedAt: now - 9 * 86_400_000 });
    await tracked({ id: "tt0460649", type: "series", name: "How I Met Your Mother", status: "watching", watchedEpisodes: 11, totalEpisodes: 208, lastWatchedAt: now - 8 * 86_400_000 });
    await tracked({ id: "kitsu:49136", type: "series", name: "Witch Watch", status: "dropped", watchedEpisodes: 8, totalEpisodes: 25, lastWatchedAt: now - 7 * 86_400_000 });
    await tracked({ id: "tt1049413", name: "Up", lastWatchedAt: now - 86_400_000 });
    await tracked({ id: "tt0816692", name: "Interstellar", rating: 9, lastWatchedAt: now });
    const result = await t.query(api.library.toRate, { token });
    expect(result.items.map((i) => [i.name, i.group])).toEqual([["Up", "recent"], ["Witch Watch", "partway"], ["How I Met Your Mother", "partway"]]);
    expect(result.tooFew).toEqual({ count: 1, names: ["The Office"] });
  });

  test("a day with dozens of titles is grouped as a Simkl import", async () => {
    const { t, tracked } = await fixture();
    const day = Date.parse("2025-05-11T10:00:00Z");
    for (let i = 0; i < 20; i++) await tracked({ id: `tt10000${i}`, name: `Old ${i}`, lastWatchedAt: day + i * 1000 });
    await tracked({ id: "tt1049413", name: "Up", lastWatchedAt: now });
    const result = await t.query(api.library.toRate, { token });
    expect(result.items.filter((i) => i.group === "import")).toHaveLength(20);
    expect(result.items.find((i) => i.name === "Up")!.group).toBe("recent");
    expect(new Date(result.importedOn!).toISOString().slice(0, 10)).toBe("2025-05-11");
  });

  test("a cleared score puts the title back on the list", async () => {
    const { t, tracked } = await fixture();
    await tracked({ id: movie.id, name: movie.name, rating: 8, lastWatchedAt: now });
    await t.mutation(api.ratings.save, { token, item: movie, rating: null });
    expect((await t.query(api.library.toRate, { token })).items.map((i) => i.id)).toEqual([movie.id]);
  });
});

describe("didn't watch it", () => {
  test("corrections clear title, search and poster statuses as well as the Library", async () => {
    const { t, profileId, tracked } = await fixture();
    await tracked({ id: movie.id, name: movie.name, lastWatchedAt: now - 86_400_000 });
    await t.run(async (ctx) => {
      await ctx.db.insert("progress", { profileId,
        media: { imdbId: movie.id, videoId: movie.id, type: "movie", name: movie.name },
        position: 4000, duration: 4000, finished: true, updatedAt: now - 1000 });
      await ctx.db.insert("viewing", { profileId, ...movie, state: "completed", at: now - 1000 });
    });
    await t.mutation(api.library.markUnwatched, { token, item: movie });
    expect((await t.query(api.ratings.details, { token, id: movie.id })).watchStatus).toBeNull();
    const mine = (await t.query(api.library.mine, { token })).find((r) => r.id === movie.id);
    expect(mine?.local).toBeUndefined();
    expect(mine?.tracked).toBeUndefined();
    expect(await t.query(api.progress.started, { token })).toEqual([]);
    expect(await t.query(api.progress.forTitle, { token, imdbId: movie.id })).toEqual([]);
    expect(await t.query(api.simkl.forTitle, { token, id: movie.id })).toBeNull();
    await t.mutation(api.library.restoreWatched, { token, id: movie.id });
    expect((await t.query(api.ratings.details, { token, id: movie.id })).watchStatus).toBe("completed");
    expect(await t.query(api.progress.forTitle, { token, imdbId: movie.id })).toHaveLength(1);
  });

  test("corrections clear shared badges and status until newer playback", async () => {
    const { t, profileId, tracked } = await fixture();
    await tracked({ id: movie.id, lastWatchedAt: now - 86_400_000 });
    await t.run(async (ctx) => {
      await ctx.db.insert("viewing", { profileId, ...movie, state: "completed", at: now - 1000 });
      await ctx.db.insert("progress", { profileId, media: { imdbId: movie.id, videoId: movie.id, type: movie.type, name: movie.name }, position: 10, duration: 100, finished: false, updatedAt: now - 1000 });
    });
    await t.mutation(api.library.markUnwatched, { token, item: movie });
    expect((await t.query(api.library.statusFor, { token, id: movie.id })).state).toBeNull();
    const badge = (await t.query(api.library.mine, { token })).find((r) => r.id === movie.id);
    expect(badge?.local).toBeUndefined();
    expect(badge?.tracked).toBeUndefined();
    expect(await t.query(api.progress.started, { token })).toHaveLength(0);
    expect(await t.query(api.progress.continueWatching, { token })).toHaveLength(0);
    expect((await t.query(api.library.overview, { token })).watched).toHaveLength(0);
    vi.setSystemTime(now + 1000);
    await t.mutation(api.library.setStatus, { token, item: movie, state: "watching" });
    expect((await t.query(api.library.statusFor, { token, id: movie.id })).state).toBe("watching");
    expect((await t.query(api.library.overview, { token })).watching.map((r) => r.id)).toContain(movie.id);
  });

  test("a rejected removal stays visible with a retry warning", async () => {
    const { t, profileId, tracked } = await fixture();
    await tracked({ id: movie.id, lastWatchedAt: now - 86_400_000 });
    await t.mutation(api.library.markUnwatched, { token, item: movie });
    vi.setSystemTime(now + 50_000);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ not_found: { movies: [{ ids: { imdb: movie.id } }] } })));
    await t.action(internal.simkl.flush, { profileId });
    expect(await t.query(api.library.unwatchWarnings, { token })).toMatchObject([{ id: movie.id, error: expect.stringContaining("couldn't remove") }]);
    await t.mutation(api.library.markUnwatched, { token, item: movie });
    expect(await t.query(api.library.unwatchWarnings, { token })).toEqual([]);
  });

  test("hides the title everywhere and asks Simkl to forget it, replacing a pending watch", async () => {
    const { t, profileId, tracked, outbox } = await fixture();
    await tracked({ id: movie.id, name: movie.name, lastWatchedAt: now - 86_400_000 });
    await t.mutation(async (ctx) => await enqueue(ctx, profileId, "watched", movie));
    await t.mutation(api.library.markUnwatched, { token, item: movie });
    const overview = await t.query(api.library.overview, { token, separateStatuses: true });
    expect(overview.watched).toEqual([]);
    expect((await t.query(api.library.toRate, { token })).items).toEqual([]);
    expect(await outbox()).toMatchObject([{ op: "unwatch", key: `unwatch:${movie.id}` }]);
  });

  test("playing a corrected movie starts fresh and can sync completion again", async () => {
    const { t, profileId, outbox } = await fixture();
    const media = { imdbId: movie.id, videoId: movie.id, type: "movie" as const, name: movie.name };
    await t.run(async (ctx) => {
      await ctx.db.insert("progress", { profileId, media, position: 4000, duration: 4000, finished: true, updatedAt: now - 1000 });
      await ctx.db.insert("viewing", { profileId, ...movie, state: "completed", at: now - 1000 });
    });
    await t.mutation(api.library.markUnwatched, { token, item: movie });
    vi.setSystemTime(now + 1000);
    await t.mutation(api.progress.save, { token, media, position: 180, duration: 4000 });
    expect((await t.query(api.ratings.details, { token, id: movie.id })).watchStatus).toBe("watching");
    await t.mutation(api.library.markUnwatched, { token, item: movie });
    vi.setSystemTime(now + 2000);
    await t.mutation(api.progress.save, { token, media, position: 4000, duration: 4000 });
    expect(await outbox()).toMatchObject([{ op: "watched" }]);
  });

  test("correcting local history cancels a queued completion before Simkl sends it", async () => {
    const { t, outbox } = await fixture();
    await t.mutation(api.progress.save, { token,
      media: { imdbId: movie.id, videoId: movie.id, type: "movie", name: movie.name },
      position: 4000, duration: 4000 });
    await t.mutation(api.library.markUnwatched, { token, item: movie });
    expect(await outbox()).toMatchObject([{ op: "unwatch" }]);
    expect(await outbox()).toHaveLength(1);
  });

  test("undo before sending restores it and cancels the Simkl change", async () => {
    const { t, tracked, outbox } = await fixture();
    await tracked({ id: movie.id, name: movie.name, lastWatchedAt: now - 86_400_000 });
    await t.mutation(api.library.markUnwatched, { token, item: movie });
    expect(await t.mutation(api.library.restoreWatched, { token, id: movie.id })).toBe("restored");
    expect(await outbox()).toEqual([]);
    expect((await t.query(api.library.overview, { token, separateStatuses: true })).watched.map((w) => w.id)).toEqual([movie.id]);
  });

  test("it goes to Simkl as a history removal, and undo afterwards says Simkl already has it", async () => {
    const { t, profileId, tracked } = await fixture();
    await tracked({ id: movie.id, name: movie.name, lastWatchedAt: now - 86_400_000 });
    await t.mutation(api.library.markUnwatched, { token, item: movie });
    vi.setSystemTime(now + 50_000);
    let request: { url: string; body: any } | undefined;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => { request = { url: String(url), body: JSON.parse(init.body as string) }; return Response.json({}); }));
    await t.action(internal.simkl.flush, { profileId });
    expect(new URL(request!.url).pathname).toBe("/sync/history/remove");
    expect(request!.body.movies).toMatchObject([{ ids: { imdb: movie.id } }]);
    expect(await t.mutation(api.library.restoreWatched, { token, id: movie.id })).toBe("simkl");
  });

  test("watching it again after saying you didn't brings it back", async () => {
    const { t, tracked } = await fixture();
    await tracked({ id: movie.id, name: movie.name, lastWatchedAt: now - 86_400_000 });
    await t.mutation(api.library.markUnwatched, { token, item: movie });
    await tracked({ id: "tt9", name: "Unrelated" });
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("tracked").collect()).find((r) => r.id === movie.id)!;
      await ctx.db.patch(row._id, { lastWatchedAt: now + 86_400_000 });
    });
    expect((await t.query(api.library.overview, { token, separateStatuses: true })).watched.map((w) => w.id)).toContain(movie.id);
  });

  test("without write-back nothing is sent, and Krida still hides it", async () => {
    const { t, profileId, tracked, outbox } = await fixture();
    await t.run(async (ctx) => { const c = (await ctx.db.query("connections").collect())[0]; await ctx.db.patch(c._id, { writeBack: false }); });
    await tracked({ id: movie.id, name: movie.name, lastWatchedAt: now - 86_400_000 });
    await t.mutation(api.library.markUnwatched, { token, item: movie });
    expect(await outbox()).toEqual([]);
    expect((await t.query(api.library.overview, { token, separateStatuses: true })).watched).toEqual([]);
    void profileId;
  });
});

describe("scores and statuses", () => {
  test.each(["tmdb:603", "mal:5114", "dbl:abc123"])("addon title %s can be saved, rated and given a status", async (id) => {
    const { t, outbox } = await fixture();
    const item = { id, type: "series" as const, name: "Addon title" };
    await t.mutation(api.library.toggle, { token, item: { imdbId: id, type: item.type, name: item.name }, saved: true });
    expect(await t.query(api.library.has, { token, imdbId: id })).toBe(true);
    await t.mutation(api.ratings.save, { token, item, rating: 8 });
    await t.mutation(api.library.setStatus, { token, item, state: "hold" });
    expect(await t.query(api.ratings.details, { token, id })).toMatchObject({ rating: 8, watchStatus: "hold" });
    expect(await outbox()).toEqual([]);
  });

  test.each(["", "../title", "a\\b", "a/b", "a?b", "a#b", "a%2Fb", "a b", "..", "x".repeat(201)])("refuses malformed catalog id %s", async (id) => {
    const { t } = await fixture();
    const item = { ...movie, id };
    await expect(t.mutation(api.library.toggle, { token, item: { imdbId: id, type: item.type, name: item.name }, saved: true })).rejects.toThrow("This title does not have a supported ID yet.");
    await expect(t.mutation(api.ratings.save, { token, item, rating: 8 })).rejects.toThrow("This title does not have a supported ID yet.");
    await expect(t.mutation(api.library.setStatus, { token, item, state: "completed" })).rejects.toThrow("This title does not have a supported ID yet.");
  });

  test("Stremio JSON imports bookmarks, watched movies and resume positions, once", async () => {
    const { t, outbox } = await fixture();
    const items = [
      { _id: "dbl:abc123", type: "movie", name: "Saved", removed: false, state: {} },
      { _id: "tmdb:603", type: "movie", name: "Watched", removed: false, state: { timesWatched: 1, duration: 7200000 } },
      { _id: "tt123", type: "series", name: "Resume", removed: false, state: { video_id: "tt123:2:3", timeOffset: 120000, duration: 2400000 } },
      { _id: "tt9", type: "movie", name: "Removed", removed: true },
      { _id: "yt:1", type: "channel", name: "Channel", removed: false },
    ];
    expect(await t.mutation(api.library.importStremio, { token, items })).toEqual({ added: 3, skipped: 2 });
    expect(await t.mutation(api.library.importStremio, { token, items })).toEqual({ added: 0, skipped: 5 });
    expect(await t.query(api.library.has, { token, imdbId: "dbl:abc123" })).toBe(true);
    expect((await t.query(api.library.statusFor, { token, id: "tmdb:603" })).state).toBe("completed");
    expect((await t.query(api.library.statusFor, { token, id: "tt123" })).state).toBe("watching");
    const rows = await t.run(async ctx => ({
      library: (await ctx.db.query("library").collect()).map(r => [r.imdbId, r.name]),
      viewing: (await ctx.db.query("viewing").collect()).map(r => [r.id, r.state]),
      progress: (await ctx.db.query("progress").collect()).map(r => [r.media.imdbId, r.media.videoId, r.media.season ?? null, r.media.episode ?? null, r.position, r.duration, r.finished]),
    }));
    expect(rows).toEqual({
      library: [["dbl:abc123", "Saved"], ["tmdb:603", "Watched"], ["tt123", "Resume"]],
      viewing: [["dbl:abc123", "plantowatch"], ["tmdb:603", "completed"], ["tt123", "watching"]],
      progress: [["tmdb:603", "tmdb:603", null, null, 7200, 7200, true], ["tt123", "tt123:2:3", 2, 3, 120, 2400, false]],
    });
    expect(await outbox()).toEqual([]);
  });

  test("Stremio import preserves existing ratings, statuses and progress, and requires a session", async () => {
    const { t } = await fixture();
    await t.mutation(api.ratings.save, { token, item: movie, rating: 9 });
    const items = [{ _id: movie.id, type: "movie", name: "Incoming", removed: false, state: { timeOffset: 10000, duration: 100000 } }];
    expect(await t.mutation(api.library.importStremio, { token, items })).toEqual({ added: 0, skipped: 1 });
    expect((await t.query(api.ratings.details, { token, id: movie.id })).rating).toBe(9);
    await expect(t.mutation(api.library.importStremio, { token: "bad", items })).rejects.toThrow("Sign in to continue");
    await expect(t.mutation(api.library.importStremio, { token, items: Array(101).fill(items[0]) })).rejects.toThrow("Import at most 100 library items at a time.");
  });

  test("Stremio preserves an existing resume position and does not mark a partly watched show completed", async () => {
    const { t } = await fixture();
    await t.mutation(api.progress.save, { token, media: { imdbId: "tt42", videoId: "tt42:1:1", type: "series", name: "Local", season: 1, episode: 1 },
      position: 300, duration: 1800 });
    expect(await t.mutation(api.library.importStremio, { token, items: [
      { _id: "tt42", type: "series", name: "Incoming", removed: false, state: { timeOffset: 1200000, duration: 1800000, video_id: "tt42:1:1" } },
      { _id: "mal:5114", type: "series", name: "Partly watched", removed: false, state: { timesWatched: 3 } },
    ] })).toEqual({ added: 1, skipped: 1 });
    expect((await t.query(api.progress.forTitle, { token, imdbId: "tt42" })).map(r => [r.videoId, r.position, r.duration])).toEqual([["tt42:1:1", 300, 1800]]);
    expect((await t.query(api.library.statusFor, { token, id: "mal:5114" })).state).toBe("watching");
  });

  test("Stremio rejects unsafe ids without partially importing the batch", async () => {
    const { t } = await fixture();
    await expect(t.mutation(api.library.importStremio, { token, items: [
      { _id: "dbl:ok", type: "movie", name: "Valid", removed: false },
      { _id: "../bad", type: "movie", name: "Invalid", removed: false },
    ] })).rejects.toThrow("This title does not have a supported ID yet.");
    expect(await t.query(api.library.has, { token, imdbId: "dbl:ok" })).toBe(false);
  });

  test("rating an imported completed title preserves its diary date", async () => {
    const { t, tracked } = await fixture();
    const at = now - 90 * 86_400_000;
    await tracked({ id: movie.id, name: movie.name, lastWatchedAt: at });
    await t.mutation(api.ratings.save, { token, item: movie, rating: 8 });
    expect((await t.query(api.library.overview, { token, separateStatuses: true })).watched[0].at).toBe(at);
    expect(await t.run(async (ctx) => await ctx.db.query("viewing").collect())).toEqual([]);
  });

  test("scoring a show you don't track doesn't put it in Watching", async () => {
    const { t } = await fixture();
    await t.mutation(api.ratings.save, { token, item: { ...movie, type: "series" }, rating: 8 });
    expect((await t.query(api.ratings.details, { token, id: movie.id })).rating).toBe(8);
    expect(await t.run(async (ctx) => await ctx.db.query("viewing").collect())).toEqual([]);
    const overview = await t.query(api.library.overview, { token, separateStatuses: true });
    expect(overview.watching).toEqual([]);
  });

  test("scoring a movie still records it as watched", async () => {
    const { t } = await fixture();
    await t.mutation(api.ratings.save, { token, item: movie, rating: 8 });
    const overview = await t.query(api.library.overview, { token, separateStatuses: true });
    expect(overview.watched).toMatchObject([{ id: movie.id, rating: 8 }]);
  });

  test("Watching carries episodes left for shows near the end", async () => {
    const { t, tracked } = await fixture();
    await tracked({ id: "tt4574334", type: "series", name: "Stranger Things", status: "watching", watchedEpisodes: 39, totalEpisodes: 42, lastWatchedAt: now });
    expect((await t.query(api.library.overview, { token, separateStatuses: true })).watching).toMatchObject([{ id: "tt4574334", left: 3 }]);
  });
});

describe("stats", () => {
  test("correcting history hides the cache and rejects a computation started before the correction", async () => {
    const { t, profileId, tracked } = await fixture();
    const stats = buildStats({ now, titles: [], facts: new Map() });
    await t.mutation(internal.wrapped.save, { profileId, stats, revision: 0 });
    await tracked({ id: movie.id, lastWatchedAt: now - 86_400_000 });
    await t.mutation(api.library.markUnwatched, { token, item: movie });
    expect((await t.query(api.wrapped.get, { token, now })).stats).toBeUndefined();
    await t.mutation(internal.wrapped.save, { profileId, stats, revision: 0 });
    expect((await t.query(api.wrapped.get, { token, now })).stats).toBeUndefined();
    await t.mutation(internal.wrapped.save, { profileId, stats, revision: 1 });
    expect((await t.query(api.wrapped.get, { token, now })).stats).toEqual(stats);
  });

  test("local episodes supplement imported history without presenting a whole show as finished", async () => {
    const { t, profileId, tracked } = await fixture();
    await tracked({ id: "tt12", type: "series", status: "watching", watchedEpisodes: 1, totalEpisodes: 8, watched: "1:1" });
    await t.run(async (ctx) => {
      for (const episode of [1, 2, 3]) await ctx.db.insert("progress", { profileId,
        media: { imdbId: "tt12", videoId: `tt12:1:${episode}`, type: "series", name: "Local show", season: 1, episode },
        position: 2400, duration: 2400, finished: true, updatedAt: now,
      });
    });
    const result = await t.query(api.library.toRate, { token });
    expect(result.items).toMatchObject([{ id: "tt12", status: "watching", group: "partway", watchedEpisodes: 3 }]);
    await t.mutation(api.library.setStatus, { token, item: { id: "tt12", type: "series", name: "Local show" }, state: "plantowatch" });
    expect((await t.query(api.library.toRate, { token })).items).toEqual([]);
  });

  test("compute stores stats the query can read, and opening Stats only recomputes when stale", async () => {
    const { t, profileId, tracked } = await fixture();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ meta: { genres: ["Drama"], cast: ["Toshiro Mifune"], director: ["Akira Kurosawa"], country: "Japan", runtime: "207 min" } })));
    await tracked({ id: movie.id, name: movie.name, rating: 10, lastWatchedAt: Date.parse("2026-03-01T02:00:00Z") });
    await t.action(internal.wrapped.compute, { profileId });
    const got = await t.query(api.wrapped.get, { token, now });
    expect(got.stale).toBe(false);
    expect(got.stats!.periods[0]).toMatchObject({ key: "all", minutes: 207, movies: 1 });
    expect(got.stats!.coverage).toMatchObject({ titles: 1, factsFor: 1 });
    await t.mutation(api.wrapped.refreshSoon, { token });
    expect(await t.run(async (ctx) => (await ctx.db.query("wrapped").collect())[0].jobId)).toBeNull();
    // A new time zone changes the clock, so it recomputes.
    await t.mutation(api.wrapped.refreshSoon, { token, timeZone: "America/Chicago" });
    expect(await t.run(async (ctx) => (await ctx.db.query("wrapped").collect())[0])).toMatchObject({ timeZone: "America/Chicago" });
    expect(await t.run(async (ctx) => {
      const { jobId } = (await ctx.db.query("wrapped").collect())[0];
      return jobId && (await ctx.db.system.get(jobId))?.name;
    })).toBe("wrapped:compute");
    expect((await t.query(api.wrapped.get, { token, now: now + 7 * 3_600_000 })).stale).toBe(true);
  });
});

describe("genre filter", () => {
  test("genres come from looked-up facts; the rest are looked up once a minute and then found", async () => {
    const { t } = await fixture();
    await t.run(async (ctx) => { await ctx.db.insert("titleFacts", { id: "tt0816692", genres: ["Sci-Fi", "Drama"], cast: [], director: [], fetchedAt: now }); });
    const first = await t.query(api.library.genres, { token, ids: ["tt0816692", movie.id] });
    expect(first).toEqual({ titles: [{ id: "tt0816692", genres: ["Sci-Fi", "Drama"] }], missing: [movie.id] });

    const fetch = vi.fn(async () => Response.json({ meta: { genres: ["Action", "Drama"], cast: [], director: [] } }));
    vi.stubGlobal("fetch", fetch);
    await t.mutation(api.library.fillGenres, { token, items: [{ id: movie.id, type: movie.type }] });
    // A second ask within the minute schedules nothing.
    await t.mutation(api.library.fillGenres, { token, items: [{ id: movie.id, type: movie.type }] });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await t.query(api.library.genres, { token, ids: [movie.id] })).titles).toEqual([{ id: movie.id, genres: ["Action", "Drama"] }]);
  });
});

describe("playback ticks", () => {
  test("ticks write at most once a minute; pausing keeps the exact spot", async () => {
    const { t } = await fixture();
    const media = { imdbId: movie.id, videoId: movie.id, type: movie.type, name: movie.name };
    const position = async () => (await t.query(api.progress.forTitle, { token, imdbId: movie.id }))[0].position;
    await t.mutation(api.progress.save, { token, media, position: 600, duration: 9300 });
    vi.setSystemTime(now + 15_000);
    await t.mutation(api.progress.save, { token, media, position: 615, duration: 9300 });
    expect(await position()).toBe(600);
    await t.mutation(api.progress.save, { token, media, position: 620, duration: 9300, final: true });
    expect(await position()).toBe(620);
    // A seek is written straight away.
    vi.setSystemTime(now + 20_000);
    await t.mutation(api.progress.save, { token, media, position: 2400, duration: 9300 });
    expect(await position()).toBe(2400);
    vi.setSystemTime(now + 90_000);
    await t.mutation(api.progress.save, { token, media, position: 2470, duration: 9300 });
    expect(await position()).toBe(2470);
  });
});
