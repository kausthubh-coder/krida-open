import { BATCH, mdbBatch, type Ratings } from "../shared/mdblist.js";
import { findByImdb, imdbIdFor, mapLimit, tmdb, tmdbImage, yearOf, type Found, type TmdbItem, type TmdbType } from "../shared/tmdb.js";
import { youtubeId } from "../shared/youtube.js";
import { cached, cachedMany, DAY } from "./cache.js";
import { NeedsKey, type ApiKeys } from "./http.js";

/*
 * What TMDB and MDBList know about titles, by IMDb id: TMDB's id and original language, every rating, and the
 * titles TMDB's audience also liked (the collaborative half of recommendations). Each answer is cached on its own,
 * so a title asked about by search, a row and the recommender is fetched once.
 */

type Kind = "movie" | "series";
export const tmdbTypeOf = (type: Kind): TmdbType => (type === "movie" ? "movie" : "tv");
export const kindOf = (t: TmdbType): Kind => (t === "movie" ? "movie" : "series");

// ---------------------------------------------------------------------------------------------
// Ids

/** IMDb ids for TMDB results (Krida plays by IMDb id), keyed "movie:123" / "tv:456". TMDB adds ids to new titles later, so a miss is asked again after a week. */
export async function imdbForTmdb(keys: ApiKeys, items: { tmdbId: number; tmdbType: TmdbType }[]) {
  const ids = items.map((i) => `${i.tmdbType}:${i.tmdbId}`);
  const found = await cachedMany<string | null>("imdb-of", ids, (id) => (id ? 180 * DAY : 7 * DAY), async (missing) => {
    const answers = await mapLimit(missing, 10, async (key) => {
      const [t, id] = key.split(":");
      // A failed request says nothing about the title; it's asked again next time.
      return await imdbIdFor(keys.tmdb, Number(id), t as TmdbType).then((imdb) => [key, imdb] as const, () => null);
    });
    return new Map(answers.filter((a) => a !== null));
  });
  const out = new Map<string, string>();
  for (const [key, imdb] of found) if (imdb) out.set(key, imdb);
  return out;
}

/** TMDB's id, original language and artwork for an IMDb id. */
export const found = (keys: ApiKeys, imdbId: string): Promise<Found | null> =>
  cached(`find:${imdbId}`, (f) => (f ? 90 * DAY : 7 * DAY), () => findByImdb(keys.tmdb, imdbId));

// ---------------------------------------------------------------------------------------------
// Ratings

export type Facts = { ratings: Ratings; certification?: string; trailer?: string };

/**
 * MDBList's ratings, certification and trailer for these titles, a batch of 200 (one request of the 1000 a day) at a
 * time and at most `maxBatches` of them; titles past that are left out until next time. Kept a week. Without an
 * MDBList key, only what's already kept: the caller's account asks MDBList for nothing.
 */
export async function factsFor(keys: ApiKeys, items: { id: string; type: Kind }[], maxBatches = 6) {
  const typeOf = new Map(items.filter((i) => i.id.startsWith("tt")).map((i) => [i.id, i.type]));
  const mdblist = keys.mdblist;
  return await cachedMany<Facts>("mdb", [...typeOf.keys()], 7 * DAY, async (missing) => {
    if (!mdblist) return new Map();
    const out = new Map<string, Facts>();
    let batches = 0;
    for (const type of ["movie", "series"] as const) {
      const ids = missing.filter((id) => typeOf.get(id) === type);
      for (let i = 0; i < ids.length && batches < maxBatches; i += BATCH, batches++) {
        const batch = ids.slice(i, i + BATCH);
        try {
          const byId = new Map((await mdbBatch(mdblist, type, batch)).map((t) => [t.imdbId, t]));
          // Titles MDBList doesn't know are remembered as having nothing, so they aren't asked about every time.
          for (const id of batch) {
            const t = byId.get(id);
            out.set(id, { ratings: t?.ratings ?? {}, certification: t?.certification, trailer: t?.trailer });
          }
        } catch (error) {
          console.warn("mdblist batch failed", error instanceof Error ? error.message : error);
          return out;
        }
      }
    }
    return out;
  });
}

/** Ratings, and the YouTube id of each title's trailer, for many titles. */
export async function ratingsFor(keys: ApiKeys, items: { id: string; type: Kind }[], maxBatches = 6) {
  const facts = await factsFor(keys, items, maxBatches);
  const ratings = new Map<string, Ratings>();
  const trailers = new Map<string, string>();
  for (const [id, f] of facts) {
    ratings.set(id, f.ratings);
    const trailer = f.trailer ? youtubeId(f.trailer) : null;
    if (trailer) trailers.set(id, trailer);
  }
  return { ratings, trailers };
}

/** The public scores a card shows, from MDBList's ratings. */
export function scoresFrom(r: Ratings | undefined) {
  if (!r) return undefined;
  const { imdb, tomatoes, metacritic, letterboxd, mal } = r;
  return imdb || tomatoes || metacritic || letterboxd || mal ? { imdb, tomatoes, metacritic, letterboxd, mal } : undefined;
}
export type Scores = ReturnType<typeof scoresFrom>;

/** A title page's ratings, certification and trailer link. */
export async function infoFor(keys: ApiKeys, id: string, type: Kind) {
  const f = (await factsFor(keys, [{ id, type }], 1)).get(id);
  if (!f && !keys.mdblist) throw new NeedsKey("mdblist", "Add your MDBList key in Settings → Connections to see ratings.");
  // Not answered for (MDBList down or out of requests): an error, so nobody is shown "no ratings" for a day.
  if (!f) throw new Error("MDBList didn't answer");
  return { ratings: f.ratings, certification: f.certification ?? null, trailer: f.trailer ?? null };
}

// ---------------------------------------------------------------------------------------------
// "Fans of this also liked"

export type SimilarEntry = { id: string; type: Kind; lang?: string; votes?: number; vote?: number };

/** TMDB's recommendations for a title, as IMDb ids, best first. Kept two weeks. */
export function similarTo(keys: ApiKeys, imdbId: string): Promise<SimilarEntry[] | null> {
  return cached(`similar:${imdbId}`, (list) => (list ? 14 * DAY : DAY), async () => {
    const f = await found(keys, imdbId);
    if (!f) return null;
    const body = await tmdb<{ results: TmdbItem[] }>(keys.tmdb, `/${f.tmdbType}/${f.tmdbId}/recommendations`);
    const results = body.results.filter((r) => (r.vote_count ?? 0) >= 20).slice(0, 20);
    const ids = await imdbForTmdb(keys, results.map((r) => ({ tmdbId: r.id, tmdbType: f.tmdbType })));
    return results.flatMap((r) => {
      const id = ids.get(`${f.tmdbType}:${r.id}`);
      return id ? [{ id, type: kindOf(f.tmdbType), lang: r.original_language || undefined, votes: r.vote_count, vote: r.vote_average }] : [];
    });
  });
}

/** `similarTo` for many titles; ones TMDB can't answer for are left out. */
export async function similarFor(keys: ApiKeys, seeds: { id: string }[]) {
  const ids = [...new Set(seeds.map((s) => s.id).filter((id) => id.startsWith("tt")))];
  const lists = await mapLimit(ids, 6, (id) => similarTo(keys, id).catch((error: unknown) => {
    console.warn("tmdb recommendations failed", id, error instanceof Error ? error.message : error);
    return null;
  }));
  const out = new Map<string, SimilarEntry[]>();
  ids.forEach((id, i) => lists[i] && out.set(id, lists[i]!));
  return out;
}

/** Original languages (anime counts as Japanese), asking TMDB about at most `limit` titles it hasn't been asked about. */
export async function langsFor(keys: ApiKeys, ids: string[], limit = 60) {
  const out = new Map<string, string>();
  for (const id of ids) if (id.startsWith("kitsu:")) out.set(id, "ja");
  const imdb = [...new Set(ids.filter((id) => id.startsWith("tt")))];
  const known = await cachedMany<Found | null>("find", imdb, (f) => (f ? 90 * DAY : 7 * DAY), async (missing) => {
    const answers = await mapLimit(missing.slice(0, limit), 8, (id) => findByImdb(keys.tmdb, id).then((f) => [id, f] as const, () => null));
    return new Map(answers.filter((a) => a !== null));
  });
  for (const [id, f] of known) if (f?.lang) out.set(id, f.lang);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Artwork

export type Art = { poster: string | null; background: string | null };
const NO_ART: Art = { poster: null, background: null };
const TMDB_ANIMATION = 16;

/** TMDB's title with exactly this name (and year, when known), when only one fits. */
async function findByName(keys: ApiKeys, name: string, year?: string, type?: Kind) {
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const types: TmdbType[] = type ? [tmdbTypeOf(type)] : ["movie", "tv"];
  for (const t of types) {
    const body = await tmdb<{ results: TmdbItem[] }>(keys.tmdb, `/search/${t}`, { query: name }).catch(() => null);
    const exact = (body?.results ?? []).filter((r) => r.poster_path && norm(r.title ?? r.name ?? "") === norm(name));
    const y = year?.slice(0, 4);
    const fits = y ? exact.filter((r) => Math.abs(Number(yearOf(r)) - Number(y)) <= 1) : exact;
    if (fits.length === 1 || (y && fits.length > 0))
      return { poster: tmdbImage(fits[0].poster_path, "w500"), background: tmdbImage(fits[0].backdrop_path, "w1280") };
  }
  return null;
}

/**
 * TMDB's artwork for an anime known only by its Kitsu entry (new ones have no IMDb id yet, so no Metahub art).
 * TMDB's search covers alternative titles, so Kitsu's romanized name finds it; it counts only when exactly one
 * animated title from that year comes back.
 */
async function findAnime(keys: ApiKeys, name: string, year: string | undefined, type?: Kind): Promise<Art | null> {
  const y = year?.slice(0, 4);
  if (!y) return null;
  const body = await tmdb<{ results: TmdbItem[] }>(keys.tmdb, `/search/${type === "movie" ? "movie" : "tv"}`, { query: name });
  const fits = body.results.filter((r) => r.genre_ids?.includes(TMDB_ANIMATION) && yearOf(r) === y && (r.backdrop_path || r.poster_path));
  if (fits.length !== 1) return null;
  return { poster: tmdbImage(fits[0].poster_path, "w500") ?? null, background: tmdbImage(fits[0].backdrop_path, "w1280") ?? null };
}

/**
 * A poster and backdrop from TMDB for a title whose usual artwork is missing (smaller regional films, new anime).
 * Kept a month; a miss without a name to search by is kept only a day, so a card that knows the name still asks.
 */
export function artworkFor(keys: ApiKeys, id: string, name?: string, year?: string, type?: Kind): Promise<Art> {
  return cached(`art:${id}:${name ?? ""}:${year ?? ""}`, (art) => (art.poster || art.background || name ? 30 * DAY : DAY), async () => {
    if (id.startsWith("kitsu:")) return (name && (await findAnime(keys, name, year, type))) || NO_ART;
    const f = (await found(keys, id)) ?? (name ? await findByName(keys, name, year, type) : null);
    return { poster: f?.poster ?? null, background: f?.background ?? null };
  });
}

type TmdbImage = { file_path: string; aspect_ratio: number; vote_average: number };

/**
 * TMDB's backdrop for an anime the page has matched exactly (ani.zip maps its AniList id to TMDB's). The best
 * voted one without text on it, as Hayase picks, since the title sits over it; else TMDB's default.
 */
export function animeBackdrop(keys: ApiKeys, tmdbId: string, type: Kind): Promise<string | null> {
  return cached(`anime-backdrop:${type}:${tmdbId}`, 30 * DAY, async () => {
    const body = await tmdb<{ backdrop_path?: string | null; images?: { backdrops?: TmdbImage[] } }>(
      keys.tmdb,
      `/${tmdbTypeOf(type)}/${tmdbId}`,
      { append_to_response: "images", include_image_language: "null" },
    );
    const [best] = (body.images?.backdrops ?? []).filter((b) => b.aspect_ratio > 1.2).sort((a, b) => b.vote_average - a.vote_average);
    return tmdbImage(best?.file_path ?? body.backdrop_path, "w1280") ?? null;
  });
}
