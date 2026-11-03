import { v } from "convex/values";
import { housemates } from "./lib/accounts";
import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internalMutation, mutation } from "./functions";
import { requireProfile } from "./lib/auth";
import { enqueue, listChangePending, statusOffWatchlist } from "./lib/simklOutbox";
import { isStatusChoice } from "./simkl";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { Infer } from "convex/values";
import { unwatchedFor } from "./lib/unwatched";
import { invalidateStats } from "./lib/statsCache";
import { feedbackRowOf, listRowOf, mineFrom, overviewFrom, progressRowOf, simklRowOf, toRateFrom, viewingRowOf, type OwnRows } from "./lib/libraryViews";
import { trackedStatusValidator, viewingStateValidator } from "./schema";
import { simklListFor, syncableStatus, titleStatus, type WatchStatus } from "./lib/watchStatus";
import { canonicalTitle, titleIds } from "./lib/titleIds";
import { mergeTitle } from "./lib/mergeTitle";
import { assertTitleId } from "./lib/titleIds";

const statusItemValidator = v.object({ id: v.string(), type: v.union(v.literal("movie"), v.literal("series")),
  name: v.string(), poster: v.optional(v.string()), year: v.optional(v.string()) });
type StatusItem = Infer<typeof statusItemValidator>;

async function writeViewing(ctx: MutationCtx, profileId: Id<"profiles">, item: StatusItem, state: WatchStatus) {
  const row = await ctx.db.query("viewing").withIndex("by_title", (q) => q.eq("profileId", profileId).eq("id", item.id)).first();
  const { year: _year, ...display } = item;
  const doc = { profileId, ...display, state, at: Date.now() };
  if (row) await ctx.db.replace(row._id, doc);
  else await ctx.db.insert("viewing", doc);
}

/** The one write path for a watch status: the menu, Plan to watch, the rating editor and playback all come here. */
export async function changeStatus(ctx: MutationCtx, me: Doc<"profiles">, item: StatusItem, state: WatchStatus, addedAt?: number) {
  await invalidateStats(ctx, me._id);
  await writeViewing(ctx, me._id, item, state);
  // When Simkl has no list for this status, Plan to watch stays as it is and follows Simkl's nearest list.
  const syncable = syncableStatus(item.type, item.id, state);
  if (syncable) {
    // Copies saved under the title's other id before they were merged leave Plan to watch with it.
    const listed = (await Promise.all((await titleIds(ctx, me._id, item.id)).map((id) =>
      ctx.db.query("library").withIndex("by_profile_imdb", (q) => q.eq("profileId", me._id).eq("imdbId", id)).take(100)))).flat();
    if (state === "plantowatch") {
      if (!listed.length) await ctx.db.insert("library", { profileId: me._id, imdbId: item.id, type: item.type,
        name: item.name, poster: item.poster, year: item.year, addedAt: addedAt ?? Date.now() });
    } else for (const entry of listed) await ctx.db.delete(entry._id);
  }
  // Replace unsent title-level choices together. Claimed writes must finish before the new choice.
  const queued = (await Promise.all([`list:${item.id}`, `status:${item.id}`, `watched:${item.id}::`, `unwatch:${item.id}`].map((key) =>
    ctx.db.query("syncOutbox").withIndex("by_key", (q) => q.eq("profileId", me._id).eq("key", key)).take(100)))).flat();
  for (const op of queued) if (op.item.id === item.id && !op.inFlight && isStatusChoice(op)) await ctx.db.delete(op._id);
  if (!syncable) {
    // Simkl hears the nearest list it has, and nothing when it already has that one (unless a change
    // already on its way would move it off).
    const tracked = await ctx.db.query("tracked").withIndex("by_profile_id", (q) => q.eq("profileId", me._id).eq("id", item.id)).first();
    const list = simklListFor(item.type, item.id, state, tracked?.status);
    const sending = queued.some((op) => op.item.id === item.id && op.inFlight && isStatusChoice(op));
    if (tracked?.status !== list || sending) await enqueue(ctx, me._id, "status", { ...item, status: list });
  } else if (state === "completed") await enqueue(ctx, me._id, "watched", { ...item, status: "completed" });
  else await enqueue(ctx, me._id, "status", { ...item, status: state });
}

export const setStatus = mutation({
  args: { token: v.string(), item: statusItemValidator, state: viewingStateValidator },
  returns: v.null(),
  handler: async (ctx, { token, item, state }) => {
    const me = await requireProfile(ctx, token);
    assertTitleId(item.id);
    await changeStatus(ctx, me, await canonicalTitle(ctx, me._id, item), state);
    return null;
  },
});

export const statusFor = query({
  args: { token: v.string(), id: v.string() },
  handler: async (ctx, { token, id }) => {
    const me = await requireProfile(ctx, token);
    const { local, tracked, saved, status } = await titleStatus(ctx, me._id, id);
    const connection = await ctx.db.query("connections").withIndex("by_profile", (q) => q.eq("profileId", me._id).eq("provider", "simkl")).first();
    return { state: status, saved: !!saved, syncError: local?.syncError, simkl: tracked?.status,
      sync: !connection ? "disconnected" as const : connection.needsReconnect ? "reconnect" as const : connection.writeBack && connection.scope.includes("media:write") ? "on" as const : "off" as const };
  },
});

/**
 * What every poster needs about this profile, in one subscription without episode lists: the inputs
 * to its status (playback comes from progress.started), whether it's in Plan to watch, and its score.
 */
export const mine = query({
  args: { token: v.string() },
  returns: v.array(v.object({ id: v.string(), local: v.optional(viewingStateValidator), tracked: v.optional(trackedStatusValidator),
    saved: v.optional(v.boolean()), rating: v.optional(v.number()) })),
  handler: async (ctx, { token }) => {
    const me = await requireProfile(ctx, token);
    return mineFrom(await simklOf(ctx, me._id), await ownOf(ctx, me._id));
  },
});

/** Older clients page through these. */
export const statuses = query({
  args: { token: v.string(), source: v.union(v.literal("krida"), v.literal("simkl")), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(v.object({ id: v.string(), state: viewingStateValidator })),
  handler: async (ctx, { token, source, paginationOpts }) => {
    const me = await requireProfile(ctx, token);
    if (source === "krida") {
      const page = await ctx.db.query("viewing").withIndex("by_profile", (q) => q.eq("profileId", me._id)).paginate(paginationOpts);
      return { ...page, page: page.page.map((r) => ({ id: r.id, state: r.state })) };
    }
    const page = await ctx.db.query("tracked").withIndex("by_profile", (q) => q.eq("profileId", me._id)).paginate(paginationOpts);
    return { ...page, page: page.page.map((r) => ({ id: r.id, state: r.status })) };
  },
});

export const list = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const profile = await requireProfile(ctx, token);
    return await ctx.db
      .query("library")
      .withIndex("by_profile", (q) => q.eq("profileId", profile._id))
      .order("desc")
      .collect();
  },
});

/** Titles on my list that someone else saved too: the easy picks when choosing together. */
export const shared = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const me = await requireProfile(ctx, token);
    const others = await housemates(ctx, me);
    const mine = await ctx.db
      .query("library")
      .withIndex("by_profile", (q) => q.eq("profileId", me._id))
      .order("desc")
      .collect();
    const out = [];
    for (const row of mine) {
      for (const other of others) {
        const theirs = await ctx.db
          .query("library")
          .withIndex("by_profile_imdb", (q) => q.eq("profileId", other._id).eq("imdbId", row.imdbId))
          .first();
        if (theirs) {
          out.push(row);
          break;
        }
      }
    }
    return out;
  },
});

export const has = query({
  args: { token: v.string(), imdbId: v.string() },
  handler: async (ctx, { token, imdbId }) => {
    const profile = await requireProfile(ctx, token);
    const row = await ctx.db
      .query("library")
      .withIndex("by_profile_imdb", (q) => q.eq("profileId", profile._id).eq("imdbId", imdbId))
      .first();
    return row !== null;
  },
});

/** Every id in Plan to watch, so each poster can show whether it's saved. */
export const savedIds = query({
  args: { token: v.string(), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(v.string()),
  handler: async (ctx, { token, paginationOpts }) => {
    const profile = await requireProfile(ctx, token);
    const rows = await ctx.db
      .query("library")
      .withIndex("by_profile", (q) => q.eq("profileId", profile._id))
      .paginate(paginationOpts);
    return { ...rows, page: rows.page.map((r) => r.imdbId) };
  },
});

export const toggle = mutation({
  args: {
    token: v.string(),
    item: v.object({
      type: v.union(v.literal("movie"), v.literal("series")),
      imdbId: v.string(),
      name: v.string(),
      poster: v.optional(v.string()),
      year: v.optional(v.string()),
    }),
    // Explicit target state, so a double click can't flip it back.
    saved: v.boolean(),
    // Undo puts a title back where it was in Plan to watch.
    addedAt: v.optional(v.number()),
  },
  returns: v.union(v.number(), v.null()),
  handler: async (ctx, { token, item: page, saved, addedAt }) => {
    const profile = await requireProfile(ctx, token);
    // Saved under the title's canonical id; removing it also removes a copy saved under its alias.
    const ids = await titleIds(ctx, profile._id, page.imdbId);
    const title = await canonicalTitle(ctx, profile._id, { id: page.imdbId, type: page.type, name: page.name, poster: page.poster, year: page.year });
    const item = { type: title.type, imdbId: title.id, name: title.name, poster: title.poster, year: title.year };
    const rows = (await Promise.all(ids.map((id) => ctx.db.query("library")
      .withIndex("by_profile_imdb", (q) => q.eq("profileId", profile._id).eq("imdbId", id)).collect()))).flat();
    // Unwatched titles use the same Plan to watch path as the status menu.
    if (saved && rows.length === 0) {
      const previous = await statusOffWatchlist(ctx, profile._id, title);
      const { status } = await titleStatus(ctx, profile._id, title.id);
      // Plan to watch can also bookmark something already watched, without planning it again on Simkl.
      // Watching a movie is local-only, so the Simkl destination alone cannot identify an active watch.
      if (previous === "completed" || previous === "watching" || status === "watching" || status === "rewatching")
        await ctx.db.insert("library", { profileId: profile._id, ...item, addedAt: addedAt ?? Date.now() });
      else await changeStatus(ctx, profile, title, "plantowatch", addedAt);
    }
    if (!saved && rows.length > 0) {
      for (const r of rows) await ctx.db.delete(r._id);
      const locals = (await Promise.all(ids.map((id) =>
        ctx.db.query("viewing").withIndex("by_title", (q) => q.eq("profileId", profile._id).eq("id", id)).first()))).filter((r) => r !== null);
      const tracked = await ctx.db.query("tracked").withIndex("by_profile_id", (q) => q.eq("profileId", profile._id).eq("id", item.imdbId)).first();
      // Simkl has it planned, or may have once a claimed write lands.
      let planned = tracked?.status === "plantowatch" || locals.some((local) => local.state === "plantowatch" && local.syncedAt !== undefined);
      const queued = (await Promise.all(ids.flatMap((id) => [`list:${id}`, `status:${id}`]).map((key) =>
        ctx.db.query("syncOutbox").withIndex("by_key", (q) => q.eq("profileId", profile._id).eq("key", key)).take(100)))).flat();
      for (const op of queued) if (op.op === "plan" || op.op === "unplan" || op.item.status === "plantowatch") {
        if (!op.inFlight) await ctx.db.delete(op._id);
        else if (op.op !== "unplan") planned = true;
      }
      for (const local of locals) if (local.state === "plantowatch") await ctx.db.delete(local._id);
      if (planned) {
        const back = await statusOffWatchlist(ctx, profile._id, title);
        const out = { id: title.id, type: title.type, name: title.name, year: title.year };
        if (back === null) await enqueue(ctx, profile._id, "unplan", out);
        else {
          // Watched before: it goes back where it was on Simkl, plays and all.
          await writeViewing(ctx, profile._id, title, back);
          await enqueue(ctx, profile._id, "status", { ...out, status: back });
        }
      }
    }
    // When it was added, for Undo.
    return !saved && rows.length > 0 ? Math.min(...rows.map((r) => r.addedAt)) : null;
  },
});

/** The Simkl watchlist, kept in Plan to watch: new planned titles come in, ones that moved on (watched, dropped) leave. */
export const fromSimkl = internalMutation({
  args: {
    profileId: v.id("profiles"),
    expectedConnectedAt: v.optional(v.number()),
    planned: v.array(
      v.object({
        id: v.string(),
        type: v.union(v.literal("movie"), v.literal("series")),
        name: v.string(),
        poster: v.optional(v.string()),
        year: v.optional(v.string()),
        addedAt: v.optional(v.number()),
      }),
    ),
    notPlanned: v.array(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { profileId, planned, notPlanned, expectedConnectedAt }) => {
    if (expectedConnectedAt !== undefined) {
      const connection = await ctx.db.query("connections")
        .withIndex("by_profile", (q) => q.eq("profileId", profileId).eq("provider", "simkl")).first();
      if (connection?.connectedAt !== expectedConnectedAt) return null;
    }
    const find = async (imdbId: string) =>
      await ctx.db
        .query("library")
        .withIndex("by_profile_imdb", (q) => q.eq("profileId", profileId).eq("imdbId", imdbId))
        .first();
    for (const p of planned) {
      // Krida just changed this entry and Simkl hasn't heard yet: Krida's change wins.
      if (await listChangePending(ctx, profileId, p.id)) continue;
      const existing = await find(p.id);
      if (existing) {
        if (!existing.source) await ctx.db.patch(existing._id, { source: "simkl" });
        continue;
      }
      await ctx.db.insert("library", {
        profileId,
        type: p.type,
        imdbId: p.id,
        name: p.name,
        poster: p.poster,
        year: p.year,
        addedAt: p.addedAt ?? Date.now(),
        source: "simkl",
      });
    }
    for (const id of notPlanned) {
      if (await listChangePending(ctx, profileId, id)) continue;
      const row = await find(id);
      if (row?.source === "simkl") await ctx.db.delete(row._id);
    }
    return null;
  },
});

/**
 * One-off cleanup: scores used to write a status row of their own (e.g. Watching) that no Simkl pull
 * could replace. Those rows carry the score's own timestamp, were never synced and have nothing
 * waiting to be sent. A rated movie's Watched is kept: scoring a movie still means you saw it.
 * Runs page by page across every profile; `dryRun` only logs what it would remove.
 */
export const dropRatingOnlyViewing = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())), dryRun: v.optional(v.boolean()) },
  returns: v.object({ removed: v.array(v.string()), isDone: v.boolean() }),
  handler: async (ctx, { cursor, dryRun = true }) => {
    const page = await ctx.db.query("viewing").paginate({ cursor: cursor ?? null, numItems: 100 });
    const removed: string[] = [];
    for (const row of page.page) {
      if (row.syncedAt !== undefined || row.syncError !== undefined || row.state === "rewatching") continue;
      if (row.type === "movie" && row.state === "completed") continue;
      const sameWrite = (await ctx.db.query("feedback").withIndex("by_profile_id", (q) => q.eq("profileId", row.profileId).eq("id", row.id)).first())?.at === row.at ||
        (await ctx.db.query("partRatings").withIndex("by_title", (q) => q.eq("profileId", row.profileId).eq("id", row.id)).collect()).some((r) => r.at === row.at);
      if (!sameWrite) continue;
      const waiting = await Promise.all([`list:${row.id}`, `status:${row.id}`, `watched:${row.id}::`].map((key) =>
        ctx.db.query("syncOutbox").withIndex("by_key", (q) => q.eq("profileId", row.profileId).eq("key", key)).first()));
      if (waiting.some(Boolean)) continue;
      removed.push(`${row.profileId}:${row.id}:${row.state}`);
      if (!dryRun) await ctx.db.delete(row._id);
    }
    console.log(dryRun ? "would remove" : "removed", removed);
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.library.dropRatingOnlyViewing, { cursor: page.continueCursor, dryRun });
    return { removed, isDone: page.isDone };
  },
});

/**
 * One-off cleanup: choices saved under an anime's IMDb id before Simkl reported it by its Kitsu id became a
 * second copy of the title (lib/titleIds). Simkl syncs merge them from now on; this merges what's already
 * there. Runs page by page across every profile; `dryRun` only logs what it would move.
 */
export const mergeAliases = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())), dryRun: v.optional(v.boolean()) },
  returns: v.object({ moved: v.array(v.string()), isDone: v.boolean() }),
  handler: async (ctx, { cursor, dryRun = true }) => {
    const page = await ctx.db.query("tracked").paginate({ cursor: cursor ?? null, numItems: 100 });
    const moved: string[] = [];
    for (const t of page.page) if (t.imdb) moved.push(...await mergeTitle(ctx, t.profileId, t, dryRun));
    if (moved.length && !dryRun) await Promise.all([...new Set(page.page.map((t) => t.profileId))].map((id) => invalidateStats(ctx, id)));
    console.log(dryRun ? "would move" : "moved", moved);
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.library.mergeAliases, { cursor: page.continueCursor, dryRun });
    return { moved, isDone: page.isDone };
  },
});

/** A profile's Simkl history. */
async function simklOf(ctx: QueryCtx, profileId: Id<"profiles">) {
  return await ctx.db.query("tracked").withIndex("by_profile", (q) => q.eq("profileId", profileId).eq("source", "simkl")).collect();
}

/** A profile's own statuses, Plan to watch (newest first), scores and corrections. */
async function ownOf(ctx: QueryCtx, profileId: Id<"profiles">) {
  const [viewing, list, feedback, unwatched] = await Promise.all([
    ctx.db.query("viewing").withIndex("by_profile", (q) => q.eq("profileId", profileId)).collect(),
    ctx.db.query("library").withIndex("by_profile", (q) => q.eq("profileId", profileId)).order("desc").collect(),
    ctx.db.query("feedback").withIndex("by_profile", (q) => q.eq("profileId", profileId)).collect(),
    unwatchedFor(ctx, profileId),
  ]);
  return { viewing, list, feedback, unwatched: [...unwatched] };
}

/** The latest plays, newest first. */
async function progressOf(ctx: QueryCtx, profileId: Id<"profiles">) {
  return await ctx.db.query("progress").withIndex("by_profile_updated", (q) => q.eq("profileId", profileId)).order("desc").take(400);
}

/*
 * The Library's inputs, one table each. The browser builds the collections, To rate and every poster's status
 * from these (lib/libraryViews.ts), so a rating re-reads the ratings and a Simkl send doesn't re-read the whole
 * history. The Simkl history is the big one, and it changes only when a sync brings something new.
 */

export const simklRows = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => (await simklOf(ctx, (await requireProfile(ctx, token))._id)).map(simklRowOf),
});

export const ownRows = query({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<OwnRows> => {
    const own = await ownOf(ctx, (await requireProfile(ctx, token))._id);
    return { viewing: own.viewing.map(viewingRowOf), list: own.list.map(listRowOf), feedback: own.feedback.map(feedbackRowOf), unwatched: own.unwatched };
  },
});

export const progressRows = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => (await progressOf(ctx, (await requireProfile(ctx, token))._id)).map(progressRowOf),
});

/** The Library in one query, for tabs on an older build. */
export const overview = query({
  args: { token: v.string(), separateStatuses: v.optional(v.boolean()) },
  handler: async (ctx, { token, separateStatuses }) => {
    const me = await requireProfile(ctx, token);
    return overviewFrom(await ownOf(ctx, me._id), await progressOf(ctx, me._id), await simklOf(ctx, me._id), separateStatuses);
  },
});

/**
 * Genres for the Library's titles, for its genre filter. The client asks only once someone reaches for the
 * filter, and passes the ids, so playback and status writes never re-run this.
 */
export const genres = query({
  args: { token: v.string(), ids: v.array(v.string()) },
  returns: v.object({ titles: v.array(v.object({ id: v.string(), genres: v.array(v.string()) })), missing: v.array(v.string()) }),
  handler: async (ctx, { token, ids }) => {
    await requireProfile(ctx, token);
    const titles: { id: string; genres: string[] }[] = [];
    const missing: string[] = [];
    for (const id of ids.slice(0, GENRE_IDS)) {
      const facts = await ctx.db.query("titleFacts").withIndex("by_title", (q) => q.eq("id", id)).first();
      const genres = facts?.genres ?? (await ctx.db.query("metaCache").withIndex("by_item_id", (q) => q.eq("item.id", id)).first())?.item.genres;
      if (genres?.length) titles.push({ id, genres });
      else missing.push(id);
    }
    return { titles, missing };
  },
});
const GENRE_IDS = 3000;

/** Looks up genres for titles that have none yet: at most 200 at a time, one run a minute across profiles. */
export const fillGenres = mutation({
  args: { token: v.string(), items: v.array(v.object({ id: v.string(), type: v.union(v.literal("movie"), v.literal("series")) })) },
  returns: v.null(),
  handler: async (ctx, { token, items }) => {
    await requireProfile(ctx, token);
    const job = await ctx.db.query("jobs").withIndex("by_name", (q) => q.eq("name", "genres")).first();
    const now = Date.now();
    if (!items.length || (job?.ranAt && now - job.ranAt < 60_000)) return null;
    await ctx.scheduler.runAfter(0, internal.wrapped.fillFacts, { items: items.slice(0, 200) });
    if (job) await ctx.db.patch(job._id, { ranAt: now });
    else await ctx.db.insert("jobs", { name: "genres", ranAt: now });
    return null;
  },
});

const rateItemValidator = v.object({
  id: v.string(), type: v.union(v.literal("movie"), v.literal("series")), name: v.string(),
  poster: v.optional(v.string()), year: v.optional(v.string()), imdb: v.optional(v.string()),
  // recent: finished lately. partway: stopped after enough episodes. import: logged in one go on Simkl.
  group: v.union(v.literal("recent"), v.literal("partway"), v.literal("import")),
  status: v.union(v.literal("completed"), v.literal("watching"), v.literal("hold"), v.literal("dropped")),
  watchedEpisodes: v.optional(v.number()), totalEpisodes: v.optional(v.number()),
  at: v.optional(v.number()), onSimkl: v.boolean(),
});

/**
 * Everything you've watched enough of to have an opinion, without a score yet. One episode of a show
 * doesn't count. History logged in bulk on Simkl gets its own group, since some of it may not be yours.
 */
export const toRate = query({
  args: { token: v.string() },
  returns: v.object({
    items: v.array(rateItemValidator),
    importedOn: v.optional(v.number()),
    // Shows left out because fewer than three episodes were watched.
    tooFew: v.object({ count: v.number(), names: v.array(v.string()) }),
  }),
  handler: async (ctx, { token }) => {
    const me = await requireProfile(ctx, token);
    return toRateFrom(await ownOf(ctx, me._id), await progressOf(ctx, me._id), await simklOf(ctx, me._id));
  },
});

const unwatchItemValidator = v.object({ id: v.string(), type: v.union(v.literal("movie"), v.literal("series")),
  name: v.string(), year: v.optional(v.string()) });

export const unwatchWarnings = query({
  args: { token: v.string() },
  returns: v.array(v.object({ ...unwatchItemValidator.fields, error: v.string() })),
  handler: async (ctx, { token }) => {
    const me = await requireProfile(ctx, token);
    const rows = await ctx.db.query("unwatched").withIndex("by_title", (q) => q.eq("profileId", me._id)).take(2000);
    return rows.filter((r) => r.syncError).map((r) => ({ id: r.id, type: r.type, name: r.name, error: r.syncError! }));
  },
});

async function refreshPicks(ctx: MutationCtx, me: Doc<"profiles">) {
  await invalidateStats(ctx, me._id);
}

/** "I didn't watch this": out of Watched, stats, ratings and picks, and out of Simkl's history if write-back is on. */
export const markUnwatched = mutation({
  args: { token: v.string(), item: unwatchItemValidator },
  returns: v.null(),
  handler: async (ctx, { token, item: page }) => {
    const me = await requireProfile(ctx, token);
    assertTitleId(page.id);
    const item = await canonicalTitle(ctx, me._id, page);
    // Saved under each of the title's ids: plays under its IMDb id stay hidden after Simkl drops the entry that linked them.
    const ids = [...new Set([...await titleIds(ctx, me._id, item.id), page.id])];
    const at = Date.now();
    for (const id of ids) {
      const row = await ctx.db.query("unwatched").withIndex("by_title", (q) => q.eq("profileId", me._id).eq("id", id)).first();
      const doc = { profileId: me._id, id, type: item.type, name: item.name, at };
      if (row) await ctx.db.replace(row._id, doc);
      else await ctx.db.insert("unwatched", doc);
    }
    const tracked = await ctx.db.query("tracked").withIndex("by_profile_id", (q) => q.eq("profileId", me._id).eq("id", item.id)).first();
    const played = (await Promise.all(ids.map((id) =>
      ctx.db.query("progress").withIndex("by_profile_imdb", (q) => q.eq("profileId", me._id).eq("media.imdbId", id)).first()))).some(Boolean);
    const viewing = await ctx.db.query("viewing").withIndex("by_title", (q) => q.eq("profileId", me._id).eq("id", item.id)).first();
    // Local history can already be queued or sent even before the next Simkl import.
    if (tracked && tracked.status !== "plantowatch" || played || viewing && viewing.state !== "plantowatch") {
      await enqueue(ctx, me._id, "unwatch", item);
      // Plays waiting under the other id would put it back on Simkl right after.
      for (const id of ids) if (id !== item.id)
        for (const w of await ctx.db.query("syncOutbox").withIndex("by_key", (q) =>
          q.eq("profileId", me._id).gte("key", `watched:${id}:`).lt("key", `watched:${id};`)).take(500))
          if (!w.inFlight) await ctx.db.delete(w._id);
    }
    await refreshPicks(ctx, me);
    return null;
  },
});

/** Undo for "I didn't watch this". Says whether Simkl had already been told. */
export const restoreWatched = mutation({
  args: { token: v.string(), id: v.string() },
  returns: v.union(v.literal("restored"), v.literal("simkl")),
  handler: async (ctx, { token, id: page }) => {
    const me = await requireProfile(ctx, token);
    const ids = [...new Set([...await titleIds(ctx, me._id, page), page])];
    let told = false;
    for (const id of ids) {
      const row = await ctx.db.query("unwatched").withIndex("by_title", (q) => q.eq("profileId", me._id).eq("id", id)).first();
      if (row) await ctx.db.delete(row._id);
      const op = await ctx.db.query("syncOutbox").withIndex("by_key", (q) => q.eq("profileId", me._id).eq("key", `unwatch:${id}`)).first();
      if (op && !op.inFlight) await ctx.db.delete(op._id);
      told ||= !!op?.inFlight || !!row?.sent;
    }
    await refreshPicks(ctx, me);
    return told ? "simkl" : "restored";
  },
});
