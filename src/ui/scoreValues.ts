/** What each score from 1 to 10 means, shown next to the number. */
export const scoreLabels = ["", "Not for me", "Not for me", "Didn't enjoy it", "Below average", "Mixed feelings", "Pretty good", "Enjoyed it", "Really good", "Loved it", "A favorite"];

export type ScoreSource = "imdb" | "mal" | "tomatoes" | "popcorn" | "metacritic" | "letterboxd" | "tmdb" | "kitsu";

/** One public rating, formatted the way its source shows it. */
export type PublicScore = { source: ScoreSource; value: string; label: string; spoken: string };

/** MDBList's ratings object; its overall `score` is not shown. */
type Numbers = Partial<Record<ScoreSource | "score", number>>;

const tenth = (n: number) => n.toFixed(1);
const SOURCES: { source: ScoreSource; label: string; value: (n: number) => string; spoken: (v: string) => string }[] = [
  { source: "imdb", label: "IMDb", value: tenth, spoken: (v) => `IMDb ${v} out of 10` },
  { source: "mal", label: "MyAnimeList", value: tenth, spoken: (v) => `MyAnimeList ${v} out of 10` },
  { source: "tomatoes", label: "Rotten Tomatoes critics", value: (n) => `${Math.round(n)}%`, spoken: (v) => `Rotten Tomatoes critics ${v}` },
  { source: "popcorn", label: "Rotten Tomatoes audience", value: (n) => `${Math.round(n)}%`, spoken: (v) => `Rotten Tomatoes audience ${v}` },
  { source: "metacritic", label: "Metacritic", value: (n) => String(Math.round(n)), spoken: (v) => `Metacritic ${v} out of 100` },
  { source: "letterboxd", label: "Letterboxd", value: tenth, spoken: (v) => `Letterboxd ${v} out of 5` },
  { source: "tmdb", label: "TMDB", value: tenth, spoken: (v) => `TMDB ${v} out of 10` },
  { source: "kitsu", label: "Kitsu", value: tenth, spoken: (v) => `Kitsu ${v} out of 10` },
];

/**
 * The public ratings a title page shows, in a fixed order so the strip reads the same on every title.
 * `imdb` is Cinemeta's IMDb rating: it arrives with the page, before MDBList answers, so it wins and
 * the number never changes under the reader. Anime leads with MyAnimeList, the score anime fans know,
 * matching the poster cards.
 */
export function publicScores(ratings: Numbers | null | undefined, extra: { imdb?: number; kitsu?: number; anime?: boolean } = {}): PublicScore[] {
  const numbers: Numbers = { ...ratings, imdb: extra.imdb ?? ratings?.imdb, kitsu: extra.kitsu };
  const order = extra.anime ? [SOURCES[1], SOURCES[0], ...SOURCES.slice(2)] : SOURCES;
  return order.flatMap(({ source, label, value, spoken }) => {
    const n = numbers[source];
    if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return [];
    const shown = value(n);
    return [{ source, label, value: shown, spoken: spoken(shown) }];
  });
}

/** "8.4" or "8,4" from Cinemeta and Kitsu, as a number; anything else is no rating. */
export function parseRating(text: string | undefined) {
  const n = Number.parseFloat((text ?? "").replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
