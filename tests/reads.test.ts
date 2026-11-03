/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import { household } from "./household";
import { sha256 } from "../convex/lib/auth";
import { mineFrom, overviewFrom, toRateFrom } from "../convex/lib/libraryViews";
import type { Doc } from "../convex/_generated/dataModel";

const modules = import.meta.glob(["../convex/**/*.ts", "../convex/**/*.js", "!../convex/**/*.d.ts"]);
const token = "test-session";
const now = Date.parse("2026-10-07T20:00:00Z");
const DAY = 86_400_000;

async function fixture() {
  const t = convexTest(schema, modules);
  const profileId = await t.run(async (ctx) => {
    const accountId = await household(ctx);
    const profileId = await ctx.db.insert("profiles", {
      name: "Test", hue: 145, passwordHash: "unused", salt: "unused", order: 0,
      failedAttempts: 0, prefs: { audioLang: "en", sounds: false }, accountId,
    });
    await ctx.db.insert("sessions", { profileId, tokenHash: await sha256(token), createdAt: now });
    await ctx.db.insert("connections", {
      profileId, provider: "simkl", accessToken: "fake-token", scope: "media:read media:write", writeBack: true, connectedAt: now,
    });
    return profileId;
  });
  const jobs = (name: string) => t.run(async (ctx) =>
    (await ctx.db.system.query("_scheduled_functions").collect()).filter((j) => j.name.replace(".js", "") === name && j.state.kind === "pending"));
  return { t, profileId, jobs };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); vi.stubEnv("SIMKL_CLIENT_ID", "fake-client"); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("the Library, built in the browser from one query per table", () => {
  test("gives the same collections, backlog and poster rows as the one-query versions", async () => {
    const { t, profileId } = await fixture();
    await t.run(async (ctx) => {
      let externalId = 1;
      const tracked = (row: Partial<Doc<"tracked">> & { id: string; status: Doc<"tracked">["status"] }) =>
        ctx.db.insert("tracked", { profileId, source: "simkl", externalId: externalId++, type: "series", name: row.id, ...row });
      // Watched on Simkl in one bulk import, one rated there, a show under way, one on hold, one planned.
      for (let i = 0; i < 21; i++) await tracked({ id: `tt10000${i}`, type: "movie", status: "completed", lastWatchedAt: now - 300 * DAY });
      await tracked({ id: "tt2000001", status: "completed", rating: 8, watchedEpisodes: 10, totalEpisodes: 10, watched: "1:1-10", lastWatchedAt: now - 20 * DAY });
      await tracked({ id: "tt2000002", status: "watching", watchedEpisodes: 4, totalEpisodes: 10, watched: "1:1-4", nextSeason: 1, nextEpisode: 5, lastWatchedAt: now - 3 * DAY });
      await tracked({ id: "kitsu:42", status: "hold", watchedEpisodes: 2, totalEpisodes: 12, poster: "https://example.com/p.jpg", imdb: "tt2000042", lastWatchedAt: now - 9 * DAY });
      await tracked({ id: "tt2000003", type: "movie", status: "plantowatch", addedAt: now - 40 * DAY });
      // Krida's own: a status, a score (and a cleared one), My list, plays, and "I didn't watch this".
      await ctx.db.insert("viewing", { profileId, id: "tt2000004", type: "movie", name: "Dropped film", state: "dropped", at: now - DAY });
      await ctx.db.insert("feedback", { profileId, id: "tt2000002", type: "series", name: "tt2000002", value: "up", rating: 6, at: now - DAY });
      await ctx.db.insert("feedback", { profileId, id: "tt2000001", type: "series", name: "tt2000001", value: null, rating: null, at: now - DAY });
      await ctx.db.insert("library", { profileId, imdbId: "tt2000005", type: "movie", name: "Saved film", addedAt: now - 2 * DAY });
      await ctx.db.insert("library", { profileId, imdbId: "tt2000003", type: "movie", name: "tt2000003", addedAt: now - 40 * DAY, source: "simkl" });
      const play = (imdbId: string, episode: number, finished: boolean, at: number) => ctx.db.insert("progress", { profileId,
        media: { type: "series", imdbId, videoId: `${imdbId}:1:${episode}`, season: 1, episode, name: imdbId }, position: finished ? 1400 : 600,
        duration: 1440, finished, hidden: false, updatedAt: at });
      for (const e of [1, 2, 3]) await play("tt2000006", e, true, now - (10 - e) * 3_600_000);
      await play("tt2000006", 4, false, now - 3_600_000);
      await play("tt2000002", 5, true, now - 2 * 3_600_000);
      await ctx.db.insert("unwatched", { profileId, id: "tt1000000", type: "movie", name: "tt1000000", at: now - DAY });
    });

    const [simkl, own, progress] = await Promise.all([
      t.query(api.library.simklRows, { token }), t.query(api.library.ownRows, { token }), t.query(api.library.progressRows, { token })]);
    expect(overviewFrom(own, progress, simkl, true)).toEqual(await t.query(api.library.overview, { token, separateStatuses: true }));
    expect(toRateFrom(own, progress, simkl)).toEqual(await t.query(api.library.toRate, { token }));
    expect(mineFrom(simkl, own)).toEqual(await t.query(api.library.mine, { token }));
    // The fixture reaches every collection, so the comparison means something.
    const overview = overviewFrom(own, progress, simkl, true);
    expect(overview.list.map((l) => l.id)).toEqual(["tt2000005", "tt2000003"]);
    expect(overview.watching.map((e) => e.id)).toEqual(["tt2000006", "tt2000002"]);
    expect(overview.hold.map((e) => e.id)).toEqual(["kitsu:42"]);
    expect(overview.dropped.map((e) => e.id)).toEqual(["tt2000004"]);
    const backlog = toRateFrom(own, progress, simkl);
    expect(backlog.items.map((i) => i.group)).toContain("import");
    expect(backlog.items.map((i) => i.id)).toContain("tt2000006");
  });

  test("the rows sent to the browser leave out what it doesn't use", async () => {
    const { t, profileId } = await fixture();
    await t.run(async (ctx) => ctx.db.insert("tracked", { profileId, source: "simkl", externalId: 7, id: "tt3000001", type: "movie", name: "Film",
      status: "completed", watchedAt: "1@2026-01-01", ratedAt: now, runtime: 120 }));
    expect(await t.query(api.library.simklRows, { token })).toEqual([{ id: "tt3000001", type: "movie", name: "Film", status: "completed" }]);
  });
});

describe("Simkl status", () => {
  test("the Library's question leaves out the library counts; Settings still has them", async () => {
    const { t, profileId } = await fixture();
    await t.run(async (ctx) => ctx.db.insert("tracked", { profileId, source: "simkl", externalId: 1, id: "tt3000001", type: "movie", name: "Film", status: "completed", rating: 7 }));
    const state = await t.query(api.simkl.syncState, { token });
    expect(state).toMatchObject({ writeBack: true, canWrite: true, waiting: 0 });
    expect(state).not.toHaveProperty("titles");
    expect(await t.query(api.simkl.status, { token })).toMatchObject({ ...state, titles: 1, watched: 1, rated: 1, planned: 0 });
  });
});

describe("stats", () => {
  async function withStats() {
    const f = await fixture();
    await f.t.run(async (ctx) => ctx.db.insert("wrapped", { profileId: f.profileId, version: 0, computedAt: now - DAY }));
    return f;
  }
  const mark = (t: Awaited<ReturnType<typeof fixture>>["t"]) => t.mutation(api.library.setStatus, { token,
    item: { id: "tt6000001", type: "movie", name: "Film" }, state: "completed" });

  test("a change while nobody's looking hides them and waits for Stats to open", async () => {
    const { t, jobs } = await withStats();
    await mark(t);
    expect(await jobs("wrapped:compute")).toHaveLength(0);
    expect(await t.run(async (ctx) => (await ctx.db.query("wrapped").collect())[0])).toMatchObject({ computedAt: 0, revision: 1 });
    await t.mutation(api.wrapped.refreshSoon, { token });
    expect(await jobs("wrapped:compute")).toHaveLength(1);
  });

  test("a change while Stats is open rebuilds them", async () => {
    const { t, jobs } = await withStats();
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("wrapped").collect())[0];
      await ctx.db.patch(row._id, { viewedAt: now - 60_000 });
    });
    await mark(t);
    expect(await jobs("wrapped:compute")).toHaveLength(1);
  });
});

describe("party housekeeping", () => {
  test("runs while a room is open and stops once none is", async () => {
    const { t, jobs } = await fixture();
    expect(await jobs("rooms:sweep")).toHaveLength(0);
    const roomId = await t.mutation(api.rooms.createParty, { token, inviteIds: [] });
    expect(await jobs("rooms:sweep")).toHaveLength(1);
    // A second room shares the booked sweep.
    await t.mutation(api.rooms.createParty, { token, inviteIds: [] });
    expect(await jobs("rooms:sweep")).toHaveLength(1);
    await t.mutation(internal.rooms.sweep, {});
    expect(await jobs("rooms:sweep")).toHaveLength(1);
    // Everyone gone long enough: the rooms close, and nothing more is booked.
    vi.setSystemTime(now + 60 * 60_000);
    await t.run(async (ctx) => {
      for (const job of await ctx.db.system.query("_scheduled_functions").collect())
        if (job.name.includes("sweep") && job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
    });
    await t.mutation(internal.rooms.sweep, {});
    expect((await t.run(async (ctx) => await ctx.db.get(roomId)))?.closedAt).toBe(now + 60 * 60_000);
    expect(await jobs("rooms:sweep")).toHaveLength(0);
  });
});
