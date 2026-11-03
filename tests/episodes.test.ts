/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import { sha256 } from "../convex/lib/auth";

const modules = import.meta.glob(["../convex/**/*.ts", "../convex/**/*.js", "!../convex/**/*.d.ts"]);
const token = "test-session";
const now = Date.parse("2026-10-07T20:00:00Z");
const show = { id: "tt0903747", type: "series" as const, name: "Breaking Bad" };
const ep = (season: number, episode: number) => ({
  type: "series" as const, imdbId: show.id, videoId: `${show.id}:${season}:${episode}`, season, episode, name: show.name,
});

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
  const outbox = () => t.run(async (ctx) => await ctx.db.query("syncOutbox").collect());
  const progress = () => t.query(api.progress.forTitle, { token, imdbId: show.id });
  const send = async () => {
    vi.setSystemTime(Date.now() + 50_000);
    const calls: { url: string; body: any }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(init.body as string) }); return Response.json({});
    }));
    const flush = t.action(internal.simkl.flush, { profileId });
    await vi.runAllTimersAsync(); await flush;
    return calls;
  };
  return { t, profileId, outbox, progress, send };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); vi.stubEnv("SIMKL_CLIENT_ID", "fake-client"); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("marking episodes from the episode list", () => {
  test("marked episodes are watched here and go to Simkl's history as those episodes", async () => {
    const { t, progress, send } = await fixture();
    await t.mutation(api.progress.mark, { token, episodes: [ep(1, 1), ep(1, 2)], watched: true });
    expect(await progress()).toMatchObject([{ episode: 2, finished: true }, { episode: 1, finished: true }]);
    const calls = await send();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/sync/history");
    expect(calls[0].body.shows).toMatchObject([{ ids: { imdb: show.id }, seasons: [{ number: 1, episodes: [{ number: 1 }, { number: 2 }] }] }]);
  });

  test("an old episode marked today lands before the furthest one, so Play carries on from there", async () => {
    const { t, progress } = await fixture();
    await t.mutation(api.progress.save, { token, media: ep(2, 5), position: 1500, duration: 1600 });
    vi.setSystemTime(now + 60_000);
    await t.mutation(api.progress.mark, { token, episodes: [ep(1, 3)], watched: true });
    expect((await progress()).map((r) => r.episode)).toEqual([5, 3]);
  });

  test("marking and unmarking before the send tells Simkl nothing", async () => {
    const { t, outbox } = await fixture();
    await t.mutation(api.progress.mark, { token, episodes: [ep(1, 4)], watched: true });
    expect((await outbox()).map((r) => r.op)).toEqual(["watched"]);
    await t.mutation(api.progress.mark, { token, episodes: [ep(1, 4)], watched: false });
    expect(await outbox()).toEqual([]);
  });

  test("unmarking an episode Simkl has removes just that play, and a pull before then doesn't bring it back", async () => {
    const { t, profileId, outbox, send } = await fixture();
    const entry = { externalId: 7, ...show, status: "watching" as const, watched: "1:1-3", watchedEpisodes: 3, watchedAt: "1:1@a,1:2@b,1:3@c" };
    await t.run(async (ctx) => { await ctx.db.insert("tracked", { profileId, source: "simkl", ...entry }); });
    await t.mutation(api.progress.mark, { token, episodes: [ep(1, 2)], watched: false });
    expect(await t.query(api.simkl.forTitle, { token, id: show.id })).toMatchObject({ watched: ["1:1", "1:3"], watchedEpisodes: 2 });
    expect(await outbox()).toMatchObject([{ op: "unwatch", item: { season: 1, episode: 2 } }]);

    await t.mutation(internal.simkl.applyEntries, { profileId, entries: [entry] });
    expect(await t.query(api.simkl.forTitle, { token, id: show.id })).toMatchObject({ watched: ["1:1", "1:3"] });

    const calls = await send();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/sync/history/remove");
    expect(calls[0].body.shows).toEqual([{ title: show.name, ids: { imdb: show.id }, seasons: [{ number: 1, episodes: [{ number: 2 }] }] }]);
    expect(await outbox()).toEqual([]);
  });

  test("while rewatching, marks stay in Krida and Simkl's history is left alone", async () => {
    const { t, profileId, outbox, progress } = await fixture();
    await t.run(async (ctx) => { await ctx.db.insert("tracked", { profileId, source: "simkl", externalId: 7, ...show, status: "completed", watched: "1:1-3" }); });
    await t.mutation(api.library.setStatus, { token, item: show, state: "rewatching" });
    vi.setSystemTime(now + 1_000);
    await t.mutation(api.progress.mark, { token, episodes: [ep(1, 1)], watched: true });
    await t.mutation(api.progress.save, { token, media: ep(1, 2), position: 1590, duration: 1600 });
    await t.mutation(api.progress.mark, { token, episodes: [ep(1, 3)], watched: false });
    expect(await outbox()).toEqual([]);
    expect(await progress()).toMatchObject([{ episode: 2, finished: true }, { episode: 1, finished: true }]);
    expect(await t.query(api.simkl.forTitle, { token, id: show.id })).toMatchObject({ watched: ["1:1", "1:2", "1:3"], rewatchingSince: now });
  });

  test("finishing an episode in the player goes to Simkl when not rewatching", async () => {
    const { t, outbox } = await fixture();
    await t.mutation(api.progress.save, { token, media: ep(1, 1), position: 1590, duration: 1600 });
    expect(await outbox()).toMatchObject([{ op: "watched", item: { season: 1, episode: 1 } }]);
  });
});
