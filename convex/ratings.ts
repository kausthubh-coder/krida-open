import { ConvexError, v } from "convex/values";
import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { query } from "./_generated/server";
import { mutation } from "./functions";
import { requireProfile } from "./lib/auth";
import { bandOf, scoreOf } from "./lib/ratings";
import { enqueue } from "./lib/simklOutbox";
import { viewingStateValidator } from "./schema";
import { changeStatus } from "./library";
import { invalidateStats } from "./lib/statsCache";
import { titleStatus } from "./lib/watchStatus";
import { canonicalTitle } from "./lib/titleIds";
import { assertTitleId } from "./lib/titleIds";

const itemValidator = v.object({ id: v.string(), type: v.union(v.literal("movie"), v.literal("series")),
  name: v.string(), poster: v.optional(v.string()) });

export const save = mutation({
  args: { token: v.string(), item: itemValidator, rating: v.optional(v.union(v.number(), v.null())),
    season: v.optional(v.number()), episode: v.optional(v.number()), state: v.optional(viewingStateValidator) },
  returns: v.null(),
  handler: async (ctx, { token, item, rating, season, episode, state }) => {
    const me = await requireProfile(ctx, token);
    if (rating !== undefined && rating !== null && (!Number.isInteger(rating) || rating < 1 || rating > 10))
      throw new ConvexError("Choose a whole-number rating from 1 to 10.");
    if ((season !== undefined && (!Number.isInteger(season) || season < 0 || season > 1000)) ||
      (episode !== undefined && (!Number.isInteger(episode) || episode < 1 || episode > 10000 || season === undefined)) ||
      (item.type === "movie" && season !== undefined))
      throw new ConvexError("That season, episode or watch status is not valid for this title.");
    assertTitleId(item.id);
    const now = Date.now();
    await invalidateStats(ctx, me._id);
    // Season and episode scores stay with this page's numbering; everything about the whole title goes under its canonical id.
    const title = await canonicalTitle(ctx, me._id, item);
    const tracked = await ctx.db.query("tracked").withIndex("by_profile_id", (q) => q.eq("profileId", me._id).eq("id", title.id)).first();
    const viewing = await ctx.db.query("viewing").withIndex("by_title", (q) => q.eq("profileId", me._id).eq("id", title.id)).first();
    if (rating !== undefined) {
      if (season !== undefined) {
        const row = await ctx.db.query("partRatings").withIndex("by_part", (q) =>
          q.eq("profileId", me._id).eq("id", item.id).eq("season", season).eq("episode", episode)).first();
        if (row) await ctx.db.patch(row._id, { rating, at: now });
        else await ctx.db.insert("partRatings", { profileId: me._id, id: item.id, season, episode, rating, at: now });
        if (rating !== null && (state ?? viewing?.state) !== "rewatching")
          await enqueue(ctx, me._id, "watched", { ...item, season, episode });
      } else {
        const row = await ctx.db.query("feedback").withIndex("by_profile_id", (q) => q.eq("profileId", me._id).eq("id", title.id)).first();
        const shown = row ? scoreOf(row) : tracked?.rating ?? null;
        const doc = { profileId: me._id, ...title, value: bandOf(rating), rating, at: now };
        if (row) await ctx.db.replace(row._id, doc);
        else await ctx.db.insert("feedback", doc);
        if (shown !== rating || await ctx.db.query("syncOutbox").withIndex("by_key", (q) =>
          q.eq("profileId", me._id).eq("key", `rate:${title.id}`)).first())
          await enqueue(ctx, me._id, "rate", { ...title, rating: rating ?? 0 });
      }
    }
    // Status is its own choice: a score never sets one, except that scoring a movie means you saw it.
    // Clearing a score never removes watch history.
    if (state !== undefined) await changeStatus(ctx, me, title, state);
    else if (rating !== undefined && rating !== null && season === undefined && title.type === "movie" && !viewing &&
      tracked?.status !== "completed")
      await changeStatus(ctx, me, title, "completed");
    return null;
  },
});

export const details = query({
  args: { token: v.string(), id: v.string() },
  returns: v.object({ rating: v.union(v.number(), v.null()), state: viewingStateValidator, watchStatus: v.optional(v.union(viewingStateValidator, v.null())),
    parts: v.array(v.object({ season: v.number(), episode: v.optional(v.number()), rating: v.union(v.number(), v.null()) })),
    sync: v.union(v.literal("disconnected"), v.literal("reconnect"), v.literal("on"), v.literal("off")), syncError: v.optional(v.string()) }),
  handler: async (ctx, { token, id }) => {
    const me = await requireProfile(ctx, token);
    const { ids, tracked, local: viewing, status } = await titleStatus(ctx, me._id, id);
    // The whole title's score lives under its canonical id; season and episode scores under this page's.
    const row = (await Promise.all(ids.map((id) =>
      ctx.db.query("feedback").withIndex("by_profile_id", (q) => q.eq("profileId", me._id).eq("id", id)).first()))).find(Boolean);
    const parts = await ctx.db.query("partRatings").withIndex("by_title", (q) => q.eq("profileId", me._id).eq("id", id)).collect();
    const connection = await ctx.db.query("connections").withIndex("by_profile", (q) => q.eq("profileId", me._id).eq("provider", "simkl")).first();
    const sync: "disconnected" | "reconnect" | "on" | "off" = !connection ? "disconnected" : connection.needsReconnect ? "reconnect" : connection.writeBack ? "on" : "off";
    return { rating: row ? scoreOf(row) : tracked?.rating ?? null, syncError: row?.syncError ?? viewing?.syncError,
      state: status ?? "watching", watchStatus: status,
      parts: parts.map(({ season, episode, rating }) => ({ season, episode, rating })),
      sync };
  },
});

export const mine = query({
  args: { token: v.string(), source: v.union(v.literal("krida"), v.literal("simkl")), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(v.object({ id: v.string(), rating: v.union(v.number(), v.null()) })),
  handler: async (ctx, { token, source, paginationOpts }) => {
    const me = await requireProfile(ctx, token);
    if (source === "simkl") {
      const result = await ctx.db.query("tracked").withIndex("by_profile", (q) => q.eq("profileId", me._id)).paginate(paginationOpts);
      return { ...result, page: result.page.filter((r) => r.rating !== undefined).map((r) => ({ id: r.id, rating: r.rating ?? null })) };
    }
    const result = await ctx.db.query("feedback").withIndex("by_profile", (q) => q.eq("profileId", me._id)).paginate(paginationOpts);
    return { ...result, page: result.page.map((r) => ({ id: r.id, rating: scoreOf(r) })) };
  },
});
