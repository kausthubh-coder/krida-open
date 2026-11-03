/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { historyOf } from "../src/data/rows";
import { tasteOf } from "../shared/taste";
import schema from "../convex/schema";
import { sha256 } from "../convex/lib/auth";
import { enqueue } from "../convex/lib/simklOutbox";

const modules = import.meta.glob(["../convex/**/*.ts", "../convex/**/*.js", "!../convex/**/*.d.ts"]);
const movie = { id: "tt0047478", type: "movie" as const, name: "Seven Samurai" };
const token = "test-session";
const now = Date.parse("2026-10-07T20:00:00Z");

async function fixture() {
  const t = convexTest(schema, modules);
  const { profileId, connectionId } = await t.run(async (ctx) => {
    const profileId = await ctx.db.insert("profiles", {
      name: "Test", hue: 145, passwordHash: "unused", salt: "unused", order: 0,
      failedAttempts: 0, prefs: { audioLang: "en", sounds: false },
    });
    await ctx.db.insert("sessions", { profileId, tokenHash: await sha256(token), createdAt: now });
    const connectionId = await ctx.db.insert("connections", {
      profileId, provider: "simkl", accessToken: "fake-token", scope: "media:read media:write",
      writeBack: true, connectedAt: now,
    });
    return { profileId, connectionId };
  });
  const tracked = async (extra: Partial<import("../convex/_generated/dataModel").Doc<"tracked">> = {}) => t.run(async (ctx) =>
    await ctx.db.insert("tracked", {
      profileId, source: "simkl", externalId: 123, ...movie, status: "completed", ...extra,
    }),
  );
  const rows = () => t.run(async (ctx) => await ctx.db.query("syncOutbox").collect());
  return { t, profileId, connectionId, tracked, rows };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); vi.stubEnv("SIMKL_CLIENT_ID", "fake-client"); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("watch-status menu and library", () => {
  const show = { ...movie, type: "series" as const };
  test.each(["plantowatch", "watching", "completed", "rewatching", "hold", "dropped"] as const)("%s is stored without changing ratings or canonical episodes", async (state) => {
    const { t, tracked, rows } = await fixture();
    await tracked({ type: "series", rating: 8, watched: "1:1-3", watchedEpisodes: 3 });
    await t.mutation(api.library.setStatus, { token, item: show, state });
    const result = await t.query(api.library.statusFor, { token, id: movie.id });
    expect(result).toMatchObject({ state, saved: state === "plantowatch", sync: "on" });
    expect(await t.query(api.simkl.forTitle, { token, id: movie.id })).toMatchObject({ rating: 8, watched: ["1:1", "1:2", "1:3"] });
    const library = await t.query(api.library.overview, { token, separateStatuses: true });
    const section = { plantowatch: "list", watching: "watching", completed: "watched", rewatching: "rewatching", hold: "hold", dropped: "dropped" }[state] as keyof typeof library;
    expect(library[section].map((r) => r.id)).toEqual([movie.id]);
    expect(Object.values(library).flat().filter((r) => r.id === movie.id)).toHaveLength(1);
    const queued = await rows();
    if (state === "rewatching") expect(queued).toEqual([]);
    else expect(queued).toMatchObject([{ op: state === "completed" ? "watched" : "status", item: { status: state } }]);
  });

  test("the newest unsent status wins across plan, completion and dropped, while episode events remain", async () => {
    const { t, profileId, rows } = await fixture();
    await t.run(async (ctx) => { await enqueue(ctx, profileId, "watched", { ...show, season: 1, episode: 3 }); });
    for (const state of ["plantowatch", "completed", "watching", "hold", "dropped"] as const)
      await t.mutation(api.library.setStatus, { token, item: show, state });
    expect(await rows()).toMatchObject([
      { op: "watched", item: { episode: 3 } }, { op: "status", item: { status: "dropped" } },
    ]);
    vi.setSystemTime(now + 50_000);
    const calls: { url: string; body: any }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(init.body as string) }); return Response.json({});
    }));
    const flush = t.action(internal.simkl.flush, { profileId });
    await vi.runAllTimersAsync(); await flush;
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ body: { movies: [], shows: [{ ids: { imdb: movie.id }, to: "dropped" }] } });
    expect(calls[1].url).toContain("/sync/add-to-list");
  });

  test.each(["plantowatch", "dropped", "completed"] as const)("movie %s uses the movie bucket", async (state) => {
    const { t, profileId, rows } = await fixture();
    await t.mutation(api.library.setStatus, { token, item: movie, state });
    vi.setSystemTime(now + 50_000);
    let body: any;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      body = JSON.parse(init.body as string); return Response.json({});
    }));
    await t.action(internal.simkl.flush, { profileId });
    expect(body.movies).toHaveLength(1);
    expect(body.shows).toEqual([]);
    expect(body.movies[0].ids).toEqual({ imdb: movie.id });
    if (state !== "completed") expect(body.movies[0].to).toBe(state);
    expect(await rows()).toEqual([]);
  });

  test.each(["watching", "hold", "rewatching"] as const)("movie %s stays local", async (state) => {
    const { t, tracked, rows } = await fixture();
    await tracked();
    await t.mutation(api.library.setStatus, { token, item: movie, state });
    expect((await t.query(api.library.statusFor, { token, id: movie.id })).state).toBe(state);
    expect(await rows()).toEqual([]);
  });

  test("pending local choices survive a stale pull; accepted choices follow later Simkl changes", async () => {
    const { t, profileId, tracked, rows } = await fixture();
    await tracked({ type: "series", status: "watching", watched: "1:1-3" });
    await t.mutation(api.library.setStatus, { token, item: show, state: "dropped" });
    const pull = (status: "watching" | "hold") => t.mutation(internal.simkl.applyEntries, { profileId,
      entries: [{ ...show, externalId: 123, status, watched: "1:1-3" }] });
    await pull("watching");
    expect((await t.query(api.library.statusFor, { token, id: movie.id })).state).toBe("dropped");
    await t.mutation(internal.simkl.settle, { profileId, sent: (await rows()).map((r) => r._id), retry: [] });
    await pull("hold");
    expect((await t.query(api.library.statusFor, { token, id: movie.id })).state).toBe("hold");
    expect(await t.query(api.library.overview, { token, separateStatuses: true })).toMatchObject({ hold: [{ id: movie.id }], dropped: [] });
  });

  test("an old acknowledgment cannot mark a newer choice synced or attach its warning", async () => {
    const { t, profileId, rows } = await fixture();
    await t.mutation(api.library.setStatus, { token, item: show, state: "hold" });
    vi.setSystemTime(now + 50_000);
    const claimed = await t.mutation(internal.simkl.claimDue, { profileId, now: now + 50_000 });
    await t.mutation(api.library.setStatus, { token, item: show, state: "dropped" });
    await t.mutation(internal.simkl.settle, { profileId, sent: claimed.map((r) => r._id), rejected: claimed.map((r) => r._id), retry: [] });
    const latest = await t.query(api.library.statusFor, { token, id: movie.id });
    expect(latest.state).toBe("dropped");
    expect(latest.syncError).toBeUndefined();
    expect(await rows()).toMatchObject([{ item: { status: "dropped" } }]);
  });

  test("retrying an older claimed completion cannot run after a newer Dropped choice", async () => {
    const { t, profileId } = await fixture();
    await t.mutation(api.library.setStatus, { token, item: show, state: "completed" });
    vi.setSystemTime(now + 50_000);
    const claimed = await t.mutation(internal.simkl.claimDue, { profileId, now: now + 50_000 });
    await t.mutation(internal.simkl.settle, { profileId, sent: [], retry: claimed.map((r) => r._id) });
    vi.setSystemTime(now + 51_000);
    await t.mutation(api.library.setStatus, { token, item: show, state: "dropped" });
    vi.setSystemTime(now + 200_000);
    const next = await t.mutation(internal.simkl.claimDue, { profileId, now: now + 200_000 });
    expect(next).toMatchObject([{ op: "status", item: { status: "dropped" } }]);
    expect(next).toHaveLength(1);
  });

  test("removing an unsent planned title cancels its status write and clears the selection", async () => {
    const { t, rows } = await fixture();
    await t.mutation(api.library.setStatus, { token, item: movie, state: "plantowatch" });
    await t.mutation(api.library.toggle, { token, item: { type: movie.type, name: movie.name, imdbId: movie.id }, saved: false });
    expect(await rows()).toEqual([]);
    expect((await t.query(api.library.statusFor, { token, id: movie.id })).state).toBeNull();
    expect((await t.query(api.library.overview, { token, separateStatuses: true })).list).toEqual([]);
  });

  test("rating an on-hold show preserves its status, and rating-editor status choices update My list", async () => {
    const { t, rows } = await fixture();
    await t.mutation(api.library.setStatus, { token, item: show, state: "hold" });
    await t.mutation(api.ratings.save, { token, item: show, rating: 7 });
    expect((await t.query(api.library.statusFor, { token, id: movie.id })).state).toBe("hold");
    await t.mutation(api.ratings.save, { token, item: show, state: "plantowatch" });
    expect((await t.query(api.library.overview, { token, separateStatuses: true })).list).toMatchObject([{ id: movie.id }]);
    expect((await rows()).filter(r => r.op === "status")).toMatchObject([{ item: { status: "plantowatch" } }]);
  });

  test("finishing a Watching movie moves it to Watched", async () => {
    const { t, rows } = await fixture();
    await t.mutation(api.library.setStatus, { token, item: movie, state: "watching" });
    await t.mutation(api.progress.save, { token, media: { type: movie.type, imdbId: movie.id, videoId: movie.id, name: movie.name }, position: 98, duration: 100 });
    expect(await t.query(api.library.overview, { token, separateStatuses: true })).toMatchObject({ watching: [], watched: [{ id: movie.id }] });
    expect(await rows()).toMatchObject([{ op: "watched", item: { status: "completed" } }]);
  });

  test("rewatch playback preserves canonical episodes and does not send a normal watch event", async () => {
    const { t, tracked, rows } = await fixture();
    await tracked({ type: "series", watched: "1:1-3" });
    await t.mutation(api.library.setStatus, { token, item: show, state: "rewatching" });
    await t.mutation(api.progress.save, { token, media: { type: "series", imdbId: movie.id, videoId: `${movie.id}:1:1`, name: movie.name, season: 1, episode: 1 }, position: 98, duration: 100 });
    expect(await rows()).toEqual([]);
    expect(await t.query(api.simkl.forTitle, { token, id: movie.id })).toMatchObject({ rewatching: true, watched: ["1:1", "1:2", "1:3"] });
  });

  test("imported hold and dropped titles remain visible despite old playback rows", async () => {
    const { t, profileId, tracked } = await fixture();
    await tracked({ type: "series", status: "hold" });
    await t.run(async (ctx) => {
      await ctx.db.insert("progress", { profileId, media: { type: "series", imdbId: movie.id, videoId: `${movie.id}:1:1`, name: movie.name }, position: 20, duration: 100, finished: false, updatedAt: now - 1000 });
    });
    expect(await t.query(api.library.overview, { token, separateStatuses: true })).toMatchObject({ watching: [], hold: [{ id: movie.id }] });
    expect(await t.query(api.library.overview, { token })).toMatchObject({ watching: [{ id: movie.id, note: "On hold" }] });
  });

  test("a rejected status write leaves a visible per-title warning", async () => {
    const { t, profileId } = await fixture();
    await t.mutation(api.library.setStatus, { token, item: show, state: "dropped" });
    vi.setSystemTime(now + 50_000);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ not_found: { shows: [{ ids: { imdb: movie.id } }] } })));
    await t.action(internal.simkl.flush, { profileId });
    expect(await t.query(api.library.statusFor, { token, id: movie.id })).toMatchObject({ state: "dropped", syncError: expect.stringContaining("couldn't match") });
  });

  test("write-back off saves locally, and invalid sessions cannot change status", async () => {
    const { t, connectionId, rows } = await fixture();
    await t.run(async (ctx) => { await ctx.db.patch(connectionId, { writeBack: false }); });
    await t.mutation(api.library.setStatus, { token, item: show, state: "hold" });
    expect(await rows()).toEqual([]);
    expect(await t.query(api.library.statusFor, { token, id: movie.id })).toMatchObject({ state: "hold", sync: "off" });
    await expect(t.mutation(api.library.setStatus, { token: "bad-session", item: show, state: "completed" })).rejects.toThrow("Sign in to continue");
    await expect(t.mutation(api.library.setStatus, { token, item: { ...show, id: "not-an-id" }, state: "completed" })).rejects.toThrow("This title does not have a supported ID yet.");
  });
});

describe("ratings", () => {
  test("the support readback selects the requested title without returning connection credentials", async () => {
    const { t, profileId } = await fixture();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ movies: [
      { movie: { ids: { imdb: "tt0000001" } }, user_rating: 9 },
      { movie: { ids: { imdb: movie.id } }, user_rating: 7 },
    ] })));
    const result = await t.action(internal.simkl.inspect, { profileId, path: "/sync/ratings", id: movie.id });
    expect(result).toMatchObject({ movies: { count: 2, sample: [{ user_rating: 7 }] } });
    expect(JSON.stringify(result)).not.toContain("fake-token");
  });

  test("paged local ratings retain clears and override imported thumbs", async () => {
    const { t, profileId, tracked } = await fixture();
    await tracked({ rating: 10, ratedAt: now - 1000 });
    await t.mutation(api.feedback.set, { token, item: movie, value: null });
    await t.mutation(api.feedback.set, { token, item: { ...movie, id: "tt0000002" }, value: "up" });
    await t.mutation(api.feedback.set, { token, item: { ...movie, id: "tt0000003" }, value: "down" });
    await t.run(async (ctx) => {
      const otherId = await ctx.db.insert("profiles", {
        name: "Other", hue: 200, passwordHash: "unused", salt: "unused", order: 1,
        failedAttempts: 0, prefs: { audioLang: "en", sounds: false },
      });
      await ctx.db.insert("feedback", { profileId: otherId, ...movie, id: "tt0000004", value: "love", at: now });
      expect(otherId).not.toBe(profileId);
    });
    const first = await t.query(api.feedback.mine, {
      token, source: "krida", paginationOpts: { cursor: null, numItems: 1 },
    });
    expect(first.page).toEqual([{ id: movie.id, value: null }]);
    expect(first.isDone).toBe(false);
    const rest = await t.query(api.feedback.mine, {
      token, source: "krida", paginationOpts: { cursor: first.continueCursor, numItems: 10 },
    });
    expect(rest.page).toEqual([{ id: "tt0000002", value: "up" }, { id: "tt0000003", value: "down" }]);
    expect(rest.isDone).toBe(true);
    const imported = await t.query(api.feedback.mine, {
      token, source: "simkl", paginationOpts: { cursor: null, numItems: 10 },
    });
    expect(imported.page).toEqual([{ id: movie.id, value: "love" }]);
    const ratings = new Map([...imported.page, ...first.page, ...rest.page].map((r) => [r.id, r.value]));
    expect(ratings.get(movie.id)).toBeNull();
    expect(ratings.has("tt0000004")).toBe(false);
    await expect(t.query(api.feedback.mine, {
      token: "invalid", source: "krida", paginationOpts: { cursor: null, numItems: 10 },
    })).rejects.toThrow("Sign in to continue");
  });

  test("paged imported ratings omit neutral and unrated titles without losing the cursor", async () => {
    const { t, tracked } = await fixture();
    await tracked({ rating: 5 });
    await tracked({ id: "tt0000002" });
    await tracked({ id: "tt0000003", rating: 7 });
    const first = await t.query(api.feedback.mine, {
      token, source: "simkl", paginationOpts: { cursor: null, numItems: 2 },
    });
    expect(first.page).toEqual([]);
    expect(first.isDone).toBe(false);
    const next = await t.query(api.feedback.mine, {
      token, source: "simkl", paginationOpts: { cursor: first.continueCursor, numItems: 2 },
    });
    expect(next.page).toEqual([{ id: "tt0000003", value: "up" }]);
    expect(next.isDone).toBe(true);
  });

  test("rating several titles books no server work, and notes each score once for the browser's copy", async () => {
    const { t, profileId } = await fixture();
    for (let i = 0; i < 10; i++) {
      await t.mutation(api.feedback.set, { token, item: { ...movie, id: `tt${i + 1000000}` }, value: "up" });
    }
    // Picks are worked out from the browser's copy (lib/recsRefresh.ts), so nothing is scheduled for them here.
    const jobs = await t.run(async (ctx) => await ctx.db.system.query("_scheduled_functions").collect());
    expect(jobs.filter((j) => j.name.includes("recs"))).toEqual([]);
    const changes = await t.run(async (ctx) => await ctx.db.query("changes").collect());
    expect(changes.filter((c) => c.table === "feedback" && c.profileId === profileId)).toHaveLength(10);
  });

  test("Like on a new movie goes to Simkl; Not for me on a new title stays local", async () => {
    const { t, rows } = await fixture();
    await t.mutation(api.feedback.set, { token, item: movie, value: "up" });
    expect(await rows()).toMatchObject([{ op: "rate", item: { rating: 7 } }]);
    await t.mutation(api.feedback.set, { token, item: { ...movie, id: "tt0000002" }, value: "down" });
    expect(await rows()).toHaveLength(1);
  });

  test("a new series is rated without inventing watched episodes", async () => {
    const { t, rows } = await fixture();
    await t.mutation(api.feedback.set, { token, item: { ...movie, type: "series" }, value: "love" });
    const pending = await rows();
    expect(pending).toMatchObject([{ op: "rate", item: { type: "series", rating: 9 } }]);
    expect(pending[0].item.episode).toBeUndefined();
  });

  test("clearing an imported rating stays cleared while removal is pending", async () => {
    const { t, tracked, rows } = await fixture();
    await tracked({ rating: 10, ratedAt: now - 1000 });
    await t.mutation(api.feedback.set, { token, item: movie, value: null });
    expect(await t.query(api.feedback.forTitle, { token, id: movie.id })).toBeNull();
    expect(await rows()).toMatchObject([{ item: { rating: 0 } }]);
    await t.mutation(api.feedback.set, { token, item: movie, value: "love" });
    expect(await rows()).toMatchObject([{ item: { rating: 10 } }]);
  });

  test("Like then clear before sending cannot leave a Like queued", async () => {
    const { t, tracked, rows } = await fixture();
    await tracked();
    await t.mutation(api.feedback.set, { token, item: movie, value: "up" });
    expect((await rows()).map((r) => r.item.rating)).toEqual([7]);
    await t.mutation(api.feedback.set, { token, item: movie, value: null });
    expect((await rows()).map((r) => r.item.rating ?? 0)).toEqual([0]);
  });

  test("an exact Simkl rating in the selected band is kept", async () => {
    const { t, tracked, rows } = await fixture();
    await tracked({ rating: 10, ratedAt: now - 1000 });
    await t.mutation(api.feedback.set, { token, item: movie, value: "love" });
    expect(await t.query(api.feedback.forTitle, { token, id: movie.id })).toBe("love");
    expect(await rows()).toEqual([]);
  });

  test("a newer rating in the first import replaces an older local thumb", async () => {
    const { t, profileId } = await fixture();
    await t.mutation(api.feedback.set, { token, item: movie, value: "down" });
    await t.mutation(internal.simkl.applyEntries, { profileId, entries: [
      { ...movie, externalId: 123, status: "completed", rating: 10, ratedAt: now + 1000 },
    ] });
    expect(await t.query(api.feedback.forTitle, { token, id: movie.id })).toBe("love");
  });

  test("a ratings-only delta preserves episode counts, next episode and watch dates", async () => {
    const { t, profileId, tracked } = await fixture();
    await tracked({ watched: "1:1-3", watchedEpisodes: 3, totalEpisodes: 10, nextSeason: 1,
      nextEpisode: 4, lastWatchedAt: now - 3000, addedAt: now - 4000 });
    await t.mutation(internal.simkl.applyEntries, { profileId, ratingsOnly: true, entries: [
      { ...movie, externalId: 123, status: "completed", rating: 7, ratedAt: now },
    ] });
    const row = await t.run(async (ctx) => await ctx.db.query("tracked").first());
    expect(row).toMatchObject({ watched: "1:1-3", watchedEpisodes: 3, totalEpisodes: 10,
      nextEpisode: 4, lastWatchedAt: now - 3000, addedAt: now - 4000, rating: 7 });
  });

  test("old provider data cannot restore a freshly cleared rating", async () => {
    const { t, profileId, tracked } = await fixture();
    await tracked({ rating: 10, ratedAt: now - 1000 });
    await t.mutation(api.feedback.set, { token, item: movie, value: null });
    await t.mutation(internal.simkl.applyEntries, { profileId, entries: [
      { ...movie, externalId: 123, status: "completed", rating: 10, ratedAt: now - 1000 },
    ] });
    expect(await t.query(api.feedback.forTitle, { token, id: movie.id })).toBeNull();
  });

  test("a ratings-only HTTP pull cannot change the watchlist or tracked status", async () => {
    const { t, profileId, connectionId, tracked } = await fixture();
    const prev = { all: "2026-10-07T19:00:00Z", movies: { rated_at: "2026-10-07T19:00:00Z" } };
    await tracked({ status: "plantowatch" });
    await t.run(async (ctx) => {
      await ctx.db.patch(connectionId, { snapshot: JSON.stringify(prev) });
      await ctx.db.insert("library", { profileId, imdbId: movie.id, type: "movie", name: movie.name,
        source: "simkl", addedAt: now });
    });
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      if (String(url).includes("/sync/activities"))
        return Response.json({ all: "2026-10-07T20:00:00Z", movies: { rated_at: "2026-10-07T20:00:00Z" } });
      return Response.json({ movies: [{ status: "completed", user_rating: 7,
        user_rated_at: "2026-10-07T20:00:00Z", movie: { title: movie.name, ids: { simkl: 123, imdb: movie.id } } }] });
    }));
    await t.action(internal.simkl.sync, { profileId });
    const row = await t.run(async (ctx) => await ctx.db.query("tracked").first());
    expect(row).toMatchObject({ status: "plantowatch", rating: 7 });
    expect(await t.run(async (ctx) => await ctx.db.query("library").collect())).toHaveLength(1);
  });

  test("ratings require a valid profile session", async () => {
    const { t, rows } = await fixture();
    await expect(t.mutation(api.feedback.set, { token: "invalid", item: movie, value: "up" })).rejects.toThrow("Sign in to continue");
    expect(await rows()).toEqual([]);
  });

  test("an unrated first import does not erase an unsynced local preference", async () => {
    const { t, profileId, connectionId } = await fixture();
    await t.run(async (ctx) => await ctx.db.patch(connectionId, { writeBack: false }));
    await t.mutation(api.feedback.set, { token, item: movie, value: "love" });
    await t.mutation(internal.simkl.applyEntries, { profileId, entries: [
      { ...movie, externalId: 123, status: "completed" },
    ] });
    expect(await t.query(api.feedback.forTitle, { token, id: movie.id })).toBe("love");
  });

  test("a later external rating restores a freshly cleared thumb", async () => {
    const { t, profileId, tracked, rows } = await fixture();
    await tracked({ rating: 10, ratedAt: now - 1000 });
    await t.mutation(api.feedback.set, { token, item: movie, value: null });
    await t.mutation(internal.simkl.settle, { profileId, sent: (await rows()).map((r) => r._id), retry: [] });
    await t.mutation(internal.simkl.applyEntries, { profileId, entries: [
      { ...movie, externalId: 123, status: "completed", rating: 7, ratedAt: now + 1000 },
    ] });
    expect(await t.query(api.feedback.forTitle, { token, id: movie.id })).toBe("up");
  });

  test("cleared ratings are not counted as positive recommendation signals", async () => {
    const { t, profileId, tracked } = await fixture();
    await tracked({ rating: 10 });
    await t.mutation(api.feedback.set, { token, item: movie, value: null });
    // The browser's taste (shared/taste.ts) reads the same rows its synced copy holds.
    const tables = await t.run(async (ctx) => {
      const all = async <T extends "tracked" | "viewing" | "library" | "feedback" | "partRatings" | "unwatched" | "progress">(table: T) =>
        (await ctx.db.query(table).collect()).filter((r) => r.profileId === profileId);
      return { tracked: await all("tracked"), viewing: await all("viewing"), library: await all("library"), feedback: await all("feedback"),
        partRatings: await all("partRatings"), unwatched: await all("unwatched"), progress: await all("progress") };
    });
    const history = historyOf(tables);
    expect(history.feedback).toMatchObject([{ id: movie.id, score: null }]);
    expect(tasteOf(history, now).seeds.find((s) => s.id === movie.id)?.loved).toBe(false);
    expect(await t.query(api.feedback.summary, { token })).toMatchObject({ love: 0, up: 0, down: 0 });
    expect(await t.query(api.feedback.starter, { token })).toMatchObject({ rated: 0, fromHistory: 1 });
    expect(await t.query(api.feedback.mine, { token, source: "krida", paginationOpts: { cursor: null, numItems: 200 } }))
      .toMatchObject({ page: [{ id: movie.id, value: null }] });
  });
});

describe("exact and scoped ratings", () => {
  const deathNote = { id: "kitsu:1376", name: "Death Note", type: "series" };
  test.each([
    ["whole anime score and Done", { rating: 10, state: "completed" }, [["rate", { ...deathNote, rating: 10 }], ["watched", { ...deathNote, status: "completed" }]]],
    // Season and episode scores stay in Krida (partRatings); scoring one marks it watched on Simkl.
    ["season score", { rating: 5, season: 1 }, [["watched", { ...deathNote, season: 1 }]]],
    ["episode score", { rating: 8, season: 1, episode: 3 }, [["watched", { ...deathNote, season: 1, episode: 3 }]]],
    ["Watching status", { state: "watching" }, [["status", { ...deathNote, status: "watching" }]]],
  ] as const)("a poster-bearing %s saves with Simkl connected", async (_label, change, queued) => {
    const { t, tracked, rows } = await fixture();
    const item = { id: "kitsu:1376", type: "series" as const, name: "Death Note", poster: "https://example.com/death-note.webp" };
    if ("state" in change && change.state === "watching") await tracked({ ...item, watched: "1:1-37" });
    await t.mutation(api.ratings.save, { token, item, ...change });
    const pending = await rows();
    expect(pending.map((r) => [r.op, r.item])).toEqual(queued);
    for (const row of pending) {
      expect(row.item).toMatchObject({ id: item.id, type: item.type, name: item.name });
      expect(row.item).not.toHaveProperty("poster");
    }
    // A score alone never writes a status.
    if ("state" in change) expect(await t.run(async (ctx) => await ctx.db.query("viewing").first())).toMatchObject({ poster: item.poster });
    else expect(await t.run(async (ctx) => await ctx.db.query("viewing").first())).toBeNull();
    const details = await t.query(api.ratings.details, { token, id: item.id });
    if ("season" in change) expect(details.parts).toMatchObject([{ season: change.season, rating: change.rating }]);
    else if ("rating" in change) expect(details.rating).toBe(change.rating);
    if ("state" in change) expect(details.state).toBe(change.state);
  });

  test("a movie poster remains local while its exact score and watch event are queued", async () => {
    const { t, rows } = await fixture();
    const item = { ...movie, poster: "https://example.com/movie.webp" };
    await t.mutation(api.ratings.save, { token, item, rating: 10 });
    expect(await rows()).toMatchObject([{ op: "rate", item: { rating: 10 } }, { op: "watched" }]);
    for (const row of await rows()) expect(row.item).not.toHaveProperty("poster");
    expect(await t.run(async (ctx) => await ctx.db.query("feedback").first())).toMatchObject({ rating: 10, poster: item.poster });
  });

  test("Death Note's poster-bearing 10/10 and Done reach the sender with valid anime payloads", async () => {
    const { t, profileId, rows } = await fixture();
    const item = { id: "kitsu:1376", type: "series" as const, name: "Death Note", poster: "https://example.com/death-note.webp" };
    await t.mutation(api.ratings.save, { token, item, rating: 10, state: "completed" });
    vi.setSystemTime(now + 50_000);
    const bodies: unknown[] = [];
    let started!: () => void;
    const firstRequest = new Promise<void>((resolve) => { started = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string)); started(); return Response.json({});
    }));
    const flush = t.action(internal.simkl.flush, { profileId });
    await firstRequest;
    await vi.advanceTimersByTimeAsync(1_300);
    await flush;
    expect(bodies).toMatchObject([
      { shows: [{ title: "Death Note", ids: { kitsu: 1376 }, status: "completed" }] },
      { shows: [{ title: "Death Note", ids: { kitsu: 1376 }, rating: 10 }] },
    ]);
    expect(await rows()).toEqual([]);
  });

  test("poster-bearing re-ratings and clears replace queued scores without losing zero", async () => {
    const { t, tracked, rows } = await fixture();
    const item = { ...movie, poster: "https://example.com/movie.webp" };
    await tracked();
    for (const rating of [8, 10, null]) await t.mutation(api.ratings.save, { token, item, rating });
    expect(await rows()).toMatchObject([{ op: "rate", item: { rating: 0 } }]);
    expect((await rows())[0].item).not.toHaveProperty("poster");
    expect(await t.query(api.ratings.details, { token, id: item.id })).toMatchObject({ rating: null });
  });

  test("legacy clients can queue a poster-bearing rating", async () => {
    const { t, rows } = await fixture();
    await t.mutation(api.feedback.set, { token, item: { ...movie, poster: "https://example.com/movie.webp" }, value: "love" });
    expect(await rows()).toMatchObject([{ op: "rate", item: { rating: 9 } }]);
    expect((await rows())[0].item).not.toHaveProperty("poster");
  });

  test.each([1, 5, 8, 10])("a new movie keeps the exact score %i and becomes watched", async (rating) => {
    const { t, rows } = await fixture();
    await t.mutation(api.ratings.save, { token, item: movie, rating });
    expect(await rows()).toEqual(expect.arrayContaining([
      expect.objectContaining({ op: "rate", item: expect.objectContaining({ rating }) }),
      expect.objectContaining({ op: "watched" }),
    ]));
    expect(await t.query(api.ratings.details, { token, id: movie.id })).toMatchObject({ rating, state: "completed" });
    expect(await t.query(api.library.overview, { token })).toMatchObject({ watched: [{ id: movie.id }] });
  });

  test.each([0, 11, 7.5, -1])("invalid score %i leaves no changes", async (rating) => {
    const { t, rows } = await fixture();
    await expect(t.mutation(api.ratings.save, { token, item: movie, rating })).rejects.toThrow("Choose a whole-number rating from 1 to 10.");
    expect(await rows()).toEqual([]);
    expect(await t.run(async (ctx) => await ctx.db.query("feedback").collect())).toEqual([]);
  });

  test("5/10 is a real score in pagination and rating counts", async () => {
    const { t } = await fixture();
    await t.mutation(api.ratings.save, { token, item: movie, rating: 5 });
    expect(await t.query(api.ratings.mine, { token, source: "krida", paginationOpts: { cursor: null, numItems: 200 } }))
      .toMatchObject({ page: [{ id: movie.id, rating: 5 }] });
    expect(await t.query(api.feedback.summary, { token })).toMatchObject({ rated: 1 });
  });

  test("an exact re-rating within the same thumb band sends the new score", async () => {
    const { t, tracked, rows } = await fixture();
    await tracked({ rating: 8 });
    await t.mutation(api.ratings.save, { token, item: movie, rating: 6 });
    expect(await rows()).toMatchObject([{ op: "rate", item: { rating: 6 } }]);
  });

  test("clearing an exact score retains the watched movie", async () => {
    const { t } = await fixture();
    await t.mutation(api.ratings.save, { token, item: movie, rating: 8 });
    await t.mutation(api.ratings.save, { token, item: movie, rating: null });
    expect(await t.query(api.ratings.details, { token, id: movie.id })).toMatchObject({ rating: null });
    expect(await t.query(api.library.overview, { token })).toMatchObject({ watched: [{ id: movie.id }] });
  });

  test("show, season and episode scores stay independent", async () => {
    const { t, rows } = await fixture();
    const item = { ...movie, type: "series" as const };
    await t.mutation(api.ratings.save, { token, item, rating: 8 });
    await t.mutation(api.ratings.save, { token, item, season: 2, rating: 6 });
    await t.mutation(api.ratings.save, { token, item, season: 2, episode: 3, rating: 10 });
    expect(await t.query(api.ratings.details, { token, id: movie.id })).toMatchObject({ rating: 8, parts: [
      { season: 2, rating: 6 }, { season: 2, episode: 3, rating: 10 },
    ] });
    expect((await rows()).filter((r) => r.op === "rate")).toMatchObject([{ item: { rating: 8 } }]);
    expect((await rows()).filter((r) => r.op === "watched")).toHaveLength(2);
  });

  test("rating a show preserves existing watched episodes", async () => {
    const { t, tracked, rows } = await fixture();
    await tracked({ type: "series", status: "watching", watched: "1:1-3", watchedEpisodes: 3 });
    await t.mutation(api.ratings.save, { token, item: { ...movie, type: "series" }, rating: 8 });
    expect((await rows()).some((r) => r.op === "watched")).toBe(false);
    expect(await t.query(api.simkl.forTitle, { token, id: movie.id })).toMatchObject({ watched: ["1:1", "1:2", "1:3"] });
  });

  test("Rewatching preserves completed history and sends no rewatch API request", async () => {
    const { t, tracked, rows } = await fixture();
    await tracked({ type: "series", watched: "1:1-10" });
    await t.mutation(api.ratings.save, { token, item: { ...movie, type: "series" }, state: "rewatching", season: 1, episode: 1, rating: 8 });
    expect(await rows()).toEqual([]);
    expect(await t.query(api.simkl.forTitle, { token, id: movie.id })).toMatchObject({ rewatching: true, watched: expect.arrayContaining(["1:10"]) });
    expect(await t.query(api.library.overview, { token })).toMatchObject({ watching: [{ note: "Rewatching" }], rewatching: [{ note: "Rewatching" }] });
  });

  test("Done explicitly sends a whole-show completion and marks it watched locally", async () => {
    const { t, rows } = await fixture();
    const item = { ...movie, type: "series" as const };
    await t.mutation(api.ratings.save, { token, item, state: "completed" });
    expect(await rows()).toMatchObject([{ op: "watched", item: { status: "completed" } }]);
    vi.setSystemTime(now + 50_000);
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string)); return Response.json({});
    }));
    await t.action(internal.simkl.flush, { profileId: (await rows())[0].profileId });
    expect(bodies).toMatchObject([{ shows: [{ status: "completed" }] }]);
    expect(await t.query(api.library.overview, { token })).toMatchObject({ watched: [{ id: movie.id }] });
  });

  test("a whole-season watch body does not invent a single episode or complete the show", async () => {
    const { t, profileId } = await fixture();
    await t.mutation(api.ratings.save, { token, item: { ...movie, type: "series" }, season: 2, rating: 8 });
    vi.setSystemTime(now + 50_000);
    let body: any;
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => { body = JSON.parse(init.body as string); return Response.json({}); }));
    await t.action(internal.simkl.flush, { profileId });
    expect(body.shows[0].seasons).toEqual([{ number: 2 }]);
    expect(body.shows[0].status).toBeUndefined();
  });

  test("a newer external score keeps the exact value rather than its band", async () => {
    const { t, profileId, connectionId } = await fixture();
    await t.run(async (ctx) => await ctx.db.patch(connectionId, { writeBack: false }));
    await t.mutation(api.ratings.save, { token, item: movie, rating: 8 });
    await t.mutation(internal.simkl.applyEntries, { profileId, entries: [
      { ...movie, externalId: 123, status: "completed", rating: 6, ratedAt: now + 1000 },
    ] });
    expect(await t.query(api.ratings.details, { token, id: movie.id })).toMatchObject({ rating: 6 });
  });

  test("a 2xx partial rejection is reported without discarding another accepted score", async () => {
    const { t, profileId, tracked, rows } = await fixture();
    await tracked();
    await t.mutation(api.ratings.save, { token, item: movie, rating: 8 });
    const second = { ...movie, id: "tt1375666", name: "Inception" };
    await t.mutation(api.ratings.save, { token, item: second, rating: 9 });
    vi.setSystemTime(now + 50_000);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ not_found: { movies: [{ ids: { imdb: movie.id } }] } })));
    const flush = t.action(internal.simkl.flush, { profileId });
    await vi.advanceTimersByTimeAsync(1300);
    await flush;
    expect(await rows()).toEqual([]);
    expect(await t.query(api.ratings.details, { token, id: movie.id })).toMatchObject({ rating: 8, syncError: expect.stringContaining("couldn't match") });
    expect((await t.query(api.ratings.details, { token, id: second.id })).syncError).toBeUndefined();
  });

  test("scoped ratings require a real profile session", async () => {
    const { t, rows } = await fixture();
    await expect(t.mutation(api.ratings.save, { token: "invalid", item: movie, rating: 8 })).rejects.toThrow("Sign in to continue");
    expect(await rows()).toEqual([]);
    await expect(t.query(api.ratings.details, { token: "invalid", id: movie.id })).rejects.toThrow("Sign in to continue");
  });
});

describe("outbox", () => {
  test("the HTTP sender delivers the old batch and then the newer rating", async () => {
    const { t, profileId, rows } = await fixture();
    await t.mutation(api.feedback.set, { token, item: movie, value: "up" });
    vi.setSystemTime(now + 50_000);
    const sentBodies: unknown[] = [];
    let started!: () => void;
    const sending = new Promise<void>((resolve) => { started = resolve; });
    let release!: () => void;
    const response = new Promise<void>((resolve) => { release = resolve; });
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      sentBodies.push(JSON.parse(init!.body as string));
      if (sentBodies.length === 1) { started(); await response; }
      return new Response(JSON.stringify({ added: { movies: 1 } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const firstFlush = t.action(internal.simkl.flush, { profileId });
    await sending;
    await t.mutation(api.feedback.set, { token, item: movie, value: "love" });
    release();
    await firstFlush;
    expect(await rows()).toMatchObject([{ item: { rating: 9 } }]);
    vi.setSystemTime(now + 110_000);
    await t.action(internal.simkl.flush, { profileId });
    expect(sentBodies).toMatchObject([
      { movies: [{ rating: 7 }] }, { movies: [{ rating: 9 }] },
    ]);
    expect(await rows()).toEqual([]);
  });

  test("the HTTP sender stops between groups if write-back is switched off", async () => {
    const { t, profileId, rows } = await fixture();
    await t.mutation(async (ctx) => {
      await enqueue(ctx, profileId, "watched", movie);
      await enqueue(ctx, profileId, "rate", { ...movie, rating: 7 });
    });
    vi.setSystemTime(now + 50_000);
    let started!: () => void;
    const sending = new Promise<void>((resolve) => { started = resolve; });
    let release!: () => void;
    const response = new Promise<void>((resolve) => { release = resolve; });
    const fetchMock = vi.fn(async () => {
      started(); await response;
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const flush = t.action(internal.simkl.flush, { profileId });
    await sending;
    await t.mutation(api.simkl.setWriteBack, { token, writeBack: false });
    release();
    await vi.advanceTimersByTimeAsync(1_300);
    await flush;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await rows()).toMatchObject([{ op: "rate" }]);
  });

  test("a batch cannot exceed the daily request budget", async () => {
    const { t, profileId, connectionId, rows } = await fixture();
    await t.run(async (ctx) => await ctx.db.patch(connectionId, { usage: { day: "2026-10-07", count: 249 } }));
    await t.mutation(async (ctx) => {
      await enqueue(ctx, profileId, "watched", movie);
      await enqueue(ctx, profileId, "rate", { ...movie, rating: 7 });
    });
    vi.setSystemTime(now + 50_000);
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const flush = t.action(internal.simkl.flush, { profileId });
    await vi.advanceTimersByTimeAsync(1_300);
    await flush;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const connection = await t.query(internal.simkl.connection, { profileId });
    expect(connection?.usage?.count).toBe(250);
    expect(connection?.flushAt).toBeGreaterThanOrEqual(Date.parse("2026-10-08T00:00:00Z"));
    expect(await rows()).toHaveLength(1);
  });

  test("acknowledging an in-flight Like does not delete a newer Love", async () => {
    const { t, profileId, rows } = await fixture();
    await t.mutation(async (ctx) => await enqueue(ctx, profileId, "rate", { ...movie, rating: 7 }));
    vi.setSystemTime(now + 50_000);
    const sent = await t.mutation(internal.simkl.claimDue, { profileId, now: Date.now() });
    await t.mutation(async (ctx) => await enqueue(ctx, profileId, "rate", { ...movie, rating: 9 }));
    await t.mutation(internal.simkl.settle, { profileId, sent: sent.map((r) => r._id), retry: [] });
    expect(await rows()).toMatchObject([{ item: { rating: 9 } }]);
  });

  test("a 401 retry cannot exceed the daily request budget", async () => {
    const { t, profileId, connectionId, rows } = await fixture();
    await t.run(async (ctx) => await ctx.db.patch(connectionId, {
      usage: { day: "2026-10-07", count: 249 }, refreshToken: "fake-refresh",
    }));
    await t.mutation(async (ctx) => await enqueue(ctx, profileId, "rate", { ...movie, rating: 7 }));
    vi.setSystemTime(now + 50_000);
    const fetchMock = vi.fn(async () => new Response("{}", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    await t.action(internal.simkl.flush, { profileId });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const connection = await t.query(internal.simkl.connection, { profileId });
    expect(connection?.usage?.count).toBe(250);
    expect(connection?.needsReconnect).not.toBe(true);
    expect(await rows()).toHaveLength(1);
  });

  test("switching write-back off during token refresh prevents the media request", async () => {
    const { t, profileId, connectionId, rows } = await fixture();
    vi.stubEnv("SIMKL_CLIENT_SECRET", "fake-secret");
    await t.run(async (ctx) => await ctx.db.patch(connectionId, {
      expiresAt: now, refreshToken: "fake-refresh",
    }));
    await t.mutation(async (ctx) => await enqueue(ctx, profileId, "rate", { ...movie, rating: 7 }));
    vi.setSystemTime(now + 50_000);
    let started!: () => void;
    const refreshing = new Promise<void>((resolve) => { started = resolve; });
    let release!: () => void;
    const response = new Promise<void>((resolve) => { release = resolve; });
    const fetchMock = vi.fn(async () => {
      started(); await response;
      return Response.json({ access_token: "refreshed-fake-token", scope: "media:read media:write" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const flush = t.action(internal.simkl.flush, { profileId });
    await refreshing;
    await t.mutation(api.simkl.setWriteBack, { token, writeBack: false });
    release();
    await flush;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await rows()).toHaveLength(1);
  });

  test("unsaving while an add is in flight queues the removal", async () => {
    const { t, profileId, rows } = await fixture();
    await t.mutation(async (ctx) => await enqueue(ctx, profileId, "plan", movie));
    vi.setSystemTime(now + 50_000);
    const sent = await t.mutation(internal.simkl.claimDue, { profileId, now: Date.now() });
    await t.mutation(async (ctx) => await enqueue(ctx, profileId, "unplan", movie));
    await t.mutation(internal.simkl.settle, { profileId, sent: sent.map((r) => r._id), retry: [] });
    expect(await rows()).toMatchObject([{ op: "unplan" }]);
  });

  test("write-back off prevents queued changes from being claimed", async () => {
    const { t, profileId, rows } = await fixture();
    await t.mutation(async (ctx) => await enqueue(ctx, profileId, "rate", { ...movie, rating: 7 }));
    await t.mutation(api.simkl.setWriteBack, { token, writeBack: false });
    expect(await t.mutation(internal.simkl.claimDue, { profileId, now: now + 50_000 })).toEqual([]);
    expect(await rows()).toHaveLength(1);
  });

  test("an opposite change after an ambiguous network failure is still sent", async () => {
    const { t, profileId, rows } = await fixture();
    await t.mutation(async (ctx) => await enqueue(ctx, profileId, "plan", movie));
    vi.setSystemTime(now + 50_000);
    const sent = await t.mutation(internal.simkl.claimDue, { profileId, now: Date.now() });
    await t.mutation(internal.simkl.settle, { profileId, sent: [], retry: sent.map((r) => r._id) });
    await t.mutation(async (ctx) => await enqueue(ctx, profileId, "unplan", movie));
    expect(await rows()).toMatchObject([{ op: "unplan" }]);
  });

  test("backoff books one job at the allowed time rather than waking repeatedly", async () => {
    const { t, profileId, connectionId } = await fixture();
    await t.run(async (ctx) => await ctx.db.patch(connectionId, { backoffUntil: now + 600_000 }));
    await t.mutation(async (ctx) => await enqueue(ctx, profileId, "rate", { ...movie, rating: 7 }));
    const connection = await t.run(async (ctx) => await ctx.db.get(connectionId));
    expect(connection?.flushAt).toBe(now + 600_000);
    expect(await t.mutation(internal.simkl.claimDue, { profileId, now: now + 50_000 })).toEqual([]);
  });

  test("disabling and re-enabling write-back cancels and replaces the booking", async () => {
    const { t, profileId, connectionId } = await fixture();
    await t.mutation(async (ctx) => await enqueue(ctx, profileId, "plan", movie));
    const before = await t.run(async (ctx) => await ctx.db.get(connectionId));
    await t.mutation(api.simkl.setWriteBack, { token, writeBack: false });
    const job = await t.run(async (ctx) => await ctx.db.system.get(before!.flushJobId!));
    expect(job?.state.kind).toBe("canceled");
    await t.mutation(api.simkl.setWriteBack, { token, writeBack: true });
    const after = await t.run(async (ctx) => await ctx.db.get(connectionId));
    expect(after?.flushJobId).not.toBe(before?.flushJobId);
    expect(await t.run(async (ctx) => (await ctx.db.system.get(after!.flushJobId!))?.state.kind)).toBe("pending");
  });

  test("reconnecting clears old-account writes and fences old import callbacks", async () => {
    const { t, profileId, rows } = await fixture();
    await t.mutation(async (ctx) => await enqueue(ctx, profileId, "rate", { ...movie, rating: 7 }));
    await t.mutation(internal.simkl.saveConnection, { profileId, accessToken: "new-fake-token", scope: "media:read media:write" });
    expect(await rows()).toEqual([]);
    await t.mutation(internal.simkl.applyEntries, { profileId, expectedConnectedAt: now, entries: [
      { ...movie, externalId: 123, status: "completed", rating: 10 },
    ] });
    await t.mutation(internal.library.fromSimkl, { profileId, expectedConnectedAt: now,
      planned: [movie], notPlanned: [] });
    expect(await t.run(async (ctx) => await ctx.db.query("tracked").collect())).toEqual([]);
    expect(await t.run(async (ctx) => await ctx.db.query("library").collect())).toEqual([]);
    await t.mutation(internal.simkl.patchConnection, { profileId, expectedConnectedAt: now,
      patch: { accessToken: "old-fake-token", snapshot: "old" } });
    const connection = await t.query(internal.simkl.connection, { profileId });
    expect(connection?.accessToken).toBe("new-fake-token");
    expect(connection?.snapshot).toBeUndefined();
  });
});

describe("saving watched titles", () => {
  test("saving a movie rated moments ago does not put it back on the Simkl watchlist", async () => {
    const { t, rows } = await fixture();
    await t.mutation(api.ratings.save, { token, item: movie, rating: 9 });
    await t.mutation(api.library.toggle, { token, item: { type: "movie", imdbId: movie.id, name: movie.name }, saved: true });
    expect((await rows()).map((r) => r.op).sort()).toEqual(["rate", "watched"]);
    expect(await t.query(api.library.has, { token, imdbId: movie.id })).toBe(true);
  });

  test("saving a movie finished in Krida does not plan it; an untouched one still does", async () => {
    const { t, profileId, rows } = await fixture();
    await t.run(async (ctx) => await ctx.db.insert("progress", {
      profileId, media: { imdbId: movie.id, videoId: movie.id, type: "movie", name: movie.name },
      position: 5900, duration: 6000, finished: true, updatedAt: now,
    }));
    await t.mutation(api.library.toggle, { token, item: { type: "movie", imdbId: movie.id, name: movie.name }, saved: true });
    await t.mutation(api.library.toggle, { token, item: { type: "movie", imdbId: "tt0000009", name: "Untouched" }, saved: true });
    expect(await rows()).toMatchObject([{ op: "status", item: { id: "tt0000009", status: "plantowatch" } }]);
  });
});

describe("Still watching", () => {
  const shows = [
    { id: "tt0903747", name: "Breaking Bad" },
    { id: "tt2861424", name: "Rick and Morty" },
    { id: "tt1475582", name: "Sherlock" },
  ].map((s) => ({ ...s, type: "series" as const }));
  const still = async (t: Awaited<ReturnType<typeof fixture>>["t"]) =>
    (await t.query(api.catalogs.home, { token })).rows.find((r) => r.key === "simkl:watching")?.items.map((i) => i.id) ?? [];

  test.each(["completed", "hold", "dropped"] as const)("a %s status set in Krida leaves the row before Simkl answers", async (state) => {
    const f = await fixture();
    for (const [i, s] of shows.entries()) await f.tracked({ ...s, externalId: 200 + i, status: "watching", lastWatchedAt: now - i * 1000 });
    expect(await still(f.t)).toEqual(shows.map((s) => s.id));
    await f.t.mutation(api.library.setStatus, { token, item: shows[0], state });
    expect(await still(f.t)).toEqual([shows[1].id, shows[2].id]);
    await f.t.mutation(api.library.setStatus, { token, item: shows[0], state: "watching" });
    expect(await still(f.t)).toEqual(shows.map((s) => s.id));
  });
});
