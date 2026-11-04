import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { hashPassword, randomHex, safeEqual } from "./auth";
import { closeRoom } from "./rooms";

const MAX_ATTEMPTS = 5;
const LOCK_MS = 5 * 60 * 1000;

export const isPin = (pin: string) => /^\d{4}$/.test(pin);

export async function hashPin(pin: string) {
  const salt = randomHex(16);
  return { hash: await hashPassword(pin, salt), salt };
}

/**
 * Checks a PIN or password against the profile's, counting wrong tries: five in a row lock the profile for five
 * minutes. Returns what to tell the person, or null when it's right. Callers return the message rather than throw,
 * or the counter would roll back with the error.
 */
export async function checkSecret(
  ctx: MutationCtx,
  profile: Doc<"profiles">,
  secret: { hash: string; salt: string },
  given: string,
  what: "PIN" | "password",
): Promise<string | null> {
  const now = Date.now();
  if (profile.lockedUntil && profile.lockedUntil > now)
    return `Too many wrong tries. Try again in ${Math.ceil((profile.lockedUntil - now) / 60000)} min.`;
  if (safeEqual(await hashPassword(given, secret.salt), secret.hash)) {
    if (profile.failedAttempts || profile.lockedUntil) await ctx.db.patch(profile._id, { failedAttempts: 0, lockedUntil: undefined });
    return null;
  }
  const failedAttempts = profile.failedAttempts + 1;
  const locked = failedAttempts >= MAX_ATTEMPTS;
  await ctx.db.patch(profile._id, { failedAttempts: locked ? 0 : failedAttempts, lockedUntil: locked ? now + LOCK_MS : undefined });
  return what === "PIN" ? "Wrong PIN. Try again." : "Wrong password. Check it and try again.";
}

/**
 * Removes a profile and everything that belongs only to it: its sessions, its rows, its room memberships, and the
 * parties it hosts, which end (their host is gone, and so is the TorBox they play from).
 */
export async function removeProfile(ctx: MutationCtx, id: Id<"profiles">) {
  for (const m of await ctx.db.query("roomMembers").withIndex("by_profile", (q) => q.eq("profileId", id)).collect()) {
    const room = await ctx.db.get(m.roomId);
    if (room && !room.closedAt && room.hostId === id) await closeRoom(ctx, room);
  }
  const owned = [
    ...(await ctx.db.query("sessions").withIndex("by_profile", (q) => q.eq("profileId", id)).collect()),
    ...(await ctx.db.query("library").withIndex("by_profile", (q) => q.eq("profileId", id)).collect()),
    ...(await ctx.db.query("addons").withIndex("by_profile", (q) => q.eq("profileId", id)).collect()),
    ...(await ctx.db.query("progress").withIndex("by_profile_updated", (q) => q.eq("profileId", id)).collect()),
    ...(await ctx.db.query("feedback").withIndex("by_profile", (q) => q.eq("profileId", id)).collect()),
    ...(await ctx.db.query("viewing").withIndex("by_profile", (q) => q.eq("profileId", id)).collect()),
    ...(await ctx.db.query("partRatings").withIndex("by_profile", (q) => q.eq("profileId", id)).collect()),
    ...(await ctx.db.query("recs").withIndex("by_profile", (q) => q.eq("profileId", id)).collect()),
    ...(await ctx.db.query("tastes").withIndex("by_profile", (q) => q.eq("profileId", id)).collect()),
    ...(await ctx.db.query("connections").withIndex("by_profile", (q) => q.eq("profileId", id)).collect()),
    ...(await ctx.db.query("tracked").withIndex("by_profile", (q) => q.eq("profileId", id)).collect()),
    ...(await ctx.db.query("syncOutbox").withIndex("by_profile", (q) => q.eq("profileId", id)).collect()),
    ...(await ctx.db.query("traktConnections").withIndex("by_profile", (q) => q.eq("profileId", id)).collect()),
    ...(await ctx.db.query("traktLogins").withIndex("by_profile", (q) => q.eq("profileId", id)).collect()),
    ...(await ctx.db.query("traktOutbox").withIndex("by_profile", (q) => q.eq("profileId", id)).collect()),
    ...(await ctx.db.query("wrapped").withIndex("by_profile", (q) => q.eq("profileId", id)).collect()),
    ...(await ctx.db.query("unwatched").withIndex("by_title", (q) => q.eq("profileId", id)).collect()),
    ...(await ctx.db.query("roomMembers").withIndex("by_profile", (q) => q.eq("profileId", id)).collect()),
    ...(await ctx.db.query("lastSources").withIndex("by_profile_show", (q) => q.eq("profileId", id)).collect()),
  ];
  for (const doc of owned) await ctx.db.delete(doc._id);
  // Last: deleting its rows above noted those changes too.
  for (const doc of await ctx.db.query("changes").withIndex("by_profile_at", (q) => q.eq("profileId", id)).collect()) await ctx.db.delete(doc._id);
  if (await ctx.db.get(id)) await ctx.db.delete(id);
}
