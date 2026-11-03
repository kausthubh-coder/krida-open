import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { titleIds } from "./titleIds";
import { hiddenBy } from "./unwatched";

// The browser imports this file too; runtime imports must stay browser-safe.

export type WatchStatus = Doc<"viewing">["state"];
export type TrackedStatus = Doc<"tracked">["status"];
/** The latest playback of a title in Krida, unless it was hidden from Continue watching. */
export type Played = { type: "movie" | "series"; finished: boolean };

/** Simkl has no Rewatching, and no Watching or On hold for movies: those stay in Krida. */
export function syncableStatus(type: "movie" | "series", id: string, state: WatchStatus): state is TrackedStatus {
  return state !== "rewatching" && !(type === "movie" && !id.startsWith("kitsu:") && (state === "watching" || state === "hold"));
}

/**
 * The Simkl list that stands for a Krida status. A rewatch shows there as Watched. A movie under way or
 * on hold stays where Simkl has it if that's Watched (a rewatch), else it waits in Plan to watch.
 */
export function simklListFor(type: "movie" | "series", id: string, state: WatchStatus, tracked?: TrackedStatus | null): TrackedStatus {
  if (syncableStatus(type, id, state)) return state;
  return state === "rewatching" || tracked === "completed" ? "completed" : "plantowatch";
}

/**
 * Where a profile stands with a title. One rule for every screen: an explicit choice in Krida, then
 * Simkl's On hold or Dropped, then playback in Krida, then the rest of Simkl, then Plan to watch. Plan to
 * watch only counts while the title is in Plan to watch.
 */
export function watchStatusOf({ local, tracked, saved, played }: {
  local?: WatchStatus | null; tracked?: TrackedStatus | null; saved?: boolean; played?: Played | null;
}): WatchStatus | null {
  if (local && (local !== "plantowatch" || saved)) return local;
  if (tracked === "hold" || tracked === "dropped") return tracked;
  // A finished last episode defers to Simkl's Watched: the rest may have been watched elsewhere.
  if (played && !(played.finished && tracked === "completed"))
    return played.type === "movie" && played.finished ? "completed" : "watching";
  if (tracked === "completed" || tracked === "watching") return tracked;
  return saved ? "plantowatch" : null;
}

/** The newest of a title's rows under each of its ids (rows from before both ids were known as one). */
const newest = <T>(rows: (T | null)[], at: (row: T) => number) =>
  rows.reduce<T | null>((best, row) => (row && (!best || at(row) > at(best)) ? row : best), null);

/** Everything that decides one title's status, read with indexes, under the title's ids (lib/titleIds). */
export async function titleStatus(ctx: QueryCtx, profileId: Id<"profiles">, id: string) {
  const ids = await titleIds(ctx, profileId, id);
  const [canonical] = ids;
  const each = <T>(read: (id: string) => Promise<T | null>) => Promise.all(ids.map(read));
  const [localRows, trackedRow, savedRows, latestRows, corrections] = await Promise.all([
    each((id) => ctx.db.query("viewing").withIndex("by_title", (q) => q.eq("profileId", profileId).eq("id", id)).first()),
    ctx.db.query("tracked").withIndex("by_profile_id", (q) => q.eq("profileId", profileId).eq("id", canonical)).first(),
    each((id) => ctx.db.query("library").withIndex("by_profile_imdb", (q) => q.eq("profileId", profileId).eq("imdbId", id)).first()),
    each((id) => ctx.db.query("progress").withIndex("by_profile_imdb", (q) => q.eq("profileId", profileId).eq("media.imdbId", id)).order("desc").first()),
    each((id) => ctx.db.query("unwatched").withIndex("by_title", (q) => q.eq("profileId", profileId).eq("id", id)).first()),
  ]);
  const correction = newest(corrections, (r) => r.at);
  const hidden = (at: number | undefined) => hiddenBy(new Map(correction ? [[canonical, correction.at]] : []), canonical, at);
  const localRow = newest(localRows, (r) => r.at);
  const latestRow = newest(latestRows, (r) => r.updatedAt);
  const saved = savedRows.find(Boolean) ?? null;
  const local = localRow && (localRow.state === "plantowatch" || !hidden(localRow.at)) ? localRow : null;
  const tracked = trackedRow && (trackedRow.status === "plantowatch" || !hidden(trackedRow.lastWatchedAt)) ? trackedRow : null;
  const latest = latestRow && !hidden(latestRow.updatedAt) ? latestRow : null;
  const played = latest && !latest.hidden ? { type: latest.media.type, finished: latest.finished } : null;
  return { ids, local, tracked, saved, latest, played,
    status: watchStatusOf({ local: local?.state, tracked: tracked?.status, saved: !!saved, played }) };
}
