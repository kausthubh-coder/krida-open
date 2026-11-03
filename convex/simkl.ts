import { ConvexError, v } from "convex/values";
import { action, internalAction, internalQuery, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internalMutation, mutation } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { randomHex, requireProfile } from "./lib/auth";
import {
  authorizeUrl,
  expandEpisodes,
  ISSUER,
  parseLibrary,
  pkcePair,
  REDIRECT_URIS,
  revoke,
  simkl,
  tokenGrant,
  withoutEpisodes,
  type SimklEntry,
} from "./lib/simkl";
import { mediaValidator, outboxOpValidator, trackedStatusValidator } from "./schema";
import { scoreOf } from "./lib/ratings";
import { syncableStatus, titleStatus } from "./lib/watchStatus";
import { mergeTitle } from "./lib/mergeTitle";
import { invalidateStats } from "./lib/statsCache";
import { DAILY_BUDGET, MINUTE, connectionFor, freshToken, session, today, usedToday } from "./lib/simklApi";
import { book, cancelFlush, clearOutbox, enqueue, listChangePending, listKey, pending, push, statusOffWatchlist } from "./lib/simklOutbox";
import { failed, pullType, simklIds, store } from "./lib/simklPull";

const STATE_TTL = 15 * MINUTE;

const SYNC_EVERY = 10 * MINUTE;

const SYNC_LEASE = 10 * MINUTE;


const isSyncing = (c: Doc<"connections">) => !!c.syncing && c.syncing > Date.now() - SYNC_LEASE;

// Convex provides process.env in every runtime; declared here so the web app's typecheck agrees.
declare const process: { env: Record<string, string | undefined> };

/** Whether this deployment has its own Simkl app (SIMKL_CLIENT_ID), so Settings offers to connect Simkl. */
export const enabled = query({
  args: {},
  returns: v.boolean(),
  handler: async () => !!process.env.SIMKL_CLIENT_ID,
});

// ---------------------------------------------------------------------------------------------
// Connecting

/** Step 1: a PKCE pair and state for this profile, and the Simkl consent page to send the browser to. */
export const start = mutation({
  args: { token: v.string(), redirectUri: v.string() },
  handler: async (ctx, { token, redirectUri }) => {
    const me = await requireProfile(ctx, token);
    if (!REDIRECT_URIS.includes(redirectUri))
      throw new ConvexError({ code: "BAD_REDIRECT", message: "Simkl can only send you back to krida-open.vercel.app." });
    for (const old of await ctx.db.query("oauthStates").collect())
      if (old.createdAt < Date.now() - STATE_TTL) await ctx.db.delete(old._id);
    const { verifier, challenge } = await pkcePair();
    const state = randomHex(16);
    await ctx.db.insert("oauthStates", {
      state,
      profileId: me._id,
      provider: "simkl",
      verifier,
      redirectUri,
      createdAt: Date.now(),
    });
    return authorizeUrl(state, challenge, redirectUri);
  },
});

/** Step 2: Simkl sent the browser back with a code; trade it for tokens and start the import. */
export const finish = action({
  args: { token: v.string(), code: v.string(), state: v.string(), iss: v.optional(v.string()) },
  handler: async (ctx, { token, code, state, iss }): Promise<{ name: string }> => {
    const profileId: Id<"profiles"> | null = await ctx.runQuery(internal.profiles.validate, { token });
    if (!profileId) throw new ConvexError({ code: "AUTH", message: "Sign in to Krida again, then connect Simkl." });
    // Mix-up protection: the answer has to come from Simkl itself.
    if (iss !== ISSUER) throw new ConvexError({ code: "ISSUER", message: "That sign-in didn’t come from Simkl. Try connecting again." });
    const pending: { verifier: string; redirectUri: string } | null = await ctx.runMutation(internal.simkl.consumeState, {
      state,
      profileId,
    });
    if (!pending)
      throw new ConvexError({
        code: "STATE",
        message: "That Simkl sign-in expired or was started on another profile. Try connecting again.",
      });
    let tokens;
    try {
      tokens = await tokenGrant({
        grant_type: "authorization_code",
        code,
        code_verifier: pending.verifier,
        redirect_uri: pending.redirectUri,
      });
    } catch {
      throw new ConvexError({ code: "EXCHANGE", message: "Simkl didn’t accept the sign-in. Try connecting again." });
    }
    let account: { name: string; avatar?: string } | undefined;
    try {
      const settings = await simkl<any>("/users/settings", tokens.accessToken);
      const name = settings?.user?.name;
      if (typeof name === "string") account = { name, avatar: typeof settings.user.avatar === "string" ? settings.user.avatar : undefined };
    } catch {
      // The account name is a nicety; the connection works without it.
    }
    await ctx.runMutation(internal.simkl.saveConnection, { profileId, ...tokens, account });
    await ctx.scheduler.runAfter(0, internal.simkl.sync, { profileId });
    return { name: account?.name ?? "Simkl" };
  },
});

export const consumeState = internalMutation({
  args: { state: v.string(), profileId: v.id("profiles") },
  handler: async (ctx, { state, profileId }) => {
    const row = await ctx.db
      .query("oauthStates")
      .withIndex("by_state", (q) => q.eq("state", state))
      .first();
    if (!row) return null;
    await ctx.db.delete(row._id);
    if (row.profileId !== profileId || row.createdAt < Date.now() - STATE_TTL) return null;
    return { verifier: row.verifier, redirectUri: row.redirectUri };
  },
});

export const saveConnection = internalMutation({
  args: {
    profileId: v.id("profiles"),
    accessToken: v.string(),
    refreshToken: v.optional(v.string()),
    expiresAt: v.optional(v.number()),
    scope: v.string(),
    account: v.optional(v.object({ name: v.string(), avatar: v.optional(v.string()) })),
  },
  handler: async (ctx, { profileId, ...tokens }) => {
    const existing = await connectionFor(ctx, profileId);
    await clearOutbox(ctx, profileId);
    if (existing) await cancelFlush(ctx, existing);
    // A fresh connection (maybe another Simkl account) starts over with a full import.
    const doc = {
      profileId,
      provider: "simkl" as const,
      ...tokens,
      writeBack: existing?.writeBack ?? true,
      connectedAt: Math.max(Date.now(), (existing?.connectedAt ?? 0) + 1),
    };
    if (existing) await ctx.db.replace(existing._id, doc);
    else await ctx.db.insert("connections", doc);
  },
});

// ---------------------------------------------------------------------------------------------
// What Settings shows, and its controls

/** The connection and its sync, without the library: sync bookkeeping changes it often, and it stays cheap to re-read. */
async function connectionStatus(ctx: QueryCtx, profileId: Id<"profiles">) {
  const c = await connectionFor(ctx, profileId);
  if (!c) return null;
  const waiting = await ctx.db
    .query("syncOutbox")
    .withIndex("by_profile", (q) => q.eq("profileId", profileId))
    .collect();
  return {
    account: c.account ?? null,
    // The page compares these with its own clock: a cached query can't know the time has passed.
    syncingSince: c.syncing ?? null,
    syncLease: SYNC_LEASE,
    usage: c.usage ?? null,
    budget: DAILY_BUDGET,
    pausedUntil: c.backoffUntil ?? null,
    // Older pages read these. A run clears `syncing` when it ends, and the next sync resets the count.
    syncing: c.syncing !== undefined,
    overBudget: (c.usage?.count ?? 0) >= DAILY_BUDGET,
    waiting: waiting.length,
    imported: c.snapshot !== undefined,
    lastSyncAt: c.lastSyncAt ?? null,
    lastError: c.lastError ?? null,
    needsReconnect: c.needsReconnect ?? false,
    writeBack: c.writeBack,
    canWrite: c.scope.includes("media:write"),
  };
}

/** Whether Simkl is connected and how its sync is going: the Library's question. */
export const syncState = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => await connectionStatus(ctx, (await requireProfile(ctx, token))._id),
});

/** The same, with what the imported library holds, for Settings. */
export const status = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const me = await requireProfile(ctx, token);
    const c = await connectionStatus(ctx, me._id);
    if (!c) return null;
    const rows = await ctx.db
      .query("tracked")
      .withIndex("by_profile", (q) => q.eq("profileId", me._id).eq("source", "simkl"))
      .collect();
    return {
      ...c,
      titles: rows.length,
      watched: rows.filter((r) => r.status === "completed" || r.status === "watching").length,
      rated: rows.filter((r) => r.rating !== undefined).length,
      planned: rows.filter((r) => r.status === "plantowatch").length,
    };
  },
});

/** Called when the app opens or comes back to the front: catch up with Simkl if it's been a while. */
export const touch = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const me = await requireProfile(ctx, token);
    const c = await connectionFor(ctx, me._id);
    if (!c || c.needsReconnect || isSyncing(c)) return;
    if (c.lastSyncAt && c.lastSyncAt > Date.now() - SYNC_EVERY) return;
    if ((c.backoffUntil && c.backoffUntil > Date.now()) || usedToday(c) >= DAILY_BUDGET) return;
    await ctx.scheduler.runAfter(0, internal.simkl.sync, { profileId: me._id });
  },
});

export const syncNow = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const me = await requireProfile(ctx, token);
    const c = await connectionFor(ctx, me._id);
    if (!c || isSyncing(c)) return;
    await ctx.scheduler.runAfter(0, internal.simkl.sync, { profileId: me._id });
  },
});

export const setWriteBack = mutation({
  args: { token: v.string(), writeBack: v.boolean() },
  returns: v.null(),
  handler: async (ctx, { token, writeBack }) => {
    const me = await requireProfile(ctx, token);
    const c = await connectionFor(ctx, me._id);
    if (c) {
      await ctx.db.patch(c._id, { writeBack });
      await book(ctx, me._id);
    }
    return null;
  },
});

export const disconnect = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const me = await requireProfile(ctx, token);
    const c = await connectionFor(ctx, me._id);
    if (!c) return;
    await cancelFlush(ctx, c);
    await clearOutbox(ctx, me._id);
    await ctx.db.delete(c._id);
    await ctx.scheduler.runAfter(0, internal.simkl.forget, {
      profileId: me._id,
      token: c.refreshToken ?? c.accessToken,
    });
  },
});

/** After disconnecting: revoke the grant and drop the imported titles (picks follow from the browser's copy). */
export const forget = internalAction({
  args: { profileId: v.id("profiles"), token: v.string() },
  handler: async (ctx, { profileId, token }) => {
    await revoke(token);
    while (await ctx.runMutation(internal.simkl.clearSome, { profileId })) {
      // Deleting in batches keeps each mutation small.
    }
  },
});

export const clearSome = internalMutation({
  args: { profileId: v.id("profiles") },
  handler: async (ctx, { profileId }) => {
    // Reconnected meanwhile: the new import owns these rows now.
    if (await connectionFor(ctx, profileId)) return false;
    const rows = await ctx.db
      .query("tracked")
      .withIndex("by_profile", (q) => q.eq("profileId", profileId).eq("source", "simkl"))
      .take(500);
    for (const r of rows) await ctx.db.delete(r._id);
    return rows.length === 500;
  },
});

// ---------------------------------------------------------------------------------------------
// Syncing

export const connection = internalQuery({
  args: { profileId: v.id("profiles") },
  handler: async (ctx, { profileId }) => await connectionFor(ctx, profileId),
});

export const claimSync = internalMutation({
  args: { profileId: v.id("profiles"), flush: v.optional(v.boolean()) },
  returns: v.boolean(),
  handler: async (ctx, { profileId, flush }) => {
    const c = await connectionFor(ctx, profileId);
    if (!c || c.needsReconnect || isSyncing(c)) return false;
    if (flush && (!c.writeBack || !c.scope.includes("media:write"))) return false;
    if (c.backoffUntil && c.backoffUntil > Date.now()) return false;
    if (usedToday(c) >= DAILY_BUDGET) return false;
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
      scope: v.optional(v.string()),
      snapshot: v.optional(v.string()),
      lastSyncAt: v.optional(v.number()),
      lastError: v.optional(v.string()),
      needsReconnect: v.optional(v.boolean()),
      backoffUntil: v.optional(v.number()),
      done: v.optional(v.boolean()),
    }),
    // Requests this run made, counted against today's budget.
    calls: v.optional(v.number()),
    expectedConnectedAt: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, { profileId, patch: { done, ...patch }, calls, expectedConnectedAt }) => {
    const c = await connectionFor(ctx, profileId);
    if (!c || (expectedConnectedAt !== undefined && c.connectedAt !== expectedConnectedAt)) return null;
    const day = today();
    await ctx.db.patch(c._id, {
      ...patch,
      ...(done ? { syncing: undefined } : {}),
      ...(done && !patch.lastError ? { lastError: undefined } : {}),
      ...(calls ? { usage: { day, count: (c.usage?.day === day ? c.usage.count : 0) + calls } } : {}),
    });
    return null;
  },
});

export const knownIds = internalQuery({
  args: { profileId: v.id("profiles") },
  handler: async (ctx, { profileId }) => {
    const rows = await ctx.db
      .query("tracked")
      .withIndex("by_profile", (q) => q.eq("profileId", profileId).eq("source", "simkl"))
      .collect();
    return rows.map((r) => ({ externalId: r.externalId, id: r.id }));
  },
});

const trackedFields = {
  externalId: v.number(),
  id: v.string(),
  imdb: v.optional(v.string()),
  type: v.union(v.literal("movie"), v.literal("series")),
  name: v.string(),
  poster: v.optional(v.string()),
  year: v.optional(v.string()),
  status: trackedStatusValidator,
  rating: v.optional(v.number()),
  ratedAt: v.optional(v.number()),
  watchedEpisodes: v.optional(v.number()),
  totalEpisodes: v.optional(v.number()),
  nextSeason: v.optional(v.number()),
  nextEpisode: v.optional(v.number()),
  watched: v.optional(v.string()),
  watchedAt: v.optional(v.string()),
  runtime: v.optional(v.number()),
  lastWatchedAt: v.optional(v.number()),
  addedAt: v.optional(v.number()),
};

export const applyEntries = internalMutation({
  args: { profileId: v.id("profiles"), entries: v.array(v.object(trackedFields)),
    ratingsOnly: v.optional(v.boolean()), expectedConnectedAt: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, { profileId, entries, ratingsOnly, expectedConnectedAt }) => {
    if (expectedConnectedAt !== undefined && (await connectionFor(ctx, profileId))?.connectedAt !== expectedConnectedAt) return null;
    for (const e of entries) {
      const existing = await ctx.db
        .query("tracked")
        .withIndex("by_profile_external", (q) =>
          q.eq("profileId", profileId).eq("source", "simkl").eq("externalId", e.externalId),
        )
        .first();
      // A ratings-only delta carries no episode list; keep the one we have.
      let doc = { profileId, source: "simkl" as const, ...e, watched: e.watched ?? existing?.watched,
        watchedAt: e.watchedAt ?? existing?.watchedAt, runtime: e.runtime ?? existing?.runtime };
      // Episodes unmarked in Krida stay unmarked until Simkl has heard.
      const unmarked = e.type === "series" && e.watched ? new Set((await ctx.db.query("syncOutbox").withIndex("by_key", (q) =>
        q.eq("profileId", profileId).gte("key", `watched:${e.id}:`).lt("key", `watched:${e.id};`)).take(500))
        .filter((o) => o.op === "unwatch").map((o) => `${o.item.season}:${o.item.episode}`)) : null;
      if (unmarked?.size) doc = { ...doc, ...withoutEpisodes(doc, unmarked) };
      // Unchanged entries aren't rewritten: every write re-runs the queries that list this library.
      if (existing && ratingsOnly) {
        if (existing.rating !== e.rating || existing.ratedAt !== e.ratedAt) await ctx.db.patch(existing._id, { rating: e.rating, ratedAt: e.ratedAt });
      } else if (existing) {
        if (!sameFields(existing, doc)) await ctx.db.replace(existing._id, doc);
      } else await ctx.db.insert("tracked", doc);
      if (!ratingsOnly && !(await listChangePending(ctx, profileId, e.id)) &&
        !(await pending(ctx, profileId, `watched:${e.id}::`))) {
        const local = await ctx.db.query("viewing").withIndex("by_title", (q) => q.eq("profileId", profileId).eq("id", e.id)).first();
        // Accepted writes follow future Simkl edits. Unsynced choices stay until Simkl logs a newer watch.
        if (local && local.state !== "rewatching" && (local.syncedAt !== undefined || (e.lastWatchedAt ?? 0) > local.at))
          await ctx.db.delete(local._id);
      }
      if (existing?.rating !== e.rating || (e.ratedAt !== undefined && existing?.ratedAt !== e.ratedAt))
        await thumbFromSimkl(ctx, profileId, e);
    }
    return null;
  },
});

/** Whether a stored document already holds exactly these fields (system fields aside). */
function sameFields(existing: Record<string, unknown>, doc: Record<string, unknown>) {
  const keys = new Set([...Object.keys(existing), ...Object.keys(doc)].filter((k) => !k.startsWith("_")));
  return [...keys].every((k) => JSON.stringify(existing[k]) === JSON.stringify(doc[k]));
}

/** 9–10 love, 6–8 like, 1–4 not for me; 5 is no opinion either way. */
export const thumbFor = (rating: number | undefined) =>
  rating === undefined ? null : rating >= 9 ? "love" : rating >= 6 ? "up" : rating <= 4 ? "down" : null;

/** A thumb as a Simkl rating, when one has to be sent. */
const RATING_FOR = { love: 9, up: 7, down: 3 } as const;

/** Rated (or un-rated) on Simkl after the Krida thumb was set: the thumb follows. */
async function thumbFromSimkl(
  ctx: MutationCtx,
  profileId: Id<"profiles">,
  e: { id: string; type: "movie" | "series"; name: string; poster?: string; rating?: number; ratedAt?: number },
) {
  if (await pending(ctx, profileId, `rate:${e.id}`)) return;
  const thumb = await ctx.db
    .query("feedback")
    .withIndex("by_profile_id", (q) => q.eq("profileId", profileId).eq("id", e.id))
    .first();
  if (thumb && e.ratedAt && thumb.at > e.ratedAt) return;
  if (thumb && e.rating !== undefined && !e.ratedAt) return;
  const value = thumbFor(e.rating);
  if (thumb && thumb.value === value) {
    await ctx.db.patch(thumb._id, { rating: e.rating ?? null, ...(e.ratedAt && e.ratedAt > thumb.at ? { at: e.ratedAt } : {}) });
    return;
  }
  if (thumb) await ctx.db.delete(thumb._id);
  if (value)
    await ctx.db.insert("feedback", {
      profileId,
      id: e.id,
      type: e.type,
      value,
      rating: e.rating,
      name: e.name,
      poster: e.poster,
      at: e.ratedAt ?? Date.now(),
    });
}

/**
 * Love/Like can introduce a title to Simkl: movies become watched, new shows become watching.
 * Not for me on an unseen title stays local. Preserve exact ratings within the selected band.
 */
export async function rateOnSimkl(
  ctx: MutationCtx,
  profileId: Id<"profiles">,
  item: { id: string; type: "movie" | "series"; name: string },
  value: "down" | "up" | "love" | null,
) {
  const tracked = await ctx.db
    .query("tracked")
    .withIndex("by_profile_id", (q) => q.eq("profileId", profileId).eq("id", item.id))
    .first();
  const queued = await pending(ctx, profileId, `rate:${item.id}`);
  const seen = (tracked && tracked.status !== "plantowatch") ||
    (queued?.inFlight && (queued.item.rating ?? 0) > 0);
  if (value === null) {
    if (tracked?.rating !== undefined || queued) await enqueue(ctx, profileId, "rate", { ...item, rating: 0 });
    return;
  }
  if (value === "down" && !seen) {
    if (queued) await enqueue(ctx, profileId, "rate", { ...item, rating: 0 });
    return;
  }
  const rating = thumbFor(tracked?.rating) === value ? tracked!.rating! : RATING_FOR[value];
  if (queued || thumbFor(tracked?.rating) !== value) await enqueue(ctx, profileId, "rate", { ...item, rating });
}

/**
 * Choices saved under an anime's IMDb id before Simkl reported it by its Kitsu id join that entry (lib/mergeTitle).
 * Run once a pull has landed: until then a second season carrying the same IMDb id may still be on its way.
 */
export const mergeAfterPull = internalMutation({
  args: { profileId: v.id("profiles"), ids: v.array(v.string()), expectedConnectedAt: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, { profileId, ids, expectedConnectedAt }) => {
    if (expectedConnectedAt !== undefined && (await connectionFor(ctx, profileId))?.connectedAt !== expectedConnectedAt) return null;
    let moved = 0;
    for (const id of ids) {
      const entry = await ctx.db.query("tracked").withIndex("by_profile_id", (q) => q.eq("profileId", profileId).eq("id", id)).first();
      if (entry?.imdb) moved += (await mergeTitle(ctx, profileId, entry)).length;
    }
    if (moved) await invalidateStats(ctx, profileId);
    return null;
  },
});

export const removeMissing = internalMutation({
  args: { profileId: v.id("profiles"), keep: v.array(v.number()), expectedConnectedAt: v.optional(v.number()) },
  returns: v.number(),
  handler: async (ctx, { profileId, keep, expectedConnectedAt }) => {
    if (expectedConnectedAt !== undefined && (await connectionFor(ctx, profileId))?.connectedAt !== expectedConnectedAt) return 0;
    const keepSet = new Set(keep);
    const rows = await ctx.db
      .query("tracked")
      .withIndex("by_profile", (q) => q.eq("profileId", profileId).eq("source", "simkl"))
      .collect();
    let removed = 0;
    for (const r of rows)
      if (!keepSet.has(r.externalId)) {
        await ctx.db.delete(r._id);
        removed++;
        // Gone from Simkl: also gone from Plan to watch if it was kept in step, unless Krida is about to add it back.
        const listed = await ctx.db
          .query("library")
          .withIndex("by_profile_imdb", (q) => q.eq("profileId", profileId).eq("imdbId", r.id))
          .first();
        if (listed?.source === "simkl" && !(await pending(ctx, profileId, listKey(r.id))))
          await ctx.db.delete(listed._id);
      }
    return removed;
  },
});

/**
 * Bring Krida up to date with Simkl: whatever Krida changed goes first (so Simkl's answer already
 * includes it), then only what /sync/activities says moved comes back.
 */
export const sync = internalAction({
  args: { profileId: v.id("profiles") },
  handler: async (ctx, { profileId }) => {
    if (!(await ctx.runMutation(internal.simkl.claimSync, { profileId }))) return;
    const conn: Doc<"connections"> | null = await ctx.runQuery(internal.simkl.connection, { profileId });
    if (!conn) return;
    const { call, state } = session(ctx, conn);
    try {
      await push(ctx, profileId, call, conn.connectedAt);
      const activities = await call<any>("/sync/activities");
      const prev = conn.snapshot ? JSON.parse(conn.snapshot) : null;
      if (!prev) {
        // First import: the whole library, one type at a time as Simkl asks.
        const entries: SimklEntry[] = [];
        for (const type of ["shows", "movies", "anime"]) entries.push(...(await pullType(call, type)));
        await store(ctx, profileId, entries, conn.connectedAt);
        await ctx.runMutation(internal.simkl.removeMissing, { profileId, keep: entries.map((e) => e.simklId), expectedConnectedAt: conn.connectedAt });
      } else if (activities?.all !== prev.all) {
        const from: string = prev.all;
        const blocks = ["tv_shows", "anime", "movies"];
        const moved = (key: string) => blocks.some((b) => activities?.[b]?.[key] !== prev?.[b]?.[key]);
        if (["watching", "plantowatch", "hold", "completed", "dropped"].some(moved)) {
          const params = { date_from: from, language: "en", extended: "full", include_all_episodes: "yes", episode_watched_at: "yes" };
          await store(ctx, profileId, parseLibrary(await call<any>("/sync/all-items", { params })), conn.connectedAt);
          }
        if (moved("rated_at")) {
          await store(ctx, profileId, parseLibrary(await call<any>("/sync/ratings", { params: { date_from: from, language: "en" } })), conn.connectedAt, true);
          }
        if (moved("removed_from_list")) {
          const body = await call<any>("/sync/all-items", { params: { extended: "simkl_ids_only" } });
          const keep = simklIds(body);
          // An answer in a shape we don't recognise must never wipe the library.
          if (keep.length > 0 || Object.keys(body ?? {}).length === 0) {
            await ctx.runMutation(internal.simkl.removeMissing, { profileId, keep, expectedConnectedAt: conn.connectedAt });
          }
        }
      }
      await ctx.runMutation(internal.simkl.patchConnection, {
        profileId,
        expectedConnectedAt: conn.connectedAt,
        patch: { snapshot: JSON.stringify(activities), lastSyncAt: Date.now(), needsReconnect: false, done: true },
        calls: state.calls,
      });
    } catch (error) {
      await failed(ctx, profileId, error, state.calls, conn.connectedAt);
    }
    await ctx.runMutation(internal.simkl.settle, { profileId, sent: [], retry: [] });
  },
});

/** Start the next sync from scratch: a full import (used after changing what an import keeps). */
export const resetImport = internalMutation({
  args: { profileId: v.id("profiles") },
  handler: async (ctx, { profileId }) => {
    const c = await connectionFor(ctx, profileId);
    if (c) await ctx.db.patch(c._id, { snapshot: undefined, syncing: undefined });
  },
});

/** A send run that couldn't start (a sync was going): try again in a couple of minutes. */
export const rebook = internalMutation({
  args: { profileId: v.id("profiles") },
  handler: async (ctx, { profileId }) => await book(ctx, profileId, 2 * MINUTE),
});

// The time comes in as an argument: a query that read the clock itself could be answered from
// Convex's query cache with an older "nothing due".
export const due = internalQuery({
  args: { profileId: v.id("profiles"), now: v.number() },
  handler: async (ctx, { profileId, now }) =>
    await ctx.db
      .query("syncOutbox")
      .withIndex("by_profile", (q) => q.eq("profileId", profileId).lte("nextAt", now + 2_000))
      .take(100),
});

/** List and status writes compete, newest wins. Plays (a movie's included) are history and always go. */
export const isStatusChoice = (op: Pick<Doc<"syncOutbox">, "op" | "item">) =>
  op.op === "status" || op.op === "plan" || op.op === "unplan" || op.op === "unwatch" && op.item.episode === undefined ||
  op.op === "watched" && op.item.status === "completed";

/** Freeze the sender's batch before network I/O. Later edits replace claimed rows rather than mutating them. */
export const claimDue = internalMutation({
  args: { profileId: v.id("profiles"), now: v.number(), expectedConnectedAt: v.optional(v.number()) },
  returns: v.array(v.object({
    _id: v.id("syncOutbox"), _creationTime: v.number(), profileId: v.id("profiles"),
    op: outboxOpValidator,
    key: v.string(), item: v.object({ id: v.string(), type: v.union(v.literal("movie"), v.literal("series")),
      name: v.string(), year: v.optional(v.string()), season: v.optional(v.number()),
      episode: v.optional(v.number()), rating: v.optional(v.number()), status: v.optional(trackedStatusValidator) }),
    at: v.number(), attempts: v.number(), nextAt: v.number(), inFlight: v.optional(v.boolean()),
  })),
  handler: async (ctx, { profileId, now, expectedConnectedAt }) => {
    const c = await connectionFor(ctx, profileId);
    if (expectedConnectedAt !== undefined && c?.connectedAt !== expectedConnectedAt) return [];
    if (!c?.writeBack || !c.scope.includes("media:write") || c.needsReconnect ||
      (c.backoffUntil && c.backoffUntil > now) || usedToday(c) >= DAILY_BUDGET) return [];
    const rows = await ctx.db.query("syncOutbox")
      .withIndex("by_profile", (q) => q.eq("profileId", profileId).lte("nextAt", now + 2_000)).take(100);
    const claimed: Doc<"syncOutbox">[] = [];
    for (const row of rows) {
      if (isStatusChoice(row)) {
        const choices = (await Promise.all([`list:${row.item.id}`, `status:${row.item.id}`, `watched:${row.item.id}::`, `unwatch:${row.item.id}`].map((key) =>
          ctx.db.query("syncOutbox").withIndex("by_key", (q) => q.eq("profileId", profileId).eq("key", key)).take(100)))).flat();
        if (choices.some((newer) => isStatusChoice(newer) &&
          (newer.at > row.at || newer.at === row.at && newer._creationTime > row._creationTime))) {
          await ctx.db.delete(row._id);
          continue;
        }
      }
      // Checked again at send time: something may have been watched since the removal was queued.
      if (row.op === "unplan" && await statusOffWatchlist(ctx, profileId, row.item) !== null) {
        await ctx.db.delete(row._id);
        continue;
      }
      await ctx.db.patch(row._id, { inFlight: true });
      claimed.push(row);
    }
    return claimed;
  },
});

export const settle = internalMutation({
  args: {
    profileId: v.id("profiles"),
    sent: v.array(v.id("syncOutbox")),
    retry: v.array(v.id("syncOutbox")),
    rejected: v.optional(v.array(v.id("syncOutbox"))),
    // Retry no sooner than this (a 429), else back off by attempts.
    notBefore: v.optional(v.number()),
  },
  handler: async (ctx, { profileId, sent, retry, rejected, notBefore }) => {
    const rejectedIds = new Set(rejected ?? []);
    for (const id of sent) {
      const op = await ctx.db.get(id);
      if (!op) continue;
      const error = rejectedIds.has(id) ? "Simkl couldn't match this title. Your changes are saved in Krida." : undefined;
      if (op.op === "rate") {
        const row = await ctx.db.query("feedback").withIndex("by_profile_id", (q) => q.eq("profileId", profileId).eq("id", op.item.id)).first();
        if (row && row.at <= op.at) await ctx.db.patch(row._id, { syncError: error });
      } else if (op.op === "watched" || op.op === "status") {
        const row = await ctx.db.query("viewing").withIndex("by_title", (q) => q.eq("profileId", profileId).eq("id", op.item.id)).first();
        const partWatch = op.op === "watched" && op.item.season !== undefined;
        if (row && row.at <= op.at && row.state !== "rewatching" && (partWatch || row.state === (op.item.status ?? (op.item.type === "movie" ? "completed" : undefined)))) await ctx.db.patch(row._id, { syncError: error,
          ...(!error && (op.op === "status" || op.item.status === "completed" || op.item.type === "movie") ? { syncedAt: Date.now() } : {}) });
        // Sent as Simkl's nearest list. It stays unsynced, so Simkl showing that list doesn't replace it.
        else if (row && row.at <= op.at && op.op === "status" && !syncableStatus(row.type, row.id, row.state)) await ctx.db.patch(row._id, { syncError: error });
      }
      await ctx.db.delete(id);
      if (op.op === "unwatch" && op.item.episode === undefined) {
        const row = await ctx.db.query("unwatched").withIndex("by_title", (q) => q.eq("profileId", profileId).eq("id", op.item.id)).first();
        if (row && row.at <= op.at) await ctx.db.patch(row._id, { sent: !error,
          syncError: error ? "Simkl couldn't remove this title. It is still hidden in Krida." : undefined });
      }
      // On the Simkl watchlist now: Plan to watch keeps it in step from here on.
      if ((op.op === "plan" || op.op === "status" && op.item.status === "plantowatch") && !error) {
        const row = await ctx.db
          .query("library")
          .withIndex("by_profile_imdb", (q) => q.eq("profileId", profileId).eq("imdbId", op.item.id))
          .first();
        if (row && !row.source) await ctx.db.patch(row._id, { source: "simkl" });
      }
    }
    for (const id of retry) {
      const op = await ctx.db.get(id);
      if (!op) continue;
      // After about a day of trying, a change is dropped rather than retried forever.
      if (op.attempts >= 8) {
        if (op.op === "unwatch" && op.item.episode === undefined) {
          const row = await ctx.db.query("unwatched").withIndex("by_title", (q) => q.eq("profileId", profileId).eq("id", op.item.id)).first();
          if (row && row.at <= op.at) await ctx.db.patch(row._id, { syncError: "Simkl removal failed after several attempts. It is still hidden in Krida." });
        }
        await ctx.db.delete(id);
      }
      else
        await ctx.db.patch(id, {
          attempts: op.attempts + 1,
          nextAt: Math.max(notBefore ?? 0, Date.now() + Math.min(6 * 60, 2 ** op.attempts) * MINUTE),
        });
    }
    // Book the next send for whatever is still waiting.
    await book(ctx, profileId);
  },
});

/** The outbox's own run, between syncs. Waits its turn if a sync is going. */
export const flush = internalAction({
  args: { profileId: v.id("profiles") },
  handler: async (ctx, { profileId }) => {
    if (!(await ctx.runMutation(internal.simkl.claimSync, { profileId, flush: true }))) {
      const conn: Doc<"connections"> | null = await ctx.runQuery(internal.simkl.connection, { profileId });
      if (conn && !conn.needsReconnect) await ctx.runMutation(internal.simkl.rebook, { profileId });
      return;
    }
    const conn: Doc<"connections"> | null = await ctx.runQuery(internal.simkl.connection, { profileId });
    if (!conn) return;
    const { call, state } = session(ctx, conn);
    try {
      await push(ctx, profileId, call, conn.connectedAt);
      await ctx.runMutation(internal.simkl.patchConnection, { profileId, expectedConnectedAt: conn.connectedAt, patch: { done: true }, calls: state.calls });
    } catch (error) {
      await failed(ctx, profileId, error, state.calls, conn.connectedAt);
    }
    // Whatever is still waiting (not due yet, or retrying) gets the next run booked.
    await ctx.runMutation(internal.simkl.settle, { profileId, sent: [], retry: [] });
  },
});

/** Older scheduled jobs call these; both now go through the outbox. */
export const addToWatchlist = internalMutation({
  args: {
    profileId: v.id("profiles"),
    item: v.object({
      id: v.string(),
      type: v.union(v.literal("movie"), v.literal("series")),
      name: v.string(),
      year: v.optional(v.string()),
    }),
  },
  handler: async (ctx, { profileId, item }) => await enqueue(ctx, profileId, "plan", item),
});

export const markWatched = internalMutation({
  args: { profileId: v.id("profiles"), media: mediaValidator },
  handler: async (ctx, { profileId, media }) =>
    await enqueue(ctx, profileId, "watched", {
      id: media.imdbId,
      type: media.type,
      name: media.name,
      year: media.year,
      season: media.season,
      episode: media.episode,
    }),
});

// ---------------------------------------------------------------------------------------------
// Reading it back for the app

/** Simkl status for a set of titles (search results, a title page). */
export async function trackedFor(ctx: QueryCtx, profileId: Id<"profiles">, ids: string[]) {
  const out = new Map<string, Doc<"tracked">>();
  for (const id of ids) {
    const row = await ctx.db
      .query("tracked")
      .withIndex("by_profile_id", (q) => q.eq("profileId", profileId).eq("id", id))
      .first();
    if (row) out.set(id, row);
  }
  return out;
}

export const forTitle = query({
  args: { token: v.string(), id: v.string() },
  handler: async (ctx, { token, id }) => {
    const me = await requireProfile(ctx, token);
    const { ids, tracked, local, status } = await titleStatus(ctx, me._id, id);
    const feedback = (await Promise.all(ids.map((id) =>
      ctx.db.query("feedback").withIndex("by_profile_id", (q) => q.eq("profileId", me._id).eq("id", id)).first()))).find(Boolean);
    if (!tracked && !local) return null;
    // Episodes are numbered per id: an alias's page doesn't show the Kitsu entry's as its own.
    const row = tracked?.id === id ? tracked : null;
    return {
      // Older title pages show this; it follows the same rule as every other status.
      status: status === "rewatching" ? "watching" as const : status,
      rewatching: status === "rewatching",
      // Episodes count as watched again only from here.
      rewatchingSince: status === "rewatching" ? local?.at ?? null : null,
      rating: feedback ? scoreOf(feedback) : tracked?.rating ?? null,
      watchedEpisodes: row?.watchedEpisodes ?? null,
      totalEpisodes: row?.totalEpisodes ?? null,
      next: row?.nextEpisode !== undefined ? { season: row.nextSeason ?? 1, episode: row.nextEpisode } : null,
      // Episodes watched anywhere Simkl knows about, as "season:episode".
      watched: expandEpisodes(row?.watched),
    };
  },
});

/** Debugging aid (CLI only): a few raw rows of one Simkl bucket, without any tokens. */
export const inspect = internalAction({
  args: { profileId: v.id("profiles"), path: v.string(), params: v.optional(v.record(v.string(), v.string())), id: v.optional(v.string()) },
  handler: async (ctx, { profileId, path, params, id }) => {
    const conn: Doc<"connections"> | null = await ctx.runQuery(internal.simkl.connection, { profileId });
    if (!conn) return null;
    const body = await simkl<any>(path, await freshToken(ctx, conn), { params: params ?? {} });
    const out: Record<string, unknown> = {};
    for (const [k, list] of Object.entries(body ?? {})) {
      if (!Array.isArray(list)) { out[k] = list; continue; }
      const matching = id ? list.filter((row) => {
        const ids = (row?.movie ?? row?.show ?? row?.anime)?.ids;
        return ids?.imdb === id || (ids?.kitsu !== undefined && `kitsu:${ids.kitsu}` === id);
      }) : list;
      out[k] = { count: list.length, sample: matching.slice(0, 2) };
    }
    return out;
  },
});

/** Support aid (CLI only): queue a change for Simkl as if it was made in Krida. */
export const queue = internalMutation({
  args: {
    profileId: v.id("profiles"),
    op: outboxOpValidator,
    item: v.object({
      id: v.string(),
      type: v.union(v.literal("movie"), v.literal("series")),
      name: v.string(),
      year: v.optional(v.string()),
      season: v.optional(v.number()),
      episode: v.optional(v.number()),
      rating: v.optional(v.number()),
      status: v.optional(trackedStatusValidator),
    }),
  },
  handler: async (ctx, { profileId, op, item }) => await enqueue(ctx, profileId, op, item),
});
