/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import { household } from "./household";
import { sha256 } from "../convex/lib/auth";
import { TEMPORARY_PROFILE_TTL_MS } from "../convex/profiles";

const modules = import.meta.glob(["../convex/**/*.ts", "../convex/**/*.js", "!../convex/**/*.d.ts"]);
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-09T12:00:00Z")); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

async function fixture() {
  const t = convexTest(schema, modules);
  const accountId = await t.run((ctx) => household(ctx));
  const add = async (name: string, token: string) => t.run(async (ctx) => {
    const profileId = await ctx.db.insert("profiles", {
      name, hue: 145, passwordHash: "unused", salt: "unused", order: 0,
      failedAttempts: 0, prefs: { audioLang: "eng", sounds: false }, accountId,
    });
    await ctx.db.insert("sessions", { profileId, tokenHash: await sha256(token), createdAt: Date.now() });
    return profileId;
  });
  await add("Host", "host");
  await add("Friend", "friend");
  const roomId = await t.mutation(api.rooms.createParty, { token: "host", inviteIds: [] });
  return { t, roomId };
}

test("a host's one-use link creates a signed-in profile already in the party", async () => {
  const { t, roomId } = await fixture();
  const { code } = await t.mutation(api.profiles.inviteTemporary, { token: "host", roomId, name: "  Guest  " });
  expect((await t.query(api.profiles.temporaryInvite, { code }))?.name).toBe("Guest");
  const guest = await t.mutation(api.profiles.joinTemporary, { code });
  expect(guest.roomId).toBe(roomId);
  const me = await t.query(api.profiles.me, { token: guest.token });
  expect(me?.temporary).toBe(true);
  expect((await t.query(api.rooms.get, { token: guest.token, roomId }))?.members.map((p) => p.name)).toContain("Guest");
  await t.mutation(api.rooms.join, { token: guest.token, roomId });
  await t.mutation(api.messages.send, { token: guest.token, roomId, kind: "chat", body: "Hello" });
  expect(await t.query(api.profiles.temporaryInvite, { code })).toBeNull();
  await expect(t.mutation(api.profiles.joinTemporary, { code })).rejects.toThrow(/already used/);
  expect((await t.query(internal.wrapped.profiles, {})).map((p) => p.name)).toEqual(["Host", "Friend"]);
});

test("only the permanent host can create links, with valid names and a bounded guest count", async () => {
  const { t, roomId } = await fixture();
  await expect(t.mutation(api.profiles.inviteTemporary, { token: "friend", roomId, name: "Guest" })).rejects.toThrow(/Only the host/);
  for (const name of [" ", "a".repeat(25)])
    await expect(t.mutation(api.profiles.inviteTemporary, { token: "host", roomId, name })).rejects.toThrow(/1 to 24/);
  for (let i = 0; i < 8; i++) await t.mutation(api.profiles.inviteTemporary, { token: "host", roomId, name: `Guest ${i}` });
  await expect(t.mutation(api.profiles.inviteTemporary, { token: "host", roomId, name: "Extra" })).rejects.toThrow(/already has 8/);
});

test("expired links and closed parties cannot be redeemed", async () => {
  const { t, roomId } = await fixture();
  const { code } = await t.mutation(api.profiles.inviteTemporary, { token: "host", roomId, name: "Guest" });
  await t.run((ctx) => ctx.db.patch(roomId, { closedAt: Date.now() }));
  expect(await t.query(api.profiles.temporaryInvite, { code })).toBeNull();
  await expect(t.mutation(api.profiles.joinTemporary, { code })).rejects.toThrow(/party has ended/);
  await t.run((ctx) => ctx.db.patch(roomId, { closedAt: undefined }));
  vi.setSystemTime(Date.now() + TEMPORARY_PROFILE_TTL_MS);
  await expect(t.mutation(api.profiles.joinTemporary, { code })).rejects.toThrow(/expired/);
});

test("expiry invalidates tokens even before cleanup, then removes the guest's data without touching the host", async () => {
  const { t, roomId } = await fixture();
  const { code } = await t.mutation(api.profiles.inviteTemporary, { token: "host", roomId, name: "Guest" });
  const guest = await t.mutation(api.profiles.joinTemporary, { code });
  const me = (await t.query(api.profiles.me, { token: guest.token }))!;
  const invite = (await t.run((ctx) => ctx.db.query("temporaryInvites").first()))!;
  await t.run((ctx) => ctx.db.insert("library", {
    profileId: me._id, imdbId: "tt1234567", type: "movie", name: "Guest title", addedAt: Date.now(),
  }));
  vi.setSystemTime(invite.expiresAt);
  expect(await t.query(api.profiles.me, { token: guest.token })).toBeNull();
  await expect(t.mutation(api.rooms.join, { token: guest.token, roomId })).rejects.toThrow(/Sign in/);
  await t.mutation(internal.profiles.expireTemporary, { inviteId: invite._id });
  expect(await t.run((ctx) => ctx.db.get(me._id))).toBeNull();
  expect(await t.run((ctx) => ctx.db.query("library").collect())).toEqual([]);
  expect((await t.query(api.profiles.list, { token: "host" })).map((p) => p.name)).toEqual(["Host", "Friend"]);
  expect(await t.query(api.profiles.me, { token: "host" })).not.toBeNull();
});
