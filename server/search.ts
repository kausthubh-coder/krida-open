import { parseTags, tagsTitle, type Tags } from "../shared/tags.js";
import { tmdb, tmdbImage, yearOf, type TmdbItem, type TmdbType } from "../shared/tmdb.js";
import { BadRequest, type ApiKeys } from "./http.js";
import { CINEMETA, KITSU } from "./meta.js";
import { imdbForTmdb, kindOf } from "./titles.js";

/*
 * Search through TMDB: it ranks by relevance and popularity and finds people, so "nolan" brings up his films;
 * Cinemeta catches typos; Kitsu adds anime seasons; a query made of tags ("telugu comedy", "90s horror movies")
 * browses them, and then only titles named like it come along. Where you stand with each title (watched, on your
 * list…) is added in the browser, which already knows, so every answer here is the same for everyone.
 */

type Kind = "movie" | "series";
const DAY_MS = 24 * 60 * 60 * 1000;

export type SearchResult = {
  id: string;
  type: Kind;
  name: string;
  poster?: string;
  year?: string;
  rating?: number;
  overview?: string;
};

export type SearchPerson = { id: number; name: string; role: string; photo?: string; titles: SearchResult[] };
export type SearchCursor = { movie: number | null; tv: number | null; multi: number | null };
export type SearchPage = { results: SearchResult[]; nextCursor: SearchCursor | null };
/** What a search found, and whether a source it asks didn't answer (so it's kept only briefly). */
export type Answer<T> = { found: T; partial: boolean };
export type SearchOut = {
  results: SearchResult[];
  person: SearchPerson | null;
  anime: SearchResult[];
  /** What a tag query ("telugu comedy") found. */
  genre: { title: string; results: SearchResult[] } | null;
  tags?: Tags | null;
  nextCursor?: SearchCursor | null;
};

const toResult = (x: TmdbItem, type: Kind, id: string): SearchResult => ({
  id,
  type,
  name: x.title ?? x.name ?? x.original_name ?? "Untitled",
  poster: tmdbImage(x.poster_path, "w342"),
  year: yearOf(x),
  rating: x.vote_count && x.vote_count >= 20 && x.vote_average ? Math.round(x.vote_average * 10) / 10 : undefined,
  overview: x.overview || undefined,
});

/** Cinemeta's search: less precise than TMDB, but it forgives typos ("intersteller"). */
async function cinemetaSearch(query: string, failed: () => void): Promise<SearchResult[]> {
  const q = encodeURIComponent(query.toLowerCase());
  const lists = await Promise.all(
    (["movie", "series"] as const).map(async (type) => {
      try {
        const res = await fetch(`${CINEMETA}/catalog/${type}/top/search=${q}.json`, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) throw new Error(`${res.status} from Cinemeta`);
        const body = (await res.json()) as { metas?: any[] };
        return (body.metas ?? [])
          .filter((m) => typeof m?.id === "string" && m.id.startsWith("tt") && typeof m.name === "string" && m.poster)
          .slice(0, 10)
          .map((m): SearchResult => ({
            id: m.id,
            type,
            name: m.name,
            poster: m.poster,
            year: typeof m.releaseInfo === "string" ? m.releaseInfo : undefined,
            rating: Number.parseFloat(m.imdbRating) || undefined,
          }));
      } catch {
        failed();
        return [];
      }
    }),
  );
  const out: SearchResult[] = [];
  for (let i = 0; i < 10; i++) for (const list of lists) if (list[i]) out.push(list[i]);
  return out;
}

function kitsuResults(metas: any[]): SearchResult[] {
  return metas
    .filter((m) => typeof m?.id === "string" && m.id.startsWith("kitsu:") && typeof m.name === "string" && m.poster)
    .map((m) => ({
      id: m.id,
      type: m.type === "movie" || m.animeType === "movie" ? ("movie" as const) : ("series" as const),
      name: m.name,
      poster: m.poster,
      year: typeof m.releaseInfo === "string" ? m.releaseInfo : undefined,
      rating: Number.parseFloat(m.imdbRating) || undefined,
    }));
}

async function kitsuCatalog(path: string, failed: () => void): Promise<SearchResult[]> {
  try {
    const res = await fetch(`${KITSU}/catalog/anime/${path}.json`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`${res.status} from Kitsu`);
    return kitsuResults(((await res.json()) as { metas?: any[] }).metas ?? []);
  } catch {
    failed();
    return [];
  }
}

const simplify = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
/** "Scary Movie" for "scary movie": a title that a tag query also names. */
const sameName = (name: string, query: string) => simplify(name).replace(/^the /, "") === simplify(query).replace(/^the /, "");

/** Anime by Kitsu id (each season its own entry, like the anime rows on Home), when the name really matches. */
async function kitsuSearch(query: string, failed: () => void): Promise<SearchResult[]> {
  const q = simplify(query);
  const found = await kitsuCatalog(`kitsu-anime-list/search=${encodeURIComponent(query)}`, failed);
  return found.filter((r) => simplify(r.name).includes(q)).slice(0, 18);
}

const TMDB_GENRE: Record<string, { movie?: number; tv?: number }> = {
  Action: { movie: 28, tv: 10759 },
  Adventure: { movie: 12, tv: 10759 },
  Animation: { movie: 16, tv: 16 },
  Anime: { movie: 16, tv: 16 },
  Comedy: { movie: 35, tv: 35 },
  Crime: { movie: 80, tv: 80 },
  Documentary: { movie: 99, tv: 99 },
  Drama: { movie: 18, tv: 18 },
  Family: { movie: 10751, tv: 10751 },
  Fantasy: { movie: 14, tv: 10765 },
  Horror: { movie: 27 },
  Mystery: { movie: 9648, tv: 9648 },
  Romance: { movie: 10749 },
  "Sci-Fi": { movie: 878, tv: 10765 },
  Thriller: { movie: 53 },
  War: { movie: 10752, tv: 10768 },
  Western: { movie: 37, tv: 37 },
};

/** Fewest votes a title needs: [English, any other language]. Regional cinema gets far fewer TMDB votes. */
const VOTE_FLOOR = {
  movie: { popular: [300, 10], best: [1500, 40], new: [30, 3] },
  tv: { popular: [100, 5], best: [400, 20], new: [15, 2] },
} as const;

const cursorOrEnd = (cursor: SearchCursor) => (Object.values(cursor).some((page) => page !== null) ? cursor : null);

/**
 * Two pages from `start`. If the second page fails, the first still counts and the cursor points at
 * the page that failed, so the next batch retries it; a page that did not answer is never skipped.
 */
async function tmdbPages(keys: ApiKeys, path: string, params: Record<string, string | number | undefined>, start = 1) {
  if (!Number.isInteger(start) || start < 1 || start > 500) throw new BadRequest("Invalid search page");
  type Page = { results: TmdbItem[]; total_pages: number };
  const first = await tmdb<Page>(keys.tmdb, path, { ...params, page: start });
  const last = Math.min(first.total_pages, 500);
  const second = start < last ? await tmdb<Page>(keys.tmdb, path, { ...params, page: start + 1 }).catch(() => null) : null;
  const through = second ? start + 1 : start;
  return { results: [...first.results, ...(second?.results ?? [])], nextPage: through < last ? through + 1 : null };
}

/**
 * Popular, well-rated titles for a set of tags (TMDB discover), movies and shows alternating. Anime on
 * its own comes from Kitsu, a season per entry; with other tags it is Japanese animation on TMDB.
 */
async function discover(keys: ApiKeys, tags: Tags, failed: () => void, cursor?: SearchCursor): Promise<SearchPage> {
  const animeOnly = tags.genres.length === 1 && tags.genres[0] === "Anime" && !tags.language && !tags.years && !tags.sort;
  if (animeOnly) {
    let down = 0;
    const [popular, rated] = await Promise.all([kitsuCatalog("kitsu-anime-popular", () => down++), kitsuCatalog("kitsu-anime-rating", () => down++)]);
    if (down === 2) throw new Error("Kitsu didn't answer");
    if (down) failed();
    const seen = new Set<string>();
    const results = [...popular, ...rated]
      .filter((r) => {
        if (seen.has(r.id) || (tags.type && r.type !== tags.type)) return false;
        seen.add(r.id);
        return true;
      })
      .slice(0, 40);
    return { results, nextCursor: null };
  }
  const language = tags.language ?? (tags.genres.includes("Anime") ? "ja" : undefined);
  const regional = !!language && language !== "en";
  const sort = tags.sort ?? "popular";
  const today = new Date().toISOString().slice(0, 10);
  const recent = new Date(Date.now() - 540 * DAY_MS).toISOString().slice(0, 10);
  // A genre TMDB has no TV id for (horror, thriller, romance) means movies only.
  const kinds = (["movie", "tv"] as const).filter(
    (t) => tags.genres.every((g) => TMDB_GENRE[g]?.[t]) && (!tags.type || kindOf(t) === tags.type) && (!cursor || cursor[t] !== null),
  );
  const next: SearchCursor = { movie: null, tv: null, multi: null };
  const failures: unknown[] = [];
  const lists = await Promise.all(
    kinds.map(async (t) => {
      const date = t === "movie" ? "primary_release_date" : "first_air_date";
      const start = cursor?.[t] ?? 1;
      const page = await tmdbPages(keys, `/discover/${t}`, {
        with_genres: [...new Set(tags.genres.map((g) => TMDB_GENRE[g][t]))].join(",") || undefined,
        with_original_language: language,
        sort_by: sort === "best" ? "vote_average.desc" : "popularity.desc",
        "vote_count.gte": VOTE_FLOOR[t][sort][regional ? 1 : 0],
        "vote_average.gte": sort === "best" ? 7 : sort === "new" ? undefined : 6,
        [`${date}.gte`]: tags.years ? `${tags.years.from}-01-01` : sort === "new" ? recent : undefined,
        [`${date}.lte`]: tags.years ? `${tags.years.to}-12-31` : sort === "new" ? today : undefined,
        include_adult: "false",
      }, start).catch((error: unknown) => {
        failures.push(error);
        return null;
      });
      // Movies still show when shows don't answer; the failed kind keeps its cursor for the next batch.
      next[t] = page ? page.nextPage : start;
      return (page?.results ?? []).filter((x) => x.poster_path).map((x) => ({ x, t }));
    }),
  );
  if (kinds.length && failures.length === kinds.length) throw failures[0];
  if (failures.length) {
    failed();
    console.warn("tmdb discover partly failed", failures[0] instanceof Error ? failures[0].message : failures[0]);
  }
  const mixed: { x: TmdbItem; t: TmdbType }[] = [];
  for (let i = 0; i < Math.max(0, ...lists.map((list) => list.length)); i++) for (const list of lists) if (list[i]) mixed.push(list[i]);
  const map = await imdbForTmdb(keys, mixed.map(({ x, t }) => ({ tmdbId: x.id, tmdbType: t })));
  const results = mixed.flatMap(({ x, t }) => {
    const id = map.get(`${t}:${x.id}`);
    return id ? [toResult(x, kindOf(t), id)] : [];
  });
  return { results, nextCursor: cursorOrEnd(next) };
}

const cleanQuery = (q: string) => q.trim().slice(0, 100);

/** The next batch of a search, with the same filters as the opening one and without repeating its extra rails. */
export async function searchPage(keys: ApiKeys, q: string, cursor: SearchCursor): Promise<Answer<SearchPage>> {
  let partial = false;
  const answer = (found: SearchPage) => ({ found, partial });
  const query = cleanQuery(q);
  if (query.length < 2) return answer({ results: [], nextCursor: null });
  const tags = parseTags(query);
  if (tags) return answer(await discover(keys, tags, () => (partial = true), cursor));
  if (cursor.multi === null) return answer({ results: [], nextCursor: null });
  const page = await tmdbPages(keys, "/search/multi", { query, include_adult: "false" }, cursor.multi);
  const titles = page.results.filter((x) =>
    (x.media_type === "movie" || x.media_type === "tv") && x.poster_path && ((x.vote_count ?? 0) >= 10 || (x.popularity ?? 0) >= 8));
  const ids = await imdbForTmdb(keys, titles.map((x) => ({ tmdbId: x.id, tmdbType: x.media_type as TmdbType })));
  return answer({
    results: titles.flatMap((x) => {
      const t = x.media_type as TmdbType;
      const id = ids.get(`${t}:${x.id}`);
      return id ? [toResult(x, kindOf(t), id)] : [];
    }),
    nextCursor: cursorOrEnd({ movie: null, tv: null, multi: page.nextPage }),
  });
}

/** A search. TMDB not answering fails it (the browser then asks Cinemeta itself); a smaller source missing makes it partial. */
export async function search(keys: ApiKeys, q: string): Promise<Answer<SearchOut>> {
  let partial = false;
  const failed = () => {
    partial = true;
  };
  const query = cleanQuery(q);
  if (query.length < 2) return { found: { results: [], person: null, anime: [], genre: null }, partial };
  const tags = parseTags(query);

  const noTitles = { results: [] as TmdbItem[], nextPage: null };
  // A tag query only looks for titles of the same name ("Scary Movie", "War"), which TMDB ranks
  // first; one with a language, years, sort or several genres can't be a name, so it skips that.
  const nameable = tags && !tags.language && !tags.years && !tags.sort && tags.genres.length === 1;
  const [primary, fuzzy, anime, discovery] = await Promise.all([
    !tags
      ? tmdbPages(keys, "/search/multi", { query, include_adult: "false" })
      : nameable
        ? tmdb<{ results: TmdbItem[] }>(keys.tmdb, "/search/multi", { query, include_adult: "false" })
          .then(({ results }) => ({ results, nextPage: null }), () => (failed(), noTitles))
        : Promise.resolve(noTitles),
    tags ? Promise.resolve([]) : cinemetaSearch(query, failed),
    tags ? Promise.resolve([]) : kitsuSearch(query, failed),
    tags ? discover(keys, tags, failed) : Promise.resolve({ results: [], nextCursor: null }),
  ]);
  const all = primary.results;
  const titles = all.filter(
    (x) =>
      (x.media_type === "movie" || x.media_type === "tv") &&
      x.poster_path &&
      ((x.vote_count ?? 0) >= 10 || (x.popularity ?? 0) >= 8) &&
      (!tags || sameName(x.title ?? x.name ?? "", query)),
  );

  // A person among the first few hits, and well known: show what they're known for.
  let person: SearchPerson | null = null;
  const top = tags ? undefined : all.slice(0, 4).find((x) => x.media_type === "person" && (x.popularity ?? 0) >= 2 && x.profile_path);
  let credits: { item: TmdbItem; tmdbType: TmdbType }[] = [];
  if (top) {
    try {
      const body = await tmdb<{ cast: TmdbItem[]; crew: TmdbItem[] }>(keys.tmdb, `/person/${top.id}/combined_credits`);
      const directing = top.known_for_department === "Directing" || top.known_for_department === "Writing";
      const pool = directing
        ? body.crew.filter((c) => c.job === "Director" || c.job === "Screenplay" || c.job === "Writer" || c.job === "Creator")
        : body.cast.filter((c) => (c.order ?? 99) < 6 && !(c.media_type === "tv" && (c.episode_count ?? 99) < 3));
      const seen = new Set<string>();
      credits = pool
        .filter((c) => (c.media_type === "movie" || c.media_type === "tv") && c.poster_path && (c.vote_count ?? 0) >= 50)
        .sort((a, b) => (b.vote_count ?? 0) - (a.vote_count ?? 0))
        .filter((c) => {
          const key = `${c.media_type}:${c.id}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .slice(0, 18)
        .map((item) => ({ item, tmdbType: item.media_type as TmdbType }));
      person = {
        id: top.id,
        name: top.name ?? "",
        role: directing ? "Director" : top.known_for_department === "Acting" ? "Actor" : (top.known_for_department ?? ""),
        photo: tmdbImage(top.profile_path, "w185"),
        titles: [],
      };
    } catch {
      failed();
      person = null;
    }
  }

  const ids = await imdbForTmdb(keys, [
    ...titles.map((x) => ({ tmdbId: x.id, tmdbType: x.media_type as TmdbType })),
    ...credits.map((c) => ({ tmdbId: c.item.id, tmdbType: c.tmdbType })),
  ]);
  const map = (x: TmdbItem, t: TmdbType) => {
    const id = ids.get(`${t}:${x.id}`);
    return id ? toResult(x, kindOf(t), id) : null;
  };
  const dedupe = (list: (SearchResult | null)[]) => {
    const seen = new Set<string>();
    return list.filter((r): r is SearchResult => {
      if (!r || seen.has(r.id)) return false;
      seen.add(r.id);
      return true;
    });
  };
  // TMDB leads; Cinemeta's fuzzier matching fills in, and leads when TMDB found little (a typo).
  const fromTmdb = titles.map((x) => map(x, x.media_type as TmdbType));
  const results = dedupe(fromTmdb.length >= 3 || tags ? [...fromTmdb, ...fuzzy] : [...fuzzy, ...fromTmdb]);
  if (person) person.titles = dedupe(credits.map((c) => map(c.item, c.tmdbType)));
  if (person && person.titles.length < 3) person = null;
  // Their films already have a row; the grid below shows everything else.
  const inPersonRow = new Set(person?.titles.map((t) => t.id) ?? []);
  const found: SearchOut = {
    results: results.filter((r) => !inPersonRow.has(r.id)),
    person,
    // Two or more seasons or films make the anime row worth showing.
    anime: anime.length >= 2 ? anime : [],
    genre: tags && discovery.results.length ? { title: tagsTitle(tags), results: discovery.results } : null,
    tags,
    nextCursor: tags ? discovery.nextCursor : cursorOrEnd({ movie: null, tv: null, multi: primary.nextPage }),
  };
  return { found, partial };
}

/** A search cursor from the query string ("movie,tv,multi" pages, "-" for done). */
export function parseCursor(text: string | null): SearchCursor {
  const parts = (text ?? "").split(",");
  const page = (x: string | undefined) => {
    if (x === undefined || x === "-") return null;
    const n = Number(x);
    if (!Number.isInteger(n) || n < 1 || n > 500) throw new BadRequest("Invalid search cursor");
    return n;
  };
  if (parts.length !== 3) throw new BadRequest("Invalid search cursor");
  return { movie: page(parts[0]), tv: page(parts[1]), multi: page(parts[2]) };
}

