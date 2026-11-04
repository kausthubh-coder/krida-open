import { v } from "convex/values";
import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { query } from "./_generated/server";
import { mutation } from "./functions";
import { requireProfile } from "./lib/auth";
import { rateOnSimkl, thumbFor } from "./simkl";
import { rateThumbOnTrakt } from "./lib/traktOutbox";
import { scoreOf } from "./lib/ratings";
import { canonicalTitle, titleIds } from "./lib/titleIds";

/**
 * A profile's own ratings, Netflix-style: Not for me, I like this, Love this. They're the strongest
 * signal the recommender gets: loved titles lead your picks, and anything close to what you turned
 * down sinks.
 */

const valueValidator = v.union(v.literal("down"), v.literal("up"), v.literal("love"));

export const set = mutation({
  args: {
    token: v.string(),
    item: v.object({
      id: v.string(),
      type: v.union(v.literal("movie"), v.literal("series")),
      name: v.string(),
      poster: v.optional(v.string()),
    }),
    // null clears the rating.
    value: v.union(valueValidator, v.null()),
  },
  returns: v.null(),
  handler: async (ctx, { token, item: page, value }) => {
    const me = await requireProfile(ctx, token);
    const item = await canonicalTitle(ctx, me._id, page);
    const existing = await ctx.db
      .query("feedback")
      .withIndex("by_profile_id", (q) => q.eq("profileId", me._id).eq("id", item.id))
      .first();
    const tracked = await ctx.db
      .query("tracked")
      .withIndex("by_profile_id", (q) => q.eq("profileId", me._id).eq("id", item.id))
      .first();
    // What the button showed: your thumb here, or your Simkl rating as one.
    const shown = existing ? existing.value : thumbFor(tracked?.rating);
    if (shown === value) return null;
    if (existing) await ctx.db.delete(existing._id);
    await ctx.db.insert("feedback", { profileId: me._id, ...item, value, at: Date.now() });
    // Positive ratings can add a previously untracked title on Simkl.
    await rateOnSimkl(ctx, me._id, item, value);
    await rateThumbOnTrakt(ctx, me._id, page, value);
    // One pending recompute per profile, even if the starter sheet sends many ratings.
    return null;
  },
});

/** Paged once per browsing session; Krida thumbs take precedence over the Simkl fallback. */
export const mine = query({
  args: {
    token: v.string(),
    source: v.union(v.literal("krida"), v.literal("simkl")),
    paginationOpts: paginationOptsValidator,
  },
  // A cleared local thumb still overrides an imported Simkl rating.
  returns: paginationResultValidator(v.object({ id: v.string(), value: v.union(valueValidator, v.null()) })),
  handler: async (ctx, { token, source, paginationOpts }) => {
    const me = await requireProfile(ctx, token);
    if (source === "simkl") {
      const result = await ctx.db
        .query("tracked")
        .withIndex("by_profile", (q) => q.eq("profileId", me._id))
        .paginate(paginationOpts);
      return {
        ...result,
        page: result.page.flatMap<{ id: string; value: "down" | "up" | "love" }>((t) => {
          const value = thumbFor(t.rating);
          return value === "down" || value === "up" || value === "love" ? [{ id: t.id, value }] : [];
        }),
      };
    }
    const rows = await ctx.db
      .query("feedback")
      .withIndex("by_profile", (q) => q.eq("profileId", me._id))
      .paginate(paginationOpts);
    return { ...rows, page: rows.page.map((r) => ({ id: r.id, value: r.value })) };
  },
});

export const forTitle = query({
  args: { token: v.string(), id: v.string() },
  returns: v.union(valueValidator, v.null()),
  handler: async (ctx, { token, id: page }) => {
    const me = await requireProfile(ctx, token);
    const [id] = await titleIds(ctx, me._id, page);
    const row = await ctx.db
      .query("feedback")
      .withIndex("by_profile_id", (q) => q.eq("profileId", me._id).eq("id", id))
      .first();
    if (row) return row.value;
    // Rated on Simkl but never thumbed here: show it as the matching thumb.
    const tracked = await ctx.db
      .query("tracked")
      .withIndex("by_profile_id", (q) => q.eq("profileId", me._id).eq("id", id))
      .first();
    return thumbFor(tracked?.rating);
  },
});

/**
 * For a profile Krida knows nothing about yet: well-known titles to rate, so picks have something to
 * start from. Movies and shows alternate; ones you've already rated keep their rating.
 */
export const starter = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const me = await requireProfile(ctx, token);
    const rated = new Map(
      (
        await ctx.db
          .query("feedback")
          .withIndex("by_profile", (q) => q.eq("profileId", me._id))
          .collect()
      ).map((f) => [f.id, f]),
    );
    // What you've watched (Simkl) but never rated, most recent first; then titles most people have
    // seen, a few from each genre (built with the catalogs).
    const history = (
      await ctx.db
        .query("tracked")
        .withIndex("by_profile", (q) => q.eq("profileId", me._id).eq("source", "simkl"))
        .collect()
    )
      .filter((t) => (t.status === "completed" || t.status === "watching") &&
        (rated.has(t.id) ? scoreOf(rated.get(t.id)!) === null : t.rating === undefined))
      .sort((a, b) => (b.lastWatchedAt ?? 0) - (a.lastWatchedAt ?? 0))
      .slice(0, 32)
      .map((t) => ({
        id: t.id,
        type: t.type,
        name: t.name,
        poster: t.id.startsWith("tt") ? undefined : t.poster,
        year: t.year,
        value: null,
        rating: null,
      }));
    const doc = await ctx.db
      .query("catalogCache")
      .withIndex("by_key", (q) => q.eq("key", "tmdb:starter"))
      .first();
    const seen = new Set(history.map((h) => h.id));
    const popular = (doc?.items ?? [])
      .filter((x) => !seen.has(x.id))
      .map((x) => ({ id: x.id, type: x.type, name: x.name, poster: x.poster, year: x.year,
        value: rated.get(x.id)?.value ?? null, rating: rated.has(x.id) ? scoreOf(rated.get(x.id)!) : null }));
    const items = [...history, ...popular].slice(0, 48);
    return { items, rated: [...rated.values()].filter((row) => scoreOf(row) !== null).length, fromHistory: history.length };
  },
});

/** How many titles this profile has rated, for Settings. */
export const summary = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const me = await requireProfile(ctx, token);
    const rows = await ctx.db
      .query("feedback")
      .withIndex("by_profile", (q) => q.eq("profileId", me._id))
      .collect();
    const onSimkl = (
      await ctx.db
        .query("tracked")
        .withIndex("by_profile", (q) => q.eq("profileId", me._id).eq("source", "simkl"))
        .collect()
    ).filter((t) => t.rating !== undefined).length;
    return {
      onSimkl,
      rated: rows.filter((r) => scoreOf(r) !== null).length,
      love: rows.filter((r) => r.value === "love").length,
      up: rows.filter((r) => r.value === "up").length,
      down: rows.filter((r) => r.value === "down").length,
    };
  },
});
