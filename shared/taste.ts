import { franchise } from "./franchise.js";

/*
 * A profile's taste, from what it watched and rated: the titles its recommendations grow from (seeds, strongest first),
 * what it has already seen or turned down, and the franchises it has watched. Built in the browser from the profile's
 * own data, so recommendations never read its history from the database; the server only fetches each seed's
 * features and scores candidates (server/recs.ts).
 */

type Kind = "movie" | "series";
type TrackedStatus = "watching" | "plantowatch" | "hold" | "completed" | "dropped";

export type History = {
  /** The latest plays, newest first. */
  progress: { imdbId: string; type: Kind; position: number; duration: number; finished: boolean; updatedAt: number }[];
  library: { imdbId: string; type: Kind; addedAt: number }[];
  tracked: {
    id: string; imdb?: string; name: string; type: Kind; status: TrackedStatus; rating?: number;
    watchedEpisodes?: number; totalEpisodes?: number; lastWatchedAt?: number; addedAt?: number;
  }[];
  /** Your scores, 1–10, or null where you cleared the imported one. */
  feedback: { id: string; type: Kind; score: number | null; at: number }[];
  viewing: { id: string; type: Kind; name: string; state: TrackedStatus | "rewatching"; at: number }[];
};

export type Seed = { id: string; type: Kind; weight: number; seen: boolean; loved: boolean; name?: string; imdb?: string };

export type Taste = {
  seeds: Seed[];
  /** Everything already watched, saved, rated or dropped (with anime's IMDb ids too): never a candidate. */
  exclude: string[];
  /** Titles turned down (dropped, or rated 4 or lower): candidates like them are pushed down. */
  disliked: { id: string; type: Kind }[];
  seenFranchises: string[];
};

const DAY = 24 * 60 * 60 * 1000;
const HALF_LIFE_DAYS = 30;
const IMPORTED_HALF_LIFE_DAYS = 365;
export const MAX_SEEDS = 30;
// A taste is stored and sent whole; these keep it well inside Convex's 8,192 values per array, whatever the library.
export const MAX_EXCLUDE = 6000;
export const MAX_FRANCHISES = 3000;
const MAX_NAME = 120;

export function tasteOf({ progress, library, tracked, feedback, viewing }: History, now: number): Taste {
  const decay = (t: number, halfLife: number) => Math.pow(0.5, (now - t) / DAY / halfLife);
  const weights = new Map<string, { type: Kind; weight: number; seen: boolean; loved: boolean }>();
  const put = (id: string, type: Kind, weight: number, seen: boolean, loved = false) => {
    const current = weights.get(id);
    // A show counts once, at the strength of its best signal.
    weights.set(id, {
      type,
      weight: Math.max(current?.weight ?? 0, weight),
      seen: seen || !!current?.seen,
      loved: loved || !!current?.loved,
    });
  };
  const exclude = new Set<string>();
  for (const p of progress.slice(0, 300)) {
    const engagement = p.finished ? 1 : Math.min(1, Math.max(0.25, (p.position / Math.max(1, p.duration)) * 1.5));
    put(p.imdbId, p.type, engagement * decay(p.updatedAt, HALF_LIFE_DAYS), true);
    exclude.add(p.imdbId);
  }
  for (const l of library) {
    put(l.imdbId, l.type, 0.5 * decay(l.addedAt, HALF_LIFE_DAYS), false);
    exclude.add(l.imdbId);
  }
  const aliases = new Map<string, string>();
  const names = new Map([...tracked, ...viewing].map((t) => [t.id, t.name]));
  // Scores (set here, or following a Simkl rating) speak for a title; the Simkl rating is the fallback.
  const scored = new Set(feedback.filter((f) => f.score !== null).map((f) => f.id));
  const cleared = new Set(feedback.filter((f) => f.score === null).map((f) => f.id));
  for (const row of viewing) {
    exclude.add(row.id);
    if (row.state !== "dropped" && !scored.has(row.id))
      put(row.id, row.type, (row.state === "hold" ? 0.25 : 0.5) * decay(row.at, IMPORTED_HALF_LIFE_DAYS), row.state !== "plantowatch");
  }
  for (const t of tracked) {
    exclude.add(t.id);
    if (t.imdb) {
      // The same show by its IMDb id (TMDB suggests it that way) counts as seen too.
      exclude.add(t.imdb);
      aliases.set(t.id, t.imdb);
    }
    if (scored.has(t.id)) continue;
    const rating = cleared.has(t.id) ? undefined : t.rating;
    // Dropped, or rated 4 or lower: never a seed.
    if (t.status === "dropped" || (rating !== undefined && rating <= 4)) continue;
    // Unrated: how you watched it is the signal. Finished counts; started long ago and never got
    // far reads as quietly abandoned.
    const abandoned =
      t.status === "watching" &&
      t.lastWatchedAt !== undefined && t.lastWatchedAt < now - 180 * DAY &&
      t.watchedEpisodes !== undefined && t.totalEpisodes !== undefined &&
      t.watchedEpisodes < 0.5 * t.totalEpisodes;
    const base =
      rating !== undefined
        ? Math.min(1, Math.max(0.2, (rating - 4) / 6))
        : abandoned
          ? 0.12
          : { completed: 0.5, watching: 0.55, hold: 0.25, plantowatch: 0.3 }[t.status];
    // Imported history ages slowly, so what you watch in Krida this month still leads.
    const when = t.lastWatchedAt ?? t.addedAt;
    const age = when ? Math.max(0.3, decay(when, IMPORTED_HALF_LIFE_DAYS)) : 0.4;
    put(t.id, t.type, 0.8 * base * age, t.status !== "plantowatch", (rating ?? 0) >= 9);
  }
  // Your own ratings in Krida are the strongest signal, and they fade only slowly.
  const disliked: { id: string; type: Kind }[] = [];
  for (const f of feedback) {
    if (f.score === null) continue;
    exclude.add(f.id);
    if (f.score <= 4) {
      disliked.push({ id: f.id, type: f.type });
      weights.delete(f.id);
      continue;
    }
    put(f.id, f.type, (0.25 + 0.85 * (f.score - 5) / 5) * Math.max(0.5, decay(f.at, 180)), true, f.score >= 9);
  }
  for (const t of tracked)
    if (!scored.has(t.id) && (t.status === "dropped" || (!cleared.has(t.id) && t.rating !== undefined && t.rating <= 4)))
      disliked.push({ id: t.id, type: t.type });
  for (const row of viewing) if (row.state === "dropped") {
    weights.delete(row.id);
    disliked.push({ id: row.id, type: row.type });
  }
  const seenFranchises = new Set(
    [...tracked.filter((t) => t.status !== "plantowatch"), ...viewing.filter((v) => v.state !== "plantowatch")].map((t) => franchise(t.name)),
  );
  const seeds = [...weights.entries()]
    .sort((a, b) => b[1].weight - a[1].weight)
    .slice(0, MAX_SEEDS)
    .map(([id, s]): Seed => ({ id, ...s, name: names.get(id)?.slice(0, MAX_NAME), imdb: aliases.get(id) }));
  return {
    seeds,
    // Plays, My list and statuses come first, then the Simkl history, so a capped list keeps Krida's own.
    exclude: [...exclude].slice(0, MAX_EXCLUDE),
    disliked: disliked.slice(0, 15),
    seenFranchises: [...seenFranchises].filter((f) => f.length <= MAX_NAME).slice(0, MAX_FRANCHISES),
  };
}

/**
 * A short digest of what a taste's rows depend on: which titles are seeds (and seen or loved), what's excluded and
 * what was turned down. Weights are left out: they move as a play saves its position and as time passes, and the
 * 6-hourly refresh catches that drift.
 */
export function tasteDigest(taste: Taste) {
  const text = JSON.stringify([taste.seeds.map((s) => [s.id, s.seen, s.loved]).sort(), [...taste.exclude].sort(), taste.disliked.map((d) => d.id).sort()]);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}
