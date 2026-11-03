import { ConvexError, v } from "convex/values";
import { query } from "./_generated/server";
import { mutation } from "./functions";
import { requireProfile } from "./lib/auth";
import { mediaValidator } from "./schema";
import { enqueue } from "./lib/simklOutbox";
import { changeStatus } from "./library";
import { hiddenBy, unwatchedFor } from "./lib/unwatched";
import { expandEpisodes, withoutEpisodes } from "./lib/simkl";
import { invalidateStats } from "./lib/statsCache";
import { canonicalId, canonicalTitle } from "./lib/titleIds";
import { isTitleId } from "../shared/ids";

const FINISHED_RATIO = 0.93;

// While playing, the position is written at most this often. Every write re-runs the queries that
// list this profile's progress (Continue watching, statuses), so ticks are cheap to skip.
const TICK_WRITE_MS = 60_000;

export const save = mutation({
  // `final`: paused, closed or left the player, so the exact position is kept.
  args: { token: v.string(), media: mediaValidator, position: v.number(), duration: v.number(), final: v.optional(v.boolean()) },
  handler: async (ctx, { token, media, position, duration, final }) => {
    const profile = await requireProfile(ctx, token);
    if (!(duration > 0) || !(position >= 0)) return;
    const finished = position / duration >= FINISHED_RATIO;
    const unseen = profile.prefs.private === true;
    const existing = await ctx.db
      .query("progress")
      .withIndex("by_profile_video", (q) =>
        q.eq("profileId", profile._id).eq("media.videoId", media.videoId),
      )
      .first();
    if (existing && !final && !existing.hidden && existing.finished === finished && !!existing.private === unseen &&
      Date.now() - existing.updatedAt < TICK_WRITE_MS && Math.abs(existing.position - position) < 90)
      return;
    const row = { media, position, duration, finished, hidden: false, private: unseen, updatedAt: Date.now() };
    if (existing) await ctx.db.patch(existing._id, row);
    else await ctx.db.insert("progress", { profileId: profile._id, ...row });
    // The play stays under this id; what it means for the whole title goes under the title's canonical id.
    const item = await canonicalTitle(ctx, profile._id,
      { id: media.imdbId, type: media.type, name: media.name, poster: media.poster, year: media.year });
    const viewing = await ctx.db.query("viewing").withIndex("by_title", (q) => q.eq("profileId", profile._id).eq("id", item.id)).first();
    const rewatching = viewing?.state === "rewatching";
    if (finished && media.type === "movie" && viewing && viewing.state !== "completed") {
      if (rewatching) await ctx.db.patch(viewing._id, { state: "completed", at: Date.now(), syncedAt: undefined });
      else await changeStatus(ctx, profile, item, "completed");
    } else if (!finished && viewing && ["plantowatch", "hold", "dropped"].includes(viewing.state))
      // A movie stays in Plan to watch and the Simkl watchlist: Simkl has no Watching for movies.
      await changeStatus(ctx, profile, item, "watching");
    // Finished here: it goes to Simkl's history with the next batch, if this profile connected it.
    // A movie has no episodes to number, so it goes to Simkl as the entry it's tracked as.
    if (finished && !existing?.finished && !rewatching)
      await enqueue(ctx, profile._id, "watched", media.type === "movie" ? { id: item.id, type: item.type, name: item.name, year: item.year } : {
        id: media.imdbId,
        type: media.type,
        name: media.name,
        year: media.year,
        season: media.season,
        episode: media.episode,
      });
  },
});

/**
 * Episodes marked watched, or not, from the episode list. Simkl hears it too, except while rewatching:
 * a rewatch is Krida's own and never touches Simkl's history.
 */
export const mark = mutation({
  args: { token: v.string(), episodes: v.array(mediaValidator), watched: v.boolean() },
  returns: v.null(),
  handler: async (ctx, { token, episodes, watched }) => {
    const profile = await requireProfile(ctx, token);
    const first = episodes[0];
    if (!first) return null;
    if (episodes.length > 500) throw new ConvexError("Mark at most 500 episodes at a time.");
    if (!isTitleId(first.imdbId) || episodes.some((m) => m.imdbId !== first.imdbId || m.type !== "series" ||
      m.season === undefined || m.episode === undefined))
      throw new ConvexError("Those aren’t episodes of one show.");
    const id = first.imdbId;
    // Episodes stay under this id (its numbering); a rewatch or "I didn't watch this" belongs to the whole title.
    const canonical = await canonicalId(ctx, profile._id, id);
    const rows = await ctx.db.query("progress").withIndex("by_profile_imdb", (q) => q.eq("profileId", profile._id).eq("media.imdbId", id)).collect();
    const viewing = await ctx.db.query("viewing").withIndex("by_title", (q) => q.eq("profileId", profile._id).eq("id", canonical)).first();
    const rewatching = viewing?.state === "rewatching";
    const unseen = profile.prefs.private === true;
    // Plays from before a rewatch (or before "I didn't watch this") don't count as watched now.
    const unwatched = await unwatchedFor(ctx, profile._id);
    const since = rewatching ? viewing.at : Math.max(unwatched.get(id) ?? 0, unwatched.get(canonical) ?? 0);
    const current = (r: (typeof rows)[number]) => r.updatedAt > since;
    const item = { id, type: "series" as const, name: first.name, year: first.year };
    const now = Date.now();
    const order = (m: { season?: number; episode?: number }) => (m.season ? m.season * 100_000 + (m.episode ?? 0) : -1);
    if (watched) {
      // Furthest first, each landing just before what comes after it, so Play still carries on from
      // the furthest episode rather than from an old one marked today.
      const marked: typeof episodes = [];
      for (const m of [...episodes].sort((a, b) => order(b) - order(a))) {
        const row = rows.find((r) => r.media.videoId === m.videoId);
        if (row?.finished && current(row)) continue;
        const later = rows.filter((r) => current(r) && order(r.media) > order(m)).map((r) => r.updatedAt - 1);
        const updatedAt = Math.max(since + 1, Math.min(now, ...later));
        if (row) {
          await ctx.db.patch(row._id, { finished: true, hidden: false, private: unseen, updatedAt });
          Object.assign(row, { finished: true, updatedAt });
        } else {
          const doc = { profileId: profile._id, media: m, position: 0, duration: 0, finished: true, hidden: false, private: unseen, updatedAt };
          rows.push({ _id: await ctx.db.insert("progress", doc), _creationTime: now, ...doc });
        }
        marked.unshift(m);
      }
      if (!rewatching)
        for (const m of marked)
          await enqueue(ctx, profile._id, "watched", { ...item, season: m.season, episode: m.episode });
    } else {
      const tracked = rewatching ? null : await ctx.db.query("tracked").withIndex("by_profile_id", (q) => q.eq("profileId", profile._id).eq("id", id)).first();
      const onSimkl = new Set(expandEpisodes(tracked?.watched));
      const drop = new Set<string>();
      for (const m of episodes) {
        const row = rows.find((r) => r.media.videoId === m.videoId);
        if (row && current(row)) await ctx.db.delete(row._id);
        if (rewatching) continue;
        const key = `${m.season}:${m.episode}`;
        if (onSimkl.has(key)) drop.add(key);
        const queued = await ctx.db.query("syncOutbox").withIndex("by_key", (q) =>
          q.eq("profileId", profile._id).eq("key", `watched:${id}:${m.season}:${m.episode}`)).first();
        if (row?.finished || onSimkl.has(key) || queued) await enqueue(ctx, profile._id, "unwatch", { ...item, season: m.season, episode: m.episode });
      }
      // Shown unwatched right away; the next Simkl sync agrees once the removal is sent.
      if (tracked && drop.size) await ctx.db.patch(tracked._id, withoutEpisodes(tracked, drop));
    }
    await invalidateStats(ctx, profile._id);
    return null;
  },
});

/** Most recent row per title, newest first. Finished episodes are kept so the client can offer the next one. */
export const continueWatching = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const profile = await requireProfile(ctx, token);
    const unwatched = await unwatchedFor(ctx, profile._id);
    const rows = await ctx.db
      .query("progress")
      .withIndex("by_profile_updated", (q) => q.eq("profileId", profile._id))
      .order("desc")
      .take(200);
    const seen = new Set<string>();
    const out = [];
    for (const r of rows) {
      if (seen.has(r.media.imdbId)) continue;
      seen.add(r.media.imdbId);
      if (r.hidden || hiddenBy(unwatched, r.media.imdbId, r.updatedAt)) continue;
      if (r.finished && r.media.type === "movie") continue;
      out.push(r);
      if (out.length >= 20) break;
    }
    return out;
  },
});

/**
 * Titles played in Krida, for the shared status rule: the latest row per title, without positions,
 * so playback ticks don't change the answer. Hidden titles were taken out of Continue watching.
 */
export const started = query({
  args: { token: v.string() },
  returns: v.array(v.object({ id: v.string(), type: v.union(v.literal("movie"), v.literal("series")), finished: v.boolean() })),
  handler: async (ctx, { token }) => {
    const profile = await requireProfile(ctx, token);
    const unwatched = await unwatchedFor(ctx, profile._id);
    const rows = await ctx.db
      .query("progress")
      .withIndex("by_profile_updated", (q) => q.eq("profileId", profile._id))
      .order("desc")
      .take(400);
    const latest = new Map<string, { id: string; type: "movie" | "series"; finished: boolean } | null>();
    for (const r of rows)
      if (!latest.has(r.media.imdbId)) latest.set(r.media.imdbId, r.hidden || hiddenBy(unwatched, r.media.imdbId, r.updatedAt) ? null : { id: r.media.imdbId, type: r.media.type, finished: r.finished });
    return [...latest.values()].filter((r) => r !== null).sort((a, b) => a.id.localeCompare(b.id));
  },
});

export const history = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const profile = await requireProfile(ctx, token);
    const unwatched = await unwatchedFor(ctx, profile._id);
    const rows = await ctx.db
      .query("progress")
      .withIndex("by_profile_updated", (q) => q.eq("profileId", profile._id))
      .order("desc")
      .take(200);
    const seen = new Set<string>();
    return rows.filter((r) => {
      if (seen.has(r.media.imdbId)) return false;
      seen.add(r.media.imdbId);
      return !hiddenBy(unwatched, r.media.imdbId, r.updatedAt);
    });
  },
});

export const forTitle = query({
  args: { token: v.string(), imdbId: v.string() },
  handler: async (ctx, { token, imdbId }) => {
    const profile = await requireProfile(ctx, token);
    const unwatched = await unwatchedFor(ctx, profile._id);
    const rows = await ctx.db
      .query("progress")
      .withIndex("by_profile_imdb", (q) => q.eq("profileId", profile._id).eq("media.imdbId", imdbId))
      .order("desc")
      .collect();
    return rows.filter((r) => !hiddenBy(unwatched, r.media.imdbId, r.updatedAt)).map((r) => ({
      videoId: r.media.videoId,
      season: r.media.season,
      episode: r.media.episode,
      position: r.position,
      duration: r.duration,
      finished: r.finished,
      updatedAt: r.updatedAt,
    }));
  },
});

export const setHidden = mutation({
  args: { token: v.string(), imdbId: v.string(), hidden: v.boolean() },
  handler: async (ctx, { token, imdbId, hidden }) => {
    const profile = await requireProfile(ctx, token);
    const rows = await ctx.db
      .query("progress")
      .withIndex("by_profile_imdb", (q) => q.eq("profileId", profile._id).eq("media.imdbId", imdbId))
      .collect();
    for (const r of rows) await ctx.db.patch(r._id, { hidden });
  },
});
