/** TMDB: "people who liked this also liked", trending, and search that understands people and typos. */

const API = "https://api.themoviedb.org/3";

export type TmdbType = "movie" | "tv";

/** TMDB turned the key down (401): the account's key stopped working, which is not TMDB being down. */
export class TmdbKeyRefused extends Error {}

/** Asks TMDB with `key`, the TMDB key of the account whose session asked (server/session.ts). */
export async function tmdb<T>(key: string, path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
  const url = new URL(API + path);
  url.searchParams.set("api_key", key);
  for (const [k, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(k, String(value));
  const res = await fetch(url);
  if (res.status === 401) throw new TmdbKeyRefused(`TMDB refused the key for ${path}`);
  if (!res.ok) throw new Error(`TMDB answered ${res.status} for ${path}`);
  return (await res.json()) as T;
}

export const tmdbImage = (path: string | null | undefined, size: "w342" | "w500" | "w780" | "w1280" | "w185") =>
  path ? `https://image.tmdb.org/t/p/${size}${path}` : undefined;

/** TMDB genre ids in the names Cinemeta uses, so both sources compare. */
const GENRES: Record<number, string[]> = {
  28: ["Action"],
  12: ["Adventure"],
  16: ["Animation"],
  35: ["Comedy"],
  80: ["Crime"],
  99: ["Documentary"],
  18: ["Drama"],
  10751: ["Family"],
  14: ["Fantasy"],
  36: ["History"],
  27: ["Horror"],
  10402: ["Music"],
  9648: ["Mystery"],
  10749: ["Romance"],
  878: ["Sci-Fi"],
  53: ["Thriller"],
  10752: ["War"],
  37: ["Western"],
  10759: ["Action", "Adventure"],
  10762: ["Family"],
  10764: ["Reality-TV"],
  10765: ["Sci-Fi", "Fantasy"],
  10766: ["Drama"],
  10767: ["Talk-Show"],
  10768: ["War"],
};

export const genreNames = (ids: number[] | undefined) => [...new Set((ids ?? []).flatMap((id) => GENRES[id] ?? []))];

export type TmdbItem = {
  id: number;
  media_type?: "movie" | "tv" | "person";
  title?: string;
  name?: string;
  original_name?: string;
  overview?: string;
  original_language?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  profile_path?: string | null;
  release_date?: string;
  first_air_date?: string;
  vote_average?: number;
  vote_count?: number;
  popularity?: number;
  genre_ids?: number[];
  known_for_department?: string;
  known_for?: TmdbItem[];
  character?: string;
  job?: string;
  order?: number;
  episode_count?: number;
};

export const yearOf = (x: TmdbItem) => (x.release_date || x.first_air_date || "").slice(0, 4) || undefined;

export type Found = { tmdbId: number; tmdbType: TmdbType; lang?: string; poster?: string; background?: string };

/** The TMDB id for an IMDb id, with its original language and artwork. */
export async function findByImdb(key: string, imdbId: string): Promise<Found | null> {
  const body = await tmdb<{ movie_results: TmdbItem[]; tv_results: TmdbItem[] }>(key, `/find/${imdbId}`, {
    external_source: "imdb_id",
  });
  const hit = body.tv_results[0] ? { r: body.tv_results[0], t: "tv" as const } : body.movie_results[0] ? { r: body.movie_results[0], t: "movie" as const } : null;
  if (!hit) return null;
  return {
    tmdbId: hit.r.id,
    tmdbType: hit.t,
    lang: hit.r.original_language || undefined,
    poster: tmdbImage(hit.r.poster_path, "w500"),
    background: tmdbImage(hit.r.backdrop_path, "w1280"),
  };
}

export async function imdbIdFor(key: string, tmdbId: number, tmdbType: TmdbType): Promise<string | null> {
  const body = await tmdb<{ imdb_id?: string | null }>(key, `/${tmdbType}/${tmdbId}/external_ids`);
  return body.imdb_id && body.imdb_id.startsWith("tt") ? body.imdb_id : null;
}

/** Run `fn` over `items`, `limit` at a time. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}
