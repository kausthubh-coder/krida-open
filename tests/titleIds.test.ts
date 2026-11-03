/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import { sha256 } from "../convex/lib/auth";
import { aliasesOf } from "../convex/lib/titleIds";
import { assemble } from "../convex/wrapped";
import type { Doc } from "../convex/_generated/dataModel";

const modules = import.meta.glob(["../convex/**/*.ts", "../convex/**/*.js", "!../convex/**/*.d.ts"]);
const token = "test-session";
const now = Date.parse("2026-10-11T12:00:00Z");
// The same anime: saved from Home or Search by its IMDb id, and imported from Simkl by its Kitsu id.
const imdb = "tt16341212";
const kitsu = "kitsu:44944";
const page = { id: imdb, type: "series" as const, name: "Aharen-san wa hakarenai", year: "2022–2025" };
const entry = { externalId: 1698489, id: kitsu, imdb, type: "series" as const, name: "Aharen-san wa Hakarenai", year: "2022",
  poster: "https://simkl.in/posters/aharen.webp" };

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
  const tracked = (extra: Partial<Doc<"tracked">> = {}) => t.run(async (ctx) =>
    await ctx.db.insert("tracked", { profileId, source: "simkl", ...entry, status: "plantowatch", ...extra }));
  const table = <T extends "library" | "viewing" | "feedback" | "syncOutbox">(name: T) =>
    t.run(async (ctx) => await ctx.db.query(name).collect());
  const save = (saved: boolean) => t.mutation(api.library.toggle, { token, item: { type: page.type, imdbId: imdb, name: page.name, year: page.year }, saved });
  return { t, profileId, tracked, table, save };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); vi.stubEnv("SIMKL_CLIENT_ID", "fake-client"); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("which ids are one title", () => {
  test("an IMDb id carried by one tracked entry is its alias", () => {
    expect([...aliasesOf([{ id: kitsu, imdb }, { id: "tt0047478" }])]).toEqual([[imdb, kitsu]]);
  });

  test("an IMDb id shared by two seasons, or tracked itself, stays its own title", () => {
    expect(aliasesOf([{ id: "kitsu:8699", imdb: "tt3909224" }, { id: "kitsu:12633", imdb: "tt3909224" }]).size).toBe(0);
    expect(aliasesOf([{ id: kitsu, imdb }, { id: imdb }]).size).toBe(0);
  });
});

describe("one title under two ids", () => {
  test("saving from the IMDb page of an anime Simkl has saves it once, under the Kitsu id", async () => {
    const { t, tracked, table, save } = await fixture();
    await tracked();
    await save(true);
    expect((await table("library")).map((r) => r.imdbId)).toEqual([kitsu]);
    expect(await t.query(api.library.statusFor, { token, id: imdb })).toMatchObject({ state: "plantowatch", saved: true });
    expect((await t.query(api.library.overview, { token, separateStatuses: true })).list).toMatchObject([{ id: kitsu, imdb }]);
  });

  test("unsaving on the IMDb page never asks Simkl to delete the anime's history", async () => {
    const { t, tracked, table, save } = await fixture();
    // Simkl moved the show to Plan to watch after an earlier save from this page, with 8 episodes watched.
    await tracked({ watched: "1:1-8", watchedEpisodes: 8, totalEpisodes: 12 });
    await t.run(async (ctx) => {
      const profileId = (await ctx.db.query("profiles").first())!._id;
      await ctx.db.insert("library", { profileId, imdbId: imdb, type: "series", name: page.name, addedAt: now - 1000, source: "simkl" });
      await ctx.db.insert("viewing", { profileId, id: imdb, type: "series", name: page.name, state: "plantowatch", at: now - 1000, syncedAt: now - 500 });
    });
    await save(false);
    const ops = await table("syncOutbox");
    expect(ops.map((o) => o.op)).not.toContain("unplan");
    expect(ops).toMatchObject([{ op: "status", item: { id: kitsu, status: "watching" } }]);
    expect(await table("library")).toEqual([]);
  });

  test("Simkl reporting a title saved under its IMDb id merges it rather than adding a second", async () => {
    const { t, profileId, table, save } = await fixture();
    await save(true);
    const [plan] = await table("syncOutbox");
    expect(plan).toMatchObject({ op: "status", item: { id: imdb, status: "plantowatch" } });
    await t.mutation(internal.simkl.settle, { profileId, sent: [plan._id], retry: [] });
    vi.setSystemTime(now + 3_600_000);
    await t.mutation(internal.simkl.applyEntries, { profileId, entries: [{ ...entry, status: "plantowatch", addedAt: now + 60_000 }] });
    await t.mutation(internal.library.fromSimkl, { profileId, planned: [{ id: kitsu, type: "series", name: entry.name, poster: entry.poster, year: entry.year, addedAt: now + 60_000 }], notPlanned: [] });
    await t.mutation(internal.simkl.mergeAfterPull, { profileId, ids: [kitsu] });
    expect(await table("library")).toMatchObject([{ imdbId: kitsu, name: entry.name, addedAt: now, source: "simkl" }]);
    // The status was sent, so Simkl's copy of it takes over.
    expect(await table("viewing")).toEqual([]);
    expect(await t.query(api.library.statusFor, { token, id: imdb })).toMatchObject({ state: "plantowatch", saved: true, simkl: "plantowatch" });
    expect((await t.query(api.library.overview, { token, separateStatuses: true })).list.map((e) => e.id)).toEqual([kitsu]);
  });

  test("a score from the IMDb page is the anime's score, and Simkl echoing it back adds no second one", async () => {
    const { t, profileId, tracked, table } = await fixture();
    await tracked({ status: "completed", watchedEpisodes: 12, totalEpisodes: 12 });
    await t.mutation(api.ratings.save, { token, item: { id: imdb, type: "series", name: page.name }, rating: 9 });
    expect(await table("syncOutbox")).toMatchObject([{ op: "rate", item: { id: kitsu, rating: 9 } }]);
    await t.mutation(internal.simkl.settle, { profileId, sent: (await table("syncOutbox")).map((o) => o._id), retry: [] });
    await t.mutation(internal.simkl.applyEntries, { profileId, entries: [{ ...entry, status: "completed", rating: 9, ratedAt: now + 1000 }] });
    expect((await table("feedback")).map((f) => [f.id, f.rating])).toEqual([[kitsu, 9]]);
    expect(await t.query(api.ratings.details, { token, id: imdb })).toMatchObject({ rating: 9, watchStatus: "completed" });
  });

  test("an IMDb id shared by two tracked seasons is saved as itself", async () => {
    const { tracked, table, save } = await fixture();
    await tracked({ imdb: "tt-other" });
    await tracked({ externalId: 2, id: "kitsu:1", imdb });
    await tracked({ externalId: 3, id: "kitsu:2", imdb });
    await save(true);
    expect((await table("library")).map((r) => r.imdbId)).toEqual([imdb]);
  });

  test("playing under the IMDb id and Simkl's history under the Kitsu id make one card", async () => {
    const { t, tracked } = await fixture();
    await tracked({ status: "watching", watched: "1:1-3", watchedEpisodes: 3, totalEpisodes: 12 });
    await t.mutation(api.progress.save, { token, position: 600, duration: 1440,
      media: { imdbId: imdb, videoId: `${imdb}:1:4`, type: "series", name: page.name, season: 1, episode: 4 } });
    const library = await t.query(api.library.overview, { token, separateStatuses: true });
    // One card, opening the page it was played on, where Play carries on.
    expect(Object.values(library).flat().map((e) => e.id)).toEqual([imdb]);
  });
});

describe("edges", () => {
  test("\"I didn't watch this\" on the IMDb page keeps its plays hidden after Simkl drops the entry", async () => {
    const { t, profileId, tracked, table } = await fixture();
    await tracked({ status: "completed", watchedEpisodes: 12, totalEpisodes: 12 });
    await t.mutation(api.progress.save, { token, position: 1440, duration: 1440,
      media: { imdbId: imdb, videoId: `${imdb}:1:1`, type: "series", name: page.name, season: 1, episode: 1 } });
    vi.setSystemTime(now + 60_000);
    await t.mutation(api.library.markUnwatched, { token, item: { id: imdb, type: "series", name: page.name } });
    // Plays waiting under the IMDb id would put it back on Simkl right after the removal.
    expect((await table("syncOutbox")).map((o) => `${o.op} ${o.item.id}`)).toEqual([`unwatch ${kitsu}`]);
    await t.mutation(internal.simkl.removeMissing, { profileId, keep: [] });
    expect(await t.query(api.progress.started, { token })).toEqual([]);
    expect(await t.query(api.library.statusFor, { token, id: imdb })).toMatchObject({ state: null });
  });

  test("two seasons arriving in one pull leave their shared IMDb id's choices alone", async () => {
    const { t, profileId, table, save } = await fixture();
    await save(true);
    await t.mutation(internal.simkl.settle, { profileId, sent: (await table("syncOutbox")).map((o) => o._id), retry: [] });
    const seasons = [{ ...entry, status: "plantowatch" as const }, { ...entry, externalId: 2, id: "kitsu:2", name: "Season 2", status: "plantowatch" as const }];
    await t.mutation(internal.simkl.applyEntries, { profileId, entries: seasons });
    await t.mutation(internal.simkl.mergeAfterPull, { profileId, ids: [kitsu, "kitsu:2"] });
    expect((await table("library")).map((r) => r.imdbId)).toEqual([imdb]);
  });

  test("saving and unsaving an IMDb id shared by two seasons never removes their history", async () => {
    const { t, profileId, tracked, table, save } = await fixture();
    await tracked({ status: "watching", watched: "1:1-5", watchedEpisodes: 5, lastWatchedAt: now - 1000 });
    await tracked({ externalId: 2, id: "kitsu:2", name: "Season 2" });
    await save(true);
    // Whatever the save sent has landed, so the unsave can't just cancel it.
    await t.mutation(internal.simkl.settle, { profileId, sent: (await table("syncOutbox")).map((o) => o._id), retry: [] });
    await save(false);
    expect((await table("syncOutbox")).map((o) => o.op)).not.toContain("unplan");
    expect(await table("library")).toEqual([]);
  });
});

describe("copies saved before titles were merged", () => {
  async function twins() {
    const f = await fixture();
    await f.tracked({ status: "completed", watchedEpisodes: 12, totalEpisodes: 12 });
    await f.t.run(async (ctx) => {
      await ctx.db.insert("library", { profileId: f.profileId, imdbId: imdb, type: "series", name: page.name, addedAt: now - 5000, source: "simkl" });
      await ctx.db.insert("library", { profileId: f.profileId, imdbId: kitsu, type: "series", name: entry.name, addedAt: now - 1000, source: "simkl" });
      await ctx.db.insert("feedback", { profileId: f.profileId, id: imdb, type: "series", name: page.name, value: "up", rating: 8, at: now - 4000 });
      await ctx.db.insert("viewing", { profileId: f.profileId, id: imdb, type: "series", name: page.name, state: "hold", at: now - 3000 });
    });
    return f;
  }

  test("show as one title everywhere", async () => {
    const { t } = await twins();
    const library = await t.query(api.library.overview, { token, separateStatuses: true });
    expect(library.list.map((e) => e.id)).toEqual([kitsu]);
    expect(library.hold).toMatchObject([{ id: kitsu, rating: 8 }]);
    expect(library.watched).toEqual([]);
    expect(await t.query(api.library.mine, { token })).toEqual([{ id: kitsu, tracked: "completed", local: "hold", saved: true, rating: 8 }]);
  });

  test("the cleanup lists them on a dry run, then merges them", async () => {
    const { t, table } = await twins();
    const dry = await t.mutation(internal.library.mergeAliases, {});
    expect(dry.moved).toHaveLength(3);
    expect(await table("library")).toHaveLength(2);
    await t.mutation(internal.library.mergeAliases, { dryRun: false });
    expect(await table("library")).toMatchObject([{ imdbId: kitsu, addedAt: now - 5000 }]);
    expect(await table("feedback")).toMatchObject([{ id: kitsu, rating: 8 }]);
    expect(await table("viewing")).toMatchObject([{ id: kitsu, state: "hold", name: entry.name }]);
  });
});

describe("Simkl's answer", () => {
  test("a title Simkl couldn't match doesn't flag another with the same name", async () => {
    const { t, profileId } = await fixture();
    const dune = (id: string, year: string) => ({ id, type: "movie" as const, name: "Dune", year });
    await t.mutation(api.library.setStatus, { token, item: dune("tt0087182", "1984"), state: "dropped" });
    await t.mutation(api.library.setStatus, { token, item: dune("tt1160419", "2021"), state: "dropped" });
    vi.setSystemTime(now + 50_000);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ not_found: { movies: [{ title: "Dune", ids: { imdb: "tt0087182" } }] } })));
    await t.action(internal.simkl.flush, { profileId });
    expect(await t.query(api.library.statusFor, { token, id: "tt0087182" })).toMatchObject({ syncError: expect.stringContaining("couldn't match") });
    expect((await t.query(api.library.statusFor, { token, id: "tt1160419" })).syncError).toBeUndefined();
  });
});

describe("stats", () => {
  test("an episode played under the IMDb id and echoed by Simkl counts once", () => {
    const rest = { feedback: [], viewing: [], library: [], unwatched: [] };
    const titles = assemble(
      [{ id: kitsu, imdb, type: "series", name: entry.name, status: "watching", watched: "1:1-3", watchedEpisodes: 3 }],
      [{ imdbId: imdb, type: "series", name: page.name, season: 1, episode: 2, position: 1440, duration: 1440, finished: true,
        startedAt: now - 1_500_000, updatedAt: now }],
      rest);
    expect(titles).toHaveLength(1);
    expect(titles[0]).toMatchObject({ id: kitsu, anime: true, watchedEpisodes: 3 });
    expect(titles[0].events).toHaveLength(3);
  });
});
