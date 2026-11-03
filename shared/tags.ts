/**
 * Search words Krida reads as tags: "telugu comedy", "90s horror movies", "best korean thrillers".
 * Pure, so the Search page uses the same parser to light up the chips it shows.
 */

type Kind = "movie" | "series";

export type Tags = {
  language?: string;
  genres: string[];
  type?: Kind;
  /** A decade ("90s") or a single year. */
  years?: { from: number; to: number };
  sort?: "best" | "new";
};

/** Languages by TMDB's original-language code. The first six get chips on the Search page. */
export const LANGUAGES: { code: string; name: string; words: string[] }[] = [
  { code: "te", name: "Telugu", words: ["telugu", "tollywood"] },
  { code: "hi", name: "Hindi", words: ["hindi", "bollywood"] },
  { code: "ta", name: "Tamil", words: ["tamil", "kollywood"] },
  { code: "ml", name: "Malayalam", words: ["malayalam", "mollywood"] },
  { code: "ko", name: "Korean", words: ["korean"] },
  { code: "ja", name: "Japanese", words: ["japanese"] },
  { code: "kn", name: "Kannada", words: ["kannada", "sandalwood"] },
  { code: "bn", name: "Bengali", words: ["bengali", "bangla"] },
  { code: "mr", name: "Marathi", words: ["marathi"] },
  { code: "pa", name: "Punjabi", words: ["punjabi"] },
  { code: "en", name: "English", words: ["english", "hollywood"] },
  { code: "es", name: "Spanish", words: ["spanish"] },
  { code: "fr", name: "French", words: ["french"] },
  { code: "de", name: "German", words: ["german"] },
  { code: "it", name: "Italian", words: ["italian"] },
  { code: "pt", name: "Portuguese", words: ["portuguese", "brazilian"] },
  { code: "zh", name: "Chinese", words: ["chinese", "mandarin"] },
  { code: "cn", name: "Cantonese", words: ["cantonese"] },
  { code: "tr", name: "Turkish", words: ["turkish"] },
  { code: "th", name: "Thai", words: ["thai"] },
];

/** Genres in Krida's names, with the words people use for them. TMDB has no TV genre for the movie-only ones. */
export const GENRES: { name: string; words: string[]; movieOnly?: boolean }[] = [
  { name: "Action", words: ["action"] },
  { name: "Comedy", words: ["comedy", "comedies", "funny"] },
  { name: "Drama", words: ["drama", "dramas"] },
  { name: "Sci-Fi", words: ["sci fi", "scifi", "science fiction"] },
  { name: "Thriller", words: ["thriller", "thrillers"], movieOnly: true },
  { name: "Horror", words: ["horror", "scary"], movieOnly: true },
  { name: "Romance", words: ["romance", "romantic", "love"], movieOnly: true },
  { name: "Crime", words: ["crime"] },
  { name: "Fantasy", words: ["fantasy"] },
  { name: "Mystery", words: ["mystery", "mysteries"] },
  { name: "Animation", words: ["animation", "animated", "cartoons"] },
  { name: "Anime", words: ["anime"] },
  { name: "Documentary", words: ["documentary", "documentaries", "docs"] },
  { name: "Family", words: ["family", "kids"] },
  { name: "Adventure", words: ["adventure"] },
  { name: "War", words: ["war"] },
  { name: "Western", words: ["western", "westerns"] },
];

export const DECADES = [2020, 2010, 2000, 1990, 1980];

type Part = Partial<Omit<Tags, "genres">> & { genres?: string[] };

const PHRASES = new Map<string, Part>();
for (const l of LANGUAGES) for (const w of l.words) PHRASES.set(w, { language: l.code });
for (const g of GENRES) for (const w of g.words) PHRASES.set(w, { genres: [g.name] });
PHRASES.set("rom com", { genres: ["Romance", "Comedy"] });
PHRASES.set("romcom", { genres: ["Romance", "Comedy"] });
for (const w of ["movie", "movies", "film", "films", "cinema"]) PHRASES.set(w, { type: "movie" });
for (const w of ["show", "shows", "series", "tv", "tv show", "tv shows", "tv series"]) PHRASES.set(w, { type: "series" });
for (const w of ["best", "top", "top rated", "highest rated", "greatest", "good", "great"]) PHRASES.set(w, { sort: "best" });
for (const w of ["new", "newest", "latest", "recent"]) PHRASES.set(w, { sort: "new" });
for (const w of ["k drama", "k dramas", "kdrama", "kdramas"]) PHRASES.set(w, { language: "ko", genres: ["Drama"], type: "series" });
// Read but meaningless on their own: "popular telugu comedy", "comedy movies in hindi".
const FILLER = new Set(["popular", "trending", "and", "in", "from", "of"]);

const simplify = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function yearsOf(word: string): Tags["years"] | null {
  const decade = /^(19|20)?(\d)0s$/.exec(word);
  if (decade) {
    const century = decade[1] ? Number(decade[1]) * 100 : Number(decade[2]) >= 3 ? 1900 : 2000;
    const from = century + Number(decade[2]) * 10;
    return { from, to: from + 9 };
  }
  const year = /^(19[2-9]\d|20\d\d)$/.exec(word);
  return year ? { from: Number(year[1]), to: Number(year[1]) } : null;
}

/**
 * The tags in a query, when every word is one. A language or genre is required, so "2012", "1917"
 * or "new girl" stay title searches.
 */
export function parseTags(query: string): Tags | null {
  const words = simplify(query).split(" ").filter(Boolean);
  const tags: Tags = { genres: [] };
  for (let i = 0; i < words.length; ) {
    let matched = 0;
    // Longest phrase first, so "science fiction" beats "science".
    for (let n = Math.min(3, words.length - i); n > 0 && !matched; n--) {
      const phrase = words.slice(i, i + n).join(" ");
      const part = PHRASES.get(phrase);
      if (part) {
        const { genres, ...rest } = part;
        Object.assign(tags, rest);
        for (const g of genres ?? []) if (!tags.genres.includes(g)) tags.genres.push(g);
        matched = n;
      } else if (n === 1) {
        const years = yearsOf(phrase);
        if (years) tags.years = years;
        if (years || FILLER.has(phrase)) matched = 1;
      }
    }
    if (!matched) return null;
    i += matched;
  }
  return tags.language || tags.genres.length ? tags : null;
}

const KNOWN = new Set([...PHRASES.keys(), ...FILLER].flatMap((p) => p.split(" ")));

/** True while someone may still be typing tags ("tel", "telugu com"), so the chips stay put. */
export function looksLikeTags(query: string): boolean {
  const words = simplify(query).split(" ").filter(Boolean);
  if (words.length === 0 || parseTags(query)) return true;
  return words.every((w, i) =>
    i === words.length - 1 && !query.endsWith(" ")
      ? [...KNOWN].some((k) => k.startsWith(w)) || /^\d{1,3}s?$/.test(w) || !!yearsOf(w)
      : KNOWN.has(w) || !!yearsOf(w),
  );
}

export const languageName = (code: string) => LANGUAGES.find((l) => l.code === code)?.name ?? code;
export const decadeLabel = (from: number) => `${String(from).slice(from < 2000 ? 2 : 0)}s`;

/** The query that means these tags, in a fixed order: "best 90s telugu action comedy movies". */
export function formatTags(tags: Tags): string {
  const years = tags.years && (tags.years.from === tags.years.to ? String(tags.years.from) : decadeLabel(tags.years.from));
  return [
    tags.sort,
    years,
    tags.language && languageName(tags.language).toLowerCase(),
    ...tags.genres.map((g) => g.toLowerCase()),
    tags.type && (tags.type === "movie" ? "movies" : "shows"),
  ]
    .filter(Boolean)
    .join(" ");
}

/** A heading for the results: "Popular Telugu comedy movies and shows", "Best 90s horror movies". */
export function tagsTitle(tags: Tags): string {
  const anime = tags.genres.includes("Anime");
  const years = tags.years && (tags.years.from === tags.years.to ? String(tags.years.from) : decadeLabel(tags.years.from));
  const genres = tags.genres.filter((g) => g !== "Anime").map((g) => (g === "Sci-Fi" ? "sci-fi" : g.toLowerCase()));
  const movieOnly = tags.genres.some((g) => GENRES.find((x) => x.name === g)?.movieOnly);
  const kinds =
    tags.type === "series" ? "shows" : tags.type === "movie" || movieOnly ? "movies" : anime ? "" : "movies and shows";
  const words = [
    tags.sort === "best" ? "Best" : tags.sort === "new" ? "New" : "Popular",
    years,
    tags.language && languageName(tags.language),
    ...genres,
    anime && "anime",
    kinds,
  ].filter(Boolean);
  return words.join(" ");
}
