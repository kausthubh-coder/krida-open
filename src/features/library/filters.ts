export type Kind = "all" | "movie" | "series";

export const titleLink = (i: { type: "movie" | "series"; id: string }) => `/title/${i.type}/${i.id}`;

/** "about 2,660 hours", from minutes. */
export function hoursLabel(minutes: number) {
  const h = minutes / 60;
  return h < 1 ? `${Math.round(minutes)} minutes` : h < 10 ? `${Math.round(h * 10) / 10} hours` : `${Math.round(h).toLocaleString()} hours`;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const monthName = (m: number) => MONTHS[m];
export function shortDate(t: number, now = Date.now()) {
  const d = new Date(t), n = new Date(now);
  if (d.toDateString() === n.toDateString()) return "today";
  return `${MONTHS[d.getMonth()].slice(0, 3)} ${d.getDate()}${d.getFullYear() !== n.getFullYear() ? `, ${d.getFullYear()}` : ""}`;
}

/** Case- and accent-insensitive, so "pokemon" finds "Pokémon". */
const fold = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

/** Without spaces or punctuation, so "spiderman" finds "Spider-Man". */
const squash = (s: string) => s.replace(/[^\p{L}\p{N}]+/gu, "");

/** One filter for every Library view and the nav's suggestions: the type chosen and what's typed. */
export function libraryFilter(kind: Kind, query: string) {
  const words = fold(query).split(/\s+/).filter(Boolean);
  return (i: { type: "movie" | "series"; name: string }) => {
    if (kind !== "all" && i.type !== kind) return false;
    const name = fold(i.name);
    return words.every((w) => name.includes(w) || (squash(w).length > 0 && squash(name).includes(squash(w))));
  };
}

/** Anime, then movies and shows that aren't anime, the same split as Stats. */
export type Format = "all" | "movie" | "series" | "anime";
export type Era = "all" | "2020" | "2010" | "2000" | "1990" | "older";
export type ScoreFilter = "all" | "high" | "scored" | "unscored";
/** No genres means any genre. */
export type Filters = { format: Format; era: Era; score: ScoreFilter; genres: string[] };
export const NO_FILTERS: Filters = { format: "all", era: "all", score: "all", genres: [] };

export const FORMATS: { value: Format; label: string }[] = [
  { value: "all", label: "All" }, { value: "movie", label: "Movies" }, { value: "series", label: "Shows" }, { value: "anime", label: "Anime" },
];
export const ERAS: { value: Era; label: string }[] = [
  { value: "all", label: "Any year" }, { value: "2020", label: "2020s" }, { value: "2010", label: "2010s" },
  { value: "2000", label: "2000s" }, { value: "1990", label: "1990s" }, { value: "older", label: "Older" },
];
export const SCORES: { value: ScoreFilter; label: string }[] = [
  { value: "all", label: "Any score" }, { value: "high", label: "8 and up" }, { value: "scored", label: "Scored" }, { value: "unscored", label: "Not scored" },
];

// Anime opens by its Kitsu id.
const formatOf = (i: { type: "movie" | "series"; id: string }): Format => (i.id.startsWith("kitsu:") ? "anime" : i.type);
const yearOf = (i: { year?: string }) => Number.parseInt(i.year ?? "", 10);
const eraOf = (i: { year?: string }): Era | undefined => {
  const y = yearOf(i);
  return Number.isNaN(y) ? undefined : y < 1990 ? "older" : (String(Math.min(2020, Math.floor(y / 10) * 10)) as Era);
};

export const activeFilters = (f: Filters) => [f.format !== "all", f.genres.length > 0, f.era !== "all", f.score !== "all"].filter(Boolean).length;

// Cinemeta, the Kitsu addon and TMDB name some genres differently; TMDB's TV genres come in pairs.
const GENRE_NAMES: Record<string, string[]> = {
  "Science Fiction": ["Sci-Fi"], "Sports": ["Sport"], "Action & Adventure": ["Action", "Adventure"],
  "Sci-Fi & Fantasy": ["Sci-Fi", "Fantasy"], "War & Politics": ["War", "Politics"],
};
/** Each title's genres under one set of names. */
export function genreIndex(titles: { id: string; genres: string[] }[]) {
  return new Map(titles.map((t) => [t.id, [...new Set(t.genres.flatMap((g) => GENRE_NAMES[g] ?? [g]))]]));
}

/** "Anime · Drama · 2010s · 8 and up": what the filters keep, for the line under a collection's title. */
export const filtersLabel = (f: Filters) => [
  f.format !== "all" && FORMATS.find((o) => o.value === f.format)!.label,
  f.genres.join(" + "),
  f.era !== "all" && ERAS.find((o) => o.value === f.era)!.label,
  f.score !== "all" && (f.score === "high" ? "Scored 8 and up" : SCORES.find((o) => o.value === f.score)!.label),
].filter(Boolean).join(" · ");

/** Genres come separately; a title without any yet doesn't match a genre. Several genres all have to fit, as in Search. */
export function matchesFilters(f: Filters, genres?: Map<string, string[]>) {
  return (i: { type: "movie" | "series"; id: string; year?: string; rating?: number }) =>
    (f.format === "all" || formatOf(i) === f.format) &&
    f.genres.every((g) => !!genres?.get(i.id)?.includes(g)) &&
    (f.era === "all" || eraOf(i) === f.era) &&
    (f.score === "all" || (f.score === "unscored" ? !i.rating : f.score === "scored" ? !!i.rating : (i.rating ?? 0) >= 8));
}

export type Sort = "recent" | "score" | "title" | "released";
export function sortBy<T extends { name: string; at: number; rating?: number; year?: string }>(items: T[], sort: Sort) {
  if (sort === "recent") return items;
  const byTitle = (a: T, b: T) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", ignorePunctuation: true });
  // Unknown years go last.
  const byReleased = (a: T, b: T) => (yearOf(b) || 0) - (yearOf(a) || 0) || byTitle(a, b);
  return [...items].sort(sort === "title" ? byTitle : sort === "released" ? byReleased : (a, b) => (b.rating ?? 0) - (a.rating ?? 0) || b.at - a.at);
}

/** Year · Movie, Show or Anime, under a poster. */
export const factsOf = (i: { type: "movie" | "series"; id?: string; year?: string }) =>
  [i.year?.slice(0, 4), i.id?.startsWith("kitsu:") ? "Anime" : i.type === "movie" ? "Movie" : "Show"].filter(Boolean).join(" · ");

type Shelves<T> = Record<"watching" | "rewatching" | "list" | "hold" | "dropped" | "watched", T[]>;
/** Every title once, across all of the Library's collections. */
export function allEntries<T extends { id: string }>(data: Shelves<T>) {
  const seen = new Set<string>();
  return [...data.watching, ...data.rewatching, ...data.list, ...data.hold, ...data.dropped, ...data.watched].filter((e) => !seen.has(e.id) && !!seen.add(e.id));
}
