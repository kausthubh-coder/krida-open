import { ConvexError, v } from "convex/values";
import { action, internalAction, internalQuery, query, type MutationCtx } from "./_generated/server";
import { internalMutation, mutation } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireProfile } from "./lib/auth";
import { bandOf } from "./lib/ratings";
import { invalidateStats } from "./lib/statsCache";
import { canonicalTitle, titleIds } from "./lib/titleIds";
import {
  MINUTE,
  deviceCode,
  deviceToken,
  revoke,
  session,
  trakt,
  traktConfigured,
  traktConnectionFor,
} from "./lib/traktApi";
import { book, cancelTraktFlush, clearTraktOutbox, push, traktListPending, traktRatePending } from "./lib/traktOutbox";
import { failed, pull } from "./lib/traktPull";

/*
 * Trakt for a profile (docs/trakt.md): connecting with a device code, a one-time import, catching up when Krida is
 * opened, and the outbox's sends. Nothing here runs on a timer: syncs start from `touch` (opening Krida) or Sync now,
 * sends from a change made in Krida, and a login's checks end with the code.
 */

const SYNC_EVERY = 10 * MINUTE;
const SYNC_LEASE = 10 * MINUTE;

const isSyncing = (c: Doc<"traktConnections">) => !!c.syncing && c.syncing > Date.now() - SYNC_LEASE;

/** Whether this deployment has its own Trakt app (TRAKT_CLIENT_ID and TRAKT_CLIENT_SECRET on Convex). */
export const enabled = query({
  args: {},
  returns: v.boolean(),
  handler: async () => traktConfigured(),
});

// ---------------------------------------------------------------------------------------------
// Connecting, with a device code

const loginFields = { userCode: v.string(), verificationUrl: v.string(), expiresAt: v.number() };

/** Step 1: a code to enter at Trakt. The server then asks Trakt whether it was approved until the code runs out. */
export const start = action({
  args: { token: v.string() },
  returns: v.object(loginFields),
  handler: async (ctx, { token }): Promise<{ userCode: string; verificationUrl: string; expiresAt: number }> => {
    const profileId: Id<"profiles"> | null = await ctx.runQuery(internal.profiles.validate, { token });
    if (!profileId) throw new ConvexError({ code: "AUTH", message: "Sign in to Krida again, then connect Trakt." });
    if (!traktConfigured()) throw new ConvexError({ code: "OFF", message: "Trakt isn’t set up on this server." });
    let code;
    try {
      code = await deviceCode();
    } catch {
      throw new ConvexError({ code: "TRAKT", message: "Couldn’t reach Trakt. Try again in a minute." });
    }
    const expiresAt = Date.now() + code.expiresIn * 1000;
    const loginId: Id<"traktLogins"> = await ctx.runMutation(internal.trakt.saveLogin, {
      profileId, deviceCode: code.deviceCode, userCode: code.userCode, verificationUrl: code.verificationUrl,
      interval: code.interval, expiresAt,
    });
    await ctx.scheduler.runAfter(code.interval * 1000, internal.trakt.poll, { loginId });
    return { userCode: code.userCode, verificationUrl: code.verificationUrl, expiresAt };
  },
});

export const saveLogin = internalMutation({
  args: { profileId: v.id("profiles"), deviceCode: v.string(), userCode: v.string(), verificationUrl: v.string(),
    interval: v.number(), expiresAt: v.number() },
  handler: async (ctx, { profileId, ...login }) => {
    // One login at a time: starting again ends the last one, and its checks stop.
    for (const old of await ctx.db.query("traktLogins").withIndex("by_profile", (q) => q.eq("profileId", profileId)).take(10))
      await ctx.db.delete(old._id);
    return await ctx.db.insert("traktLogins", { profileId, ...login });
  },
});

/** The login under way, for the page that shows the code. Never the device code itself. */
export const login = query({
  args: { token: v.string() },
  returns: v.union(v.null(), v.object({ ...loginFields, over: v.union(v.null(), v.literal("denied"), v.literal("expired")) })),
  handler: async (ctx, { token }) => {
    const me = await requireProfile(ctx, token);
    const row = await ctx.db.query("traktLogins").withIndex("by_profile", (q) => q.eq("profileId", me._id)).first();
    if (!row) return null;
    return { userCode: row.userCode, verificationUrl: row.verificationUrl, expiresAt: row.expiresAt, over: row.over ?? null };
  },
});

/** Closing the code: no more asking Trakt. */
export const cancel = mutation({
  args: { token: v.string() },
  returns: v.null(),
  handler: async (ctx, { token }) => {
    const me = await requireProfile(ctx, token);
    for (const row of await ctx.db.query("traktLogins").withIndex("by_profile", (q) => q.eq("profileId", me._id)).take(10))
      await ctx.db.delete(row._id);
    return null;
  },
});

export const loginById = internalQuery({
  args: { loginId: v.id("traktLogins") },
  handler: async (ctx, { loginId }) => await ctx.db.get(loginId),
});

/**
 * Step 2: ask Trakt whether the code was approved, every `interval` seconds as Trakt asks, until it was, the person
 * said no, the code ran out, or they closed it. It never outlives the code (ten minutes).
 */
export const poll = internalAction({
  args: { loginId: v.id("traktLogins") },
  returns: v.null(),
  handler: async (ctx, { loginId }) => {
    const login: Doc<"traktLogins"> | null = await ctx.runQuery(internal.trakt.loginById, { loginId });
    if (!login || login.over) return null;
    if (login.expiresAt <= Date.now()) {
      await ctx.runMutation(internal.trakt.endLogin, { loginId, over: "expired" });
      return null;
    }
    const answer = await deviceToken(login.deviceCode);
    if (answer.kind === "tokens") {
      let account: { name: string; avatar?: string } | undefined;
      try {
        const { body } = await trakt<any>("/users/settings", answer.tokens.accessToken);
        const name = body?.user?.name || body?.user?.username;
        const avatar = body?.user?.images?.avatar?.full;
        if (typeof name === "string") account = { name, ...(typeof avatar === "string" ? { avatar } : {}) };
      } catch {
        // The account name is a nicety; the connection works without it.
      }
      await ctx.runMutation(internal.trakt.saveConnection, { loginId, ...answer.tokens, account });
      return null;
    }
    if (answer.kind === "over") {
      await ctx.runMutation(internal.trakt.endLogin, { loginId, over: answer.reason });
      return null;
    }
    // Asked too often: Trakt wants more time between asks.
    const wait = (login.interval + (answer.kind === "slowDown" ? 5 : 0)) * 1000;
    if (answer.kind === "slowDown") await ctx.runMutation(internal.trakt.slowLogin, { loginId, interval: login.interval + 5 });
    if (Date.now() + wait < login.expiresAt) await ctx.scheduler.runAfter(wait, internal.trakt.poll, { loginId });
    else await ctx.runMutation(internal.trakt.endLogin, { loginId, over: "expired" });
    return null;
  },
});

export const slowLogin = internalMutation({
  args: { loginId: v.id("traktLogins"), interval: v.number() },
  handler: async (ctx, { loginId, interval }) => {
    if (await ctx.db.get(loginId)) await ctx.db.patch(loginId, { interval });
  },
});

export const endLogin = internalMutation({
  args: { loginId: v.id("traktLogins"), over: v.union(v.literal("denied"), v.literal("expired")) },
  handler: async (ctx, { loginId, over }) => {
    if (await ctx.db.get(loginId)) await ctx.db.patch(loginId, { over });
  },
});

/** Library rows a profile's Trakt watchlist kept in step stop following it (disconnected, or another account). */
async function unflagWatchlist(ctx: MutationCtx, profileId: Id<"profiles">) {
  for (const row of await ctx.db.query("library").withIndex("by_profile", (q) => q.eq("profileId", profileId)).collect())
    if (row.trakt) await ctx.db.patch(row._id, { trakt: undefined });
}

/** Approved: keep the tokens on the server and start the import. */
export const saveConnection = internalMutation({
  args: {
    loginId: v.id("traktLogins"),
    accessToken: v.string(),
    refreshToken: v.optional(v.string()),
    expiresAt: v.optional(v.number()),
    account: v.optional(v.object({ name: v.string(), avatar: v.optional(v.string()) })),
  },
  handler: async (ctx, { loginId, ...tokens }) => {
    // Closed or started again meanwhile: that approval is no longer wanted.
    const login = await ctx.db.get(loginId);
    if (!login || login.over) return;
    await ctx.db.delete(loginId);
    const { profileId } = login;
    const existing = await traktConnectionFor(ctx, profileId);
    await clearTraktOutbox(ctx, profileId);
    if (existing) {
      await cancelTraktFlush(ctx, existing);
      await unflagWatchlist(ctx, profileId);
    }
    // A fresh connection (maybe another Trakt account) starts over with a full import.
    const doc = {
      profileId,
      ...tokens,
      writeBack: existing?.writeBack ?? true,
      connectedAt: Math.max(Date.now(), (existing?.connectedAt ?? 0) + 1),
    };
    if (existing) await ctx.db.replace(existing._id, doc);
    else await ctx.db.insert("traktConnections", doc);
    await ctx.scheduler.runAfter(0, internal.trakt.sync, { profileId });
  },
});

// ---------------------------------------------------------------------------------------------
// What Settings shows, and its controls

/** The connection and how its sync is going. No tokens. */
export const status = query({
  args: { token: v.string() },
  returns: v.union(v.null(), v.object({
    account: v.union(v.null(), v.object({ name: v.string(), avatar: v.optional(v.string()) })),
    // The page compares these with its own clock: a cached query can't know the time has passed.
    syncingSince: v.union(v.null(), v.number()),
    syncLease: v.number(),
    pausedUntil: v.union(v.null(), v.number()),
    imported: v.union(v.null(), v.object({ plays: v.number(), planned: v.number(), rated: v.number() })),
    waiting: v.number(),
    lastSyncAt: v.union(v.null(), v.number()),
    lastError: v.union(v.null(), v.string()),
    needsReconnect: v.boolean(),
    writeBack: v.boolean(),
  })),
  handler: async (ctx, { token }) => {
    const me = await requireProfile(ctx, token);
    const c = await traktConnectionFor(ctx, me._id);
    if (!c) return null;
    const waiting = await ctx.db.query("traktOutbox").withIndex("by_profile", (q) => q.eq("profileId", me._id)).take(100);
    return {
      account: c.account ?? null,
      syncingSince: c.syncing ?? null,
      syncLease: SYNC_LEASE,
      pausedUntil: c.backoffUntil ?? null,
      imported: c.imported ?? null,
      waiting: waiting.length,
      lastSyncAt: c.lastSyncAt ?? null,
      lastError: c.lastError ?? null,
      needsReconnect: c.needsReconnect ?? false,
      writeBack: c.writeBack,
    };
  },
});

/** Called when the app opens or comes back to the front: catch up with Trakt if it's been a while. */
export const touch = mutation({
  args: { token: v.string() },
  returns: v.null(),
  handler: async (ctx, { token }) => {
    const me = await requireProfile(ctx, token);
    const c = await traktConnectionFor(ctx, me._id);
    if (!c || c.needsReconnect || isSyncing(c)) return null;
    if (c.lastSyncAt && c.lastSyncAt > Date.now() - SYNC_EVERY) return null;
    if (c.backoffUntil && c.backoffUntil > Date.now()) return null;
    await ctx.scheduler.runAfter(0, internal.trakt.sync, { profileId: me._id });
    return null;
  },
});

export const syncNow = mutation({
  args: { token: v.string() },
  returns: v.null(),
  handler: async (ctx, { token }) => {
    const me = await requireProfile(ctx, token);
    const c = await traktConnectionFor(ctx, me._id);
    if (c && !isSyncing(c)) await ctx.scheduler.runAfter(0, internal.trakt.sync, { profileId: me._id });
    return null;
  },
});

export const setWriteBack = mutation({
  args: { token: v.string(), writeBack: v.boolean() },
  returns: v.null(),
  handler: async (ctx, { token, writeBack }) => {
    const me = await requireProfile(ctx, token);
    const c = await traktConnectionFor(ctx, me._id);
    if (c) {
      await ctx.db.patch(c._id, { writeBack });
      await book(ctx, me._id);
    }
    return null;
  },
});

/** Krida forgets the tokens at once; what the import brought in stays, and stops following Trakt. */
export const disconnect = mutation({
  args: { token: v.string() },
  returns: v.null(),
  handler: async (ctx, { token }) => {
    const me = await requireProfile(ctx, token);
    for (const row of await ctx.db.query("traktLogins").withIndex("by_profile", (q) => q.eq("profileId", me._id)).take(10))
      await ctx.db.delete(row._id);
    const c = await traktConnectionFor(ctx, me._id);
    if (!c) return null;
    await cancelTraktFlush(ctx, c);
    await clearTraktOutbox(ctx, me._id);
    await ctx.db.delete(c._id);
    await unflagWatchlist(ctx, me._id);
    // Trakt forgets the grant too. Its revoke takes the access token (a refresh token there revokes nothing).
    await ctx.scheduler.runAfter(0, internal.trakt.revokeGrant, { token: c.accessToken });
    return null;
  },
});

export const revokeGrant = internalAction({
  args: { token: v.string() },
  returns: v.null(),
  handler: async (_ctx, { token }) => {
    await revoke(token);
    return null;
  },
});

// ---------------------------------------------------------------------------------------------
// Syncing

export const connection = internalQuery({
  args: { profileId: v.id("profiles") },
  handler: async (ctx, { profileId }) => await traktConnectionFor(ctx, profileId),
});

export const claimSync = internalMutation({
  args: { profileId: v.id("profiles"), flush: v.optional(v.boolean()) },
  returns: v.boolean(),
  handler: async (ctx, { profileId, flush }) => {
    const c = await traktConnectionFor(ctx, profileId);
    if (!c || c.needsReconnect || isSyncing(c)) return false;
    if (flush && !c.writeBack) return false;
    if (c.backoffUntil && c.backoffUntil > Date.now()) return false;
    // A send run that starts is the one that was booked: the booking is spent.
    await ctx.db.patch(c._id, { syncing: Date.now(), ...(flush ? { flushAt: undefined, flushJobId: undefined } : {}) });
    return true;
  },
});

export const patchConnection = internalMutation({
  args: {
    profileId: v.id("profiles"),
    patch: v.object({
      accessToken: v.optional(v.string()),
      refreshToken: v.optional(v.string()),
      expiresAt: v.optional(v.number()),
      snapshot: v.optional(v.string()),
      imported: v.optional(v.object({ plays: v.number(), planned: v.number(), rated: v.number() })),
      lastSyncAt: v.optional(v.number()),
      lastError: v.optional(v.string()),
      needsReconnect: v.optional(v.boolean()),
      backoffUntil: v.optional(v.number()),
      done: v.optional(v.boolean()),
    }),
    expectedConnectedAt: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, { profileId, patch: { done, ...patch }, expectedConnectedAt }) => {
    const c = await traktConnectionFor(ctx, profileId);
    if (!c || (expectedConnectedAt !== undefined && c.connectedAt !== expectedConnectedAt)) return null;
    await ctx.db.patch(c._id, {
      ...patch,
      ...(done ? { syncing: undefined } : {}),
      ...(done && !patch.lastError ? { lastError: undefined } : {}),
    });
    return null;
  },
});

/**
 * Bring Krida up to date with Trakt: whatever Krida changed goes first (so Trakt's answer already includes it), then
 * only what /sync/last_activities says moved comes back. The first sync brings in everything.
 */
export const sync = internalAction({
  args: { profileId: v.id("profiles") },
  returns: v.null(),
  handler: async (ctx, { profileId }) => {
    if (!(await ctx.runMutation(internal.trakt.claimSync, { profileId }))) return null;
    const conn: Doc<"traktConnections"> | null = await ctx.runQuery(internal.trakt.connection, { profileId });
    if (!conn) return null;
    const { call, all } = session(ctx, conn);
    try {
      await push(ctx, profileId, call, conn.connectedAt);
      const { body: activities } = await call<any>("/sync/last_activities");
      const prev = conn.snapshot ? JSON.parse(conn.snapshot) : null;
      const counts = await pull(ctx, profileId, all, activities, prev, conn.connectedAt);
      await ctx.runMutation(internal.trakt.patchConnection, {
        profileId,
        expectedConnectedAt: conn.connectedAt,
        patch: { snapshot: JSON.stringify(activities), lastSyncAt: Date.now(), needsReconnect: false, done: true,
          ...(prev ? {} : { imported: counts }) },
      });
    } catch (error) {
      await failed(ctx, profileId, error, conn.connectedAt);
    }
    await ctx.runMutation(internal.trakt.settle, { profileId, sent: [], retry: [] });
    return null;
  },
});

const sameConnection = async (ctx: MutationCtx, profileId: Id<"profiles">, expectedConnectedAt: number) =>
  (await traktConnectionFor(ctx, profileId))?.connectedAt === expectedConnectedAt;

const kind = v.union(v.literal("movie"), v.literal("series"));
const playFields = { id: v.string(), type: kind, name: v.string(), year: v.optional(v.string()),
  season: v.optional(v.number()), episode: v.optional(v.number()), at: v.number() };

/** Whether Krida is about to tell Trakt this play didn't happen. */
async function unwatchWaiting(ctx: MutationCtx, profileId: Id<"profiles">, p: { id: string; season?: number; episode?: number }) {
  const keys = [`unwatch:${p.id}`, ...(p.episode !== undefined ? [`watched:${p.id}:${p.season ?? ""}:${p.episode}`] : [])];
  for (const key of keys) {
    const row = await ctx.db.query("traktOutbox").withIndex("by_key", (q) => q.eq("profileId", profileId).eq("key", key)).first();
    if (row?.op === "unwatch") return true;
  }
  return false;
}

/** Plays from Trakt become finished progress rows; pauses become a place to carry on from. */
export const applyPlays = internalMutation({
  args: { profileId: v.id("profiles"), expectedConnectedAt: v.number(),
    plays: v.array(v.object(playFields)),
    paused: v.array(v.object({ ...playFields, position: v.number(), duration: v.number() })) },
  returns: v.null(),
  handler: async (ctx, { profileId, expectedConnectedAt, plays, paused }) => {
    if (!(await sameConnection(ctx, profileId, expectedConnectedAt))) return null;
    const rowFor = async (p: { id: string; type: "movie" | "series"; name: string; year?: string; season?: number; episode?: number }) => {
      const videoId = p.type === "movie" ? p.id : `${p.id}:${p.season}:${p.episode}`;
      const media = { type: p.type, imdbId: p.id, videoId, name: p.name,
        ...(p.year !== undefined ? { year: p.year } : {}),
        ...(p.type === "series" ? { season: p.season, episode: p.episode } : {}) };
      const row = await ctx.db.query("progress").withIndex("by_profile_video", (q) => q.eq("profileId", profileId).eq("media.videoId", videoId)).first();
      return { media, row };
    };
    let wrote = false;
    for (const p of plays) {
      if (await unwatchWaiting(ctx, profileId, p)) continue;
      const { media, row } = await rowFor(p);
      if (!row) {
        await ctx.db.insert("progress", { profileId, media, position: 0, duration: 0, finished: true, hidden: false, updatedAt: p.at });
        wrote = true;
      } else if (row.finished ? row.updatedAt < p.at : row.updatedAt <= p.at) {
        // Watched again elsewhere since; a play under way here that's newer stays as it is.
        await ctx.db.patch(row._id, { finished: true, updatedAt: p.at });
        wrote = true;
      }
    }
    for (const p of paused) {
      const { media, row } = await rowFor(p);
      if (row && row.updatedAt >= p.at) continue;
      const doc = { position: p.position, duration: p.duration, finished: false, updatedAt: p.at };
      if (row) await ctx.db.patch(row._id, doc);
      else await ctx.db.insert("progress", { profileId, media, hidden: false, ...doc });
      wrote = true;
    }
    if (wrote) await invalidateStats(ctx, profileId);
    return null;
  },
});

/** The Trakt watchlist, kept in Plan to watch. A change Krida hasn't sent yet wins. */
export const applyWatchlist = internalMutation({
  args: { profileId: v.id("profiles"), expectedConnectedAt: v.number(),
    items: v.array(v.object({ id: v.string(), type: kind, name: v.string(), year: v.optional(v.string()), addedAt: v.optional(v.number()) })) },
  returns: v.null(),
  handler: async (ctx, { profileId, expectedConnectedAt, items }) => {
    if (!(await sameConnection(ctx, profileId, expectedConnectedAt))) return null;
    for (const item of items) {
      if (await traktListPending(ctx, profileId, item.id)) continue;
      const title = await canonicalTitle(ctx, profileId, { id: item.id, type: item.type, name: item.name, year: item.year });
      const existing = await ctx.db.query("library").withIndex("by_profile_imdb", (q) => q.eq("profileId", profileId).eq("imdbId", title.id)).first();
      if (existing) {
        if (!existing.trakt) await ctx.db.patch(existing._id, { trakt: true });
        continue;
      }
      await ctx.db.insert("library", { profileId, type: title.type, imdbId: title.id, name: title.name,
        ...(title.year !== undefined ? { year: title.year } : {}), addedAt: item.addedAt ?? Date.now(), trakt: true });
    }
    return null;
  },
});

/** Titles that came from the Trakt watchlist and left it there leave Plan to watch. */
export const pruneWatchlist = internalMutation({
  args: { profileId: v.id("profiles"), expectedConnectedAt: v.number(), keep: v.array(v.string()) },
  returns: v.null(),
  handler: async (ctx, { profileId, expectedConnectedAt, keep }) => {
    if (!(await sameConnection(ctx, profileId, expectedConnectedAt))) return null;
    const kept = new Set(keep);
    for (const row of await ctx.db.query("library").withIndex("by_profile", (q) => q.eq("profileId", profileId)).collect()) {
      if (!row.trakt) continue;
      const ids = await titleIds(ctx, profileId, row.imdbId);
      if (ids.some((id) => kept.has(id))) continue;
      if ((await Promise.all(ids.map((id) => traktListPending(ctx, profileId, id)))).some(Boolean)) continue;
      await ctx.db.delete(row._id);
    }
    return null;
  },
});

/** Trakt scores, 1 to 10 like Krida's. The newer of the two wins. */
export const applyRatings = internalMutation({
  args: { profileId: v.id("profiles"), expectedConnectedAt: v.number(),
    ratings: v.array(v.object({ id: v.string(), type: kind, name: v.string(), rating: v.number(), at: v.number() })) },
  returns: v.null(),
  handler: async (ctx, { profileId, expectedConnectedAt, ratings }) => {
    if (!(await sameConnection(ctx, profileId, expectedConnectedAt))) return null;
    let wrote = false;
    for (const r of ratings) {
      const title = await canonicalTitle(ctx, profileId, { id: r.id, type: r.type, name: r.name });
      if (await traktRatePending(ctx, profileId, r.id)) continue;
      const row = await ctx.db.query("feedback").withIndex("by_profile_id", (q) => q.eq("profileId", profileId).eq("id", title.id)).first();
      if (row && row.at >= r.at) continue;
      const doc = { profileId, ...title, value: bandOf(r.rating), rating: r.rating, at: r.at };
      if (row) await ctx.db.replace(row._id, doc);
      else await ctx.db.insert("feedback", doc);
      wrote = true;
    }
    if (wrote) await invalidateStats(ctx, profileId);
    return null;
  },
});

// ---------------------------------------------------------------------------------------------
// The outbox's own runs

/** A send run that couldn't start (a sync was going): try again in a couple of minutes. */
export const rebook = internalMutation({
  args: { profileId: v.id("profiles") },
  handler: async (ctx, { profileId }) => await book(ctx, profileId, 2 * MINUTE),
});

/** Freeze the sender's batch before network I/O. Later edits replace claimed rows rather than changing them. */
export const claimDue = internalMutation({
  args: { profileId: v.id("profiles"), now: v.number(), expectedConnectedAt: v.number() },
  handler: async (ctx, { profileId, now, expectedConnectedAt }) => {
    const c = await traktConnectionFor(ctx, profileId);
    if (c?.connectedAt !== expectedConnectedAt || !c.writeBack || c.needsReconnect || (c.backoffUntil && c.backoffUntil > now)) return [];
    const rows = await ctx.db.query("traktOutbox")
      .withIndex("by_profile", (q) => q.eq("profileId", profileId).lte("nextAt", now + 2_000)).take(100);
    for (const row of rows) await ctx.db.patch(row._id, { inFlight: true });
    return rows.map((row) => ({ ...row, inFlight: true }));
  },
});

export const settle = internalMutation({
  args: {
    profileId: v.id("profiles"),
    sent: v.array(v.id("traktOutbox")),
    retry: v.array(v.id("traktOutbox")),
    rejected: v.optional(v.array(v.id("traktOutbox"))),
    // Retry no sooner than this (a 429), else back off by attempts.
    notBefore: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, { profileId, sent, retry, rejected, notBefore }) => {
    const rejectedIds = new Set(rejected ?? []);
    for (const id of sent) {
      const op = await ctx.db.get(id);
      if (!op) continue;
      await ctx.db.delete(id);
      if (rejectedIds.has(id)) console.warn("trakt rejected", op.op, op.item.id);
      // On the Trakt watchlist now: Plan to watch keeps it in step from here on.
      else if (op.op === "plan") {
        const row = await ctx.db.query("library").withIndex("by_profile_imdb", (q) => q.eq("profileId", profileId).eq("imdbId", op.item.id)).first();
        if (row && !row.trakt) await ctx.db.patch(row._id, { trakt: true });
      }
    }
    for (const id of retry) {
      const op = await ctx.db.get(id);
      if (!op) continue;
      // After about a day of trying, a change is dropped rather than retried forever.
      if (op.attempts >= 8) await ctx.db.delete(id);
      else await ctx.db.patch(id, {
        attempts: op.attempts + 1,
        nextAt: Math.max(notBefore ?? 0, Date.now() + Math.min(6 * 60, 2 ** op.attempts) * MINUTE),
      });
    }
    // Book the next send for whatever is still waiting.
    await book(ctx, profileId);
    return null;
  },
});

/** The outbox's own run, between syncs. Waits its turn if a sync is going. */
export const flush = internalAction({
  args: { profileId: v.id("profiles") },
  returns: v.null(),
  handler: async (ctx, { profileId }) => {
    if (!(await ctx.runMutation(internal.trakt.claimSync, { profileId, flush: true }))) {
      const conn: Doc<"traktConnections"> | null = await ctx.runQuery(internal.trakt.connection, { profileId });
      if (conn && !conn.needsReconnect) await ctx.runMutation(internal.trakt.rebook, { profileId });
      return null;
    }
    const conn: Doc<"traktConnections"> | null = await ctx.runQuery(internal.trakt.connection, { profileId });
    if (!conn) return null;
    const { call } = session(ctx, conn);
    try {
      await push(ctx, profileId, call, conn.connectedAt);
      await ctx.runMutation(internal.trakt.patchConnection, { profileId, expectedConnectedAt: conn.connectedAt, patch: { done: true } });
    } catch (error) {
      await failed(ctx, profileId, error, conn.connectedAt);
    }
    // Whatever is still waiting (not due yet, or retrying) gets the next run booked.
    await ctx.runMutation(internal.trakt.settle, { profileId, sent: [], retry: [] });
    return null;
  },
});
