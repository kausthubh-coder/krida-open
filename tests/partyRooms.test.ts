/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import { household } from "./household";
import { sha256 } from "../convex/lib/auth";
import type { Id } from "../convex/_generated/dataModel";

const modules = import.meta.glob(["../convex/**/*.ts", "../convex/**/*.js", "!../convex/**/*.d.ts"]);
const now = Date.parse("2026-10-07T20:00:00Z");
const MINUTE = 60_000;
const dune = { type: "movie" as const, imdbId: "tt15239678", videoId: "tt15239678", name: "Dune: Part Two" };

/** Maya and Ravi, signed in, and nothing started yet. */
async function friends() {
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
  const member = (roomId: Id<"rooms">, profileId: Id<"profiles">) =>
    t.run((ctx) =>
      ctx.db
        .query("roomMembers")
        .withIndex("by_room_profile", (q) => q.eq("roomId", roomId).eq("profileId", profileId))
        .first(),
    );
  const room = (roomId: Id<"rooms">) => t.run((ctx) => ctx.db.get(roomId));
  const names = async (roomId: Id<"rooms">, token = "host") =>
    (await t.query(api.rooms.get, { token, roomId }))!.members.map((m) => m.name).sort();
  return { t, host, friend, profile, member, room, names };
}

/** A party Maya started with Ravi in it. */
async function party() {
  const f = await friends();
  const roomId = await f.t.mutation(api.rooms.createParty, { token: "host", inviteIds: [f.friend] });
  await f.t.mutation(api.rooms.join, { token: "friend", roomId });
  return { ...f, roomId };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("being in a party and watching alone at once", () => {
  test("a movie playing alone on the TV carries on when the same profile starts or joins a party on the phone", async () => {
    const { t, host, member, room } = await friends();
    const solo = await t.mutation(api.rooms.create, { token: "host", media: dune });

    // Starting a party on the phone.
    const mine = await t.mutation(api.rooms.createParty, { token: "host", inviteIds: [] });
    expect((await member(solo, host))?.left).toBe(false);

    // Joining Ravi's on the phone.
    const theirs = await t.mutation(api.rooms.createParty, { token: "friend", inviteIds: [host] });
    await t.mutation(api.rooms.join, { token: "host", roomId: theirs });
    expect((await member(solo, host))?.left).toBe(false);
    expect((await room(solo))?.closedAt).toBeUndefined();
    // The party left behind is still left behind; the header shows the party, not the movie.
    expect((await member(mine, host))?.left).toBe(true);
    expect((await t.query(api.rooms.mine, { token: "host" }))?._id).toBe(theirs);
  });
});

describe("who can act on a room", () => {
  test("someone who never joined can't play, stop, chat, invite or suggest in it", async () => {
    const { t, roomId, profile, friend } = await party();
    await profile("Stranger", "stranger");
    const token = "stranger";
    const attempts = [
      () => t.mutation(api.rooms.control, { token, roomId, playing: false, position: 10, action: "pause" }),
      () => t.mutation(api.rooms.stop, { token, roomId }),
      () => t.mutation(api.rooms.playNow, { token, roomId, media: dune }),
      () => t.mutation(api.rooms.requestSwitch, { token, roomId, media: dune }),
      () => t.mutation(api.rooms.suggest, { token, roomId, media: dune }),
      () => t.mutation(api.rooms.setNext, { token, roomId, media: dune }),
      () => t.mutation(api.rooms.queueAdd, { token, roomId, media: dune }),
      () => t.mutation(api.rooms.cancelSwitch, { token, roomId }),
      () => t.mutation(api.messages.send, { token, roomId, kind: "chat", body: "hi" }),
      () => t.mutation(api.invites.send, { token, roomId, toId: friend }),
    ];
    for (const attempt of attempts) await expect(attempt()).rejects.toThrow(/not in this party/);
    // Nothing they tried got through, and they never became a member.
    const r = await t.query(api.rooms.get, { token: "host", roomId });
    expect(r?.media).toBeUndefined();
    expect(r?.members.map((m) => m.name).sort()).toEqual(["Maya", "Ravi"]);
    expect((await t.query(api.messages.list, { token: "host", roomId })).map((m) => m.body)).toEqual(["started the party", "joined"]);
  });

  test("someone the sweep counted out can still pause before their heartbeat puts them back", async () => {
    const { t, roomId, host, member } = await party();
    await t.run((ctx) => ctx.db.patch(roomId, { status: "ready", media: dune }));
    const row = (await member(roomId, host))!;
    await t.run((ctx) => ctx.db.patch(row._id, { left: true, swept: true }));
    await t.mutation(api.rooms.control, { token: "host", roomId, playing: false, position: 42, action: "pause" });
    expect((await t.query(api.rooms.get, { token: "friend", roomId }))?.playback).toMatchObject({ playing: false, position: 42, by: host });
  });

  test("leaving a room you were never in does nothing", async () => {
    const { t, roomId, profile } = await party();
    await profile("Stranger", "stranger");
    await t.mutation(api.rooms.leave, { token: "stranger", roomId, announce: true });
    const events = (await t.query(api.messages.list, { token: "host", roomId })).map((m) => m.body);
    expect(events).toEqual(["started the party", "joined"]);
  });
});

describe("a guest from a one-use link", () => {
  async function guest() {
    const p = await party();
    const { code } = await p.t.mutation(api.profiles.inviteTemporary, { token: "host", roomId: p.roomId, name: "Guest" });
    const { token } = await p.t.mutation(api.profiles.joinTemporary, { code });
    return { ...p, token };
  }

  test("joins and chats in the party they were invited to", async () => {
    const { t, roomId, token, names } = await guest();
    await t.mutation(api.rooms.join, { token, roomId });
    await t.mutation(api.rooms.heartbeat, { token, roomId, watching: true });
    await t.mutation(api.messages.send, { token, roomId, kind: "chat", body: "Hello" });
    await t.mutation(api.rooms.suggest, { token, roomId, media: dune });
    expect(await names(roomId)).toEqual(["Guest", "Maya", "Ravi"]);
    expect((await t.query(api.messages.list, { token, roomId })).filter((m) => m.kind === "chat").map((m) => m.body)).toEqual(["Hello"]);
  });

  test("can't see, join or start other rooms", async () => {
    const { t, token } = await guest();
    const other = await t.mutation(api.rooms.create, { token: "friend", media: dune });
    expect((await t.query(api.rooms.live, { token: "host" })).map((r) => r._id)).toEqual([other]);
    expect(await t.query(api.rooms.live, { token })).toEqual([]);
    await expect(t.mutation(api.rooms.join, { token, roomId: other })).rejects.toThrow(/party they were invited to/);
    await expect(t.mutation(api.rooms.create, { token, media: dune })).rejects.toThrow(/party they were invited to/);
    await expect(t.mutation(api.rooms.createParty, { token, inviteIds: [] })).rejects.toThrow(/party they were invited to/);
    expect((await t.query(api.rooms.get, { token: "friend", roomId: other }))?.members.map((m) => m.name)).toEqual(["Ravi"]);
  });
});

describe("asking to switch while someone is watching", () => {
  const arrival = { type: "movie" as const, imdbId: "tt2543164", videoId: "tt2543164", name: "Arrival" };

  /** Dune is on and Ravi is watching; Maya asks to switch to Arrival. */
  async function asked() {
    const p = await party();
    await p.t.mutation(api.rooms.playNow, { token: "host", roomId: p.roomId, media: dune });
    await p.t.run((ctx) => ctx.db.patch(p.roomId, { status: "ready" }));
    await p.t.mutation(api.rooms.heartbeat, { token: "friend", roomId: p.roomId, watching: true });
    expect(await p.t.mutation(api.rooms.requestSwitch, { token: "host", roomId: p.roomId, media: arrival })).toBe("asked");
    const request = (await p.t.query(api.rooms.get, { token: "host", roomId: p.roomId }))!.switchRequest!;
    return { ...p, request };
  }

  test("the one who asked can't answer for the other", async () => {
    const { t, roomId, request } = await asked();
    await expect(t.mutation(api.rooms.answerSwitch, { token: "host", roomId, requestId: request.id, accept: true }))
      .rejects.toThrow(/asked/);
    const r = await t.query(api.rooms.get, { token: "friend", roomId });
    expect(r?.media?.videoId).toBe(dune.videoId);
    expect(r?.switchRequest?.id).toBe(request.id);
  });

  test("an answer after the time ran out clears the request", async () => {
    const { t, roomId, request } = await asked();
    vi.setSystemTime(now + 31_000);
    expect(await t.mutation(api.rooms.answerSwitch, { token: "friend", roomId, requestId: request.id, accept: true })).toBe("expired");
    const r = await t.query(api.rooms.get, { token: "host", roomId });
    expect(r?.switchRequest).toBeUndefined();
    expect(r?.media?.videoId).toBe(dune.videoId);
  });

  test("only the one who asked can call it off", async () => {
    const { t, roomId, request } = await asked();
    await expect(t.mutation(api.rooms.cancelSwitch, { token: "friend", roomId })).rejects.toThrow(/asked/);
    expect((await t.query(api.rooms.get, { token: "host", roomId }))?.switchRequest?.id).toBe(request.id);
    await t.mutation(api.rooms.cancelSwitch, { token: "host", roomId });
    expect((await t.query(api.rooms.get, { token: "host", roomId }))?.switchRequest).toBeUndefined();
  });
});

describe("invites", () => {
  const pending = (t: Awaited<ReturnType<typeof friends>>["t"]) =>
    t.run(async (ctx) => (await ctx.db.query("invites").collect()).filter((i) => i.status === "pending").length);

  test("an invite that was replaced can't be accepted afterwards", async () => {
    const { t, friend } = await friends();
    const roomId = await t.mutation(api.rooms.createParty, { token: "host", inviteIds: [friend] });
    const [first] = await t.query(api.invites.mine, { token: "friend" });
    await t.mutation(api.invites.send, { token: "host", roomId, toId: friend });
    await t.mutation(api.invites.respond, { token: "friend", inviteId: first._id, accept: true });
    expect((await t.run((ctx) => ctx.db.get(first._id)))?.status).toBe("cancelled");
    expect(await t.query(api.invites.mine, { token: "friend" })).toHaveLength(1);
  });

  test("two people inviting the same friend to one party send one invite", async () => {
    const { t, roomId, profile } = await party();
    const third = await profile("Ananya", "third");
    await t.mutation(api.invites.send, { token: "host", roomId, toId: third });
    await t.mutation(api.invites.send, { token: "friend", roomId, toId: third });
    expect((await t.query(api.invites.mine, { token: "third" })).map((i) => i.roomId)).toEqual([roomId]);
    expect(await pending(t)).toBe(1);
  });

  test("starting a party with someone listed twice invites them once", async () => {
    const { t, friend } = await friends();
    await t.mutation(api.rooms.createParty, { token: "host", inviteIds: [friend, friend] });
    expect(await t.query(api.invites.mine, { token: "friend" })).toHaveLength(1);
    expect(await pending(t)).toBe(1);
  });
});

describe("the host leaving", () => {
  /** Maya's party with a guest who arrived first, then Ravi a minute later. */
  async function withGuest() {
    const f = await friends();
    const roomId = await f.t.mutation(api.rooms.createParty, { token: "host", inviteIds: [f.friend] });
    const { code } = await f.t.mutation(api.profiles.inviteTemporary, { token: "host", roomId, name: "Guest" });
    await f.t.mutation(api.profiles.joinTemporary, { code });
    vi.setSystemTime(now + MINUTE);
    await f.t.mutation(api.rooms.join, { token: "friend", roomId });
    return { ...f, roomId };
  }

  test("hands the party to the friend who joined first, not a guest", async () => {
    const { t, roomId, friend } = await withGuest();
    await t.mutation(api.rooms.leave, { token: "host", roomId, announce: true });
    expect((await t.query(api.rooms.get, { token: "friend", roomId }))?.hostId).toBe(friend);
    // Hosting is what lets them add a guest.
    expect((await t.mutation(api.profiles.inviteTemporary, { token: "friend", roomId, name: "Another" })).code).toHaveLength(64);
  });

  test("hands it on when the sweep counts the host as gone", async () => {
    const { t, roomId, friend } = await withGuest();
    vi.setSystemTime(now + 11 * MINUTE);
    await t.mutation(api.rooms.heartbeat, { token: "friend", roomId, watching: true });
    const guest = (await t.query(api.rooms.get, { token: "friend", roomId }))!.members.find((m) => m.temporary)!;
    await t.run(async (ctx) => {
      const row = await ctx.db.query("roomMembers").withIndex("by_room_profile", (q) => q.eq("roomId", roomId).eq("profileId", guest._id)).first();
      await ctx.db.patch(row!._id, { lastSeenAt: now + 11 * MINUTE });
    });
    await t.mutation(internal.rooms.sweep, {});
    expect((await t.query(api.rooms.get, { token: "friend", roomId }))?.hostId).toBe(friend);
  });

  test("ends the party when only guests are left, since a guest never hosts", async () => {
    const { t, roomId, host } = await withGuest();
    await t.mutation(api.rooms.leave, { token: "friend", roomId });
    await t.mutation(api.rooms.leave, { token: "host", roomId });
    const room = await t.run((ctx) => ctx.db.get(roomId));
    expect(room?.hostId).toBe(host);
    expect(room?.closedAt).toBe(now + MINUTE);
  });
});

describe("a friend peeking into a movie watched alone", () => {
  async function peeked() {
    const f = await friends();
    const roomId = await f.t.mutation(api.rooms.create, { token: "host", media: dune });
    await f.t.mutation(api.rooms.join, { token: "friend", roomId });
    expect((await f.room(roomId))?.kind).toBe("party");
    return { ...f, roomId };
  }

  test("turns it back into watching alone once they leave", async () => {
    const { t, roomId, room } = await peeked();
    await t.mutation(api.rooms.leave, { token: "friend", roomId, announce: true });
    expect((await room(roomId))?.kind).toBe("solo");
    expect(await t.query(api.rooms.mine, { token: "host" })).toBeNull();
  });

  test("turns it back once the sweep counts them as gone", async () => {
    const { t, roomId, room } = await peeked();
    vi.setSystemTime(now + 11 * MINUTE);
    await t.mutation(api.rooms.heartbeat, { token: "host", roomId, watching: true });
    await t.mutation(internal.rooms.sweep, {});
    expect((await room(roomId))?.kind).toBe("solo");
  });

  test("stays a party while someone else is invited", async () => {
    const { t, roomId, room, profile } = await peeked();
    const third = await profile("Ananya", "third");
    await t.mutation(api.invites.send, { token: "host", roomId, toId: third });
    await t.mutation(api.rooms.leave, { token: "friend", roomId });
    expect((await room(roomId))?.kind).toBe("party");
  });

  test("a party started as one stays a party when the friend leaves", async () => {
    const { t, roomId, room } = await party();
    await t.mutation(api.rooms.leave, { token: "friend", roomId });
    expect((await room(roomId))?.kind).toBe("party");
  });
});

describe("the shared clock when nobody is in the player", () => {
  const SECOND = 1000;
  /** Dune playing from 100 s, both in the player. */
  async function playing() {
    const p = await party();
    await p.t.mutation(api.rooms.playNow, { token: "host", roomId: p.roomId, media: dune });
    await p.t.run(async (ctx) => {
      const room = (await ctx.db.get(p.roomId))!;
      await ctx.db.patch(p.roomId, { status: "ready", playback: { ...room.playback, playing: true, position: 100, anchorAt: now } });
    });
    await p.t.mutation(api.rooms.heartbeat, { token: "host", roomId: p.roomId, watching: true });
    await p.t.mutation(api.rooms.heartbeat, { token: "friend", roomId: p.roomId, watching: true });
    const seq = (await p.room(p.roomId))!.playback.seq;
    const at = (ms: number, token: string, watching: boolean) => {
      vi.setSystemTime(now + ms);
      return p.t.mutation(api.rooms.heartbeat, { token, roomId: p.roomId, watching });
    };
    return { ...p, seq, at };
  }

  test("stops where it was once everyone has backed out to browse", async () => {
    const { roomId, room, host, seq, at } = await playing();
    await at(10 * SECOND, "host", false);
    await at(12 * SECOND, "friend", false);
    expect((await room(roomId))?.playback.playing).toBe(true);
    // A second beat from outside the player: Maya really has left it, and nobody else is in it.
    await at(20 * SECOND, "host", false);
    expect((await room(roomId))?.playback).toEqual({
      playing: false, position: 110, anchorAt: now + 20 * SECOND, seq: seq + 1, action: "pause", by: host,
    });
  });

  test("keeps going while someone else is still in the player", async () => {
    const { roomId, room, at } = await playing();
    await at(5 * SECOND, "friend", true);
    await at(10 * SECOND, "host", false);
    await at(10 * SECOND, "friend", true);
    await at(20 * SECOND, "host", false);
    expect((await room(roomId))?.playback).toMatchObject({ playing: true, position: 100, anchorAt: now });
  });

  test("keeps going on the TV while the same profile browses on the phone", async () => {
    const { roomId, room, at } = await playing();
    // Ravi stepped away long ago; Maya watches on the TV and browses on the phone.
    await at(MINUTE, "host", true);
    await at(MINUTE + 1 * SECOND, "host", false);
    await at(MINUTE + 5 * SECOND, "host", true);
    await at(MINUTE + 10 * SECOND, "host", true);
    await at(MINUTE + 11 * SECOND, "host", false);
    expect((await room(roomId))?.playback).toMatchObject({ playing: true, position: 100, anchorAt: now });
  });

  test("stops when the last one in the player presses Leave", async () => {
    const { t, roomId, room, host, seq, at } = await playing();
    await at(5 * SECOND, "friend", false);
    vi.setSystemTime(now + 30 * SECOND);
    await t.mutation(api.rooms.leave, { token: "host", roomId, announce: true });
    expect((await room(roomId))?.playback).toEqual({
      playing: false, position: 130, anchorAt: now + 30 * SECOND, seq: seq + 1, action: "pause", by: host,
    });
  });
});

describe("play and pause from the player", () => {
  const arrival = { type: "movie" as const, imdbId: "tt2543164", videoId: "tt2543164", name: "Arrival" };

  async function ready() {
    const p = await party();
    await p.t.mutation(api.rooms.playNow, { token: "host", roomId: p.roomId, media: arrival });
    await p.t.run((ctx) => ctx.db.patch(p.roomId, { status: "ready" }));
    const before = (await p.room(p.roomId))!.playback;
    return { ...p, before };
  }

  test("a late pause from the title before doesn't move this one", async () => {
    const { t, roomId, room, before } = await ready();
    await t.mutation(api.rooms.control, { token: "friend", roomId, playing: false, position: 5400, action: "pause", videoId: dune.videoId });
    expect((await room(roomId))?.playback).toEqual(before);
  });

  test("a pause while the next title is still getting ready is ignored", async () => {
    const { t, roomId, room } = await ready();
    await t.mutation(api.rooms.playNow, { token: "host", roomId, media: dune });
    const preparing = (await room(roomId))!.playback;
    await t.mutation(api.rooms.control, { token: "friend", roomId, playing: false, position: 30, action: "pause", videoId: dune.videoId });
    expect((await room(roomId))?.playback).toEqual(preparing);
  });

  test("anchors at when the person pressed, no more than 3 seconds back", async () => {
    const { t, roomId, room, friend, before } = await ready();
    vi.setSystemTime(now + 10_000);
    const press = (at: number) =>
      t.mutation(api.rooms.control, { token: "friend", roomId, playing: true, position: 60, action: "play", videoId: arrival.videoId, at });
    await press(now + 9_000);
    expect((await room(roomId))?.playback).toEqual({ playing: true, position: 60, anchorAt: now + 9_000, seq: before.seq + 1, by: friend, action: "play" });
    await press(now);
    expect((await room(roomId))?.playback.anchorAt).toBe(now + 7_000);
    await press(now + 60_000);
    expect((await room(roomId))?.playback.anchorAt).toBe(now + 10_000);
  });

  test("tabs that send neither still anchor at the server's now", async () => {
    const { t, roomId, room, host, before } = await ready();
    vi.setSystemTime(now + 10_000);
    await t.mutation(api.rooms.control, { token: "host", roomId, playing: false, position: 75, action: "pause" });
    expect((await room(roomId))?.playback).toEqual({ playing: false, position: 75, anchorAt: now + 10_000, seq: before.seq + 1, by: host, action: "pause" });
  });
});

describe("rooms to drop into", () => {
  test("a friend's party shows however many ended rooms were active after it", async () => {
    const { t, friend } = await friends();
    const theirs = await t.mutation(api.rooms.createParty, { token: "friend", inviteIds: [] });
    await t.run(async (ctx) => {
      for (let i = 1; i <= 25; i++) {
        const roomId = await ctx.db.insert("rooms", {
          hostId: friend, kind: "party", status: "idle", jobId: 0, createdAt: now + i, lastActiveAt: now + i, closedAt: now + i,
          playback: { playing: false, position: 0, anchorAt: now, seq: 0 },
        });
        await ctx.db.insert("roomMembers", {
          roomId, profileId: friend, joinedAt: now, lastSeenAt: now + i, buffering: false, position: 0, left: true,
        });
      }
    });
    expect((await t.query(api.rooms.live, { token: "host" })).map((r) => r._id)).toEqual([theirs]);
  });
});

describe("back to picking", () => {
  test("drops what was lined up after the title, so it doesn't come back as Up next on the next one", async () => {
    const { t, roomId } = await party();
    const severance = { type: "series" as const, imdbId: "tt11280740", videoId: "tt11280740:1:1", name: "Severance", season: 1, episode: 1 };
    const arrival = { type: "movie" as const, imdbId: "tt2543164", videoId: "tt2543164", name: "Arrival" };
    await t.mutation(api.rooms.playNow, { token: "host", roomId, media: dune });
    await t.mutation(api.rooms.setNext, { token: "friend", roomId, media: severance });
    await t.mutation(api.rooms.stop, { token: "host", roomId });
    expect((await t.query(api.rooms.get, { token: "host", roomId }))?.next).toBeUndefined();
    expect((await t.query(api.rooms.mine, { token: "host" }))?.next).toBeUndefined();

    await t.mutation(api.rooms.playNow, { token: "host", roomId, media: arrival });
    const r = await t.query(api.rooms.get, { token: "friend", roomId });
    expect(r?.media?.videoId).toBe(arrival.videoId);
    expect(r?.next).toBeUndefined();
    expect(r?.queue).toEqual([]);
  });
});

describe("a laptop that slept through being counted as gone", () => {
  /** Maya's laptop sleeps; Ravi keeps watching, and the sweep counts Maya as gone. */
  async function swept() {
    const p = await party();
    vi.setSystemTime(now + 11 * MINUTE);
    await p.t.mutation(api.rooms.heartbeat, { token: "friend", roomId: p.roomId, watching: true });
    await p.t.mutation(internal.rooms.sweep, {});
    expect(await p.member(p.roomId, p.host)).toMatchObject({ left: true, swept: true });
    return p;
  }

  test("stays out of a party left behind for another one when it wakes", async () => {
    const { t, roomId, host, member, names } = await swept();
    const other = await t.mutation(api.rooms.createParty, { token: "host", inviteIds: [] });
    await t.mutation(api.rooms.heartbeat, { token: "host", roomId, watching: true });
    expect(await member(roomId, host)).toMatchObject({ left: true, swept: false });
    expect(await names(roomId, "friend")).toEqual(["Ravi"]);
    expect((await t.query(api.rooms.mine, { token: "host" }))?._id).toBe(other);
  });

  test("stays out after pressing Leave on another device", async () => {
    const { t, roomId, host, member, names } = await swept();
    await t.mutation(api.rooms.leave, { token: "host", roomId, announce: true });
    await t.mutation(api.rooms.heartbeat, { token: "host", roomId, watching: true });
    expect(await member(roomId, host)).toMatchObject({ left: true, swept: false });
    // Out means out: the party's people and chat are no longer theirs to read.
    expect(await t.query(api.rooms.get, { token: "host", roomId })).toBeNull();
    await expect(t.query(api.messages.list, { token: "host", roomId })).rejects.toThrow("You left this party");
    expect(await names(roomId, "friend")).toEqual(["Ravi"]);
  });

  test("stays out of a party that ended and was opened again", async () => {
    const { t, roomId, host, member, names } = await swept();
    await t.mutation(api.rooms.leave, { token: "friend", roomId });
    await t.mutation(internal.rooms.closeIfEmpty, { roomId });
    expect(await member(roomId, host)).toMatchObject({ left: true, swept: false });
    // Ravi comes back within the grace period, which opens the party again.
    await t.mutation(api.rooms.join, { token: "friend", roomId });
    await t.mutation(api.rooms.heartbeat, { token: "host", roomId, watching: true });
    expect(await names(roomId, "friend")).toEqual(["Ravi"]);
  });

  test("asleep for longer than a party lasts, it stays out of one that's still going", async () => {
    const { t, roomId, host, member, names } = await swept();
    vi.setSystemTime(now + 13 * 60 * MINUTE);
    await t.mutation(api.rooms.heartbeat, { token: "friend", roomId, watching: true });
    await t.mutation(api.rooms.heartbeat, { token: "host", roomId, watching: true });
    expect((await member(roomId, host))?.left).toBe(true);
    expect(await names(roomId)).toEqual(["Ravi"]);
  });

  test("still comes back to the party it was counted out of", async () => {
    const { t, roomId, host, member, names } = await swept();
    await t.mutation(api.rooms.heartbeat, { token: "host", roomId, watching: true });
    expect(await member(roomId, host)).toMatchObject({ left: false, swept: false });
    expect(await names(roomId)).toEqual(["Maya", "Ravi"]);
  });
});

describe("asking to join someone watching alone", () => {
  test("Ravi knocks, Maya sees who and what, lets him in, and Ravi joins", async () => {
    const { t, friend, names, room } = await friends();
    const solo = await t.mutation(api.rooms.create, { token: "host", media: dune });
    await t.mutation(api.invites.knock, { token: "friend", roomId: solo });
    const asked = await t.query(api.invites.mine, { token: "host" });
    expect(asked.map((i) => [i.kind, i.from.name, i.media?.name])).toEqual([["knock", "Ravi", "Dune: Part Two"]]);
    expect(await t.query(api.invites.knockState, { token: "friend", roomId: solo })).toEqual({ _id: asked[0]._id, status: "pending" });
    // The host's own list of who they invited doesn't show a knock as "waiting for Maya".
    expect(await t.query(api.invites.forRoom, { token: "host", roomId: solo })).toEqual([]);

    await t.mutation(api.invites.respond, { token: "host", inviteId: asked[0]._id, accept: true });
    expect((await t.query(api.invites.knockState, { token: "friend", roomId: solo }))?.status).toBe("accepted");
    await t.mutation(api.rooms.join, { token: "friend", roomId: solo });
    expect(await names(solo)).toEqual(["Maya", "Ravi"]);
    expect((await room(solo))?.kind).toBe("party");
    expect(friend).toBe(asked[0].from._id);
  });

  test("a no, a take-back and a room that ended each say so", async () => {
    const { t } = await friends();
    const solo = await t.mutation(api.rooms.create, { token: "host", media: dune });
    const first = await t.mutation(api.invites.knock, { token: "friend", roomId: solo });
    await t.mutation(api.invites.respond, { token: "host", inviteId: first, accept: false });
    expect((await t.query(api.invites.knockState, { token: "friend", roomId: solo }))?.status).toBe("declined");

    const second = await t.mutation(api.invites.knock, { token: "friend", roomId: solo });
    await t.mutation(api.invites.withdraw, { token: "friend", inviteId: second });
    expect((await t.query(api.invites.knockState, { token: "friend", roomId: solo }))?.status).toBe("cancelled");
    expect(await t.query(api.invites.mine, { token: "host" })).toEqual([]);

    await t.mutation(api.invites.knock, { token: "friend", roomId: solo });
    await t.mutation(api.rooms.leave, { token: "host", roomId: solo });
    await t.mutation(internal.rooms.closeIfEmpty, { roomId: solo });
    expect((await t.query(api.invites.knockState, { token: "friend", roomId: solo }))?.status).toBe("cancelled");
  });

  test("a newer knock replaces the older one, and the host can't knock on their own room", async () => {
    const { t } = await friends();
    const solo = await t.mutation(api.rooms.create, { token: "host", media: dune });
    await t.mutation(api.invites.knock, { token: "friend", roomId: solo });
    const latest = await t.mutation(api.invites.knock, { token: "friend", roomId: solo });
    expect((await t.query(api.invites.mine, { token: "host" })).map((i) => i._id)).toEqual([latest]);
    await expect(t.mutation(api.invites.knock, { token: "host", roomId: solo })).rejects.toThrow("You're already here");
  });

  test("a knock left unanswered runs out after 10 minutes", async () => {
    const { t } = await friends();
    const solo = await t.mutation(api.rooms.create, { token: "host", media: dune });
    await t.mutation(api.invites.knock, { token: "friend", roomId: solo });
    vi.setSystemTime(now + 11 * MINUTE);
    expect((await t.query(api.invites.knockState, { token: "friend", roomId: solo }))?.status).toBe("expired");
  });
});
