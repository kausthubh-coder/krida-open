/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Doc } from "../convex/_generated/dataModel";
import schema from "../convex/schema";
import { sha256 } from "../convex/lib/auth";
import { enqueue } from "../convex/lib/simklOutbox";
import { watchStatusOf, type WatchStatus } from "../convex/lib/watchStatus";

const modules = import.meta.glob(["../convex/**/*.ts", "../convex/**/*.js", "!../convex/**/*.d.ts"]);
const movie = { id: "tt0047478", type: "movie" as const, name: "Seven Samurai" };
const show = { ...movie, type: "series" as const };
const listItem = { type: movie.type, name: movie.name, imdbId: movie.id };
const showItem = { ...listItem, type: "series" as const };
const token = "test-session";
const now = Date.parse("2026-10-07T20:00:00Z");
const episode = (n: number, id = movie.id) =>
  ({ type: "series" as const, imdbId: id, videoId: `${id}:1:${n}`, name: movie.name, season: 1, episode: n });
const moviePlay = { type: "movie" as const, imdbId: movie.id, videoId: movie.id, name: movie.name };

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
  const tracked = async (extra: Partial<Doc<"tracked">> = {}) => t.run(async (ctx) =>
    await ctx.db.insert("tracked", { profileId, source: "simkl", externalId: 123, ...movie, status: "completed", ...extra }));
  const rows = () => t.run(async (ctx) => await ctx.db.query("syncOutbox").collect());
  const sendAll = async () => await t.mutation(internal.simkl.settle, { profileId, sent: (await rows()).map((r) => r._id), retry: [] });
  const listed = (id = movie.id, type: "movie" | "series" = "movie") => t.run(async (ctx) => {
    await ctx.db.insert("library", { profileId, imdbId: id, type, name: movie.name, addedAt: now, source: "simkl" });
  });
  return { t, profileId, connectionId, tracked, rows, sendAll, listed };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); vi.stubEnv("SIMKL_CLIENT_ID", "fake-client"); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("leaving My list never deletes plays on Simkl", () => {
  test.each([false, true])("a planned show with an episode watched in Krida keeps it (play already sent: %s)", async (sent) => {
    const { t, profileId, tracked, rows, sendAll, listed } = await fixture();
    await tracked({ type: "series", status: "plantowatch" });
    await listed(movie.id, "series");
    await t.mutation(api.progress.save, { token, media: episode(1), position: 98, duration: 100 });
    if (sent) await sendAll();
    await t.mutation(api.library.toggle, { token, item: showItem, saved: false });
    const queued = await rows();
    expect(queued.some((r) => r.op === "unplan")).toBe(false);
    expect(queued).toEqual(expect.arrayContaining([expect.objectContaining({ op: "status", item: expect.objectContaining({ status: "watching" }) })]));
    vi.setSystemTime(now + 50_000);
    const paths: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => { paths.push(new URL(url).pathname); return Response.json({}); }));
    const flush = t.action(internal.simkl.flush, { profileId });
    await vi.runAllTimersAsync();
    await flush;
    expect(paths).toEqual(sent ? ["/sync/add-to-list"] : ["/sync/history", "/sync/add-to-list"]);
    expect(paths).not.toContain("/sync/history/remove");
  });

  test("Plan to watch on a watched movie, then removing it, moves it back to Watched", async () => {
    const { t, profileId, tracked, rows, sendAll } = await fixture();
    await tracked({ status: "completed", lastWatchedAt: now - 86_400_000 });
    await t.mutation(api.library.setStatus, { token, item: movie, state: "plantowatch" });
    await sendAll();
    await t.mutation(internal.simkl.applyEntries, { profileId, entries: [{ ...movie, externalId: 123, status: "plantowatch", lastWatchedAt: now - 86_400_000 }] });
    expect(await t.query(api.library.statusFor, { token, id: movie.id })).toMatchObject({ state: "plantowatch", saved: true });
    await t.mutation(api.library.toggle, { token, item: listItem, saved: false });
    expect(await rows()).toMatchObject([{ op: "status", item: { status: "completed" } }]);
    expect(await t.query(api.library.statusFor, { token, id: movie.id })).toMatchObject({ state: "completed", saved: false });
  });

  test("a title that was only ever planned still leaves the Simkl watchlist", async () => {
    const { t, tracked, rows, listed } = await fixture();
    await tracked({ status: "plantowatch" });
    await listed();
    await t.mutation(api.library.toggle, { token, item: listItem, saved: false });
    expect(await rows()).toMatchObject([{ op: "unplan" }]);
  });

  test("the sender drops a queued removal once the title has been watched", async () => {
    const { t, profileId, tracked, rows } = await fixture();
    await tracked({ status: "plantowatch" });
    await t.mutation(async (ctx) => await enqueue(ctx, profileId, "unplan", movie));
    await t.mutation(api.progress.save, { token, media: moviePlay, position: 98, duration: 100 });
    const claimed = await t.mutation(internal.simkl.claimDue, { profileId, now: now + 50_000 });
    expect(claimed).toMatchObject([{ op: "watched" }]);
    expect((await rows()).some((r) => r.op === "unplan")).toBe(false);
  });
});

describe("one write path for status", () => {
  test.each([
    ["movie", false], ["movie", true], ["series", false], ["series", true],
  ] as const)("bookmarking a partially watched %s preserves progress and status (explicit: %s)", async (type, explicit) => {
    const { t, rows } = await fixture();
    const item = { ...movie, type };
    await t.mutation(api.progress.save, { token, media: type === "movie" ? moviePlay : episode(1), position: 1800, duration: 7200 });
    if (explicit) await t.mutation(api.library.setStatus, { token, item, state: "watching" });
    const pendingBefore = await rows();
    await t.mutation(api.library.toggle, { token, item: { ...listItem, type }, saved: true });
    expect(await t.query(api.library.statusFor, { token, id: movie.id })).toMatchObject({ state: "watching", saved: true });
    expect(await t.query(api.progress.forTitle, { token, imdbId: movie.id })).toMatchObject([{ position: 1800, finished: false }]);
    expect(await rows()).toEqual(pendingBefore);
  });

  test("a score alone leaves status to Simkl, so finishing there shows Watched", async () => {
    const { t, profileId, tracked } = await fixture();
    await tracked({ type: "series", status: "watching", watched: "1:1-3" });
    await t.mutation(api.ratings.save, { token, item: show, rating: 8 });
    expect(await t.run(async (ctx) => await ctx.db.query("viewing").collect())).toEqual([]);
    await t.mutation(internal.simkl.applyEntries, { profileId, entries: [{ ...show, externalId: 123, status: "completed", rating: 8 }] });
    expect((await t.query(api.library.statusFor, { token, id: movie.id })).state).toBe("completed");
    expect((await t.query(api.ratings.details, { token, id: movie.id })).state).toBe("completed");
  });

  test("an untouched title has no status anywhere", async () => {
    const { t } = await fixture();
    expect((await t.query(api.ratings.details, { token, id: movie.id })).watchStatus).toBeNull();
    expect((await t.query(api.library.statusFor, { token, id: movie.id })).state).toBeNull();
    expect(await t.query(api.simkl.forTitle, { token, id: movie.id })).toBeNull();
  });

  test("the cleanup removes score-written status rows and keeps real choices", async () => {
    const { t, profileId } = await fixture();
    const ids = ["tt0000001", "tt0000002", "tt0000003", "tt0000004", "tt0000005"];
    await t.run(async (ctx) => {
      const base = { profileId, type: "series" as const, name: "Show", at: now - 5000 };
      const score = { profileId, type: "series" as const, name: "Show", value: "up" as const, rating: 8, at: now - 5000 };
      // Written by a score: the score's own timestamp, never synced.
      await ctx.db.insert("viewing", { ...base, id: ids[0], state: "watching" });
      await ctx.db.insert("feedback", { ...score, id: ids[0] });
      await ctx.db.insert("viewing", { ...base, id: ids[1], state: "watching" });
      await ctx.db.insert("partRatings", { profileId, id: ids[1], season: 1, rating: 7, at: now - 5000 });
      // A choice made at another time.
      await ctx.db.insert("viewing", { ...base, id: ids[2], state: "hold", at: now - 9000 });
      await ctx.db.insert("feedback", { ...score, id: ids[2] });
      // A scored movie stays Watched.
      await ctx.db.insert("viewing", { ...base, id: ids[3], type: "movie", state: "completed" });
      await ctx.db.insert("feedback", { ...score, id: ids[3], type: "movie" });
      // Still waiting for Simkl.
      await ctx.db.insert("viewing", { ...base, id: ids[4], state: "dropped" });
      await ctx.db.insert("feedback", { ...score, id: ids[4] });
    });
    await t.mutation(async (ctx) => await enqueue(ctx, profileId, "status", { ...show, id: ids[4], status: "dropped" }));
    expect(await t.mutation(internal.library.dropRatingOnlyViewing, { dryRun: true }))
      .toEqual({ removed: [`${profileId}:${ids[0]}:watching`, `${profileId}:${ids[1]}:watching`], isDone: true });
    expect(await t.run(async (ctx) => await ctx.db.query("viewing").collect())).toHaveLength(5);
    await t.mutation(internal.library.dropRatingOnlyViewing, { dryRun: false });
    expect((await t.run(async (ctx) => await ctx.db.query("viewing").collect())).map((r) => r.id).sort()).toEqual(ids.slice(2));
    expect(await t.mutation(internal.library.dropRatingOnlyViewing, { dryRun: false })).toEqual({ removed: [], isDone: true });
  });

  test("adding to My list is the Plan to watch choice, and Undo keeps the original date", async () => {
    const { t, rows } = await fixture();
    await t.mutation(api.library.setStatus, { token, item: show, state: "dropped" });
    await t.mutation(api.library.toggle, { token, item: showItem, saved: true, addedAt: now - 60_000 });
    expect(await t.query(api.library.statusFor, { token, id: movie.id })).toMatchObject({ state: "plantowatch", saved: true });
    expect(await rows()).toMatchObject([{ op: "status", item: { status: "plantowatch" } }]);
    const addedAt = await t.mutation(api.library.toggle, { token, item: showItem, saved: false });
    expect(addedAt).toBe(now - 60_000);
    await t.mutation(api.library.toggle, { token, item: showItem, saved: true, addedAt: addedAt! });
    expect((await t.query(api.library.overview, { token, separateStatuses: true })).list).toMatchObject([{ id: movie.id, at: now - 60_000 }]);
  });

  test("playing a planned movie keeps it in My list and on the Simkl watchlist", async () => {
    const { t, profileId, rows, sendAll } = await fixture();
    await t.mutation(api.library.setStatus, { token, item: movie, state: "plantowatch" });
    await t.mutation(api.progress.save, { token, media: moviePlay, position: 20, duration: 100 });
    expect(await t.query(api.library.statusFor, { token, id: movie.id })).toMatchObject({ state: "watching", saved: true });
    expect(await rows()).toMatchObject([{ op: "status", item: { status: "plantowatch" } }]);
    await sendAll();
    await t.mutation(internal.simkl.applyEntries, { profileId, entries: [{ ...movie, externalId: 123, status: "plantowatch" }] });
    expect(await t.query(api.library.statusFor, { token, id: movie.id })).toMatchObject({ state: "watching", saved: true });
    // Finished in another app later: Simkl's newer watch replaces the local Watching.
    await t.mutation(internal.simkl.applyEntries, { profileId, entries: [{ ...movie, externalId: 123, status: "completed", lastWatchedAt: now + 60_000 }] });
    expect(await t.run(async (ctx) => await ctx.db.query("viewing").collect())).toEqual([]);
  });

  test("Rewatching shows as Watched on Simkl, and sends nothing when Simkl already has it", async () => {
    const { t, rows, tracked } = await fixture();
    await t.mutation(api.library.setStatus, { token, item: show, state: "rewatching" });
    expect(await rows()).toMatchObject([{ op: "status", item: { status: "completed" } }]);
    await t.run(async (ctx) => { for (const r of await ctx.db.query("syncOutbox").collect()) await ctx.db.delete(r._id); });
    await tracked({ type: "series", status: "completed" });
    await t.mutation(api.library.setStatus, { token, item: show, state: "watching" });
    await t.mutation(api.library.setStatus, { token, item: show, state: "rewatching" });
    // The Watching that was still waiting is replaced, and Simkl already says Watched.
    expect(await rows()).toEqual([]);
    expect((await t.query(api.library.statusFor, { token, id: movie.id })).state).toBe("rewatching");
  });

  test("a movie under way waits in Simkl's Plan to watch and stays Watching in Krida", async () => {
    const { t, profileId, tracked, rows, sendAll } = await fixture();
    await tracked({ status: "dropped" });
    await t.mutation(api.library.setStatus, { token, item: movie, state: "watching" });
    expect(await rows()).toMatchObject([{ op: "status", item: { status: "plantowatch" } }]);
    await t.mutation(internal.simkl.settle, { profileId, sent: (await rows()).map((r) => r._id), retry: [], rejected: (await rows()).map((r) => r._id) });
    expect((await t.query(api.library.statusFor, { token, id: movie.id })).syncError).toMatch(/couldn't match/);
    await t.mutation(api.library.setStatus, { token, item: movie, state: "hold" });
    await sendAll();
    await t.mutation(internal.simkl.applyEntries, { profileId, entries: [{ ...movie, externalId: 123, status: "plantowatch" }] });
    const latest = await t.query(api.library.statusFor, { token, id: movie.id });
    expect(latest).toMatchObject({ state: "hold", simkl: "plantowatch" });
    expect(latest.syncError).toBeUndefined();
  });

  test("a status already on its way to Simkl is followed by the nearest list", async () => {
    const { t, profileId, tracked, rows } = await fixture();
    await tracked({ type: "series", status: "completed" });
    await t.mutation(api.library.setStatus, { token, item: show, state: "dropped" });
    await t.mutation(internal.simkl.claimDue, { profileId, now: now + 60_000 });
    vi.setSystemTime(now + 1_000);
    await t.mutation(api.library.setStatus, { token, item: show, state: "rewatching" });
    // Simkl already had Watched, but the Dropped being sent would move it off, so Watched follows it.
    expect(await rows()).toMatchObject([{ op: "status", item: { status: "completed" } }]);
  });

  test("a movie Simkl has as Watched stays Watched there while you watch it again", async () => {
    const { t, tracked, rows } = await fixture();
    await tracked({ status: "completed" });
    await t.mutation(api.library.setStatus, { token, item: movie, state: "watching" });
    expect(await t.run(async (ctx) => (await ctx.db.query("viewing").collect()).map((r) => [r.id, r.state]))).toEqual([[movie.id, "watching"]]);
    expect(await rows()).toEqual([]);
  });

  test("a movie play survives a later status change in the same batch", async () => {
    const { t, profileId } = await fixture();
    await t.mutation(api.progress.save, { token, media: moviePlay, position: 98, duration: 100 });
    vi.setSystemTime(now + 1_000);
    await t.mutation(api.library.setStatus, { token, item: movie, state: "dropped" });
    const claimed = await t.mutation(internal.simkl.claimDue, { profileId, now: now + 60_000 });
    expect(claimed.map((r) => r.op).sort()).toEqual(["status", "watched"]);
  });
});

describe("reading status", () => {
  test("Settings gets raw sync times rather than answers from a cached clock", async () => {
    const { t, connectionId } = await fixture();
    await t.run(async (ctx) => await ctx.db.patch(connectionId, { syncing: now - 1000, usage: { day: "2026-10-06", count: 250 } }));
    expect(await t.query(api.simkl.status, { token })).toMatchObject({
      syncingSince: now - 1000, syncLease: 600_000, usage: { day: "2026-10-06", count: 250 }, budget: 250,
    });
  });

  test("every reader agrees with the shared status rule", async () => {
    const { t, tracked } = await fixture();
    const cases: { id: string; setup: () => Promise<unknown>; status: WatchStatus | null }[] = [
      // Planned on Simkl, but taken off My list in Krida.
      { id: "tt0000001", setup: () => tracked({ id: "tt0000001", externalId: 1, status: "plantowatch" }), status: null },
      // Last episode finished here, the show finished on Simkl.
      { id: "tt0000002", setup: async () => {
        await tracked({ id: "tt0000002", externalId: 2, type: "series", status: "completed" });
        await t.mutation(api.progress.save, { token, media: episode(2, "tt0000002"), position: 98, duration: 100 });
      }, status: "completed" },
      { id: "tt0000003", setup: () => t.mutation(api.progress.save, { token, media: episode(1, "tt0000003"), position: 10, duration: 100 }), status: "watching" },
      { id: "tt0000004", setup: () => tracked({ id: "tt0000004", externalId: 4, status: "dropped" }), status: "dropped" },
      { id: "tt0000005", setup: () => t.mutation(api.library.setStatus, { token, item: { ...show, id: "tt0000005" }, state: "rewatching" }), status: "rewatching" },
    ];
    for (const c of cases) await c.setup();
    const mine = await t.query(api.library.mine, { token });
    const started = await t.query(api.progress.started, { token });
    const overview = await t.query(api.library.overview, { token, separateStatuses: true });
    const section = { watching: "watching", completed: "watched", rewatching: "rewatching", hold: "hold", dropped: "dropped" } as const;
    for (const c of cases) {
      const row = mine.find((r) => r.id === c.id);
      expect(watchStatusOf({ ...row, played: started.find((p) => p.id === c.id) }), c.id).toBe(c.status);
      expect((await t.query(api.library.statusFor, { token, id: c.id })).state, c.id).toBe(c.status);
      expect((await t.query(api.ratings.details, { token, id: c.id })).watchStatus, c.id).toBe(c.status);
      if (c.status && c.status !== "plantowatch") expect(overview[section[c.status]].map((r) => r.id), c.id).toContain(c.id);
    }
  });

  test("the poster query has scores and My list but no episode lists", async () => {
    const { t, profileId, tracked } = await fixture();
    await tracked({ type: "series", status: "watching", rating: 9, watched: "1:1-100" });
    await t.mutation(api.ratings.save, { token, item: { ...movie, id: "tt0000002" }, rating: 6 });
    await t.mutation(api.feedback.set, { token, item: movie, value: null });
    await t.run(async (ctx) => { await ctx.db.insert("library", { profileId, ...listItem, imdbId: "tt0000003", addedAt: now }); });
    const rows = await t.query(api.library.mine, { token });
    expect(rows).toEqual(expect.arrayContaining([
      { id: movie.id, tracked: "watching" },
      { id: "tt0000002", local: "completed", rating: 6 },
      { id: "tt0000003", saved: true },
    ]));
    expect(JSON.stringify(rows)).not.toContain("1:1-100");
  });

  test("playback ticks don't change the started list", async () => {
    const { t } = await fixture();
    await t.mutation(api.progress.save, { token, media: episode(1), position: 10, duration: 100 });
    const first = await t.query(api.progress.started, { token });
    await t.mutation(api.progress.save, { token, media: episode(1), position: 40, duration: 100 });
    expect(await t.query(api.progress.started, { token })).toEqual(first);
    expect(first).toEqual([{ id: movie.id, type: "series", finished: false }]);
  });
});
