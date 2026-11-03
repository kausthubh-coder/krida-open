/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import schema from "../convex/schema";
import { household } from "./household";
import { sha256 } from "../convex/lib/auth";

const modules = import.meta.glob(["../convex/**/*.ts", "../convex/**/*.js", "!../convex/**/*.d.ts"]);
const now = Date.parse("2026-10-12T20:00:00Z");
const prefs = { audioLang: "eng", sounds: false };
const movie = (n: number) => ({ type: "movie" as const, imdbId: `tt100000${n}`, videoId: `tt100000${n}`, name: `Film ${n}` });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
});
afterEach(() => vi.useRealTimers());

async function fixture() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const accountId = await household(ctx);
    const me = await ctx.db.insert("profiles", { name: "Maya", hue: 60, passwordHash: "unused", salt: "unused", order: 0, failedAttempts: 0, prefs, accountId });
    const friend = await ctx.db.insert("profiles", { name: "Ravi", hue: 205, passwordHash: "unused", salt: "unused", order: 1, failedAttempts: 0, prefs, accountId });
    await ctx.db.insert("sessions", { profileId: me, tokenHash: await sha256("me"), createdAt: now });
    await ctx.db.insert("sessions", { profileId: friend, tokenHash: await sha256("friend"), createdAt: now });
    return { me, friend };
  });
  return { t, ...ids };
}

async function room(t: Awaited<ReturnType<typeof fixture>>["t"], hostId: Id<"profiles">, kind: "solo" | "party") {
  await t.run(async (ctx) => {
    const roomId = await ctx.db.insert("rooms", {
      hostId, hostAccountId: (await ctx.db.get(hostId))!.accountId, kind, media: movie(9), status: "ready",
      playback: { playing: true, position: 0, anchorAt: now, seq: 0 }, createdAt: now, lastActiveAt: now,
    });
    await ctx.db.insert("roomMembers", { roomId, profileId: hostId, joinedAt: now, lastSeenAt: now, buffering: false, position: 0, left: false });
  });
}

describe("private mode", () => {
  test("plays made while private stay off the other's Home, even after it's turned off", async () => {
    const { t } = await fixture();
    await t.mutation(api.progress.save, { token: "friend", media: movie(1), position: 600, duration: 6000 });
    await t.mutation(api.profiles.update, { token: "friend", prefsPatch: { private: true } });
    await t.mutation(api.progress.save, { token: "friend", media: movie(2), position: 600, duration: 6000 });
    await t.mutation(api.profiles.update, { token: "friend", prefsPatch: { private: false } });

    const [row] = await t.query(api.catalogs.friends, { token: "me" });
    expect(row.items.map((i) => i.id)).toEqual(["tt1000001"]);
  });

  test("a private solo room isn't offered to join; a party still is", async () => {
    const { t, friend } = await fixture();
    await room(t, friend, "solo");
    expect(await t.query(api.rooms.live, { token: "me" })).toHaveLength(1);

    await t.mutation(api.profiles.update, { token: "friend", prefsPatch: { private: true } });
    expect(await t.query(api.rooms.live, { token: "me" })).toHaveLength(0);

    await room(t, friend, "party");
    expect((await t.query(api.rooms.live, { token: "me" })).map((r) => r.kind)).toEqual(["party"]);
  });
});
