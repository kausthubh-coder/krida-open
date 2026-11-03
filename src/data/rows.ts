import { useMemo, useSyncExternalStore } from "react";
import type { Doc } from "../../convex/_generated/dataModel";
import { feedbackRowOf, listRowOf, progressRowOf, simklRowOf, viewingRowOf, type OwnRows } from "../../convex/lib/libraryViews";
import { scoreOf } from "../../convex/lib/ratings";
import { hiddenBy } from "../../convex/lib/unwatched";
import type { History } from "../../shared/taste";
import { useSyncStore, useTables, type Tables } from "./sync";

/*
 * What the Library's old queries answered, built from this profile's synced tables with the same rules: the Simkl
 * history, your own choices, your plays, Continue watching and Plan to watch. Pure functions of the tables, so optimistic
 * patches (mine.ts) work them out the same way.
 */

export type Played = { id: string; type: "movie" | "series"; finished: boolean };

export const simklRowsOf = (t: Pick<Tables, "tracked">) => t.tracked.map(simklRowOf);

export const unwatchedOf = (t: Pick<Tables, "unwatched">) => new Map(t.unwatched.map((u) => [u.id, u.at]));

/** Your own statuses, Plan to watch (newest first), scores and "I didn't watch this". */
export const ownRowsOf = (t: Pick<Tables, "viewing" | "library" | "feedback" | "unwatched">): OwnRows => ({
  viewing: t.viewing.map(viewingRowOf),
  list: [...t.library].sort((a, b) => b.addedAt - a.addedAt).map(listRowOf),
  feedback: t.feedback.map(feedbackRowOf),
  unwatched: [...unwatchedOf(t)],
});

/** The latest plays, newest first. */
const latestPlays = (t: Pick<Tables, "progress">, max = 400) => [...t.progress].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, max);

export const progressRowsOf = (t: Pick<Tables, "progress">) => latestPlays(t).map(progressRowOf);

/**
 * Titles played in Krida, for the shared status rule: the latest play of each, without positions. Hidden titles were
 * taken out of Continue watching.
 */
export function playedOf(t: Pick<Tables, "progress" | "unwatched">): Played[] {
  const unwatched = unwatchedOf(t);
  const latest = new Map<string, Played | null>();
  for (const r of latestPlays(t))
    if (!latest.has(r.media.imdbId))
      latest.set(r.media.imdbId, r.hidden || hiddenBy(unwatched, r.media.imdbId, r.updatedAt) ? null : { id: r.media.imdbId, type: r.media.type, finished: r.finished });
  return [...latest.values()].filter((r) => r !== null);
}

/** Where a show's next episode is counted from once its latest episode is finished (Settings → Home). */
export type NextUpFrom = "last" | "furthest";

/** The furthest episode of a show finished in Krida, specials aside. */
function furthestFinished(progress: Doc<"progress">[], imdbId: string) {
  let far: Doc<"progress"> | undefined;
  for (const p of progress) {
    const { season, episode } = p.media;
    if (p.media.imdbId !== imdbId || !p.finished || season === undefined || episode === undefined || season === 0) continue;
    if (!far || season > far.media.season! || (season === far.media.season && episode > far.media.episode!)) far = p;
  }
  return far;
}

/**
 * Continue watching: the latest play of each title still in progress, newest first. A show whose latest episode is
 * finished goes on from that episode, or with `furthest` from the furthest one finished (a rewatch of an early
 * episode doesn't send you back there). An episode you're partway through stays where you left it.
 */
export function continueOf(t: Pick<Tables, "progress" | "unwatched">, from: NextUpFrom = "last"): Doc<"progress">[] {
  const unwatched = unwatchedOf(t);
  const seen = new Set<string>();
  const out: Doc<"progress">[] = [];
  for (const r of latestPlays(t, 200)) {
    if (seen.has(r.media.imdbId)) continue;
    seen.add(r.media.imdbId);
    if (r.hidden || hiddenBy(unwatched, r.media.imdbId, r.updatedAt) || (r.finished && r.media.type === "movie")) continue;
    out.push((from === "furthest" && r.finished && furthestFinished(t.progress, r.media.imdbId)) || r);
    if (out.length >= 20) break;
  }
  return out;
}

// One hook per view, each rebuilt only when its own tables change.

export function useSimklRows() {
  const t = useTables();
  const tracked = t?.tracked;
  return useMemo(() => (tracked ? simklRowsOf({ tracked }) : undefined), [tracked]);
}

export function useOwnRows() {
  const t = useTables();
  const [viewing, library, feedback, unwatched] = [t?.viewing, t?.library, t?.feedback, t?.unwatched];
  return useMemo(() => (viewing && library && feedback && unwatched ? ownRowsOf({ viewing, library, feedback, unwatched }) : undefined),
    [viewing, library, feedback, unwatched]);
}

export function useProgressRows() {
  const progress = useTables()?.progress;
  return useMemo(() => (progress ? progressRowsOf({ progress }) : undefined), [progress]);
}

export function usePlayed() {
  const t = useTables();
  const [progress, unwatched] = [t?.progress, t?.unwatched];
  return useMemo(() => (progress && unwatched ? playedOf({ progress, unwatched }) : undefined), [progress, unwatched]);
}

export function useContinueWatching(from: NextUpFrom = "last") {
  const t = useTables();
  const [progress, unwatched] = [t?.progress, t?.unwatched];
  return useMemo(() => (progress && unwatched ? continueOf({ progress, unwatched }, from) : undefined), [progress, unwatched, from]);
}

/** Plan to watch, newest first. */
export function useMyList() {
  const library = useTables()?.library;
  return useMemo(() => (library ? [...library].sort((a, b) => b.addedAt - a.addedAt) : undefined), [library]);
}

/**
 * How far into a movie you are (its latest play), for its card's progress bar. A card redraws only when its own
 * bar changes, and every card reads one index of latest plays, built once per change to the progress table.
 */
export function useMovieProgress(id: string, type: "movie" | "series") {
  const store = useSyncStore();
  return useSyncExternalStore(store.subscribe, () => {
    const progress = type === "movie" ? store.tables()?.progress : undefined;
    return progress && movieShares(progress).get(id);
  });
}

const latestShares = new WeakMap<Tables["progress"], Map<string, number | undefined>>();
/** Each movie's share watched in its latest play (undefined once finished), by IMDb id. */
export function movieShares(progress: Tables["progress"]) {
  let shares = latestShares.get(progress);
  if (!shares) {
    const latest = new Map<string, Tables["progress"][number]>();
    for (const p of progress) {
      const seen = latest.get(p.media.imdbId);
      if (!seen || p.updatedAt > seen.updatedAt) latest.set(p.media.imdbId, p);
    }
    shares = new Map([...latest].map(([id, p]) => [id, p.finished ? undefined : p.position / Math.max(1, p.duration)]));
    latestShares.set(progress, shares);
  }
  return shares;
}

/** What the recommender learns from (shared/taste.ts), with "I didn't watch this" taken out. */
export function historyOf(t: Tables): History {
  const unwatched = unwatchedOf(t);
  const kept = (id: string, at: number | undefined) => !hiddenBy(unwatched, id, at);
  return {
    progress: latestPlays(t, 300).filter((p) => kept(p.media.imdbId, p.updatedAt)).map((p) => ({
      imdbId: p.media.imdbId, type: p.media.type, position: p.position, duration: p.duration, finished: p.finished, updatedAt: p.updatedAt,
    })),
    library: t.library.map((l) => ({ imdbId: l.imdbId, type: l.type, addedAt: l.addedAt })),
    tracked: t.tracked.filter((r) => kept(r.id, r.status === "plantowatch" ? Infinity : r.lastWatchedAt)).map((r) => ({
      id: r.id, imdb: r.imdb, name: r.name, type: r.type, status: r.status, rating: r.rating,
      watchedEpisodes: r.watchedEpisodes, totalEpisodes: r.totalEpisodes, lastWatchedAt: r.lastWatchedAt, addedAt: r.addedAt,
    })),
    feedback: t.feedback.map((f) => ({ id: f.id, type: f.type, score: scoreOf(f), at: f.at })),
    viewing: t.viewing.filter((r) => kept(r.id, r.state === "plantowatch" ? Infinity : r.at))
      .map((r) => ({ id: r.id, type: r.type, name: r.name, state: r.state, at: r.at })),
  };
}
