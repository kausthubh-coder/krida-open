import { ConvexError, v } from "convex/values";
import { internalQuery, query, type MutationCtx } from "./_generated/server";
import { internalMutation, mutation } from "./functions";
import { prefsValidator } from "./schema";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { assertSafeTarget, qaSignInAllowed } from "./lib/deployment";
import { mergePrefs, prefsPatchValidator } from "./lib/prefs";
import { accountNamed, accountOfClerk, ensureAccount as ensureAccountRow, MAX_PROFILES } from "./lib/accounts";
import { checkSecret, hashPin, isPin, removeProfile } from "./lib/profiles";
import {
  hashPassword,
  profileFromToken,
  publicProfile,
  randomHex,
  requireClerk,
  requireProfile,
  sessionOf,
  sha256,
} from "./lib/auth";
export const TEMPORARY_PROFILE_TTL_MS = 24 * 60 * 60 * 1000;

export const inviteTemporary = mutation({
  args: { token: v.string(), roomId: v.id("rooms"), name: v.string() },
  handler: async (ctx, { token, roomId, name }) => {
    const me = await requireProfile(ctx, token);
    const room = await ctx.db.get(roomId);
    if (!room || room.closedAt) throw new ConvexError({ code: "NOT_FOUND", message: "This party has ended" });
    if (room.hostId !== me._id || me.expiresAt !== undefined)
      throw new ConvexError({ code: "FORBIDDEN", message: "Only the host can add temporary profiles" });
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 24)
      throw new ConvexError({ code: "INVALID", message: "Enter a name with 1 to 24 characters" });
    const invites = await ctx.db.query("temporaryInvites").withIndex("by_room", (q) => q.eq("roomId", roomId)).collect();
    if (invites.filter((i) => i.expiresAt > Date.now()).length >= 8)
      throw new ConvexError({ code: "LIMIT", message: "This party already has 8 temporary profiles" });
    const code = randomHex(32);
    const expiresAt = Date.now() + TEMPORARY_PROFILE_TTL_MS;
    const inviteId = await ctx.db.insert("temporaryInvites", {
      roomId, name: trimmed, hue: (me.hue + 137 * (invites.length + 1)) % 360,
      tokenHash: await sha256(code), expiresAt,
    });
    await ctx.db.patch(roomId, { kind: "party" });
    await ctx.scheduler.runAt(expiresAt, internal.profiles.expireTemporary, { inviteId });
    return { code, expiresAt };
  },
});

export const temporaryInvite = query({
  args: { code: v.string() },
  handler: async (ctx, { code }) => {
    const tokenHash = await sha256(code);
    const invite = await ctx.db.query("temporaryInvites").withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash)).unique();
    if (!invite || invite.profileId || invite.expiresAt <= Date.now()) return null;
    const room = await ctx.db.get(invite.roomId);
    const host = room && await ctx.db.get(room.hostId);
    if (!room || room.closedAt || !host) return null;
    return { name: invite.name, hue: invite.hue, host: host.name, expiresAt: invite.expiresAt };
  },
});

export const joinTemporary = mutation({
  args: { code: v.string() },
  handler: async (ctx, { code }) => {
    const tokenHash = await sha256(code);
    const invite = await ctx.db.query("temporaryInvites").withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash)).unique();
    if (!invite || invite.profileId || invite.expiresAt <= Date.now())
      throw new ConvexError({ code: "INVALID", message: "This link has expired or was already used. Ask the host for a new one." });
    const room = await ctx.db.get(invite.roomId);
    if (!room || room.closedAt) throw new ConvexError({ code: "NOT_FOUND", message: "This party has ended" });
    const profileId = await ctx.db.insert("profiles", {
      name: invite.name, hue: invite.hue, expiresAt: invite.expiresAt, order: 1000, failedAttempts: 0,
      prefs: { audioLang: "eng", sounds: true },
    });
    const token = randomHex(32);
    await ctx.db.insert("sessions", { profileId, tokenHash: await sha256(token), createdAt: Date.now() });
    await ctx.db.patch(invite._id, { profileId });
    // Membership is committed with the session, so a reload can still find the party.
    await ctx.db.insert("roomMembers", {
      roomId: room._id, profileId, joinedAt: Date.now(), lastSeenAt: Date.now(),
      buffering: false, position: 0, watching: true, left: false,
    });
    await ctx.db.insert("messages", { roomId: room._id, profileId, kind: "event", body: "joined", createdAt: Date.now() });
    await ctx.db.patch(room._id, { lastActiveAt: Date.now() });
    return { token, roomId: room._id };
  },
});

export const expireTemporary = internalMutation({
  args: { inviteId: v.id("temporaryInvites") },
  handler: async (ctx, { inviteId }) => {
    const invite = await ctx.db.get(inviteId);
    if (!invite || invite.expiresAt > Date.now()) return;
    if (invite.profileId) await removeProfile(ctx, invite.profileId);
    await ctx.db.delete(inviteId);
    await ctx.scheduler.runAfter(0, internal.rooms.closeIfEmpty, { roomId: invite.roomId });
  },
});

/**
 * The picker and "who's watching": the profiles of the signed-in Clerk user's account, or of the session's account
 * when there's no Clerk sign-in (QA sign-ins). Signed out, nothing. Never another account's.
 */
export const list = query({
  args: { token: v.optional(v.string()) },
  handler: async (ctx, { token }) => {
    const identity = await ctx.auth.getUserIdentity();
    const accountId = identity ? (await accountOfClerk(ctx, identity))?._id : (await profileFromToken(ctx, token))?.accountId;
    if (!accountId) return [];
    const profiles = await ctx.db.query("profiles").withIndex("by_account", (q) => q.eq("accountId", accountId)).take(MAX_PROFILES * 2);
    return profiles.sort((a, b) => a.order - b.order).map((p) => ({ ...publicProfile(p), hasPin: !!p.pin }));
  },
});

export const me = query({
  args: { token: v.optional(v.string()) },
  handler: async (ctx, { token }) => {
    const session = token ? await sessionOf(ctx, token) : null;
    const profile = await profileFromToken(ctx, token);
    if (!profile) return null;
    // A session from choosing a profile ends with the Clerk sign-in that chose it (the app signs it out).
    return { ...publicProfile(profile), prefs: profile.prefs, hasPin: !!profile.pin, viaAccount: !!session?.clerkUserId };
  },
});

/** The signed-in Clerk user's account, made on their first sign-in. */
export const ensureAccount = mutation({
  args: {},
  returns: v.id("accounts"),
  handler: async (ctx) => (await ensureAccountRow(ctx, await requireClerk(ctx)))._id,
});

function cleanName(name: string) {
  const trimmed = name.trim();
  if (!trimmed) throw new ConvexError({ code: "INVALID", message: "Enter a name" });
  if (trimmed.length > 24) throw new ConvexError({ code: "INVALID", message: "Use 24 characters or fewer" });
  return trimmed;
}

const cleanHue = (hue: number) => ((Math.round(hue) % 360) + 360) % 360;

/** A new profile in the signed-in account, up to 8, with an optional PIN. */
export const create = mutation({
  args: { name: v.string(), hue: v.number(), pin: v.optional(v.string()) },
  returns: v.id("profiles"),
  handler: async (ctx, { name, hue, pin }) => {
    const account = await ensureAccountRow(ctx, await requireClerk(ctx));
    const mine = await ctx.db.query("profiles").withIndex("by_account", (q) => q.eq("accountId", account._id)).collect();
    if (mine.length >= MAX_PROFILES) throw new ConvexError({ code: "LIMIT", message: `An account has at most ${MAX_PROFILES} profiles` });
    const trimmed = cleanName(name);
    if (mine.some((p) => p.name.toLowerCase() === trimmed.toLowerCase()))
      throw new ConvexError({ code: "INVALID", message: `There's already a profile called ${trimmed}` });
    if (pin !== undefined && !isPin(pin)) throw new ConvexError({ code: "INVALID", message: "A PIN is 4 digits" });
    return await ctx.db.insert("profiles", {
      accountId: account._id,
      name: trimmed,
      hue: cleanHue(hue),
      pin: pin === undefined ? undefined : await hashPin(pin),
      order: Math.max(-1, ...mine.map((p) => p.order)) + 1,
      failedAttempts: 0,
      prefs: { audioLang: "eng", sounds: true },
    });
  },
});

/** A profile of the signed-in account, refusing any other; when it has a PIN, checks it (counting wrong tries). */
async function myProfile(ctx: MutationCtx, profileId: Id<"profiles">, pin: string | undefined) {
  const identity = await requireClerk(ctx);
  const account = await accountOfClerk(ctx, identity);
  const profile = await ctx.db.get(profileId);
  if (!profile || !account || profile.accountId !== account._id)
    throw new ConvexError({ code: "FORBIDDEN", message: "That profile isn't in your account" });
  const wrong = profile.pin ? (pin === undefined ? "Enter the PIN." : await checkSecret(ctx, profile, profile.pin, pin, "PIN")) : null;
  return { identity, account, profile, wrong };
}

const refused = (message: string) => ({ ok: false as const, message });

/**
 * The picker: the signed-in account picks one of its profiles (with its PIN, when it has one) and gets the session
 * token everything else takes.
 */
export const choose = mutation({
  args: { profileId: v.id("profiles"), pin: v.optional(v.string()) },
  handler: async (ctx, { profileId, pin }) => {
    const { identity, account, profile, wrong } = await myProfile(ctx, profileId, pin);
    if (wrong) return refused(wrong);
    const token = randomHex(32);
    const sid = (identity as { sid?: unknown }).sid;
    await ctx.db.insert("sessions", {
      profileId: profile._id,
      tokenHash: await sha256(token),
      createdAt: Date.now(),
      accountId: account._id,
      clerkUserId: identity.subject,
      clerkSessionId: typeof sid === "string" ? sid : undefined,
    });
    return { ok: true as const, token };
  },
});

/** Rename a profile or change its colour from the picker (its PIN, when it has one). */
export const edit = mutation({
  args: { profileId: v.id("profiles"), name: v.optional(v.string()), hue: v.optional(v.number()), pin: v.optional(v.string()) },
  handler: async (ctx, { profileId, name, hue, pin }) => {
    const { profile, wrong } = await myProfile(ctx, profileId, pin);
    if (wrong) return refused(wrong);
    await ctx.db.patch(profile._id, {
      ...(name !== undefined ? { name: cleanName(name) } : {}),
      ...(hue !== undefined ? { hue: cleanHue(hue) } : {}),
    });
    return { ok: true as const };
  },
});

/** Delete a profile of the signed-in account: its sessions, memberships and history go, and parties it hosts end. */
export const deleteProfile = mutation({
  args: { profileId: v.id("profiles"), pin: v.optional(v.string()) },
  handler: async (ctx, { profileId, pin }) => {
    const { profile, wrong } = await myProfile(ctx, profileId, pin);
    if (wrong) return refused(wrong);
    await removeProfile(ctx, profile._id);
    return { ok: true as const };
  },
});

/**
 * Set, change or remove this profile's PIN (`null`). Setting one signs out the profile's other devices, which chose
 * it without it.
 */
export const setPin = mutation({
  args: { token: v.string(), pin: v.union(v.string(), v.null()) },
  returns: v.null(),
  handler: async (ctx, { token, pin }) => {
    const profile = await requireProfile(ctx, token);
    if (!profile.accountId) throw new ConvexError({ code: "FORBIDDEN", message: "Temporary profiles have no PIN" });
    if (pin === null) {
      await ctx.db.patch(profile._id, { pin: undefined });
      return null;
    }
    if (!isPin(pin)) throw new ConvexError({ code: "INVALID", message: "A PIN is 4 digits" });
    await ctx.db.patch(profile._id, { pin: await hashPin(pin) });
    const keep = await sha256(token);
    for (const s of await ctx.db.query("sessions").withIndex("by_profile", (q) => q.eq("profileId", profile._id)).collect())
      if (s.tokenHash !== keep) await ctx.db.delete(s._id);
    return null;
  },
});

/** Back to the picker: ends this device's profile session; the Clerk sign-in stays. */
export const signOut = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const session = await sessionOf(ctx, token);
    if (session) await ctx.db.delete(session._id);
  },
});

/**
 * Signing out of the account on this device (before Clerk forgets it): ends every profile session this Clerk sign-in
 * made, and the one in `token`.
 */
export const signOutAccount = mutation({
  args: { token: v.optional(v.string()) },
  returns: v.number(),
  handler: async (ctx, { token }) => {
    const identity = await ctx.auth.getUserIdentity();
    const sid = (identity as { sid?: unknown } | null)?.sid;
    const ended = typeof sid === "string"
      ? (await ctx.db.query("sessions").withIndex("by_clerkSession", (q) => q.eq("clerkSessionId", sid)).collect()).filter((s) => s.clerkUserId === identity!.subject)
      : [];
    const mine = token ? await sessionOf(ctx, token) : null;
    if (mine && !ended.some((s) => s._id === mine._id) && (!mine.clerkUserId || mine.clerkUserId === identity?.subject)) ended.push(mine);
    for (const s of ended) await ctx.db.delete(s._id);
    return ended.length;
  },
});

/**
 * For scripts: a QA profile's name and password give its session, with no Clerk sign-in. Only on a backend on this
 * machine and on dev (qaSignInAllowed); production has no such way in.
 */
export const qaSignIn = mutation({
  args: { name: v.string(), password: v.string() },
  handler: async (ctx, { name, password }) => {
    if (!qaSignInAllowed()) throw new ConvexError({ code: "FORBIDDEN", message: "QA sign-in is off on this deployment" });
    if (!/(^|-)QA(-|$)/.test(name)) throw new ConvexError({ code: "FORBIDDEN", message: "Only QA profiles sign in this way" });
    const profile = await ctx.db.query("profiles").withIndex("by_name", (q) => q.eq("name", name)).first();
    if (!profile?.passwordHash || !profile.salt || profile.expiresAt !== undefined) return refused("No QA profile has that name");
    const wrong = await checkSecret(ctx, profile, { hash: profile.passwordHash, salt: profile.salt }, password, "password");
    if (wrong) return refused(wrong);
    const token = randomHex(32);
    await ctx.db.insert("sessions", { profileId: profile._id, tokenHash: await sha256(token), createdAt: Date.now() });
    return { ok: true as const, token };
  },
});

export const update = mutation({
  args: {
    token: v.string(),
    name: v.optional(v.string()),
    hue: v.optional(v.number()),
    // The whole object, replaced: what tabs opened before `prefsPatch` send.
    prefs: v.optional(
      prefsValidator,
    ),
    // Only the settings that changed, merged into the stored ones, so two quick changes can't undo each other.
    // `subLang: null` turns subtitles off.
    prefsPatch: v.optional(prefsPatchValidator),
  },
  handler: async (ctx, { token, name, hue, prefs, prefsPatch }) => {
    const profile = await requireProfile(ctx, token);
    const patch: Record<string, unknown> = {};
    if (name !== undefined) patch.name = cleanName(name);
    if (hue !== undefined) patch.hue = cleanHue(hue);
    if (prefs) patch.prefs = prefs;
    if (prefsPatch) patch.prefs = mergePrefs(prefs ?? profile.prefs, prefsPatch);
    await ctx.db.patch(profile._id, patch);
  },
});

export const validate = internalQuery({
  args: { token: v.optional(v.string()) },
  handler: async (ctx, { token }) => {
    const profile = await profileFromToken(ctx, token);
    return profile?._id ?? null;
  },
});

export const prefsOf = internalQuery({
  args: { profileId: v.id("profiles") },
  handler: async (ctx, { profileId }) => (await ctx.db.get(profileId))?.prefs ?? null,
});

export const seed = internalMutation({
  args: {
    profiles: v.array(v.object({ name: v.string(), hue: v.number(), password: v.string() })),
    // The account they share, made if there's none.
    account: v.optional(v.string()),
  },
  handler: async (ctx, { profiles, account }) => {
    const existing = await ctx.db.query("profiles").first();
    if (existing) throw new Error("Profiles already exist");
    const accountId = await accountNamed(ctx, account ?? "Krida");
    let order = 0;
    for (const p of profiles) {
      const salt = randomHex(16);
      await ctx.db.insert("profiles", {
        name: p.name,
        hue: p.hue,
        salt,
        passwordHash: await hashPassword(p.password, salt),
        order: order++,
        failedAttempts: 0,
        prefs: { audioLang: "eng", subLang: undefined, sounds: true },
        accountId,
      });
    }
  },
});

export const resetPassword = internalMutation({
  args: { name: v.string(), password: v.string(), confirmProd: v.optional(v.boolean()) },
  handler: async (ctx, { name, password, confirmProd }) => {
    assertSafeTarget("profiles:resetPassword", confirmProd);
    const profile = (await ctx.db.query("profiles").collect()).find((p) => p.name === name);
    if (!profile) throw new Error("No such profile");
    const salt = randomHex(16);
    await ctx.db.patch(profile._id, {
      salt,
      passwordHash: await hashPassword(password, salt),
      failedAttempts: 0,
      lockedUntil: undefined,
    });
  },
});

/** The account a profile added from the CLI joins when none is named: every QA profile shares one. */
const defaultAccount = (name: string) => (/-QA(-|$)/i.test(name) ? "QA" : name);

/** Adds one more profile (from the CLI), in the account named `account` (made if there's none). */
export const add = internalMutation({
  args: { name: v.string(), hue: v.number(), password: v.string(), account: v.optional(v.string()) },
  handler: async (ctx, { name, hue, password, account }) => {
    const all = await ctx.db.query("profiles").collect();
    if (all.some((p) => p.name === name)) throw new Error("A profile with that name exists");
    const salt = randomHex(16);
    const accountId = await accountNamed(ctx, account ?? defaultAccount(name));
    return await ctx.db.insert("profiles", {
      accountId,
      name,
      hue,
      salt,
      passwordHash: await hashPassword(password, salt),
      order: Math.max(-1, ...all.map((p) => p.order)) + 1,
      failedAttempts: 0,
      prefs: { audioLang: "eng", subLang: undefined, sounds: true },
    });
  },
});

/** Removes a profile and everything that belongs only to it (from the CLI). */
export const remove = internalMutation({
  args: { name: v.string(), confirmProd: v.optional(v.boolean()) },
  handler: async (ctx, { name, confirmProd }) => {
    assertSafeTarget("profiles:remove", confirmProd);
    const profile = (await ctx.db.query("profiles").collect()).find((p) => p.name === name);
    if (!profile) throw new Error("No such profile");
    await removeProfile(ctx, profile._id);
  },
});
