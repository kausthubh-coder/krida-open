/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import { household } from "./household";
import { sha256 } from "../convex/lib/auth";

const modules = import.meta.glob(["../convex/**/*.ts", "../convex/**/*.js", "!../convex/**/*.d.ts"]);
const now = Date.parse("2026-10-07T20:00:00Z");
const dune = { type: "movie" as const, imdbId: "tt15239678", videoId: "tt15239678", name: "Dune: Part Two" };

/** Two profiles, signed in, and an empty party one of them started for the other. */
async function party() {
  const t = convexTest(schema, modules);
  const accountId = await t.run((ctx) => household(ctx));
  const profile = async (name: string, token: string) =>
    await t.run(async (ctx) => {
      const id = await ctx.db.insert("profiles", {
        name, hue: 145, passwordHash: "unused", salt: "unused", order: 0,
        failedAttempts: 0, prefs: { audioLang: "en", sounds: false }, accountId,
      });
      await ctx.db.insert("sessions", { profileId: id, tokenHash: await sha256(token), createdAt: now });
      return id;
    });
  const host = await profile("Maya", "host");
  const friend = await profile("Ravi", "friend");
  const roomId = await t.mutation(api.rooms.createParty, { token: "host", inviteIds: [friend] });
  await t.mutation(api.rooms.join, { token: "friend", roomId });
  const room = () => t.query(api.rooms.get, { token: "host", roomId });
  return { t, roomId, host, friend, room };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("picking from the app with the Party panel", () => {
  test("an empty party starts out picking, with nothing to play yet", async () => {
    const { room } = await party();
    const r = await room();
    expect(r?.status).toBe("idle");
    expect(r?.media).toBeUndefined();
    expect(r?.members.map((m) => m.name).sort()).toEqual(["Maya", "Ravi"]);
  });

  test("browsing while picking counts as here, so both being in starts the countdown", async () => {
    const { t, roomId, room } = await party();
    // What the app sends from any page while the party is picking.
    await t.mutation(api.rooms.heartbeat, { token: "host", roomId, watching: true });
    await t.mutation(api.rooms.heartbeat, { token: "friend", roomId, watching: true });
    await t.mutation(api.rooms.suggest, { token: "host", roomId, media: dune });
    expect((await room())?.starting).toBeUndefined();

    const [suggestion] = (await room())!.suggestions;
    await t.mutation(api.rooms.vote, { token: "friend", roomId, suggestionId: suggestion.id, in: true });
    const starting = (await room())?.starting;
    expect(starting?.suggestionId).toBe(suggestion.id);

    // The countdown ends: the party is no longer picking, which sends everyone browsing to the player.
    await t.mutation(internal.rooms.startSuggestion, { roomId, suggestionId: suggestion.id, at: starting!.at });
    const started = await room();
    expect(started?.status).toBe("preparing");
    expect(started?.media?.videoId).toBe(dune.videoId);
    expect(started?.suggestions).toEqual([]);
  });

  test("someone only browsing (not picking) isn't waited for", async () => {
    const { t, roomId, room } = await party();
    await t.mutation(api.rooms.heartbeat, { token: "host", roomId, watching: true });
    await t.mutation(api.rooms.heartbeat, { token: "friend", roomId, watching: false });
    await t.mutation(api.rooms.suggest, { token: "host", roomId, media: dune });
    expect((await room())!.suggestions.map((s) => s.media.videoId)).toEqual([dune.videoId]);
    // Alone in the room, there's nobody to agree with: no countdown, Play now is the way.
    expect((await room())?.starting).toBeUndefined();
  });

  test("a friend arriving to pick can be the last one a suggestion was waiting for", async () => {
    const { t, roomId, room } = await party();
    await t.mutation(api.rooms.heartbeat, { token: "host", roomId, watching: true });
    await t.mutation(api.rooms.heartbeat, { token: "friend", roomId, watching: false });
    await t.mutation(api.rooms.suggest, { token: "host", roomId, media: dune });
    const [suggestion] = (await room())!.suggestions;
    await t.mutation(api.rooms.vote, { token: "friend", roomId, suggestionId: suggestion.id, in: true });
    expect((await room())?.starting).toBeUndefined();
    // Their app notices the party is picking and starts counting them as here.
    await t.mutation(api.rooms.heartbeat, { token: "friend", roomId, watching: true });
    expect((await room())?.starting?.suggestionId).toBe(suggestion.id);
  });

  test("back to picking clears what was on and keeps the party", async () => {
    const { t, roomId, room } = await party();
    await t.mutation(api.rooms.requestSwitch, { token: "host", roomId, media: dune });
    expect((await room())?.status).toBe("preparing");
    await t.mutation(api.rooms.stop, { token: "friend", roomId });
    const r = await room();
    expect(r?.status).toBe("idle");
    expect(r?.media).toBeUndefined();
    expect(r?.closedAt).toBeUndefined();
    expect((await t.query(api.rooms.mine, { token: "friend" }))?._id).toBe(roomId);
  });

  test("cancelling a countdown prevents its scheduled callback from starting playback", async () => {
    const { t, roomId, room } = await party();
    await t.mutation(api.rooms.suggest, { token: "host", roomId, media: dune });
    const [suggestion] = (await room())!.suggestions;
    await t.mutation(api.rooms.vote, { token: "friend", roomId, suggestionId: suggestion.id, in: true });
    const starting = (await room())!.starting!;
    await t.mutation(api.rooms.cancelStart, { token: "friend", roomId });
    await t.mutation(internal.rooms.startSuggestion, { roomId, suggestionId: suggestion.id, at: starting.at });
    expect((await room())?.status).toBe("idle");
    expect((await room())?.starting).toBeUndefined();
  });

  test("lining up a title while browsing leaves current playback alone", async () => {
    const { t, roomId, room } = await party();
    await t.mutation(api.rooms.requestSwitch, { token: "host", roomId, media: dune });
    const next = { type: "series" as const, imdbId: "tt11280740", videoId: "tt11280740:1:1", name: "Severance", season: 1, episode: 1 };
    await t.mutation(api.rooms.setNext, { token: "friend", roomId, media: next });
    expect((await room())?.media?.videoId).toBe(dune.videoId);
    expect((await room())?.next?.media.videoId).toBe(next.videoId);
    await t.mutation(api.rooms.clearNext, { token: "host", roomId });
    expect((await room())?.next).toBeUndefined();
    expect((await room())?.media?.videoId).toBe(dune.videoId);
  });
});

describe("watching the credits", () => {
  const episode = (n: number) => ({
    type: "series" as const, imdbId: "tt2560140", videoId: `tt2560140:1:${n}`, name: "Attack on Titan", season: 1, episode: n,
  });

  test("holds Up next for everyone on this episode, and the next episode starts fresh", async () => {
    const { t, roomId, host, room } = await party();
    await t.mutation(api.rooms.requestSwitch, { token: "host", roomId, media: episode(9) });
    await t.mutation(api.rooms.watchCredits, { token: "host", roomId, videoId: episode(9).videoId });
    expect((await t.query(api.rooms.get, { token: "friend", roomId }))?.credits).toEqual({ by: host, videoId: episode(9).videoId });

    // The episode ends and the countdown moves the room on.
    await t.run((ctx) => ctx.db.patch(roomId, { status: "ready" }));
    await t.mutation(api.rooms.advance, { token: "friend", roomId, fromVideoId: episode(9).videoId, media: episode(10), auto: true });
    expect((await room())?.media?.videoId).toBe(episode(10).videoId);
    expect((await room())?.credits).toBeUndefined();
  });

  test("a click from an episode that has already moved on does nothing", async () => {
    const { t, roomId, room } = await party();
    await t.mutation(api.rooms.requestSwitch, { token: "host", roomId, media: episode(10) });
    await t.mutation(api.rooms.watchCredits, { token: "friend", roomId, videoId: episode(9).videoId });
    expect((await room())?.credits).toBeUndefined();
    // The same click from the episode that's on holds Up next.
    await t.mutation(api.rooms.watchCredits, { token: "friend", roomId, videoId: episode(10).videoId });
    expect((await room())?.credits?.videoId).toBe(episode(10).videoId);
  });
});

describe("party chat", () => {
  test("a burst of reactions keeps only the newest few, so the conversation stays in the window", async () => {
    const { t, roomId } = await party();
    await t.mutation(api.messages.send, { token: "host", roomId, kind: "chat", body: "the opening scene" });
    for (let i = 0; i < 80; i++) {
      vi.setSystemTime(now + 1000 + i);
      await t.mutation(api.messages.send, { token: "friend", roomId, kind: "reaction", body: "😂" });
    }
    vi.setSystemTime(now + 5000);
    await t.mutation(api.messages.send, { token: "friend", roomId, kind: "chat", body: "lol" });
    const list = await t.query(api.messages.list, { token: "host", roomId });
    expect(list.filter((m) => m.kind === "chat").map((m) => m.body)).toEqual(["the opening scene", "lol"]);
    const reactions = list.filter((m) => m.kind === "reaction");
    expect(reactions).toHaveLength(12);
    // The newest ones, which are the ones still floating over the picture.
    expect(reactions.at(-1)!.createdAt).toBe(now + 1079);
    expect(list.map((m) => m.createdAt)).toEqual([...list.map((m) => m.createdAt)].sort((a, b) => a - b));
  });
});

describe("screens in the party", () => {
  const prepared = (t: Awaited<ReturnType<typeof party>>["t"]) =>
    t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect())
        .filter((f) => f.name.includes("prepare"))
        .map((f) => (f.args[0] as { screen?: string }).screen),
    );

  test("one SDR screen among them gets everyone an SDR copy, which looks right on both", async () => {
    const { t, roomId } = await party();
    await t.mutation(api.rooms.heartbeat, { token: "host", roomId, watching: true, screen: "hdr" });
    await t.mutation(api.rooms.heartbeat, { token: "friend", roomId, watching: true, screen: "sdr" });
    await t.mutation(api.rooms.playNow, { token: "host", roomId, media: dune });
    expect(await prepared(t)).toEqual(["sdr"]);
  });

  test("all on HDR screens keep HDR; someone browsing elsewhere doesn't count", async () => {
    const { t, roomId } = await party();
    await t.mutation(api.rooms.heartbeat, { token: "host", roomId, watching: true, screen: "hdr" });
    await t.mutation(api.rooms.heartbeat, { token: "friend", roomId, watching: false, screen: "sdr" });
    await t.mutation(api.rooms.playNow, { token: "host", roomId, media: dune });
    expect(await prepared(t)).toEqual(["hdr"]);
  });

  test("everyone in Krida for Windows gets the app's pick; one browser among them gets its own", async () => {
    const both = await party();
    await both.t.mutation(api.rooms.heartbeat, { token: "host", roomId: both.roomId, watching: true, screen: "app" });
    await both.t.mutation(api.rooms.heartbeat, { token: "friend", roomId: both.roomId, watching: true, screen: "app" });
    await both.t.mutation(api.rooms.playNow, { token: "host", roomId: both.roomId, media: dune });
    expect(await prepared(both.t)).toEqual(["app"]);
    const mixed = await party();
    await mixed.t.mutation(api.rooms.heartbeat, { token: "host", roomId: mixed.roomId, watching: true, screen: "app" });
    await mixed.t.mutation(api.rooms.heartbeat, { token: "friend", roomId: mixed.roomId, watching: true, screen: "hdr" });
    await mixed.t.mutation(api.rooms.playNow, { token: "host", roomId: mixed.roomId, media: dune });
    expect(await prepared(mixed.t)).toEqual(["hdr"]);
  });
});
