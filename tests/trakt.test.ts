/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import { sha256 } from "../convex/lib/auth";

const modules = import.meta.glob(["../convex/**/*.ts", "../convex/**/*.js", "!../convex/**/*.d.ts"]);
const token = "test-session";
const otherToken = "other-session";
const now = Date.parse("2026-10-07T20:00:00Z");
const iso = (t: number) => new Date(t).toISOString();
const DAY = 86_400_000;

const samurai = { title: "Seven Samurai", year: 1954, ids: { trakt: 1, slug: "seven-samurai-1954", imdb: "tt0047478", tmdb: 346 } };
const severance = { title: "Severance", year: 2022, ids: { trakt: 2, imdb: "tt11280740", tmdb: 95396 } };
const paprika = { title: "Paprika", year: 2006, ids: { trakt: 3, imdb: "tt0851578" } };
const dark = { title: "Dark", year: 2017, ids: { trakt: 4, imdb: "tt5753856" } };
// Trakt knows it, but without an IMDb id Krida can't open it.
const noImdb = { title: "Somewhere", year: 2001, ids: { trakt: 5, tmdb: 9 } };
const movieMedia = { type: "movie" as const, imdbId: "tt0047478", videoId: "tt0047478", name: "Seven Samurai", year: "1954" };

type Call = { method: string; path: string; params: URLSearchParams; body: any };
type Route = unknown | ((body: any, call: Call) => Response);

/** Trakt, as far as these tests need it: answers by method and path, and every request it got. */
function stubTrakt(routes: Record<string, Route>) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const call = { method: init.method ?? "GET", path: url.pathname, params: url.searchParams, body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const route = routes[`${call.method} ${call.path}`];
    if (route === undefined) return new Response("not here", { status: 404 });
    return typeof route === "function" ? (route as (body: any, call: Call) => Response)(call.body, call) : Response.json(route);
  }));
  return calls;
}

async function fixture({ connected = true } = {}) {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const profile = (name: string, order: number) => ctx.db.insert("profiles", {
      name, hue: 145, passwordHash: "unused", salt: "unused", order, failedAttempts: 0, prefs: { audioLang: "en", sounds: false },
    });
    const profileId = await profile("Test", 0);
    const otherId = await profile("Other", 1);
    await ctx.db.insert("sessions", { profileId, tokenHash: await sha256(token), createdAt: now });
    await ctx.db.insert("sessions", { profileId: otherId, tokenHash: await sha256(otherToken), createdAt: now });
    if (connected)
      await ctx.db.insert("traktConnections", { profileId, accessToken: "access-secret", refreshToken: "refresh-secret",
        expiresAt: now + 30 * DAY, writeBack: true, connectedAt: now - DAY });
    return { profileId, otherId };
  });
  const outbox = () => t.run(async (ctx) => await ctx.db.query("traktOutbox").collect());
  const table = <T extends "progress" | "library" | "feedback">(name: T) => t.run(async (ctx) => await ctx.db.query(name).collect());
  return { t, ...ids, outbox, table };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.stubEnv("TRAKT_CLIENT_ID", "fake-client");
  vi.stubEnv("TRAKT_CLIENT_SECRET", "fake-secret");
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("connecting with a device code", () => {
  const device = { device_code: "device-secret", user_code: "ABCD1234", verification_url: "https://trakt.tv/activate", expires_in: 600, interval: 5 };

  test("tokens are kept for this profile only, and neither they nor the device code reach the browser", async () => {
    const { t, profileId } = await fixture({ connected: false });
    let asked = 0;
    const calls = stubTrakt({
      "POST /oauth/device/code": device,
      // Pending once, then approved.
      "POST /oauth/device/token": () => ++asked === 1 ? new Response("{}", { status: 400 })
        : Response.json({ access_token: "access-secret", refresh_token: "refresh-secret", expires_in: 86_400, created_at: now / 1000 }),
      "GET /users/settings": { user: { username: "sam", name: "Sam" } },
    });
    expect(await t.query(api.trakt.enabled, {})).toBe(true);
    const shown = await t.action(api.trakt.start, { token });
    expect(shown).toEqual({ userCode: "ABCD1234", verificationUrl: "https://trakt.tv/activate", expiresAt: now + 600_000 });
    expect(await t.query(api.trakt.login, { token })).toEqual({ ...shown, over: null });
    const loginId = (await t.run(async (ctx) => await ctx.db.query("traktLogins").first()))!._id;

    await t.action(internal.trakt.poll, { loginId });
    expect(await t.query(api.trakt.status, { token })).toBeNull();
    await t.action(internal.trakt.poll, { loginId });

    expect(calls.filter((c) => c.path === "/oauth/device/token").map((c) => c.body)).toEqual([
      { code: "device-secret", client_id: "fake-client", client_secret: "fake-secret" },
      { code: "device-secret", client_id: "fake-client", client_secret: "fake-secret" },
    ]);
    const rows = await t.run(async (ctx) => await ctx.db.query("traktConnections").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ profileId, accessToken: "access-secret", refreshToken: "refresh-secret",
      expiresAt: now + DAY, account: { name: "Sam" }, writeBack: true, connectedAt: now });
    expect(await t.query(api.trakt.login, { token })).toBeNull();
    const status = await t.query(api.trakt.status, { token });
    expect(status).toEqual({ account: { name: "Sam" }, syncingSince: null, syncLease: 600_000, pausedUntil: null, imported: null,
      waiting: 0, lastSyncAt: null, lastError: null, needsReconnect: false, writeBack: true });
    expect(JSON.stringify([shown, status])).not.toMatch(/secret/);
    expect(await t.query(api.trakt.status, { token: otherToken })).toBeNull();
  });

  test("asking stops when the person says no or the code runs out", async () => {
    const { t } = await fixture({ connected: false });
    const calls = stubTrakt({ "POST /oauth/device/code": device, "POST /oauth/device/token": () => new Response("", { status: 418 }) });
    await t.action(api.trakt.start, { token });
    const loginId = (await t.run(async (ctx) => await ctx.db.query("traktLogins").first()))!._id;
    await t.action(internal.trakt.poll, { loginId });
    expect(await t.query(api.trakt.login, { token })).toMatchObject({ over: "denied" });
    await t.action(internal.trakt.poll, { loginId });
    expect(calls.filter((c) => c.path === "/oauth/device/token")).toHaveLength(1);

    await t.action(api.trakt.start, { token });
    const second = (await t.run(async (ctx) => await ctx.db.query("traktLogins").first()))!._id;
    vi.setSystemTime(now + 600_001);
    await t.action(internal.trakt.poll, { loginId: second });
    expect(await t.query(api.trakt.login, { token })).toMatchObject({ over: "expired" });
    expect(calls.filter((c) => c.path === "/oauth/device/token")).toHaveLength(1);
    expect(await t.query(api.trakt.status, { token })).toBeNull();
  });

  test("without the server's Trakt app, connecting says so and changes nothing", async () => {
    vi.unstubAllEnvs();
    const { t } = await fixture({ connected: false });
    const calls = stubTrakt({});
    expect(await t.query(api.trakt.enabled, {})).toBe(false);
    await expect(t.action(api.trakt.start, { token })).rejects.toThrow("Trakt isn’t set up on this server.");
    expect(calls).toEqual([]);
  });
});

describe("importing", () => {
  const activities = {
    all: "2026-10-07T19:00:00.000Z",
    movies: { watched_at: "2026-10-01T20:00:00.000Z", paused_at: "2026-10-05T20:00:00.000Z", watchlisted_at: "2026-09-01T00:00:00.000Z", rated_at: "2026-10-02T00:00:00.000Z" },
    episodes: { watched_at: "2026-09-02T00:00:00.000Z", paused_at: "2026-10-05T20:00:00.000Z" },
    shows: { watchlisted_at: "2026-09-01T00:00:00.000Z", rated_at: "2026-10-03T00:00:00.000Z" },
  };
  const library = {
    "GET /sync/last_activities": activities,
    "GET /sync/watched/movies": [
      { plays: 2, last_watched_at: "2026-10-01T20:00:00.000Z", last_updated_at: "2026-10-01T20:00:00.000Z", movie: samurai },
      { plays: 1, last_watched_at: "2026-10-01T20:00:00.000Z", last_updated_at: "2026-10-01T20:00:00.000Z", movie: noImdb },
    ],
    "GET /sync/watched/shows": [{
      plays: 2, last_watched_at: "2026-09-02T00:00:00.000Z", last_updated_at: "2026-09-02T00:00:00.000Z", show: severance,
      seasons: [{ number: 1, episodes: [
        { number: 1, plays: 1, last_watched_at: "2026-09-01T00:00:00.000Z" },
        { number: 2, plays: 1, last_watched_at: "2026-09-02T00:00:00.000Z" },
      ] }],
    }],
    "GET /sync/playback": [{ progress: 50, paused_at: "2026-10-05T20:00:00.000Z", id: 9, type: "episode",
      episode: { season: 1, number: 3, title: "In Perpetuity", runtime: 60, ids: { trakt: 30 } }, show: severance }],
    "GET /sync/watchlist/movies": [{ rank: 1, listed_at: "2026-09-01T00:00:00.000Z", type: "movie", movie: paprika }],
    "GET /sync/watchlist/shows": [{ rank: 2, listed_at: "2026-08-01T00:00:00.000Z", type: "show", show: dark }],
    "GET /sync/ratings/movies": [{ rated_at: "2026-10-02T00:00:00.000Z", rating: 10, type: "movie", movie: samurai }],
    "GET /sync/ratings/shows": [{ rated_at: "2026-10-03T00:00:00.000Z", rating: 8, type: "show", show: severance }],
  };
  const t0 = (s: string) => Date.parse(s);

  test("the first sync fills progress, Plan to watch and ratings, and sends nothing back", async () => {
    const { t, profileId, outbox, table } = await fixture();
    stubTrakt(library);
    await t.action(internal.trakt.sync, { profileId });

    const progress = (await table("progress")).map(({ profileId: p, media, position, duration, finished, hidden, updatedAt }) =>
      ({ p, media, position, duration, finished, hidden, updatedAt })).sort((a, b) => a.media.videoId.localeCompare(b.media.videoId));
    expect(progress).toEqual([
      { p: profileId, media: movieMedia, position: 0, duration: 0, finished: true, hidden: false, updatedAt: t0("2026-10-01T20:00:00Z") },
      ...[1, 2].map((episode) => ({ p: profileId, media: { type: "series", imdbId: "tt11280740", videoId: `tt11280740:1:${episode}`,
        name: "Severance", year: "2022", season: 1, episode }, position: 0, duration: 0, finished: true, hidden: false,
        updatedAt: t0(`2026-09-0${episode}T00:00:00Z`) })),
      { p: profileId, media: { type: "series", imdbId: "tt11280740", videoId: "tt11280740:1:3", name: "Severance", year: "2022", season: 1, episode: 3 },
        position: 1800, duration: 3600, finished: false, hidden: false, updatedAt: t0("2026-10-05T20:00:00Z") },
    ]);
    expect((await table("library")).map(({ imdbId, type, name, year, addedAt, trakt }) => ({ imdbId, type, name, year, addedAt, trakt }))).toEqual([
      { imdbId: "tt0851578", type: "movie", name: "Paprika", year: "2006", addedAt: t0("2026-09-01T00:00:00Z"), trakt: true },
      { imdbId: "tt5753856", type: "series", name: "Dark", year: "2017", addedAt: t0("2026-08-01T00:00:00Z"), trakt: true },
    ]);
    expect((await table("feedback")).map(({ id, type, name, value, rating, at }) => ({ id, type, name, value, rating, at }))).toEqual([
      { id: "tt0047478", type: "movie", name: "Seven Samurai", value: "love", rating: 10, at: t0("2026-10-02T00:00:00Z") },
      { id: "tt11280740", type: "series", name: "Severance", value: "up", rating: 8, at: t0("2026-10-03T00:00:00Z") },
    ]);
    expect(await t.query(api.trakt.status, { token })).toMatchObject({ imported: { plays: 3, planned: 2, rated: 2 }, lastSyncAt: now, lastError: null });
    expect(await outbox()).toEqual([]);
    expect(await t.run(async (ctx) => await ctx.db.query("syncOutbox").collect())).toEqual([]);
  });

  test("a later sync fetches only what moved, keeps newer choices made in Krida, and follows the watchlist", async () => {
    const { t, profileId, table } = await fixture();
    stubTrakt(library);
    await t.action(internal.trakt.sync, { profileId });
    // Rated again in Krida after Trakt's score.
    await t.mutation(api.ratings.save, { token, item: { id: "tt11280740", type: "series", name: "Severance" }, rating: 6 });
    await t.run(async (ctx) => { for (const row of await ctx.db.query("traktOutbox").collect()) await ctx.db.delete(row._id); });

    vi.setSystemTime(now + 20 * 60_000);
    const later = { ...activities, all: "2026-10-07T20:10:00.000Z",
      episodes: { ...activities.episodes, watched_at: "2026-10-07T20:05:00.000Z" },
      movies: { ...activities.movies, watchlisted_at: "2026-10-07T20:06:00.000Z" },
      shows: { ...activities.shows, rated_at: "2026-10-07T20:07:00.000Z" } };
    const calls = stubTrakt({
      ...library,
      "GET /sync/last_activities": later,
      "GET /sync/watched/shows": [{
        last_watched_at: "2026-10-07T20:05:00.000Z", last_updated_at: "2026-10-07T20:05:00.000Z", show: severance,
        seasons: [{ number: 1, episodes: [{ number: 3, plays: 1, last_watched_at: "2026-10-07T20:05:00.000Z" }] }],
      }],
      "GET /sync/watchlist/movies": [],
      // Older than Krida's 6.
      "GET /sync/ratings/shows": [{ rated_at: "2026-10-03T00:00:00.000Z", rating: 8, type: "show", show: severance }],
    });
    await t.action(internal.trakt.sync, { profileId });

    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /sync/last_activities", "GET /sync/watched/shows", "GET /sync/watchlist/movies", "GET /sync/watchlist/shows",
      "GET /sync/ratings/movies", "GET /sync/ratings/shows",
    ]);
    const episode3 = (await table("progress")).find((r) => r.media.videoId === "tt11280740:1:3");
    expect(episode3).toMatchObject({ finished: true, position: 1800, updatedAt: t0("2026-10-07T20:05:00Z") });
    expect((await table("library")).map((r) => r.imdbId)).toEqual(["tt5753856"]);
    expect((await table("feedback")).find((r) => r.id === "tt11280740")).toMatchObject({ rating: 6 });
  });
});

describe("sending changes to Trakt", () => {
  const sentBody = (at: number) => ({ movies: [{ title: "Seven Samurai", year: 1954, ids: { imdb: "tt0047478" }, watched_at: iso(at) }], shows: [] });

  test("a finished movie queues one play, sent once, and retried after a failure", async () => {
    const { t, profileId, outbox } = await fixture();
    await t.mutation(api.progress.save, { token, media: movieMedia, position: 5_600, duration: 6_000 });
    await t.mutation(api.progress.save, { token, media: movieMedia, position: 5_990, duration: 6_000, final: true });
    expect(await outbox()).toMatchObject([{ op: "watched", key: "watched:tt0047478::", attempts: 0, at: now, nextAt: now + 45_000,
      item: { id: "tt0047478", type: "movie", name: "Seven Samurai", year: "1954" } }]);

    vi.setSystemTime(now + 50_000);
    let answer = 500;
    const calls = stubTrakt({ "POST /sync/history": () => answer === 500 ? new Response("down", { status: 500 })
      : Response.json({ added: { movies: 1, episodes: 0 }, not_found: { movies: [], shows: [], episodes: [] } }, { status: 201 }) });
    await t.action(internal.trakt.flush, { profileId });
    expect(await outbox()).toMatchObject([{ op: "watched", attempts: 1, nextAt: now + 50_000 + 60_000 }]);
    expect(await t.query(api.trakt.status, { token })).toMatchObject({ waiting: 1, lastError: "Couldn’t reach Trakt. Krida tries again next time you open it." });

    vi.setSystemTime(now + 115_000);
    answer = 201;
    await t.action(internal.trakt.flush, { profileId });
    await t.action(internal.trakt.flush, { profileId });
    expect(calls.map((c) => [c.method, c.path, c.body])).toEqual([
      ["POST", "/sync/history", sentBody(now)],
      ["POST", "/sync/history", sentBody(now)],
    ]);
    expect(await outbox()).toEqual([]);
    expect(await t.query(api.trakt.status, { token })).toMatchObject({ waiting: 0, lastError: null });
  });

  test("saved to Plan to watch and finished before sending: one play and no watchlist change", async () => {
    const { t, outbox } = await fixture();
    await t.mutation(api.library.toggle, { token, item: { type: "movie", imdbId: "tt0047478", name: "Seven Samurai", year: "1954" }, saved: true });
    expect((await outbox()).map((r) => r.op)).toEqual(["plan"]);
    await t.mutation(api.progress.save, { token, media: movieMedia, position: 5_600, duration: 6_000 });
    expect((await outbox()).map((r) => [r.op, r.key])).toEqual([["watched", "watched:tt0047478::"]]);
  });

  test("an anime episode goes to Trakt as the IMDb episode it stands for", async () => {
    const { t, outbox } = await fixture();
    await t.mutation(api.progress.save, { token, position: 1_400, duration: 1_440, media: {
      type: "series", imdbId: "kitsu:1376", videoId: "kitsu:1376:5", name: "Death Note", episode: 5,
      ref: { imdbId: "tt0877057", season: 1, episode: 5 } } });
    expect((await outbox()).map((r) => r.item)).toEqual([{ id: "tt0877057", type: "series", name: "Death Note", season: 1, episode: 5 }]);
  });

  test("unmarking an episode and clearing a score are sent as removals", async () => {
    const { t, profileId, outbox } = await fixture();
    const episode = { type: "series" as const, imdbId: "tt11280740", videoId: "tt11280740:1:1", name: "Severance", season: 1, episode: 1 };
    await t.mutation(api.progress.mark, { token, episodes: [episode], watched: true });
    await t.mutation(api.progress.mark, { token, episodes: [episode], watched: false });
    // Marked then unmarked before sending: nothing to tell Trakt. Unmarked again: Trakt may have it from elsewhere.
    expect(await outbox()).toEqual([]);
    await t.mutation(api.progress.mark, { token, episodes: [episode], watched: false });
    // A show's score (a movie's would also mark it watched).
    await t.mutation(api.ratings.save, { token, item: { id: "tt5753856", type: "series", name: "Dark" }, rating: 9 });
    await t.mutation(api.ratings.save, { token, item: { id: "tt5753856", type: "series", name: "Dark" }, rating: null });
    expect((await outbox()).map((r) => [r.op, r.key, r.item.rating])).toEqual([
      ["unwatch", "watched:tt11280740:1:1", undefined],
      ["rate", "rate:tt5753856", 0],
    ]);
    vi.setSystemTime(now + 50_000);
    const calls = stubTrakt({
      "POST /sync/history/remove": { deleted: { episodes: 1 }, not_found: {} },
      "POST /sync/ratings/remove": { deleted: { shows: 1 }, not_found: {} },
    });
    const flush = t.action(internal.trakt.flush, { profileId });
    await vi.advanceTimersByTimeAsync(2_000);
    await flush;
    expect(calls.map((c) => [c.path, c.body])).toEqual([
      ["/sync/history/remove", { movies: [], shows: [{ title: "Severance", ids: { imdb: "tt11280740" }, seasons: [{ number: 1, episodes: [{ number: 1 }] }] }] }],
      ["/sync/ratings/remove", { movies: [], shows: [{ title: "Dark", ids: { imdb: "tt5753856" } }] }],
    ]);
    expect(await outbox()).toEqual([]);
  });

  test("with write-back off, or for another profile, nothing is queued", async () => {
    const { t, profileId, outbox } = await fixture();
    await t.mutation(api.trakt.setWriteBack, { token, writeBack: false });
    await t.mutation(api.progress.save, { token, media: movieMedia, position: 5_600, duration: 6_000 });
    await t.mutation(api.progress.save, { token: otherToken, media: { ...movieMedia, videoId: "tt0047478" }, position: 5_600, duration: 6_000 });
    expect(await outbox()).toEqual([]);
    expect((await t.run(async (ctx) => await ctx.db.query("traktConnections").collect())).map((c) => [c.profileId, c.writeBack])).toEqual([[profileId, false]]);
  });
});

test("disconnecting deletes the tokens and waiting changes, and revokes the grant", async () => {
  const { t, profileId, outbox, table } = await fixture();
  await t.run(async (ctx) => {
    await ctx.db.insert("library", { profileId, type: "movie", imdbId: "tt0851578", name: "Paprika", addedAt: now, trakt: true });
  });
  await t.mutation(api.progress.save, { token, media: movieMedia, position: 5_600, duration: 6_000 });
  expect(await outbox()).toHaveLength(1);
  const calls = stubTrakt({ "POST /oauth/revoke": {} });
  await t.mutation(api.trakt.disconnect, { token });
  expect(await t.run(async (ctx) => await ctx.db.query("traktConnections").collect())).toEqual([]);
  expect(await outbox()).toEqual([]);
  expect(await t.query(api.trakt.status, { token })).toBeNull();
  // What the import brought in stays, and no longer follows Trakt.
  expect((await table("library")).map((r) => [r.imdbId, r.trakt])).toEqual([["tt0851578", undefined]]);
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(calls.map((c) => [c.method, c.path, c.body])).toEqual([
    ["POST", "/oauth/revoke", { token: "access-secret", client_id: "fake-client", client_secret: "fake-secret" }],
  ]);
});

test("a run whose token Trakt refuses asks to connect again", async () => {
  const { t, profileId } = await fixture();
  stubTrakt({ "GET /sync/last_activities": () => new Response("", { status: 401 }), "POST /oauth/token": () => new Response("{}", { status: 401 }) });
  await t.action(internal.trakt.sync, { profileId });
  expect(await t.query(api.trakt.status, { token })).toMatchObject({ needsReconnect: true,
    lastError: "Trakt signed Krida out. Connect again to keep your history in sync." });
});

test("no cron calls Trakt", async () => {
  const { default: crons } = (await import("../convex/crons")) as { default: { crons: Record<string, { name: string }> } };
  const targets = Object.values(crons.crons).map((c) => c.name);
  expect(targets.length).toBeGreaterThan(0);
  expect(targets.filter((name) => /^trakt[:/.]/.test(name))).toEqual([]);
});
