import { ConvexError, v } from "convex/values";
import { query } from "./_generated/server";
import { mutation } from "./functions";
import { publicProfile, requireProfile } from "./lib/auth";
import { guestOnly, hostAccount, isGuest, memberRow, requireMember } from "./lib/rooms";

/** An invite that goes unanswered this long expires: the inviter can send another. */
export const INVITE_TTL_MS = 10 * 60 * 1000;

/** Invite a profile of my account, or call back someone of another account who was in this party before. */
export const send = mutation({
  args: { token: v.string(), roomId: v.id("rooms"), toId: v.id("profiles") },
  handler: async (ctx, { token, roomId, toId }) => {
    const me = await requireProfile(ctx, token);
    if (toId === me._id) throw new ConvexError({ code: "INVALID", message: "You're already here" });
    const room = await ctx.db.get(roomId);
    if (!room || room.closedAt) throw new ConvexError({ code: "NOT_FOUND", message: "This room has ended" });
    await requireMember(ctx, roomId, me._id);
    const to = await ctx.db.get(toId);
    const before = await memberRow(ctx, roomId, toId);
    if (!to || before?.kicked || (to.accountId !== me.accountId && !before))
      throw new ConvexError({ code: "FORBIDDEN", message: "Send them the party's link instead" });
    // One live invite per person: a newer one replaces older ones from me, and anyone's to this room.
    const pending = await ctx.db
      .query("invites")
      .withIndex("by_to_status", (q) => q.eq("toId", toId).eq("status", "pending"))
      .collect();
    for (const i of pending) {
      if (i.kind !== "knock" && (i.fromId === me._id || i.roomId === roomId)) await ctx.db.patch(i._id, { status: "cancelled" });
    }
    // Inviting someone into a room you were watching alone makes it a party.
    if (room.kind !== "party") await ctx.db.patch(roomId, { kind: "party" });
    await ctx.db.insert("invites", { roomId, fromId: me._id, toId, status: "pending", createdAt: Date.now() });
  },
});

export const mine = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const me = await requireProfile(ctx, token);
    const pending = await ctx.db
      .query("invites")
      .withIndex("by_to_status", (q) => q.eq("toId", me._id).eq("status", "pending"))
      .collect();
    const out = [];
    for (const i of pending) {
      if (Date.now() - i.createdAt > INVITE_TTL_MS) continue;
      const room = await ctx.db.get(i.roomId);
      const from = await ctx.db.get(i.fromId);
      if (!room || room.closedAt || !from) continue;
      out.push({
        _id: i._id,
        roomId: i.roomId,
        // A knock asks me to let them in; an invite asks me to come.
        kind: i.kind ?? ("invite" as const),
        createdAt: i.createdAt,
        expiresAt: i.createdAt + INVITE_TTL_MS,
        media: room.media,
        playing: room.status === "ready" || room.status === "preparing",
        from: publicProfile(from),
      });
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  },
});

/** Invites I sent for a room, so the inviter can see "waiting for …". */
export const forRoom = query({
  args: { token: v.string(), roomId: v.id("rooms") },
  handler: async (ctx, { token, roomId }) => {
    const me = await requireProfile(ctx, token);
    await requireMember(ctx, roomId, me._id);
    const invites = await ctx.db
      .query("invites")
      .withIndex("by_room", (q) => q.eq("roomId", roomId))
      .collect();
    const now = Date.now();
    return invites
      .filter((i) => i.kind !== "knock" && (i.status === "pending" || i.status === "declined" || i.status === "expired"))
      .map((i) => ({
        _id: i._id,
        toId: i.toId,
        // The sweep marks expiry once a minute; don't wait for it.
        status: i.status === "pending" && now - i.createdAt > INVITE_TTL_MS ? ("expired" as const) : i.status,
        createdAt: i.createdAt,
        expiresAt: i.createdAt + INVITE_TTL_MS,
      }));
  },
});

export const respond = mutation({
  args: { token: v.string(), inviteId: v.id("invites"), accept: v.boolean() },
  handler: async (ctx, { token, inviteId, accept }) => {
    const me = await requireProfile(ctx, token);
    const invite = await ctx.db.get(inviteId);
    // A replaced, cancelled or expired invite stays that way.
    if (!invite || invite.toId !== me._id || invite.status !== "pending") return;
    await ctx.db.patch(inviteId, { status: accept ? "accepted" : "declined" });
  },
});

/**
 * Ask whoever is watching alone to let me join, instead of dropping into their film. They answer with `respond`;
 * once they say yes, my screen joins. A newer knock replaces my older ones.
 */
export const knock = mutation({
  args: { token: v.string(), roomId: v.id("rooms") },
  handler: async (ctx, { token, roomId }) => {
    const me = await requireProfile(ctx, token);
    if (isGuest(me)) throw guestOnly();
    const room = await ctx.db.get(roomId);
    if (!room || room.closedAt) throw new ConvexError({ code: "NOT_FOUND", message: "They’ve stopped watching" });
    if (room.hostId === me._id) throw new ConvexError({ code: "INVALID", message: "You're already here" });
    // Knocking is for someone of your own account watching alone; another account's party opens with its link.
    const before = await memberRow(ctx, roomId, me._id);
    if (before?.kicked || (me.accountId !== (await hostAccount(ctx, room)) && !before))
      throw new ConvexError({ code: "FORBIDDEN", message: "Ask the host for this party's link" });
    const mine = await ctx.db
      .query("invites")
      .withIndex("by_room", (q) => q.eq("roomId", roomId))
      .collect();
    for (const i of mine) {
      if (i.kind === "knock" && i.fromId === me._id && i.status === "pending") await ctx.db.patch(i._id, { status: "cancelled" });
    }
    return await ctx.db.insert("invites", {
      roomId,
      fromId: me._id,
      toId: room.hostId,
      status: "pending",
      createdAt: Date.now(),
      kind: "knock",
    });
  },
});

/** How my latest knock on a room went: waiting, let in, turned down, or run out. */
export const knockState = query({
  args: { token: v.string(), roomId: v.id("rooms") },
  handler: async (ctx, { token, roomId }) => {
    const me = await requireProfile(ctx, token);
    const invites = await ctx.db
      .query("invites")
      .withIndex("by_room", (q) => q.eq("roomId", roomId))
      .collect();
    const latest = invites
      .filter((i) => i.kind === "knock" && i.fromId === me._id)
      .sort((a, b) => b._creationTime - a._creationTime)[0];
    if (!latest) return null;
    const room = await ctx.db.get(roomId);
    // The sweep marks expiry every few minutes, and a room that ended takes its knocks with it; don't wait for either.
    const gone = !room || !!room.closedAt;
    const status =
      latest.status === "pending" && (gone || Date.now() - latest.createdAt > INVITE_TTL_MS) ? ("expired" as const) : latest.status;
    return { _id: latest._id, status };
  },
});

/** Never mind: take back a knock that hasn't been answered. */
export const withdraw = mutation({
  args: { token: v.string(), inviteId: v.id("invites") },
  handler: async (ctx, { token, inviteId }) => {
    const me = await requireProfile(ctx, token);
    const invite = await ctx.db.get(inviteId);
    if (!invite || invite.fromId !== me._id || invite.status !== "pending") return;
    await ctx.db.patch(inviteId, { status: "cancelled" });
  },
});
