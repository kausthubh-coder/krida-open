import { ConvexError, v } from "convex/values";
import { query } from "./_generated/server";
import { mutation } from "./functions";
import { requireProfile } from "./lib/auth";
import { requireMember } from "./lib/rooms";

const LIMIT = 60;
// Reactions only matter for the moment they float over the picture, so only the newest few share
// the window the conversation is read from; a burst of laughing can't push the chat out of it.
const REACTIONS_KEPT = 12;
const SCAN = 400;

export const list = query({
  args: { token: v.string(), roomId: v.id("rooms") },
  handler: async (ctx, { token, roomId }) => {
    const me = await requireProfile(ctx, token);
    await requireMember(ctx, roomId, me._id);
    const rows = [];
    let reactions = 0;
    let scanned = 0;
    for await (const row of ctx.db
      .query("messages")
      .withIndex("by_room", (q) => q.eq("roomId", roomId))
      .order("desc")) {
      if (rows.length >= LIMIT || ++scanned > SCAN) break;
      if (row.kind === "reaction" && ++reactions > REACTIONS_KEPT) continue;
      rows.push(row);
    }
    return rows.reverse();
  },
});

export const send = mutation({
  args: {
    token: v.string(),
    roomId: v.id("rooms"),
    kind: v.union(v.literal("chat"), v.literal("reaction")),
    body: v.string(),
  },
  handler: async (ctx, { token, roomId, kind, body }) => {
    const me = await requireProfile(ctx, token);
    await requireMember(ctx, roomId, me._id);
    const text = body.trim();
    if (!text) return;
    if (text.length > 500) throw new ConvexError({ code: "INVALID", message: "Keep messages under 500 characters" });
    await ctx.db.insert("messages", { roomId, profileId: me._id, kind, body: text, createdAt: Date.now() });
    // Chatting counts as still watching.
    const room = await ctx.db.get(roomId);
    if (room?.autoStreak) await ctx.db.patch(roomId, { autoStreak: 0 });
  },
});
