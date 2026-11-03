import { cached, DAY } from "./cache.js";
import { CINEMETA, KITSU } from "../shared/addons.js";

/** A title as catalogs and the recommender see it: display fields plus the features used to compare titles. */
export type CatalogItem = {
  id: string;
  type: "movie" | "series";
  name: string;
  poster?: string;
  background?: string;
  logo?: string;
  year?: string;
  description?: string;
  rating?: number;
  // Where `rating` comes from when it isn't IMDb (Cinemeta), so cards can label it.
  ratingSource?: "tmdb";
  popularity?: number;
  // Original language (ISO 639-1) and vote count, from TMDB when known: the recommender matches what people
  // actually watch (Telugu films, anime) and trusts well-voted titles more.
  lang?: string;
  votes?: number;
  genres: string[];
  cast: string[];
  director: string[];
  writer: string[];
};

/** A title as a row on Home shows it. */
export type RecItem = {
  id: string;
  type: "movie" | "series";
  name: string;
  poster?: string;
  background?: string;
  logo?: string;
  year?: string;
  description?: string;
  rating?: number;
  ratingSource?: "tmdb";
  scores?: { imdb?: number; tomatoes?: number; metacritic?: number; letterboxd?: number; mal?: number };
  genres: string[];
  reason?: string;
  // YouTube id of its trailer (MDBList's), so a poster on Home can start it without looking it up.
  trailer?: string;
};

export { CINEMETA, KITSU };

const list = (value: unknown, max: number): string[] =>
  Array.isArray(value) ? value.filter((x): x is string => typeof x === "string").slice(0, max) : [];

/** A Stremio meta (from any addon) reduced to what rows and the recommender need. */
export function normalize(meta: any): CatalogItem | null {
  if (!meta || typeof meta.id !== "string" || typeof meta.name !== "string") return null;
  const type = meta.type === "movie" || meta.animeType === "movie" ? "movie" : "series";
  const rating = Number.parseFloat(meta.imdbRating);
  const popularity = Number(meta.popularity);
  const description = typeof meta.description === "string" ? meta.description.slice(0, 280) : undefined;
  return {
    id: meta.id,
    type,
    name: meta.name,
    poster: typeof meta.poster === "string" ? meta.poster : undefined,
    background: typeof meta.background === "string" ? meta.background : undefined,
    logo: typeof meta.logo === "string" ? meta.logo : undefined,
    year: typeof meta.releaseInfo === "string" ? meta.releaseInfo : meta.year ? String(meta.year) : undefined,
    description,
    rating: Number.isFinite(rating) && rating > 0 ? rating : undefined,
    popularity: Number.isFinite(popularity) && popularity > 0 ? popularity : undefined,
    genres: list(meta.genres ?? meta.genre, 6),
    cast: list(meta.cast, 5),
    director: list(meta.director, 2),
    writer: list(meta.writer, 2),
  };
}

export async function fetchMetas(url: string) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
  const body = (await res.json()) as { metas?: unknown[] };
  return (body.metas ?? []).map(normalize).filter((x): x is CatalogItem => x !== null);
}

/** Genres, cast and crew for one title, from its addon (Kitsu for anime), kept a month. */
export function featuresFor(id: string, type: "movie" | "series"): Promise<CatalogItem | null> {
  return cached(`meta:${type}:${id}`, (item) => (item ? 30 * DAY : DAY), async () => {
    const base = id.startsWith("kitsu:") ? KITSU : CINEMETA;
    const res = await fetch(`${base}/meta/${type}/${encodeURIComponent(id)}.json`, { signal: AbortSignal.timeout(10_000) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${res.status} from ${new URL(base).host}`);
    return normalize(((await res.json()) as { meta?: unknown }).meta);
  });
}
