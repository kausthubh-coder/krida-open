/**
 * MDBList: every rating in one place (IMDb, Rotten Tomatoes, Metacritic, Letterboxd, MyAnimeList, TMDB) plus
 * an overall score. The free plan allows 1000 requests a day; a batch of up to 200 titles is one request.
 */

const API = "https://api.mdblist.com";
export const BATCH = 200;

export type Ratings = {
  score?: number;
  imdb?: number;
  tomatoes?: number;
  popcorn?: number;
  metacritic?: number;
  letterboxd?: number;
  mal?: number;
  tmdb?: number;
};

export type MdbTitle = {
  imdbId: string;
  tmdbId?: number;
  ratings: Ratings;
  certification?: string;
  trailer?: string;
};

function parse(x: any): MdbTitle | null {
  const imdbId = x?.ids?.imdb;
  if (typeof imdbId !== "string" || !imdbId.startsWith("tt")) return null;
  const ratings: Ratings = {};
  const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined);
  ratings.score = num(x.score);
  for (const r of x.ratings ?? []) {
    const value = num(r?.value);
    if (value === undefined) continue;
    if (r.source === "imdb") ratings.imdb = value;
    else if (r.source === "tomatoes") ratings.tomatoes = value;
    else if (r.source === "popcorn") ratings.popcorn = value;
    else if (r.source === "metacritic") ratings.metacritic = value;
    // MDBList reports Letterboxd out of 10; Letterboxd itself uses five stars.
    else if (r.source === "letterboxd") ratings.letterboxd = Math.round(value * 5) / 10;
    else if (r.source === "myanimelist") ratings.mal = value;
    // TMDB's vote average, out of 10 like on TMDB (MDBList may send it out of 100).
    else if (r.source === "tmdb") ratings.tmdb = Math.round((value > 10 ? value / 10 : value) * 10) / 10;
  }
  return {
    imdbId,
    tmdbId: typeof x.ids?.tmdb === "number" ? x.ids.tmdb : undefined,
    ratings,
    certification: typeof x.certification === "string" && x.certification ? x.certification : undefined,
    trailer: typeof x.trailer === "string" && x.trailer ? x.trailer : undefined,
  };
}

/** Ratings for up to 200 IMDb ids of one type in a single request, asked with the account's MDBList `key`. */
export async function mdbBatch(key: string, type: "movie" | "series", imdbIds: string[]): Promise<MdbTitle[]> {
  if (imdbIds.length === 0) return [];
  const res = await fetch(`${API}/imdb/${type === "movie" ? "movie" : "show"}?apikey=${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids: imdbIds.slice(0, BATCH) }),
  });
  if (!res.ok) throw new Error(`MDBList answered ${res.status}`);
  const body = await res.json();
  return (Array.isArray(body) ? body : []).map(parse).filter((x): x is MdbTitle => x !== null);
}
