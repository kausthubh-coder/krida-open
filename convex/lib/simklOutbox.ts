import { ConvexError } from "convex/values";
import { type ActionCtx, type MutationCtx, type QueryCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  SimklRateError,
  SimklRejectedError,
} from "./simkl";
import { syncableStatus, type TrackedStatus } from "./watchStatus";
import { titleIds } from "./titleIds";
import { isTitleId } from "../../shared/ids";
import { BATCH_WAIT, DAILY_BUDGET, DAY, connectionFor, session, today, usedToday } from "./simklApi";

// ---------------------------------------------------------------------------------------------
// Krida → Simkl: an outbox, sent in batches

type Op = Doc<"syncOutbox">["op"];

type OutItem = {
  id: string;
  type: "movie" | "series";
  name: string;
  year?: string;
  season?: number;
  episode?: number;
  rating?: number;
  status?: Doc<"tracked">["status"];
};

export const listKey = (id: string) => `list:${id}`;

export async function pending(ctx: QueryCtx, profileId: Id<"profiles">, key: string) {
  return await ctx.db
    .query("syncOutbox")
    .withIndex("by_key", (q) => q.eq("profileId", profileId).eq("key", key))
    .first();
}

/**
 * Where a title belongs on Simkl once it leaves the watchlist, or null when it was only ever planned.
 * /sync/history/remove deletes a title with every play, so anything watched, rated by season or
 * episode, or kept in another list moves back to that list instead.
 */
export async function statusOffWatchlist(ctx: QueryCtx, profileId: Id<"profiles">,
  item: { id: string; type: "movie" | "series" }): Promise<TrackedStatus | null> {
  // History under the title's other id counts too: Simkl removes the whole entry, whichever id asks.
  const ids = await titleIds(ctx, profileId, item.id);
  const [canonical] = ids;
  const tracked = await ctx.db.query("tracked").withIndex("by_profile_id", (q) => q.eq("profileId", profileId).eq("id", canonical)).first();
  if (tracked && tracked.status !== "plantowatch") return tracked.status;
  // An IMDb id several entries carry (one per season) asks Simkl about whichever it matches, so history on any of them counts.
  const seasons = tracked || !canonical.startsWith("tt") ? [] : await ctx.db.query("tracked")
    .withIndex("by_profile_imdb", (q) => q.eq("profileId", profileId).eq("imdb", canonical)).take(20);
  const latest = seasons.filter((s) => s.status !== "plantowatch").sort((a, b) => (b.lastWatchedAt ?? 0) - (a.lastWatchedAt ?? 0))[0];
  if (latest) return latest.status;
  const locals = await Promise.all(ids.map((id) =>
    ctx.db.query("viewing").withIndex("by_title", (q) => q.eq("profileId", profileId).eq("id", id)).first()));
  for (const l of locals) if (l && l.state !== "plantowatch" && syncableStatus(item.type, l.id, l.state)) return l.state;
  const anyOf = async (check: (id: string) => Promise<boolean>) => (await Promise.all(ids.map(check))).some(Boolean);
  const watched = [tracked, ...seasons].some((t) => !!t?.watched || t?.lastWatchedAt !== undefined || (t?.watchedEpisodes ?? 0) > 0) ||
    locals.some((l) => l?.state === "rewatching") ||
    // Plays waiting to be sent or in flight (";" sorts right after ":").
    await anyOf(async (id) => !!(await ctx.db.query("syncOutbox").withIndex("by_key", (q) =>
      q.eq("profileId", profileId).gte("key", `watched:${id}:`).lt("key", `watched:${id};`)).first())) ||
    await anyOf(async (id) => !!(await ctx.db.query("progress").withIndex("by_profile_imdb", (q) => q.eq("profileId", profileId).eq("media.imdbId", id))
      .filter((q) => q.eq(q.field("finished"), true)).first())) ||
    await anyOf(async (id) => !!(await ctx.db.query("partRatings").withIndex("by_title", (q) => q.eq("profileId", profileId).eq("id", id))
      .filter((q) => q.neq(q.field("rating"), null)).first()));
  if (!watched) return null;
  return item.type === "movie" || (tracked?.totalEpisodes && (tracked.watchedEpisodes ?? 0) >= tracked.totalEpisodes)
    ? "completed" : "watching";
}

/** Whether Krida has a change for this watchlist entry that Simkl hasn't heard about yet. */
export async function listChangePending(ctx: QueryCtx, profileId: Id<"profiles">, id: string) {
  return await pending(ctx, profileId, listKey(id)) ?? await pending(ctx, profileId, `status:${id}`);
}

/**
 * Queue a change for Simkl. Changes wait a little so a run of them (a binge, a few saves) goes as one
 * request; a save and an unsave of the same title before then cancel out.
 */
export async function enqueue(ctx: MutationCtx, profileId: Id<"profiles">, op: Op, item: OutItem) {
  // Only ids this adapter can resolve belong in Simkl's outbox.
  if (!isTitleId(item.id)) return;
  const c = await connectionFor(ctx, profileId);
  if (!c || !c.writeBack || !c.scope.includes("media:write")) return;
  // UI items can carry artwork. Only tracker fields belong in the outbox.
  item = {
    id: item.id, type: item.type, name: item.name,
    ...(item.year !== undefined ? { year: item.year } : {}),
    ...(item.season !== undefined ? { season: item.season } : {}),
    ...(item.episode !== undefined ? { episode: item.episode } : {}),
    ...(item.rating !== undefined ? { rating: item.rating } : {}),
    ...(item.status !== undefined ? { status: item.status } : {}),
  };
  // One episode unmarked shares its key with marking it, so the two cancel out before sending.
  const part = op === "unwatch" && item.episode !== undefined;
  const key =
    op === "watched" || part
      ? `watched:${item.id}:${item.season ?? ""}:${item.episode ?? ""}`
      : op === "status" ? `status:${item.id}` : op === "rate"
        ? `rate:${item.id}`
        : op === "unwatch" ? `unwatch:${item.id}` : listKey(item.id);
  // Watching it again, or saying you never did: whichever came last is what Simkl should hear.
  for (const key of part ? [] : op === "unwatch" ? [`status:${item.id}`] : op === "watched" || op === "status" ? [`unwatch:${item.id}`] : []) {
    const stale = await pending(ctx, profileId, key);
    if (stale && !stale.inFlight) await ctx.db.delete(stale._id);
  }
  if (op === "unwatch" && !part) {
    const watches = await ctx.db.query("syncOutbox").withIndex("by_key", (q) =>
      q.eq("profileId", profileId).gte("key", `watched:${item.id}:`).lt("key", `watched:${item.id};`)).take(500);
    for (const w of watches) if (!w.inFlight) await ctx.db.delete(w._id);
  }
  const existing = await pending(ctx, profileId, key);
  // A newer rating for the same title replaces the one waiting.
  if (existing && (op === "rate" || op === "status") && !existing.inFlight) {
    await ctx.db.patch(existing._id, { item, at: Date.now() });
    await book(ctx, profileId);
    return;
  }
  if (existing) {
    if (existing.op === op && op !== "rate" && op !== "status") return;
    // Saved then unsaved (or the reverse) before it was sent: nothing to tell Simkl.
    await ctx.db.delete(existing._id);
    if (!existing.inFlight) {
      await book(ctx, profileId);
      return;
    }
  }
  const now = Date.now();
  await ctx.db.insert("syncOutbox", { profileId, op, key, item, at: now, attempts: 0, nextAt: now + BATCH_WAIT });
  await book(ctx, profileId);
}

export async function cancelFlush(ctx: MutationCtx, c: Doc<"connections">) {
  if (c.flushJobId) {
    const job = await ctx.db.system.get(c.flushJobId);
    if (job?.state.kind === "pending") await ctx.scheduler.cancel(c.flushJobId);
  }
  if (c.flushAt || c.flushJobId) await ctx.db.patch(c._id, { flushAt: undefined, flushJobId: undefined });
}

export async function clearOutbox(ctx: MutationCtx, profileId: Id<"profiles">) {
  const rows = await ctx.db.query("syncOutbox").withIndex("by_profile", (q) => q.eq("profileId", profileId)).take(1000);
  if (rows.length === 1000) throw new ConvexError("Too many pending Simkl changes to reconnect safely. Sync them first.");
  for (const row of rows) await ctx.db.delete(row._id);
}

/**
 * Make sure a send run is booked for the earliest waiting change, and only one: a run already
 * booked in time is left alone.
 */
export async function book(ctx: MutationCtx, profileId: Id<"profiles">, minDelay = 5_000) {
  const c = await connectionFor(ctx, profileId);
  if (!c) return;
  if (!c.writeBack || !c.scope.includes("media:write") || c.needsReconnect) {
    await cancelFlush(ctx, c);
    return;
  }
  const next = await ctx.db
    .query("syncOutbox")
    .withIndex("by_profile", (q) => q.eq("profileId", profileId))
    .first();
  if (!next) {
    await cancelFlush(ctx, c);
    return;
  }
  const now = Date.now();
  const tomorrow = Date.parse(`${today()}T00:00:00Z`) + DAY;
  const notBefore = Math.max(c.backoffUntil ?? 0, usedToday(c) >= DAILY_BUDGET ? tomorrow : 0);
  const at = Math.max(next.nextAt + 1_000, now + minDelay, notBefore);
  if (c.flushAt && c.flushAt > now && c.flushAt <= at && c.flushAt >= notBefore) return;
  await cancelFlush(ctx, c);
  const flushJobId = await ctx.scheduler.runAt(at, internal.simkl.flush, { profileId });
  await ctx.db.patch(c._id, { flushAt: at, flushJobId });
}

const idsFor = (id: string) =>
  id.startsWith("kitsu:") ? { kitsu: Number(id.slice(6)) } : id.startsWith("tt") ? { imdb: id } : null;

const yearOf = (year?: string) => (year ? Number.parseInt(year, 10) || undefined : undefined);

// Anime go under shows[] (Simkl resolves them by Kitsu id); movies by IMDb id under movies[].
const bucket = (item: OutItem) => (item.type === "movie" && !item.id.startsWith("kitsu:") ? "movies" : "shows");

/** /sync/history: movies, and episodes grouped per show and season. Removals name episodes without times. */
function historyBody(ops: Doc<"syncOutbox">[], timed = true) {
  const movies: object[] = [];
  const shows = new Map<string, { title: string; year?: number; ids: object; seasons: Map<number, object[] | null>; flat: object[]; full: boolean }>();
  for (const { item, at } of ops) {
    const ids = idsFor(item.id);
    if (!ids) continue;
    const watched_at = timed ? new Date(at).toISOString() : undefined;
    if (bucket(item) === "movies") {
      movies.push({ title: item.name, year: yearOf(item.year), ids, watched_at });
      continue;
    }
    const show = shows.get(item.id) ?? { title: item.name, year: yearOf(item.year), ids, seasons: new Map<number, object[] | null>(), flat: [] as object[], full: false };
    shows.set(item.id, show);
    if (item.episode === undefined) {
      if (item.status === "completed" && item.season === undefined) show.full = true;
      else if (item.season !== undefined) show.seasons.set(item.season, null);
      continue;
    }
    // Kitsu numbers each entry's episodes from 1, which is how Simkl numbers anime too.
    if (item.id.startsWith("kitsu:")) show.flat.push({ number: item.episode, watched_at });
    else {
      if (show.seasons.get(item.season ?? 1) === null) continue;
      const list = show.seasons.get(item.season ?? 1) ?? [];
      list.push({ number: item.episode, watched_at });
      show.seasons.set(item.season ?? 1, list);
    }
  }
  return {
    movies,
    shows: [...shows.values()].map(({ seasons, flat, full, ...show }) => ({
      ...show,
      ...(full ? { status: "completed" } : {
        ...(flat.length ? { episodes: flat } : {}),
        ...(seasons.size ? { seasons: [...seasons.entries()].map(([number, episodes]) => ({ number, ...(episodes ? { episodes } : {}) })) } : {}),
      }),
    })),
  };
}

function listBody(ops: Doc<"syncOutbox">[], extra: object = {}) {
  const body: { movies: object[]; shows: object[] } = { movies: [], shows: [] };
  for (const { item } of ops) {
    const ids = idsFor(item.id);
    if (ids) body[bucket(item)].push({ title: item.name, year: yearOf(item.year), ids, ...extra });
  }
  return body;
}

function ratingsBody(ops: Doc<"syncOutbox">[]) {
  const body: { movies: object[]; shows: object[] } = { movies: [], shows: [] };
  for (const { item, at } of ops) {
    const ids = idsFor(item.id);
    if (ids)
      body[bucket(item)].push({ title: item.name, year: yearOf(item.year), ids, rating: item.rating, rated_at: new Date(at).toISOString() });
  }
  return body;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Send what's due, one request per kind of change. Simkl allows one write a second, so requests are
 * spaced out; a 429 stops the run and everything waits for Simkl's retry-after.
 */
export async function push(ctx: ActionCtx, profileId: Id<"profiles">, call: ReturnType<typeof session>["call"], expectedConnectedAt: number) {
  const ops: Doc<"syncOutbox">[] = await ctx.runMutation(internal.simkl.claimDue, { profileId, now: Date.now(), expectedConnectedAt });
  if (ops.length === 0) return;
  const groups: { ops: Doc<"syncOutbox">[]; path: string; body: object }[] = [];
  const of = (op: Op) => ops.filter((o) => o.op === op);
  if (of("watched").length) groups.push({ ops: of("watched"), path: "/sync/history", body: historyBody(of("watched")) });
  if (of("plan").length) groups.push({ ops: of("plan"), path: "/sync/add-to-list", body: listBody(of("plan"), { to: "plantowatch" }) });
  if (of("status").length) {
    const body: { movies: object[]; shows: object[] } = { movies: [], shows: [] };
    for (const { item } of of("status")) {
      const ids = idsFor(item.id);
      if (ids) body[bucket(item)].push({ title: item.name, year: yearOf(item.year), ids, to: item.status });
    }
    groups.push({ ops: of("status"), path: "/sync/add-to-list", body });
  }
  // Only titles that were on the watchlist and never watched get here, so nothing watched is lost.
  if (of("unplan").length) groups.push({ ops: of("unplan"), path: "/sync/history/remove", body: listBody(of("unplan")) });
  // "I didn't watch this": the whole title leaves Simkl's history.
  const titles = of("unwatch").filter((o) => o.item.episode === undefined);
  if (titles.length) groups.push({ ops: titles, path: "/sync/history/remove", body: listBody(titles) });
  // Episodes unmarked in the episode list: just those plays.
  const parts = of("unwatch").filter((o) => o.item.episode !== undefined);
  if (parts.length) groups.push({ ops: parts, path: "/sync/history/remove", body: historyBody(parts, false) });
  const rated = of("rate").filter((o) => (o.item.rating ?? 0) > 0);
  const cleared = of("rate").filter((o) => !o.item.rating);
  if (rated.length) groups.push({ ops: rated, path: "/sync/ratings", body: ratingsBody(rated) });
  if (cleared.length) groups.push({ ops: cleared, path: "/sync/ratings/remove", body: listBody(cleared) });
  for (const [i, group] of groups.entries()) {
    if (i > 0) await pause(1_200);
    const ids = group.ops.map((o) => o._id);
    try {
      const response = await call<{ not_found?: Record<string, unknown[]> }>(group.path, { method: "POST", body: group.body });
      const notFound = Object.values(response?.not_found ?? {}).flat();
      const rejected = group.ops.filter(({ item }) => notFound.some((entry) => {
        const row = entry as { ids?: { imdb?: string; kitsu?: number }; title?: string };
        // By id when Simkl echoes one: two entries can share a name (an anime's IMDb and Kitsu ids, remakes).
        if (row.ids?.imdb !== undefined || row.ids?.kitsu !== undefined)
          return row.ids.imdb === item.id || (row.ids.kitsu !== undefined && `kitsu:${row.ids.kitsu}` === item.id);
        return row.title === item.name;
      })).map((op) => op._id);
      await ctx.runMutation(internal.simkl.settle, { profileId, sent: ids, retry: [], rejected });
    } catch (error) {
      if (error instanceof SimklRejectedError) {
        // Simkl won't take these as they are; retrying the same request can't help.
        await ctx.runMutation(internal.simkl.settle, { profileId, sent: ids, retry: [], rejected: ids });
        continue;
      }
      const rest = groups.slice(i).flatMap((g) => g.ops.map((o) => o._id));
      await ctx.runMutation(internal.simkl.settle, {
        profileId,
        sent: [],
        retry: rest,
        notBefore: error instanceof SimklRateError ? Date.now() + error.retryAfter : undefined,
      });
      throw error;
    }
  }
}
