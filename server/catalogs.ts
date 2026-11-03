import { genreNames, mapLimit, tmdb, tmdbImage, yearOf, type TmdbItem, type TmdbType } from "../shared/tmdb.js";
import { cached, DAY, HOUR, inMemory, keep, peek } from "./cache.js";
import type { ApiKeys } from "./http.js";
import { CINEMETA, fetchMetas, type CatalogItem, type RecItem } from "./meta.js";
import { found, imdbForTmdb, ratingsFor, scoresFrom } from "./titles.js";

/*
 * Krida's built-in rows: Netflix's Top 10, TMDB's trending titles, and Cinemeta's popular and top-rated genre rows.
 * Each row is fetched at most every 6 hours and kept a week, so a row whose source is down keeps showing its last
 * answer. Rows hold every title's features too: they are the recommender's candidates, with the profile's own catalogs.
 */

type Kind = "movie" | "series";
const FRESH_MS = 6 * HOUR * 1000;

/** Genres offered as rows. The recommender picks which ones each person sees. */
export const GENRES = [
  "Action", "Adventure", "Animation", "Comedy", "Crime", "Documentary", "Drama", "Family", "Fantasy", "Horror", "Mystery",
  "Romance", "Sci-Fi", "Thriller",
];

export type Row = { key: string; title: string; type: Kind; source: string; items: CatalogItem[]; fetchedAt: number };
type Entry = { key: string; title: string; type: Kind; source: string; load: () => Promise<CatalogItem[]> };

/** TMDB results in Krida's terms (IMDb ids, Cinemeta genre names); ones without an IMDb id are dropped. */
export async function fromTmdb(keys: ApiKeys, results: { r: TmdbItem; t: TmdbType }[]): Promise<CatalogItem[]> {
  const ids = await imdbForTmdb(keys, results.map(({ r, t }) => ({ tmdbId: r.id, tmdbType: t })));
  const out: CatalogItem[] = [];
  for (const { r, t } of results) {
    const id = ids.get(`${t}:${r.id}`);
    if (!id || !r.poster_path || out.some((o) => o.id === id)) continue;
    out.push({
      id,
      type: t === "movie" ? "movie" : "series",
      name: r.title ?? r.name ?? "Untitled",
      poster: tmdbImage(r.poster_path, "w500"),
      background: tmdbImage(r.backdrop_path, "w1280"),
      year: yearOf(r),
      description: r.overview ? r.overview.slice(0, 280) : undefined,
      rating: r.vote_average && (r.vote_count ?? 0) >= 20 ? Math.round(r.vote_average * 10) / 10 : undefined,
      ratingSource: "tmdb",
      popularity: r.popularity,
      lang: r.original_language || undefined,
      votes: r.vote_count,
      genres: genreNames(r.genre_ids),
      cast: [],
      director: [],
      writer: [],
    });
  }
  return out;
}

/** Netflix's own weekly global Top 10 (English and non-English lists merged by views), matched to IMDb through TMDB search. */
async function netflixWeekly(keys: ApiKeys, type: Kind): Promise<CatalogItem[]> {
  const res = await fetch("https://www.netflix.com/tudum/top10/data/all-weeks-global.tsv");
  if (!res.ok) throw new Error(`${res.status} from netflix.com`);
  const [header, ...lines] = (await res.text()).split(/\r?\n/).map((l) => l.split("\t"));
  const col = (name: string) => header.indexOf(name);
  const [week, category, title, views] = [col("week"), col("category"), col("show_title"), col("weekly_views")];
  const kind = type === "movie" ? "Films" : "TV";
  const rows = lines.filter((l) => l[category]?.startsWith(kind));
  const latest = rows.reduce((max, l) => (l[week] > max ? l[week] : max), "");
  const names = [...new Set(rows.filter((l) => l[week] === latest).sort((a, b) => Number(b[views]) - Number(a[views])).map((l) => l[title]))];
  const t: TmdbType = type === "movie" ? "movie" : "tv";
  const hits = await mapLimit(names.slice(0, 20), 5, async (query) => {
    const body = await tmdb<{ results: TmdbItem[] }>(keys.tmdb, `/search/${t}`, { query }).catch(() => ({ results: [] as TmdbItem[] }));
    return body.results[0];
  });
  return await fromTmdb(keys, hits.filter((r): r is TmdbItem => !!r).map((r) => ({ r, t })));
}

/** TMDB's trending titles this week. */
async function tmdbTrending(keys: ApiKeys, type: Kind): Promise<CatalogItem[]> {
  const t: TmdbType = type === "movie" ? "movie" : "tv";
  const pages = await Promise.all([1, 2].map((page) => tmdb<{ results: TmdbItem[] }>(keys.tmdb, `/trending/${t}/week`, { page })));
  return await fromTmdb(keys, pages.flatMap((p) => p.results.map((r) => ({ r, t }))));
}

/**
 * Krida's own rows: Netflix's Top 10 and TMDB's trending titles (shown on Home beside a profile's addon catalogs), and
 * Cinemeta's popular and top-rated genre rows (Home shows the genres a profile watches most; all of them are the
 * recommender's candidates). A profile's addon catalogs are fetched by its browser, not here.
 */
async function entries(keys: ApiKeys): Promise<Entry[]> {
  const out: Entry[] = [];
  const metas = (url: string) => async () => (await fetchMetas(url)).slice(0, 60);
  for (const type of ["movie", "series"] as const) {
    out.push({ key: `netflix:top10:${type}`, title: type === "movie" ? "Top 10 movies on Netflix" : "Top 10 shows on Netflix", type, source: "netflix",
      load: async () => (await netflixWeekly(keys, type)).slice(0, 10) });
    out.push({ key: `tmdb:trending:${type}`, title: type === "movie" ? "Trending movies this week" : "Trending shows this week", type, source: "tmdb",
      load: () => tmdbTrending(keys, type) });
    out.push({ key: `cinemeta:top:${type}`, title: type === "movie" ? "Popular movies" : "Popular shows", type, source: "cinemeta",
      load: metas(`${CINEMETA}/catalog/${type}/top.json`) });
    // Top rated rather than popular, so genre rows don't repeat the Popular rows.
    for (const genre of GENRES)
      out.push({ key: `cinemeta:genre:${type}:${genre}`, title: `Top-rated ${genre.toLowerCase()} ${type === "movie" ? "movies" : "shows"}`, type,
        source: "genre", load: metas(`${CINEMETA}/catalog/${type}/imdbRating/genre=${encodeURIComponent(genre)}.json`) });
  }
  return out;
}

/** A row, fetched again once it's 6 hours old. A fetch that fails or finds nothing keeps the last answer. */
async function rowFor(e: Entry): Promise<Row | null> {
  const old = await peek<Row>(`row:${e.key}`);
  if (old && Date.now() - old.fetchedAt < FRESH_MS) return { ...old, title: e.title };
  try {
    const items = await e.load();
    if (!items.length) return old ?? null;
    const row: Row = { key: e.key, title: e.title, type: e.type, source: e.source, items, fetchedAt: Date.now() };
    await keep(`row:${e.key}`, row, 7 * DAY);
    return row;
  } catch (error) {
    console.warn(`catalog ${e.key} failed`, error instanceof Error ? error.message : error);
    return old ?? null;
  }
}

/**
 * Every row, full, for Home and the recommender. Put together at most every 15 minutes per instance, with the keys of
 * whoever asked first: the rows are the same for everyone.
 */
export function allRows(keys: ApiKeys): Promise<Row[]> {
  return inMemory("rows", 15 * 60, async () => {
    const all = await entries(keys);
    const rows = await mapLimit(all, 8, rowFor);
    return rows.filter((r): r is Row => r !== null);
  });
}

const isTop10 = (title: string) => /top ?10/i.test(title);
export const shownCount = (title: string) => (isTop10(title) ? 10 : 24);

// Browsers keep the last answer across deploys (`useHome`'s "api.rows"): a change to its shape needs a new name there.
export type ShownRow = { key: string; title: string; style: "poster" | "top10"; source: string; updatedAt: number; items: RecItem[] };

/** TMDB's poster (and backdrop) for titles a catalog gave none, by IMDb id, else by name. Kept a month. */
function posterFor(keys: ApiKeys, item: CatalogItem) {
  // A miss is asked about again the next day; TMDB may have been down, or add it later.
  return cached(`row-poster:${item.id}`, (p) => (p ? 30 * DAY : DAY), async () => {
    const f = await found(keys, item.id).catch(() => null);
    if (f?.poster) return { poster: f.poster, background: f.background };
    // TMDB doesn't know every special by IMDb id ("…: Holidays"): its name, then the show it belongs to.
    for (const query of [...new Set([item.name, item.name.split(":")[0].trim()])]) {
      const body = await tmdb<{ results: TmdbItem[] }>(keys.tmdb, `/search/${item.type === "movie" ? "movie" : "tv"}`, { query }).catch(() => null);
      const hit = body?.results.find((r) => r.poster_path);
      const poster = tmdbImage(hit?.poster_path, "w500");
      if (poster) return { poster, background: tmdbImage(hit?.backdrop_path, "w1280") };
    }
    return null;
  });
}

/**
 * What Home shows of every row: as many titles as a row shows, with display fields only (only a Top 10's titles can
 * lead the hero, so only they keep a synopsis and backdrop), MDBList's scores and trailers, and TMDB posters where the
 * catalog had none.
 */
export function shownRows(keys: ApiKeys): Promise<ShownRow[]> {
  // Built without MDBList's scores when the asker has no MDBList key; kept apart, so it never stands in for the full rows.
  return inMemory(keys.mdblist ? "shown" : "shown-unrated", 15 * 60, () => buildShown(keys));
}

async function buildShown(keys: ApiKeys): Promise<ShownRow[]> {
  const rows = await allRows(keys);
  const shown = rows.map((r) => ({ row: r, items: r.items.slice(0, shownCount(r.title)) }));
  const titles = shown.flatMap((s) => s.items);
  const { ratings, trailers } = await ratingsFor(keys, titles, 8);
  const missing = [...new Map(titles.filter((i) => !i.poster && i.id.startsWith("tt")).map((i) => [i.id, i])).values()];
  const posters = new Map((await mapLimit(missing, 4, async (i) => [i.id, await posterFor(keys, i).catch(() => null)] as const)));
  return shown.map(({ row, items }) => {
    const top10 = isTop10(row.title);
    return {
      key: row.key,
      title: row.title,
      style: top10 ? "top10" : "poster",
      source: row.source,
      updatedAt: row.fetchedAt,
      items: items.map(({ id, type, name, poster, background, logo, year, description, rating, ratingSource, genres }) => ({
        id, type, name, year, rating, ratingSource, genres: genres.slice(0, 3),
        poster: poster ?? posters.get(id)?.poster,
        ...(top10 ? { background: background ?? posters.get(id)?.background, logo, description } : {}),
        scores: scoresFrom(ratings.get(id)),
        trailer: trailers.get(id),
      })),
    };
  });
}

/**
 * For a new profile to rate: the titles most people have seen (most votes on TMDB), a few from each
 * genre so every rating says something different about taste. Kept a day.
 */
export function starterTitles(keys: ApiKeys): Promise<CatalogItem[]> {
  // A thin list (TMDB answered for few genres) isn't kept, so the next ask fills it.
  return cached("starter", (items) => (items.length >= 30 ? DAY : 0), async () => {
    const genres: { t: TmdbType; id: number; take: number }[] = [
      ...[28, 35, 18, 878, 80, 16, 27, 10749, 53, 14, 12, 10751].map((id) => ({ t: "movie" as const, id, take: 3 })),
      ...[10759, 35, 18, 10765, 80, 16, 9648].map((id) => ({ t: "tv" as const, id, take: 2 })),
    ];
    const lists = await Promise.all(
      genres.map(async ({ t, id, take }) => {
        const body = await tmdb<{ results: TmdbItem[] }>(keys.tmdb, `/discover/${t}`, { with_genres: id, sort_by: "vote_count.desc", include_adult: "false" })
          .catch(() => ({ results: [] as TmdbItem[] }));
        return body.results.slice(0, take + 2).map((r) => ({ r, t }));
      }),
    );
    const mixed: { r: TmdbItem; t: TmdbType }[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < 5; i++)
      for (const list of lists) {
        const x = list[i];
        if (!x || seen.has(`${x.t}:${x.r.id}`)) continue;
        seen.add(`${x.t}:${x.r.id}`);
        mixed.push(x);
      }
    return (await fromTmdb(keys, mixed)).slice(0, 40);
  });
}

/** TMDB's discover filters for a "culture" the recommender tracks: a language, or anime. */
const discoverFor = (culture: string) =>
  culture === "anime" ? { with_original_language: "ja", with_genres: 16 } : { with_original_language: culture, without_genres: 16 };

/**
 * Well-voted and recent popular titles in a language someone watches, as candidates for their picks (never shown as
 * rows). Catalog rows are mostly English, so a Telugu film fan would otherwise only ever be offered what TMDB's
 * audience pairs with Telugu films. Kept a day.
 */
export function languageRow(keys: ApiKeys, culture: string, type: Kind): Promise<CatalogItem[]> {
  return cached(`lang-row:${culture}:${type}`, (items) => (items.length ? DAY : HOUR), async () => {
    const year = new Date().getUTCFullYear();
    const t: TmdbType = type === "movie" ? "movie" : "tv";
    const dateKey = t === "movie" ? "primary_release_date.gte" : "first_air_date.gte";
    const ask = (params: Record<string, string | number>) =>
      tmdb<{ results: TmdbItem[] }>(keys.tmdb, `/discover/${t}`, { ...discoverFor(culture), include_adult: "false", ...params })
        .then((b) => b.results)
        .catch(() => [] as TmdbItem[]);
    const lists = await Promise.all([
      ...[1, 2, 3].map((page) => ask({ sort_by: "vote_count.desc", "vote_average.gte": 6.5, [dateKey]: `${year - 25}-01-01`, page })),
      ...[1, 2].map((page) => ask({ sort_by: "popularity.desc", "vote_count.gte": 25, "vote_average.gte": 6.3, [dateKey]: `${year - 4}-01-01`, page })),
    ]);
    return (await fromTmdb(keys, lists.flat().map((r) => ({ r, t })))).slice(0, 100);
  });
}
