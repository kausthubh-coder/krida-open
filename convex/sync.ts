import { v } from "convex/values";
import type { PaginationOptions } from "convex/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { query, type QueryCtx } from "./_generated/server";
import { internalMutation, SYNCED, type Synced } from "./functions";
import { requireProfile } from "./lib/auth";

/*
 * Each browser keeps a copy of its profile's own tables (Simkl history, statuses, Plan to watch, scores, plays) and fetches
 * only what changed since it last looked, so a rating reads one row instead of the whole library, and a play saving
 * its position reads one row instead of every recent play. Every write to these tables notes the change (functions.ts).
 */

const syncedValidator = v.union(...SYNCED.map((t) => v.literal(t)));

// A mutation that started before the cursor can land after it (its time is when it started), so a pull looks back
// this far as well. Mutations take well under a second.
const OVERLAP_MS = 5000;
// Further behind than this, a browser fetches everything again instead.
const MAX_CHANGES = 5000;
const PAGE = 500;
// Changes older than this are forgotten; a browser whose copy is older fetches everything again.
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;

/** This profile's newest forgotten change: a copy from before it can't catch up by pulling. */
async function floorOf(ctx: QueryCtx, profileId: Id<"profiles">) {
  return (await ctx.db.query("syncFloors").withIndex("by_profile", (q) => q.eq("profileId", profileId)).first())?.at ?? 0;
}

/** What changed since `since` (a pull's cursor): each row as it is now, or null where it was deleted. */
export const pull = query({
  args: { token: v.string(), since: v.number() },
  handler: async (ctx, { token, since }) => {
    const me = await requireProfile(ctx, token);
    if (since < (await floorOf(ctx, me._id))) return { reset: true as const };
    const rows = await ctx.db
      .query("changes")
      .withIndex("by_profile_at", (q) => q.eq("profileId", me._id).gt("at", since - OVERLAP_MS))
      .take(MAX_CHANGES + 1);
    if (rows.length > MAX_CHANGES) return { reset: true as const };
    const changes = await Promise.all(rows.map(async (r) => {
      const table = r.table as Synced;
      const id = ctx.db.normalizeId(table, r.docId);
      return { table, id: r.docId, doc: id ? await ctx.db.get(id) : null };
    }));
    return { reset: false as const, cursor: rows.reduce((at, r) => Math.max(at, r.at), since), changes };
  },
});

function pageOf(ctx: QueryCtx, profileId: Id<"profiles">, table: Synced, page: PaginationOptions) {
  switch (table) {
    case "tracked": return ctx.db.query("tracked").withIndex("by_profile", (q) => q.eq("profileId", profileId)).paginate(page);
    case "viewing": return ctx.db.query("viewing").withIndex("by_profile", (q) => q.eq("profileId", profileId)).paginate(page);
    case "library": return ctx.db.query("library").withIndex("by_profile", (q) => q.eq("profileId", profileId)).paginate(page);
    case "feedback": return ctx.db.query("feedback").withIndex("by_profile", (q) => q.eq("profileId", profileId)).paginate(page);
    case "partRatings": return ctx.db.query("partRatings").withIndex("by_profile", (q) => q.eq("profileId", profileId)).paginate(page);
    case "unwatched": return ctx.db.query("unwatched").withIndex("by_title", (q) => q.eq("profileId", profileId)).paginate(page);
    case "progress": return ctx.db.query("progress").withIndex("by_profile_updated", (q) => q.eq("profileId", profileId)).paginate(page);
  }
}

/**
 * One page of a table, for a browser starting its copy. The first page of the first table also says how far the
 * changes go (`head`), so pulling from there afterwards catches anything written meanwhile.
 */
export const snapshot = query({
  args: { token: v.string(), table: syncedValidator, cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { token, table, cursor }) => {
    const me = await requireProfile(ctx, token);
    const latest = cursor === null
      ? (await ctx.db.query("changes").withIndex("by_profile_at", (q) => q.eq("profileId", me._id)).order("desc").first())?.at ?? 0
      : null;
    const head = latest === null ? null : Math.max(latest, await floorOf(ctx, me._id));
    const page = await pageOf(ctx, me._id, table, { cursor, numItems: PAGE });
    return { docs: page.page, cursor: page.isDone ? null : page.continueCursor, head };
  },
});

/** Forgets changes older than a month, a batch at a time, noting for each profile the newest one forgotten. */
export const prune = internalMutation({
  args: {},
  handler: async (ctx) => {
    const old = await ctx.db.query("changes").withIndex("by_at", (q) => q.lt("at", Date.now() - KEEP_MS)).take(500);
    const newest = new Map<Id<"profiles">, number>();
    for (const row of old) {
      newest.set(row.profileId, Math.max(row.at, newest.get(row.profileId) ?? 0));
      await ctx.db.delete(row._id);
    }
    for (const [profileId, at] of newest) {
      const floor = await ctx.db.query("syncFloors").withIndex("by_profile", (q) => q.eq("profileId", profileId)).first();
      if (floor) await ctx.db.patch(floor._id, { at: Math.max(at, floor.at) });
      else await ctx.db.insert("syncFloors", { profileId, at });
    }
    if (old.length === 500) await ctx.scheduler.runAfter(0, internal.sync.prune, {});
  },
});
