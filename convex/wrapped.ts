import { v } from "convex/values";
import { housemates } from "./lib/accounts";
import { internalAction, internalQuery, query, type ActionCtx } from "./_generated/server";
import { internalMutation, mutation } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireProfile } from "./lib/auth";
import { isPreview } from "./preview";
import { scoreOf } from "./lib/ratings";
import { expandEpisodes, expandWatchedAt } from "./lib/simkl";
import { mapLimit } from "../shared/tmdb";
import { hiddenBy, unwatchedFor } from "./lib/unwatched";
import { aliasesOf, canonicalWith } from "./lib/titleIds";
import { buildStats, watchedEnough, type Facts, type StatTitle, type WatchEvent } from "./lib/stats";
import { STATS_VERSION, statsValidator } from "./lib/statsShape";
import { STATS_SETTLE_MS, STATS_VIEWING_MS } from "./lib/statsCache";
import { CINEMETA, KITSU } from "../shared/addons";

/**
 * Library stats and Wrapped. Computed in an action from paginated reads (a long Simkl history is too big
 * for one query), cached per profile, refreshed nightly and when Stats is opened after a while.
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const STALE = 6 * HOUR;
// Genre and people lookups per run. Cinemeta and Kitsu are free, but a big history fills over a few runs.
const FACTS_PER_RUN = 300;

export const get = query({
  // The time comes in as an argument: a cached query that read the clock could call fresh stats stale.
  args: { token: v.string(), now: v.number() },
  returns: v.object({
    stats: v.optional(statsValidator),
    computedAt: v.optional(v.number()),
    computing: v.boolean(),
    stale: v.boolean(),
  }),
  handler: async (ctx, { token, now }) => {
    const me = await requireProfile(ctx, token);
    const row = await ctx.db.query("wrapped").withIndex("by_profile", (q) => q.eq("profileId", me._id)).first();
    const job = row?.jobId ? await ctx.db.system.get(row.jobId) : null;
    const current = row?.version === STATS_VERSION ? row : null;
    return {
      stats: current?.stats,
      computedAt: current?.stats ? current.computedAt : undefined,
      computing: job?.state.kind === "pending" || job?.state.kind === "inProgress",
      stale: !current?.stats || now - current.computedAt > STALE,
    };
  },
});

/** Opening Stats: recompute if it's been a while, in the profile's own time zone. */
export const refreshSoon = mutation({
  args: { token: v.string(), timeZone: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { token, timeZone }) => {
    const me = await requireProfile(ctx, token);
    const zone = timeZone && timeZone.length <= 64 ? timeZone : undefined;
    const row = await ctx.db.query("wrapped").withIndex("by_profile", (q) => q.eq("profileId", me._id)).first();
    const job = row?.jobId ? await ctx.db.system.get(row.jobId) : null;
    const running = job?.state.kind === "pending" || job?.state.kind === "inProgress";
    const fresh = row?.stats && row.version === STATS_VERSION && Date.now() - row.computedAt < STALE && row.timeZone === (zone ?? row.timeZone);
    // Stats are being looked at: changes for a while after this keep them up to date (invalidateStats).
    const viewedAt = Date.now();
    if (running || fresh) {
      if (row) await ctx.db.patch(row._id, { viewedAt, ...(zone && row.timeZone !== zone ? { timeZone: zone } : {}) });
      return null;
    }
    const jobId = await ctx.scheduler.runAfter(0, internal.wrapped.compute, { profileId: me._id });
    if (row) await ctx.db.patch(row._id, { jobId, viewedAt, ...(zone ? { timeZone: zone } : {}) });
    else await ctx.db.insert("wrapped", { profileId: me._id, version: 0, computedAt: 0, timeZone: zone, jobId, viewedAt });
    return null;
  },
});

/** Every lasting profile (not a party guest's). */
export const profiles = internalQuery({
  args: {},
  handler: async (ctx) => (await ctx.db.query("profiles").collect()).filter((p) => p.expiresAt === undefined).map((p) => ({ _id: p._id, name: p.name })),
});

/** Nightly, for everyone, spread out so the addon lookups don't all land at once. */
export const computeAll = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    if (isPreview()) return null;
    const profiles: { _id: Id<"profiles"> }[] = await ctx.runQuery(internal.wrapped.profiles, {});
    for (const [i, p] of profiles.entries()) await ctx.scheduler.runAfter(i * 60_000, internal.wrapped.compute, { profileId: p._id });
    return null;
  },
});

const PAGE = 150;

export const trackedPage = internalQuery({
  args: { profileId: v.id("profiles"), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { profileId, cursor }) => {
    const page = await ctx.db.query("tracked").withIndex("by_profile", (q) => q.eq("profileId", profileId).eq("source", "simkl"))
      .paginate({ cursor, numItems: PAGE });
    return {
      ...page,
      page: page.page.map((t) => ({
        id: t.id, imdb: t.imdb, type: t.type, name: t.name, poster: t.poster, year: t.year, status: t.status, rating: t.rating,
        watchedEpisodes: t.watchedEpisodes, totalEpisodes: t.totalEpisodes, watched: t.watched, watchedAt: t.watchedAt, runtime: t.runtime,
        lastWatchedAt: t.lastWatchedAt, addedAt: t.addedAt,
      })),
    };
  },
});

export const progressPage = internalQuery({
  args: { profileId: v.id("profiles"), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { profileId, cursor }) => {
    const page = await ctx.db.query("progress").withIndex("by_profile_updated", (q) => q.eq("profileId", profileId))
      .paginate({ cursor, numItems: PAGE * 2 });
    return {
      ...page,
      page: page.page.map((p) => ({
        imdbId: p.media.imdbId, type: p.media.type, name: p.media.name, poster: p.media.poster, year: p.media.year,
        season: p.media.season, episode: p.media.episode, position: p.position, duration: p.duration,
        finished: p.finished, hidden: p.hidden, startedAt: p._creationTime, updatedAt: p.updatedAt,
      })),
    };
  },
});

/** Everything small about a profile: scores, statuses, Plan to watch, "didn't watch", time together. */
export const rest = internalQuery({
  args: { profileId: v.id("profiles") },
  handler: async (ctx, { profileId }) => {
    const me = await ctx.db.get(profileId);
    const feedback = await ctx.db.query("feedback").withIndex("by_profile", (q) => q.eq("profileId", profileId)).collect();
    const viewing = await ctx.db.query("viewing").withIndex("by_profile", (q) => q.eq("profileId", profileId)).collect();
    const library = await ctx.db.query("library").withIndex("by_profile", (q) => q.eq("profileId", profileId)).collect();
    const unwatched = [...(await unwatchedFor(ctx, profileId)).entries()];
    const row = await ctx.db.query("wrapped").withIndex("by_profile", (q) => q.eq("profileId", profileId)).first();

    // The friend: the other profile, with their scores and the time you spent in the same room.
    const other = me ? (await housemates(ctx, me))[0] : undefined;
    let friend: { name: string; hue: number; scores: [string, number][]; togetherMinutes: number; parties: number } | undefined;
    if (other && me) {
      const theirFeedback = await ctx.db.query("feedback").withIndex("by_profile", (q) => q.eq("profileId", other._id)).collect();
      const scores = new Map<string, number>();
      for (const t of await ctx.db.query("tracked").withIndex("by_status", (q) => q.eq("profileId", other._id).eq("status", "completed")).take(3000))
        if (t.rating !== undefined) scores.set(t.id, t.rating);
      for (const f of theirFeedback) { const s = scoreOf(f); if (s === null) scores.delete(f.id); else scores.set(f.id, s); }
      let together = 0, parties = 0;
      for (const mine of await ctx.db.query("roomMembers").withIndex("by_profile", (q) => q.eq("profileId", profileId)).order("desc").take(500)) {
        const theirs = await ctx.db.query("roomMembers").withIndex("by_room_profile", (q) => q.eq("roomId", mine.roomId).eq("profileId", other._id)).first();
        if (!theirs) continue;
        const overlap = Math.min(mine.lastSeenAt, theirs.lastSeenAt) - Math.max(mine.joinedAt, theirs.joinedAt);
        if (overlap > 5 * 60_000) { together += overlap / 60_000; parties++; }
      }
      friend = { name: other.name, hue: other.hue, scores: [...scores.entries()], togetherMinutes: together, parties };
    }
    return {
      feedback: feedback.map((f) => ({ id: f.id, type: f.type, name: f.name, poster: f.poster, score: scoreOf(f) })),
      viewing: viewing.map((r) => ({ id: r.id, type: r.type, name: r.name, poster: r.poster, state: r.state, at: r.at })),
      library: library.map((l) => ({ id: l.imdbId, type: l.type, name: l.name, poster: l.poster, year: l.year, addedAt: l.addedAt })),
      unwatched, timeZone: row?.timeZone, revision: row?.revision ?? 0, friend,
    };
  },
});

export const factsFor = internalQuery({
  args: { ids: v.array(v.string()) },
  handler: async (ctx, { ids }) => {
    const out: { id: string; facts?: Doc<"titleFacts">; meta?: { genres: string[]; cast: string[]; director: string[] } }[] = [];
    for (const id of ids) {
      const facts = await ctx.db.query("titleFacts").withIndex("by_title", (q) => q.eq("id", id)).first();
      const meta = facts ? null : await ctx.db.query("metaCache").withIndex("by_item_id", (q) => q.eq("item.id", id)).first();
      out.push({ id, facts: facts ?? undefined, meta: meta ? { genres: meta.item.genres, cast: meta.item.cast, director: meta.item.director } : undefined });
    }
    return out;
  },
});

const factsValidator = v.object({
  id: v.string(), genres: v.array(v.string()), cast: v.array(v.string()), director: v.array(v.string()),
  country: v.optional(v.string()), runtime: v.optional(v.number()),
});

export const putFacts = internalMutation({
  args: { rows: v.array(factsValidator) },
  returns: v.null(),
  handler: async (ctx, { rows }) => {
    for (const row of rows) {
      const existing = await ctx.db.query("titleFacts").withIndex("by_title", (q) => q.eq("id", row.id)).first();
      const doc = { ...row, fetchedAt: Date.now() };
      if (existing) await ctx.db.replace(existing._id, doc);
      else await ctx.db.insert("titleFacts", doc);
    }
    return null;
  },
});

/** Facts for Library titles nobody has looked up yet, so the genre filter can place them. */
export const fillFacts = internalAction({
  args: { items: v.array(v.object({ id: v.string(), type: v.union(v.literal("movie"), v.literal("series")) })) },
  returns: v.null(),
  handler: async (ctx, { items }) => {
    const fetched = (await mapLimit(items, 8, (t) => fetchFacts(t.id, t.type))).filter((f): f is NonNullable<typeof f> => f !== null);
    for (let i = 0; i < fetched.length; i += 100) await ctx.runMutation(internal.wrapped.putFacts, { rows: fetched.slice(i, i + 100) });
    return null;
  },
});

export const save = internalMutation({
  args: { profileId: v.id("profiles"), stats: statsValidator, revision: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, { profileId, stats, revision }) => {
    const row = await ctx.db.query("wrapped").withIndex("by_profile", (q) => q.eq("profileId", profileId)).first();
    if ((row?.revision ?? 0) !== (revision ?? 0)) {
      // Something changed while this ran. Start again only if someone is looking at Stats; otherwise it waits for them.
      const watched = row?.viewedAt !== undefined && Date.now() - row.viewedAt < STATS_VIEWING_MS;
      const jobId = watched ? await ctx.scheduler.runAfter(STATS_SETTLE_MS, internal.wrapped.compute, { profileId }) : undefined;
      if (row) await ctx.db.patch(row._id, { jobId });
      return null;
    }
    const doc = { version: STATS_VERSION, computedAt: Date.now(), stats };
    if (row) await ctx.db.patch(row._id, { ...doc, jobId: undefined });
    else await ctx.db.insert("wrapped", { profileId, ...doc });
    return null;
  },
});

const strings = (value: unknown, max: number) =>
  Array.isArray(value) ? value.filter((x): x is string => typeof x === "string").slice(0, max) : [];
const minutesOf = (value: unknown) => {
  const m = typeof value === "string" ? /(\d+)\s*h(?:our)?s?\s*(\d+)?|(\d+)\s*min/i.exec(value) : null;
  if (!m) return undefined;
  const n = m[3] ? Number(m[3]) : Number(m[1]) * 60 + Number(m[2] ?? 0);
  return n > 0 && n < 600 ? n : undefined;
};

/** Genres, people, country and runtime for one title, from Cinemeta (or the Kitsu addon for anime). */
async function fetchFacts(id: string, type: "movie" | "series") {
  const url = id.startsWith("kitsu:")
    ? `${KITSU}/meta/${type}/${encodeURIComponent(id)}.json`
    : `${CINEMETA}/meta/${type}/${encodeURIComponent(id)}.json`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const meta = (await res.json())?.meta;
    if (!meta) return null;
    return {
      id, genres: strings(meta.genres ?? meta.genre, 6), cast: strings(meta.cast, 5), director: strings(meta.director, 2),
      country: typeof meta.country === "string" ? meta.country.slice(0, 80) : id.startsWith("kitsu:") ? "Japan" : undefined,
      runtime: minutesOf(meta.runtime),
    };
  } catch {
    return null;
  }
}

async function pages<T>(load: (cursor: string | null) => Promise<{ page: T[]; isDone: boolean; continueCursor: string }>) {
  const out: T[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page = await load(cursor);
    out.push(...page.page);
    if (page.isDone) return out;
    cursor = page.continueCursor;
  }
}

export const compute = internalAction({
  args: { profileId: v.id("profiles") },
  returns: v.null(),
  handler: async (ctx, { profileId }) => {
    const now = Date.now();
    const rest = await ctx.runQuery(internal.wrapped.rest, { profileId });
    const tracked = await pages((cursor) => ctx.runQuery(internal.wrapped.trackedPage, { profileId, cursor }));
    const progress = await pages((cursor) => ctx.runQuery(internal.wrapped.progressPage, { profileId, cursor }));
    const titles = assemble(tracked, progress, rest);
    const facts = await gatherFacts(ctx, titles);
    const stats = buildStats({
      now, timeZone: rest.timeZone, titles, facts,
      friend: rest.friend ? { ...rest.friend, scores: new Map(rest.friend.scores) } : undefined,
      kridaSince: progress.reduce<number | undefined>((a, p) => (a === undefined || p.startedAt < a ? p.startedAt : a), undefined),
    });
    await ctx.runMutation(internal.wrapped.save, { profileId, stats, revision: rest.revision });
    return null;
  },
});

type TrackedRow = {
  id: string; imdb?: string; type: "movie" | "series"; name: string; poster?: string; year?: string; status: Doc<"tracked">["status"];
  rating?: number; watchedEpisodes?: number; totalEpisodes?: number; watched?: string; watchedAt?: string; runtime?: number;
  lastWatchedAt?: number; addedAt?: number;
};
type ProgressRow = {
  imdbId: string; type: "movie" | "series"; name: string; poster?: string; year?: string; season?: number; episode?: number;
  position: number; duration: number; finished: boolean; hidden?: boolean; startedAt: number; updatedAt: number;
};
type Rest = {
  feedback: { id: string; type: "movie" | "series"; name: string; poster?: string; score: number | null }[];
  viewing: { id: string; type: "movie" | "series"; name: string; poster?: string; state: Doc<"viewing">["state"]; at: number }[];
  library: { id: string; type: "movie" | "series"; name: string; poster?: string; year?: string; addedAt: number }[];
  unwatched: [string, number][];
};

/** One list of titles from Simkl, Krida's own playback, statuses, scores and Plan to watch. Krida's own watching wins. */
export function assemble(tracked: TrackedRow[], progress: ProgressRow[], rest: Rest): StatTitle[] {
  // A title saved or played under both of its ids is one title, under the id Simkl tracks it by (lib/titleIds).
  const canonical = canonicalWith(aliasesOf(tracked));
  const unwatched = new Map<string, number>();
  for (const [id, at] of rest.unwatched) unwatched.set(canonical(id), Math.max(at, unwatched.get(canonical(id)) ?? 0));
  const scores = new Map<string, number | null>();
  for (const f of rest.feedback) if (f.id === canonical(f.id) || !scores.has(canonical(f.id))) scores.set(canonical(f.id), f.score);
  const scoreFor = (id: string, simkl?: number) => (scores.has(id) ? scores.get(id) ?? undefined : simkl);
  const titles = new Map<string, StatTitle>();
  // Kitsu entries number episodes flat, within one season; a play keeps the numbering of the id it was played under.
  const episodeKey = (played: string, season: number | undefined, episode: number | undefined) => {
    const id = canonical(played);
    return episode === undefined ? id : `${id}:${played.startsWith("kitsu:") ? 1 : season ?? 1}:${episode}`;
  };

  for (const t of tracked) {
    if (t.status === "plantowatch" || hiddenBy(unwatched, t.id, t.lastWatchedAt)) continue;
    const dated = expandWatchedAt(t.watchedAt).map((e): WatchEvent => ({ t: e.t, key: `${t.id}:${e.key}` }));
    const datedByKey = new Map(dated.map((e) => [e.key, e]));
    const keys = [...new Set([...expandEpisodes(t.watched).map((k) => `${t.id}:${k}`), ...datedByKey.keys()])];
    const seriesEvents: WatchEvent[] = keys.map((key) => datedByKey.get(key) ?? { key });
    for (let i = seriesEvents.length; i < (t.watchedEpisodes ?? 0); i++) seriesEvents.push({ key: `${t.id}:?${i}` });
    const events: WatchEvent[] = t.type === "movie"
      ? t.status === "completed" ? [{ t: t.lastWatchedAt, key: t.id }] : []
      : seriesEvents;
    titles.set(t.id, {
      id: t.id, type: t.type, name: t.name, poster: t.id.startsWith("tt") ? undefined : t.poster, year: t.year,
      anime: t.id.startsWith("kitsu:"), status: t.status, score: scoreFor(t.id, t.rating),
      watchedEpisodes: t.watchedEpisodes, totalEpisodes: t.totalEpisodes, runtime: t.runtime,
      lastWatchedAt: t.lastWatchedAt, addedAt: t.addedAt, events,
    });
  }

  // Krida playback: real times, real minutes watched. It replaces Simkl's record of the same episode.
  for (const p of progress) {
    if (p.hidden && !p.finished) continue;
    const id = canonical(p.imdbId);
    if (hiddenBy(unwatched, id, p.updatedAt) || p.position < 120) continue;
    const key = episodeKey(p.imdbId, p.season, p.episode);
    const event: WatchEvent = { t: p.startedAt, key, minutes: (p.finished ? p.duration : p.position) / 60, krida: true };
    const title = titles.get(id) ?? {
      id, type: p.type, name: p.name, poster: p.poster, year: p.year, anime: id.startsWith("kitsu:"),
      status: p.type === "movie" ? (p.finished ? "completed" : "watching") : "watching", score: scoreFor(id), events: [],
      lastWatchedAt: p.updatedAt,
    } satisfies StatTitle;
    // Without episode identities, preserve the imported count and use Krida to date one unknown entry.
    const unknown = p.type === "series" && !title.events.some((e) => e.key === key)
      ? title.events.find((e) => e.key.startsWith(`${id}:?`))?.key : undefined;
    title.events = [...title.events.filter((e) => e.key !== key && e.key !== unknown), event];
    if (p.type === "series") title.watchedEpisodes = Math.max(title.watchedEpisodes ?? 0,
      title.events.filter((e) => !e.krida || progress.some((r) => r.finished && episodeKey(r.imdbId, r.season, r.episode) === e.key)).length);
    if (p.type === "movie" && p.finished) title.status = "completed";
    title.lastWatchedAt = Math.max(title.lastWatchedAt ?? 0, p.updatedAt);
    titles.set(id, title);
  }

  // Statuses chosen in Krida, and scores for titles with no other history (a score means you saw it).
  // Oldest first, so the newest status of a title saved under both ids is the one that stays.
  for (const view of [...rest.viewing].sort((a, b) => a.at - b.at)) {
    const id = canonical(view.id);
    if (view.state === "plantowatch" || hiddenBy(unwatched, id, view.at)) continue;
    const status = view.state === "rewatching" ? "completed" : view.state;
    const title = titles.get(id);
    if (title) title.status = status;
    else titles.set(id, { id, type: view.type, name: view.name, poster: view.poster, anime: id.startsWith("kitsu:"),
      status, score: scoreFor(id), events: view.type === "movie" && status === "completed" ? [{ t: view.at, key: id }] : [], lastWatchedAt: view.at });
  }
  for (const f of rest.feedback) {
    const id = canonical(f.id);
    if (scores.get(id) === null || titles.has(id) || hiddenBy(unwatched, id, undefined)) continue;
    titles.set(id, { id, type: f.type, name: f.name, poster: f.poster, anime: id.startsWith("kitsu:"),
      status: f.type === "movie" ? "completed" : "watching", score: scores.get(id)!, events: f.type === "movie" ? [{ key: id }] : [] });
  }
  for (const l of rest.library) {
    const id = canonical(l.id);
    if (!titles.has(id))
      titles.set(id, { id, type: l.type, name: l.name, poster: l.poster, year: l.year, anime: id.startsWith("kitsu:"),
        status: "plantowatch", addedAt: l.addedAt, events: [] });
  }
  return [...titles.values()];
}

/** Known facts for every title watched enough, plus a capped batch of new lookups (scored and recent first). */
async function gatherFacts(ctx: ActionCtx, titles: StatTitle[]) {
  const wanted = titles.filter(watchedEnough)
    .sort((a, b) => (b.score !== undefined ? 1 : 0) - (a.score !== undefined ? 1 : 0) || (b.lastWatchedAt ?? 0) - (a.lastWatchedAt ?? 0));
  const facts = new Map<string, Facts>();
  const missing: StatTitle[] = [];
  for (let i = 0; i < wanted.length; i += 100) {
    const batch = wanted.slice(i, i + 100);
    const found = await ctx.runQuery(internal.wrapped.factsFor, { ids: batch.map((t) => t.id) });
    for (const [j, row] of found.entries()) {
      if (row.facts) {
        facts.set(row.id, row.facts);
        if (Date.now() - row.facts.fetchedAt > 90 * DAY) missing.push(batch[j]);
      } else {
        if (row.meta?.genres.length) facts.set(row.id, row.meta);
        missing.push(batch[j]);
      }
    }
  }
  const fetched = (await mapLimit(missing.slice(0, FACTS_PER_RUN), 8, (t) => fetchFacts(t.id, t.type)))
    .filter((f): f is NonNullable<typeof f> => f !== null);
  for (let i = 0; i < fetched.length; i += 100) await ctx.runMutation(internal.wrapped.putFacts, { rows: fetched.slice(i, i + 100) });
  for (const f of fetched) facts.set(f.id, f);
  return facts;
}
