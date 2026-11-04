import { ConvexError } from "convex/values";
import { type ActionCtx, type MutationCtx, type QueryCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { titleIds } from "./titleIds";
import { BATCH_WAIT, TraktRateError, TraktRejectedError, WRITE_GAP, session, traktConnectionFor } from "./traktApi";
import type { WatchStatus } from "./watchStatus";

// ---------------------------------------------------------------------------------------------
// Krida → Trakt: an outbox, sent in batches. The only place that builds a Trakt write, removals included
// (scripts/check-boundaries.ts).

export type TraktOp = Doc<"traktOutbox">["op"];

type OutItem = {
  id: string;
  type: "movie" | "series";
  name: string;
  year?: string;
  season?: number;
  episode?: number;
  rating?: number;
  status?: string;
};

async function pending(ctx: QueryCtx, profileId: Id<"profiles">, key: string) {
  return await ctx.db.query("traktOutbox").withIndex("by_key", (q) => q.eq("profileId", profileId).eq("key", key)).first();
}

/** Plays of one title waiting to go (";" sorts right after ":"). */
const playsOf = (ctx: QueryCtx, profileId: Id<"profiles">, id: string) =>
  ctx.db.query("traktOutbox").withIndex("by_key", (q) => q.eq("profileId", profileId).gte("key", `watched:${id}:`).lt("key", `watched:${id};`)).take(500);

/** Whether Krida has a watchlist change for this title that Trakt hasn't heard about yet. */
export async function traktListPending(ctx: QueryCtx, profileId: Id<"profiles">, id: string) {
  return !!(await pending(ctx, profileId, `list:${id}`));
}

/** Whether a rating for this title is waiting to go to Trakt. */
export async function traktRatePending(ctx: QueryCtx, profileId: Id<"profiles">, id: string) {
  return !!(await pending(ctx, profileId, `rate:${id}`));
}

/**
 * Queue a change for Trakt, if this profile connected it with write-back on. Changes wait a little so a run of them
 * (a binge, a few saves) goes as one request; opposite changes before then cancel out.
 *
 * Trakt knows titles by IMDb id. A Kitsu entry has none of its own, so callers pass the IMDb episode an anime's
 * Kitsu episode stands for (`media.ref`) where they have it, and anything else under a Kitsu id stays in Krida.
 */
export async function enqueueTrakt(ctx: MutationCtx, profileId: Id<"profiles">, op: TraktOp, item: OutItem) {
  if (!item.id.startsWith("tt")) return;
  const c = await traktConnectionFor(ctx, profileId);
  if (!c || !c.writeBack) return;
  // Callers pass display items; only what Trakt needs goes in the outbox.
  const out = {
    id: item.id, type: item.type, name: item.name,
    ...(item.year !== undefined ? { year: item.year } : {}),
    ...(item.season !== undefined ? { season: item.season } : {}),
    ...(item.episode !== undefined ? { episode: item.episode } : {}),
    ...(op === "rate" ? { rating: item.rating ?? 0 } : {}),
  };
  // A play and taking that play back share a key, so the two cancel out before sending.
  const key = op === "watched" || (op === "unwatch" && item.episode !== undefined)
    ? `watched:${item.id}:${item.season ?? ""}:${item.episode ?? ""}`
    : op === "rate" ? `rate:${item.id}` : op === "unwatch" ? `unwatch:${item.id}` : `list:${item.id}`;
  // "I didn't watch this" takes back plays still waiting; watching it again takes back the "didn't".
  if (op === "unwatch" && item.episode === undefined)
    for (const w of await playsOf(ctx, profileId, item.id)) if (!w.inFlight) await ctx.db.delete(w._id);
  if (op === "watched") {
    const stale = await pending(ctx, profileId, `unwatch:${item.id}`);
    if (stale && !stale.inFlight) await ctx.db.delete(stale._id);
  }
  const existing = await pending(ctx, profileId, key);
  // A newer rating for the same title replaces the one waiting.
  if (existing && op === "rate" && !existing.inFlight) {
    await ctx.db.patch(existing._id, { item: out, at: Date.now() });
    await book(ctx, profileId);
    return;
  }
  if (existing) {
    if (existing.op === op && op !== "rate") return;
    // Saved then unsaved (or marked then unmarked) before it was sent: nothing to tell Trakt.
    await ctx.db.delete(existing._id);
    if (!existing.inFlight) {
      await book(ctx, profileId);
      return;
    }
  }
  const now = Date.now();
  await ctx.db.insert("traktOutbox", { profileId, op, key, item: out, at: now, attempts: 0, nextAt: now + BATCH_WAIT });
  await book(ctx, profileId);
}

/** A play in Krida as Trakt knows it: an anime's Kitsu episode goes as the IMDb episode it stands for. */
export function traktMedia(media: Pick<Doc<"progress">["media"], "type" | "imdbId" | "name" | "year" | "season" | "episode" | "ref">): OutItem {
  const { type, name, year } = media;
  if (media.imdbId.startsWith("tt") || !media.ref) return { id: media.imdbId, type, name, year, season: media.season, episode: media.episode };
  return { id: media.ref.imdbId, type, name, year, season: media.ref.season, episode: media.ref.episode };
}

// A thumb as a Trakt score.
const THUMB_RATING = { love: 9, up: 7, down: 3 } as const;

/** A thumb set (or cleared) in Krida goes to Trakt as a score. */
export async function rateThumbOnTrakt(ctx: MutationCtx, profileId: Id<"profiles">,
  item: { id: string; type: "movie" | "series"; name: string }, value: keyof typeof THUMB_RATING | null) {
  await enqueueTrakt(ctx, profileId, "rate", { ...item, rating: value === null ? 0 : THUMB_RATING[value] });
}

/**
 * A watch status chosen in Krida, as Trakt has it: Plan to watch is the watchlist, Watched marks the title watched
 * (a show, every episode), and leaving Plan to watch takes it off the watchlist. Trakt has no Watching, On hold or
 * Dropped, so those only leave the watchlist. Called before Krida changes Plan to watch.
 */
export async function traktStatus(ctx: MutationCtx, profileId: Id<"profiles">,
  item: { id: string; type: "movie" | "series"; name: string; year?: string }, state: WatchStatus, leavesList: boolean) {
  const out = { id: item.id, type: item.type, name: item.name, year: item.year };
  if (state === "plantowatch") await enqueueTrakt(ctx, profileId, "plan", out);
  else {
    if (state === "completed") await enqueueTrakt(ctx, profileId, "watched", { ...out, status: "completed" });
    if (leavesList) await enqueueTrakt(ctx, profileId, "unplan", out);
  }
}

/** Whether this title is in Plan to watch under any of its ids. */
export async function inPlanToWatch(ctx: QueryCtx, profileId: Id<"profiles">, id: string) {
  for (const each of await titleIds(ctx, profileId, id))
    if (await ctx.db.query("library").withIndex("by_profile_imdb", (q) => q.eq("profileId", profileId).eq("imdbId", each)).first()) return true;
  return false;
}

/** Undo for "I didn't watch this": a removal not sent yet is dropped. */
export async function takeBackTraktUnwatch(ctx: MutationCtx, profileId: Id<"profiles">, id: string) {
  const op = await pending(ctx, profileId, `unwatch:${id}`);
  if (op && !op.inFlight) await ctx.db.delete(op._id);
}

export async function cancelTraktFlush(ctx: MutationCtx, c: Doc<"traktConnections">) {
  if (c.flushJobId) {
    const job = await ctx.db.system.get(c.flushJobId);
    if (job?.state.kind === "pending") await ctx.scheduler.cancel(c.flushJobId);
  }
  if (c.flushAt || c.flushJobId) await ctx.db.patch(c._id, { flushAt: undefined, flushJobId: undefined });
}

export async function clearTraktOutbox(ctx: MutationCtx, profileId: Id<"profiles">) {
  const rows = await ctx.db.query("traktOutbox").withIndex("by_profile", (q) => q.eq("profileId", profileId)).take(1000);
  if (rows.length === 1000) throw new ConvexError("Too many pending Trakt changes to reconnect safely. Sync them first.");
  for (const row of rows) await ctx.db.delete(row._id);
}

/** Make sure one send run is booked for the earliest waiting change: a run already booked in time is left alone. */
export async function book(ctx: MutationCtx, profileId: Id<"profiles">, minDelay = 5_000) {
  const c = await traktConnectionFor(ctx, profileId);
  if (!c) return;
  if (!c.writeBack || c.needsReconnect) {
    await cancelTraktFlush(ctx, c);
    return;
  }
  const next = await ctx.db.query("traktOutbox").withIndex("by_profile", (q) => q.eq("profileId", profileId)).first();
  if (!next) {
    await cancelTraktFlush(ctx, c);
    return;
  }
  const now = Date.now();
  const notBefore = c.backoffUntil ?? 0;
  const at = Math.max(next.nextAt + 1_000, now + minDelay, notBefore);
  if (c.flushAt && c.flushAt > now && c.flushAt <= at && c.flushAt >= notBefore) return;
  await cancelTraktFlush(ctx, c);
  const flushJobId = await ctx.scheduler.runAt(at, internal.trakt.flush, { profileId });
  await ctx.db.patch(c._id, { flushAt: at, flushJobId });
}

const yearOf = (year?: string) => (year ? Number.parseInt(year, 10) || undefined : undefined);

type Row = Doc<"traktOutbox">;

/** Movies and shows (with seasons and episodes) as Trakt's /sync bodies take them. */
function body(ops: Row[], extra: (op: Row) => object = () => ({})) {
  const movies: object[] = [];
  const shows = new Map<string, { title: string; year?: number; ids: object; whole: boolean; seasons: Map<number, object[]>; extra: object }>();
  for (const op of ops) {
    const { item } = op;
    const ids = { imdb: item.id };
    if (item.type === "movie") {
      movies.push({ title: item.name, year: yearOf(item.year), ids, ...extra(op) });
      continue;
    }
    const show = shows.get(item.id) ?? { title: item.name, year: yearOf(item.year), ids, whole: false, seasons: new Map(), extra: {} };
    shows.set(item.id, show);
    if (item.episode === undefined) {
      // The whole show (or a whole season), as one entry Trakt expands.
      if (item.season === undefined) {
        show.whole = true;
        show.extra = extra(op);
      } else show.seasons.set(item.season, show.seasons.get(item.season) ?? []);
      continue;
    }
    const list = show.seasons.get(item.season ?? 1) ?? [];
    list.push({ number: item.episode, ...extra(op) });
    show.seasons.set(item.season ?? 1, list);
  }
  return {
    movies,
    shows: [...shows.values()].map(({ seasons, whole, extra, ...show }) => ({
      ...show,
      ...(whole ? extra : { seasons: [...seasons.entries()].map(([number, episodes]) => ({ number, ...(episodes.length ? { episodes } : {}) })) }),
    })),
  };
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Whether Trakt listed this change in its not_found. */
function notFound(op: Row, missing: any) {
  const imdbOf = (row: any) => row?.ids?.imdb;
  const shows = Array.isArray(missing?.shows) ? missing.shows : [];
  const movies = Array.isArray(missing?.movies) ? missing.movies : [];
  return (op.item.type === "movie" ? movies : shows).some((row: any) => imdbOf(row) === op.item.id);
}

/**
 * Send what's due, one request per kind of change, a second apart. A 429 stops the run and everything waits for
 * Trakt's Retry-After; a change Trakt rejects or can't find is dropped; anything else is retried with backoff.
 */
export async function push(ctx: ActionCtx, profileId: Id<"profiles">, call: ReturnType<typeof session>["call"], expectedConnectedAt: number) {
  const ops: Row[] = await ctx.runMutation(internal.trakt.claimDue, { profileId, now: Date.now(), expectedConnectedAt });
  if (ops.length === 0) return;
  const of = (op: TraktOp) => ops.filter((o) => o.op === op);
  const watchedAt = (o: Row) => ({ watched_at: new Date(o.at).toISOString() });
  const groups: { ops: Row[]; path: string; body: object }[] = [];
  if (of("watched").length) groups.push({ ops: of("watched"), path: "/sync/history", body: body(of("watched"), watchedAt) });
  // "I didn't watch this", or episodes unmarked in the episode list: those plays leave Trakt's history.
  if (of("unwatch").length) groups.push({ ops: of("unwatch"), path: "/sync/history/remove", body: body(of("unwatch")) });
  if (of("plan").length) groups.push({ ops: of("plan"), path: "/sync/watchlist", body: body(of("plan")) });
  if (of("unplan").length) groups.push({ ops: of("unplan"), path: "/sync/watchlist/remove", body: body(of("unplan")) });
  const rated = of("rate").filter((o) => (o.item.rating ?? 0) > 0);
  const cleared = of("rate").filter((o) => !o.item.rating);
  if (rated.length) groups.push({ ops: rated, path: "/sync/ratings",
    body: body(rated, (o) => ({ rating: o.item.rating, rated_at: new Date(o.at).toISOString() })) });
  if (cleared.length) groups.push({ ops: cleared, path: "/sync/ratings/remove", body: body(cleared) });
  for (const [i, group] of groups.entries()) {
    if (i > 0) await pause(WRITE_GAP);
    const ids = group.ops.map((o) => o._id);
    try {
      const { body: answer } = await call<{ not_found?: unknown }>(group.path, { method: "POST", body: group.body });
      const rejected = group.ops.filter((op) => notFound(op, answer?.not_found)).map((op) => op._id);
      await ctx.runMutation(internal.trakt.settle, { profileId, sent: ids, retry: [], rejected });
    } catch (error) {
      if (error instanceof TraktRejectedError) {
        await ctx.runMutation(internal.trakt.settle, { profileId, sent: ids, retry: [], rejected: ids });
        continue;
      }
      const rest = groups.slice(i).flatMap((g) => g.ops.map((o) => o._id));
      await ctx.runMutation(internal.trakt.settle, {
        profileId, sent: [], retry: rest,
        notBefore: error instanceof TraktRateError ? Date.now() + error.retryAfter : undefined,
      });
      throw error;
    }
  }
}
