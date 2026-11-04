/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import schema from "../convex/schema";
import { sha256 } from "../convex/lib/auth";

const modules = import.meta.glob(["../convex/**/*.ts", "../convex/**/*.js", "!../convex/**/*.d.ts"]);

afterEach(() => vi.unstubAllGlobals());

/** A party playing the host account's TorBox stream, with a friend from another account in it. */
async function fixture() {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("#EXTM3U\nseg0.ts\n")));
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    const account = async (name: string, key: string) => {
      const accountId = await ctx.db.insert("accounts", { name, createdAt: now });
      await ctx.db.insert("accountKeys", { accountId, debrid: { service: "torbox", key }, updatedAt: now });
      return accountId;
    };
    const profile = async (name: string, accountId: Id<"accounts">, token: string) => {
      const profileId = await ctx.db.insert("profiles", {
        name, hue: 145, passwordHash: "unused", salt: "unused", order: 0, failedAttempts: 0, prefs: { audioLang: "eng", sounds: false }, accountId,
      });
      await ctx.db.insert("sessions", { profileId, tokenHash: await sha256(token), createdAt: now });
      return profileId;
    };
    const mine = await account("Host", "host-key");
    const other = await account("Other", "other-key");
    const host = await profile("Host", mine, "host");
    const sibling = await profile("Sibling", mine, "sibling");
    const friend = await profile("Friend", other, "friend");
    await profile("Stranger", other, "stranger");
    const streamId = await ctx.db.insert("streams", {
      torrentId: 7, fileId: 3, presignedToken: "p", domain: "https://cdn.test", audios: [], createdAt: now, accountId: mine,
    });
    const roomId = await ctx.db.insert("rooms", {
      hostId: host, hostAccountId: mine, kind: "party", media: { type: "movie", imdbId: "tt100", videoId: "tt100", name: "Film" }, status: "ready", streamId,
      playback: { playing: true, position: 0, anchorAt: now, seq: 0 }, createdAt: now, lastActiveAt: now,
    });
    const member = async (profileId: Id<"profiles">) =>
      await ctx.db.insert("roomMembers", { roomId, profileId, joinedAt: now, lastSeenAt: now, buffering: false, position: 0, left: false });
    await member(host);
    const friendRow = await member(friend);
    return { streamId, roomId, friendRow, sibling };
  });
  const status = async (token: string) => (await t.fetch(`/hls/playlist.m3u8?s=${ids.streamId}&a=0&t=${token}`)).status;
  return { t, status, ...ids };
}

describe("who may load a stream's playlist", () => {
  test("the host's account and the room's members, nobody else", async () => {
    const { status } = await fixture();
    expect([await status("host"), await status("sibling"), await status("friend"), await status("stranger"), await status("nobody")]).toEqual([
      200, 200, 200, 403, 401,
    ]);
  });

  test("a member who was kicked or left stops getting it; one the sweep counted as gone still does", async () => {
    const { t, status, friendRow } = await fixture();
    await t.run(async (ctx) => await ctx.db.patch(friendRow, { left: true, swept: true }));
    expect(await status("friend")).toBe(200);
    await t.run(async (ctx) => await ctx.db.patch(friendRow, { left: true, swept: false }));
    expect(await status("friend")).toBe(403);
    await t.run(async (ctx) => await ctx.db.patch(friendRow, { left: true, swept: false, kicked: true }));
    expect(await status("friend")).toBe(403);
  });

  test("once the party ends or moves to another stream, a friend's old stream id stops working", async () => {
    const { t, status, roomId } = await fixture();
    await t.run(async (ctx) => {
      const room = (await ctx.db.get(roomId))!;
      const next = await ctx.db.insert("streams", { torrentId: 8, fileId: 1, presignedToken: "q", domain: "https://cdn.test", audios: [], createdAt: Date.now(), accountId: room.hostAccountId });
      await ctx.db.patch(roomId, { streamId: next });
    });
    expect([await status("friend"), await status("host")]).toEqual([403, 200]);
    await t.run(async (ctx) => await ctx.db.patch(roomId, { closedAt: Date.now() }));
    expect([await status("friend"), await status("host")]).toEqual([403, 200]);
  });
});

describe("warming a title for a room", () => {
  const media = { type: "movie" as const, imdbId: "tt200", videoId: "tt200", name: "Next film" };
  const scheduled = (t: Awaited<ReturnType<typeof fixture>>["t"]) => t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).length);

  test("spends the host's keys only for someone in that room", async () => {
    const { t, roomId, friendRow } = await fixture();
    await expect(t.mutation(api.rooms.warm, { token: "stranger", media, roomId })).rejects.toThrow("You're not in this party");
    await t.run(async (ctx) => await ctx.db.patch(friendRow, { left: true, swept: false }));
    await expect(t.mutation(api.rooms.warm, { token: "friend", media, roomId })).rejects.toThrow("You left this party");
    expect(await scheduled(t)).toBe(0);
    await t.mutation(api.rooms.warm, { token: "host", media, roomId });
    expect(await scheduled(t)).toBe(1);
  });
});
