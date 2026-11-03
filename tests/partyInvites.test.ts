/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { sha256 } from "../convex/lib/auth";
import schema from "../convex/schema";
import { household } from "./household";

/*
 * The rules of docs/models/PartyInvites.tla, one test per invariant (docs/models/README.md): a party across
 * accounts, its invite link, temporary guests, kicks, and what happens when the host leaves.
 */

const modules = import.meta.glob(["../convex/**/*.ts", "../convex/**/*.js", "!../convex/**/*.d.ts"]);
const now = Date.parse("2026-11-03T20:00:00Z");
const dune = { type: "movie" as const, imdbId: "tt15239678", videoId: "tt15239678", name: "Dune: Part Two" };
const arrival = { type: "movie" as const, imdbId: "tt2543164", videoId: "tt2543164", name: "Arrival" };

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

const forbidden = (message: string) => expect.objectContaining({ data: { code: "FORBIDDEN", message } });
const notFound = expect.objectContaining({ data: { code: "NOT_FOUND", message: "This party has ended" } });
const signIn = expect.objectContaining({ data: { code: "UNAUTHENTICATED", message: "Sign in to continue" } });

/**
 * Account A (TorBox) with Ana, who hosts, and Arun; account B (TorBox) with Bea; account C (no TorBox) with Cy.
 * Each is signed in with a token named after them.
 */
async function accounts() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const a = await household(ctx, "A");
    const b = await household(ctx, "B");
    const c = await household(ctx, "C", false);
    const make = async (name: string, accountId: Id<"accounts">, order: number) => {
      const id = await ctx.db.insert("profiles", { name, hue: 10, order, failedAttempts: 0, prefs: { audioLang: "eng", sounds: false }, accountId });
      await ctx.db.insert("sessions", { profileId: id, tokenHash: await sha256(name.toLowerCase()), createdAt: now });
      return id;
    };
    return { ana: await make("Ana", a, 0), arun: await make("Arun", a, 1), bea: await make("Bea", b, 0), cy: await make("Cy", c, 0) };
  });
  const row = (roomId: Id<"rooms">, profileId: Id<"profiles">) =>
    t.run((ctx) => ctx.db.query("roomMembers").withIndex("by_room_profile", (q) => q.eq("roomId", roomId).eq("profileId", profileId)).first());
  const room = (roomId: Id<"rooms">) => t.run((ctx) => ctx.db.get(roomId));
  const names = async (token: string, roomId: Id<"rooms">) => (await t.query(api.rooms.get, { token, roomId }))!.members.map((m) => m.name);
  return { t, ...ids, row, room, names };
}

/** Ana's party with its link shared. */
async function party() {
  const f = await accounts();
  const roomId = await f.t.mutation(api.rooms.createParty, { token: "ana", inviteIds: [] });
  const code = await f.t.mutation(api.rooms.shareLink, { token: "ana", roomId });
  return { ...f, roomId, code };
}

/** A guest in it from a one-use link. */
async function withGuest() {
  const f = await party();
  const { code: guestCode } = await f.t.mutation(api.profiles.inviteTemporary, { token: "ana", roomId: f.roomId, name: "Gil" });
  const guest = await f.t.mutation(api.profiles.joinTemporary, { code: guestCode });
  return { ...f, guest: guest.token, guestId: (await f.t.query(api.profiles.me, { token: guest.token }))!._id };
}

describe("MembersInvitedOrSameAccount", () => {
  test("join needs the link or the host's account", async () => {
    const { t, roomId, code, names } = await party();
    await expect(t.mutation(api.rooms.join, { token: "bea", roomId })).rejects.toThrow(forbidden("Ask the host for this party's link"));
    await expect(t.mutation(api.rooms.join, { token: "bea", roomId, code: "0".repeat(32) })).rejects.toThrow(forbidden("Ask the host for this party's link"));
    await t.mutation(api.rooms.join, { token: "arun", roomId });
    await t.mutation(api.rooms.join, { token: "bea", roomId, code });
    expect(await names("ana", roomId)).toEqual(["Ana", "Arun", "Bea"]);
    // Once in, a reload rejoins without the link.
    await t.mutation(api.rooms.leave, { token: "bea", roomId });
    await t.mutation(api.rooms.join, { token: "bea", roomId });
    expect(await names("ana", roomId)).toEqual(["Ana", "Arun", "Bea"]);
  });

  test("a guest joins only its own room", async () => {
    const { t, guest } = await withGuest();
    const other = await t.mutation(api.rooms.createParty, { token: "bea", inviteIds: [] });
    const otherCode = await t.mutation(api.rooms.shareLink, { token: "bea", roomId: other });
    await expect(t.mutation(api.rooms.join, { token: guest, roomId: other, code: otherCode })).rejects.toThrow(
      forbidden("Guests can only watch in the party they were invited to"),
    );
    await expect(t.mutation(api.rooms.shareLink, { token: guest, roomId: other })).rejects.toThrow(
      forbidden("Guests can only watch in the party they were invited to"),
    );
  });

  test("an invite goes only to my account, or back to someone who was in the party", async () => {
    const { t, roomId, code, bea, arun } = await party();
    await expect(t.mutation(api.invites.send, { token: "ana", roomId, toId: bea })).rejects.toThrow(forbidden("Send them the party's link instead"));
    await t.mutation(api.invites.send, { token: "ana", roomId, toId: arun });
    await t.mutation(api.rooms.join, { token: "bea", roomId, code });
    await t.mutation(api.rooms.leave, { token: "bea", roomId });
    await t.mutation(api.invites.send, { token: "ana", roomId, toId: bea });
    expect((await t.query(api.invites.forRoom, { token: "ana", roomId })).map((i) => i.toId).sort()).toEqual([arun, bea].sort());
  });
});

describe("EndedRoomIsEmpty", () => {
  test("an ended party has no members and no working invite", async () => {
    const { t, roomId, code, row, room, ana, cy } = await party();
    const { code: unused } = await t.mutation(api.profiles.inviteTemporary, { token: "ana", roomId, name: "Later" });
    await t.mutation(api.rooms.join, { token: "cy", roomId, code });
    // Cy's account has no TorBox, so Ana leaving ends the party.
    await t.mutation(api.rooms.leave, { token: "ana", roomId });
    expect((await room(roomId))?.closedAt).toBe(now);
    expect((await row(roomId, ana))?.left).toBe(true);
    expect((await row(roomId, cy))?.left).toBe(true);
    await expect(t.mutation(api.rooms.join, { token: "bea", roomId, code })).rejects.toThrow(notFound);
    expect(await t.query(api.rooms.byLink, { token: "bea", code })).toBeNull();
    expect(await t.query(api.profiles.temporaryInvite, { code: unused })).toBeNull();
    // The host reopening it a moment later brings neither link back.
    await t.mutation(api.rooms.join, { token: "ana", roomId });
    expect((await room(roomId))?.closedAt).toBe(undefined);
    expect(await t.query(api.profiles.temporaryInvite, { code: unused })).toBeNull();
    await expect(t.mutation(api.rooms.join, { token: "bea", roomId, code })).rejects.toThrow(forbidden("Ask the host for this party's link"));
    await expect(t.mutation(api.profiles.joinTemporary, { code: unused })).rejects.toThrow(/expired or was already used/);
  });

  test("a guest ends with the party", async () => {
    const { t, roomId, guest, guestId } = await withGuest();
    await t.mutation(api.rooms.leave, { token: "ana", roomId });
    expect(await t.query(api.profiles.me, { token: guest })).toBeNull();
    expect(await t.run((ctx) => ctx.db.get(guestId))).toBeNull();
  });
});

describe("ExpiredGuestNotMember", () => {
  test("an expired guest is out before expireTemporary runs", async () => {
    const { t, roomId, guest, names } = await withGuest();
    expect(await names("ana", roomId)).toEqual(["Ana", "Gil"]);
    const invite = (await t.run((ctx) => ctx.db.query("temporaryInvites").first()))!;
    vi.setSystemTime(invite.expiresAt + 1);
    await t.mutation(api.rooms.heartbeat, { token: "ana", roomId });
    expect(await t.run((ctx) => ctx.db.get(invite._id))).not.toBeNull();
    expect(await names("ana", roomId)).toEqual(["Ana"]);
    expect((await t.query(api.rooms.mine, { token: "ana" }))?.members.map((m) => m.name)).toEqual(["Ana"]);
    await expect(t.query(api.rooms.get, { token: guest, roomId })).rejects.toThrow(signIn);
    await expect(t.mutation(api.messages.send, { token: guest, roomId, kind: "chat", body: "still here?" })).rejects.toThrow(signIn);
  });
});

describe("OneHostPresent and HostHasTorBox", () => {
  test("the host leaving hands off within the account first", async () => {
    const { t, roomId, code, room, arun } = await party();
    await t.mutation(api.rooms.join, { token: "bea", roomId, code });
    vi.setSystemTime(now + 1000);
    await t.mutation(api.rooms.join, { token: "arun", roomId });
    await t.mutation(api.rooms.leave, { token: "ana", roomId });
    const after = await room(roomId);
    expect([after?.hostId, after?.hostAccountId, after?.closedAt]).toEqual([arun, (await t.run((ctx) => ctx.db.get(arun)))!.accountId, undefined]);
  });

  test("with nobody of the host's account, it goes to someone whose account has TorBox", async () => {
    const { t, roomId, code, room, bea } = await party();
    await t.mutation(api.rooms.join, { token: "cy", roomId, code });
    vi.setSystemTime(now + 1000);
    await t.mutation(api.rooms.join, { token: "bea", roomId, code });
    await t.mutation(api.rooms.leave, { token: "ana", roomId });
    expect((await room(roomId))?.hostId).toBe(bea);
    // Bea hosts now: the room plays Bea's TorBox, and Bea can add guests.
    expect((await t.mutation(api.profiles.inviteTemporary, { token: "bea", roomId, name: "Gus" })).code).toHaveLength(64);
  });

  test("with only guests and accounts without TorBox left, the party ends", async () => {
    const { t, roomId, code, room, guestId, cy, row } = await withGuest();
    await t.mutation(api.rooms.join, { token: "cy", roomId, code });
    await t.mutation(api.rooms.leave, { token: "ana", roomId });
    expect((await room(roomId))?.closedAt).toBe(now);
    expect((await row(roomId, cy))?.left).toBe(true);
    expect(await row(roomId, guestId)).toBeNull();
  });

  test("the sweep counting the host as gone hands off the same way", async () => {
    const { t, roomId, code, room, bea } = await party();
    await t.mutation(api.rooms.join, { token: "bea", roomId, code });
    vi.setSystemTime(now + 11 * 60_000);
    await t.mutation(api.rooms.heartbeat, { token: "bea", roomId });
    await t.mutation(internal.rooms.sweep, {});
    expect((await room(roomId))?.hostId).toBe(bea);
  });

  test("a party needs the host's TorBox", async () => {
    const { t } = await accounts();
    await expect(t.mutation(api.rooms.createParty, { token: "cy", inviteIds: [] })).rejects.toThrow(
      expect.objectContaining({ data: { code: "NEEDS_TORBOX", message: "Parties need TorBox. Add a TorBox key in Settings → Connections." } }),
    );
    expect(await t.run((ctx) => ctx.db.query("rooms").collect())).toEqual([]);
  });

  test("joining while the host has just left alone finds the party over", async () => {
    const { t, roomId } = await party();
    await t.mutation(api.rooms.leave, { token: "ana", roomId });
    await expect(t.mutation(api.rooms.join, { token: "arun", roomId })).rejects.toThrow(notFound);
  });
});

describe("KickedStayOut", () => {
  test("a kicked profile can't come back", async () => {
    const { t, roomId, code, bea, row, names } = await party();
    await t.mutation(api.rooms.join, { token: "bea", roomId, code });
    await expect(t.mutation(api.rooms.kick, { token: "bea", roomId, profileId: bea })).rejects.toThrow(forbidden("Only the host can remove people"));
    await t.mutation(api.rooms.kick, { token: "ana", roomId, profileId: bea });
    expect(await names("ana", roomId)).toEqual(["Ana"]);
    const removed = forbidden("The host removed you from this party");
    await expect(t.mutation(api.rooms.join, { token: "bea", roomId, code })).rejects.toThrow(removed);
    await t.mutation(api.rooms.heartbeat, { token: "bea", roomId });
    expect((await row(roomId, bea))?.left).toBe(true);
    await expect(t.query(api.rooms.get, { token: "bea", roomId })).rejects.toThrow(removed);
    await expect(t.mutation(api.messages.send, { token: "bea", roomId, kind: "chat", body: "let me in" })).rejects.toThrow(removed);
    expect((await t.query(api.rooms.byLink, { token: "bea", code }))?.removed).toBe(true);
  });

  test("a kicked guest's profile ends", async () => {
    const { t, roomId, guest, guestId } = await withGuest();
    await t.mutation(api.rooms.kick, { token: "ana", roomId, profileId: guestId });
    expect(await t.query(api.profiles.me, { token: guest })).toBeNull();
  });
});

describe("SeesCurrentTitle", () => {
  test("every member's room read shows the new title", async () => {
    const { t, roomId, code, guest } = await withGuest();
    await t.mutation(api.rooms.join, { token: "bea", roomId, code });
    await t.mutation(api.rooms.changeMedia, { token: "ana", roomId, media: dune });
    for (const token of ["ana", "bea", guest]) expect((await t.query(api.rooms.get, { token, roomId }))?.media?.name).toBe("Dune: Part Two");
    await t.mutation(api.rooms.changeMedia, { token: "bea", roomId, media: arrival });
    for (const token of ["ana", "bea", guest]) expect((await t.query(api.rooms.get, { token, roomId }))?.media?.name).toBe("Arrival");
  });
});

describe("the invite link", () => {
  test("says whose party it opens, to anyone signed in, until it ends", async () => {
    const { t, roomId, code, ana } = await party();
    expect(await t.mutation(api.rooms.shareLink, { token: "arun", roomId }).catch((e) => e.data)).toEqual({ code: "FORBIDDEN", message: "You're not in this party" });
    expect(await t.query(api.rooms.byLink, { token: "bea", code })).toEqual({
      roomId, host: { _id: ana, name: "Ana", hue: 10, temporary: false }, media: undefined, status: "idle", removed: false, inIt: false,
    });
    expect(await t.query(api.rooms.byLink, { token: "nobody", code })).toBeNull();
    expect(await t.mutation(api.rooms.shareLink, { token: "ana", roomId })).toBe(code);
  });
});
