import { type ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { TraktAuthError, TraktRateError, TraktStoppedError, type session } from "./traktApi";

// ---------------------------------------------------------------------------------------------
// Trakt → Krida: plays into progress, the watchlist into Plan to watch, ratings into Your ratings.

type Kind = "movie" | "series";

/** A finished play (a movie, or one episode), as a progress row needs it. */
export type Play = { id: string; type: Kind; name: string; year?: string; season?: number; episode?: number; at: number };
/** Somewhere a movie or episode was paused in another app. */
export type Paused = Play & { position: number; duration: number };
export type Listed = { id: string; type: Kind; name: string; year?: string; addedAt?: number };
export type Rated = { id: string; type: Kind; name: string; rating: number; at: number };

const time = (value: unknown) => {
  const t = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(t) && t > 0 ? t : undefined;
};
const imdbOf = (title: any) => (typeof title?.ids?.imdb === "string" && /^tt\d+$/.test(title.ids.imdb) ? title.ids.imdb as string : undefined);
const titleOf = (title: any, type: Kind) => {
  const id = imdbOf(title);
  if (!id || typeof title?.title !== "string") return null;
  return { id, type, name: title.title as string, ...(title.year ? { year: String(title.year) } : {}) };
};
const whole = (n: unknown) => (typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : undefined);
// Changed at or after the last sync. Equal times are taken again: writing a play twice changes nothing.
const after = (at: number | undefined, since: number | undefined) => since === undefined || (at ?? 0) >= since;

/** /sync/watched/movies: one play per movie, at the last time it was watched. */
export function watchedMovies(rows: any[], since?: number): Play[] {
  const out: Play[] = [];
  for (const row of rows) {
    const movie = titleOf(row?.movie, "movie");
    const at = time(row?.last_watched_at);
    if (movie && at && after(time(row?.last_updated_at) ?? at, since)) out.push({ ...movie, at });
  }
  return out;
}

/** /sync/watched/shows: every watched episode, at the last time it was watched. */
export function watchedShows(rows: any[], since?: number): Play[] {
  const out: Play[] = [];
  for (const row of rows) {
    const show = titleOf(row?.show, "series");
    if (!show || !after(time(row?.last_updated_at) ?? time(row?.last_watched_at), since)) continue;
    for (const season of Array.isArray(row?.seasons) ? row.seasons : [])
      for (const episode of Array.isArray(season?.episodes) ? season.episodes : []) {
        const s = whole(season?.number);
        const e = whole(episode?.number);
        const at = time(episode?.last_watched_at) ?? time(row?.last_watched_at);
        if (s !== undefined && e && at) out.push({ ...show, season: s, episode: e, at });
      }
  }
  return out;
}

/** /sync/playback?extended=full: paused movies and episodes, with how far in (Trakt gives a percentage). */
export function playback(rows: any[]): Paused[] {
  const out: Paused[] = [];
  for (const row of rows) {
    const progress = typeof row?.progress === "number" ? row.progress : NaN;
    const at = time(row?.paused_at);
    if (!(progress > 0 && progress < 100) || !at) continue;
    if (row?.type === "movie") {
      const movie = titleOf(row.movie, "movie");
      const minutes = row.movie?.runtime;
      if (movie && typeof minutes === "number" && minutes > 0)
        out.push({ ...movie, at, duration: minutes * 60, position: (progress / 100) * minutes * 60 });
    } else if (row?.type === "episode") {
      const show = titleOf(row.show, "series");
      const s = whole(row.episode?.season);
      const e = whole(row.episode?.number);
      const minutes = row.episode?.runtime ?? row.show?.runtime;
      if (show && s !== undefined && e && typeof minutes === "number" && minutes > 0)
        out.push({ ...show, season: s, episode: e, at, duration: minutes * 60, position: (progress / 100) * minutes * 60 });
    }
  }
  return out;
}

/** /sync/watchlist/movies and /shows. */
export function watchlist(rows: any[]): Listed[] {
  const out: Listed[] = [];
  for (const row of rows) {
    const title = row?.type === "movie" ? titleOf(row.movie, "movie") : row?.type === "show" ? titleOf(row.show, "series") : null;
    if (title) out.push({ ...title, ...(time(row.listed_at) ? { addedAt: time(row.listed_at) } : {}) });
  }
  return out;
}

/** /sync/ratings/movies and /shows: whole-title scores, 1 to 10 like Krida's. */
export function ratings(rows: any[], since?: number): Rated[] {
  const out: Rated[] = [];
  for (const row of rows) {
    const title = row?.type === "movie" ? titleOf(row.movie, "movie") : row?.type === "show" ? titleOf(row.show, "series") : null;
    const rating = row?.rating;
    const at = time(row?.rated_at);
    if (title && at && Number.isInteger(rating) && rating >= 1 && rating <= 10 && after(at, since))
      out.push({ id: title.id, type: title.type, name: title.name, rating, at });
  }
  return out;
}

type All = ReturnType<typeof session>["all"];

/**
 * Bring in what moved on Trakt since the last sync (`prev`, the last /sync/last_activities; null the first time,
 * which brings in everything). Returns what came in, for Settings.
 */
export async function pull(ctx: ActionCtx, profileId: Id<"profiles">, all: All, activities: any, prev: any, expectedConnectedAt: number) {
  const moved = (block: string, key: string) => !prev || activities?.[block]?.[key] !== prev?.[block]?.[key];
  const since = (block: string, key: string) => (prev ? time(prev?.[block]?.[key]) : undefined);
  const counts = { plays: 0, planned: 0, rated: 0 };

  const plays: Play[] = [];
  if (moved("movies", "watched_at")) plays.push(...watchedMovies(await all("/sync/watched/movies"), since("movies", "watched_at")));
  if (moved("episodes", "watched_at")) plays.push(...watchedShows(await all("/sync/watched/shows"), since("episodes", "watched_at")));
  const paused = moved("movies", "paused_at") || moved("episodes", "paused_at")
    ? playback(await all("/sync/playback", { extended: "full" })) : [];
  for (let i = 0; i < Math.max(plays.length, paused.length); i += 200)
    await ctx.runMutation(internal.trakt.applyPlays, { profileId, expectedConnectedAt,
      plays: plays.slice(i, i + 200), paused: paused.slice(i, i + 200) });
  counts.plays = plays.length;

  if (moved("movies", "watchlisted_at") || moved("shows", "watchlisted_at")) {
    const listed = [...watchlist(await all("/sync/watchlist/movies")), ...watchlist(await all("/sync/watchlist/shows"))];
    for (let i = 0; i < listed.length; i += 200)
      await ctx.runMutation(internal.trakt.applyWatchlist, { profileId, expectedConnectedAt, items: listed.slice(i, i + 200) });
    // Titles that left the Trakt watchlist leave Plan to watch, if they came from there.
    await ctx.runMutation(internal.trakt.pruneWatchlist, { profileId, expectedConnectedAt, keep: listed.map((l) => l.id) });
    counts.planned = listed.length;
  }

  if (moved("movies", "rated_at") || moved("shows", "rated_at")) {
    const rated = [
      ...ratings(await all("/sync/ratings/movies"), since("movies", "rated_at")),
      ...ratings(await all("/sync/ratings/shows"), since("shows", "rated_at")),
    ];
    for (let i = 0; i < rated.length; i += 200)
      await ctx.runMutation(internal.trakt.applyRatings, { profileId, expectedConnectedAt, ratings: rated.slice(i, i + 200) });
    counts.rated = rated.length;
  }
  return counts;
}

/** Record why a run stopped, and when it may try again. */
export async function failed(ctx: ActionCtx, profileId: Id<"profiles">, error: unknown, expectedConnectedAt: number) {
  if (error instanceof TraktStoppedError) {
    await ctx.runMutation(internal.trakt.patchConnection, { profileId, expectedConnectedAt, patch: { done: true } });
    return;
  }
  console.warn("trakt", error instanceof Error ? error.message : error);
  const auth = error instanceof TraktAuthError;
  const rate = error instanceof TraktRateError;
  await ctx.runMutation(internal.trakt.patchConnection, {
    profileId,
    expectedConnectedAt,
    patch: {
      lastError: auth
        ? "Trakt signed Krida out. Connect again to keep your history in sync."
        : rate
          ? "Trakt asked Krida to slow down. It catches up in a few minutes."
          : "Couldn’t reach Trakt. Krida tries again next time you open it.",
      needsReconnect: auth ? true : undefined,
      backoffUntil: rate ? Date.now() + error.retryAfter : undefined,
      done: true,
    },
  });
}
