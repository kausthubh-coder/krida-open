import { tmdb, tmdbImage, yearOf, type TmdbItem, type TmdbType } from "../shared/tmdb.js";
import { cached, DAY } from "./cache.js";
import type { SearchResult } from "./search.js";
import { found, imdbForTmdb, kindOf } from "./titles.js";
import type { ApiKeys } from "./http.js";

/*
 * A person's page: who they are and what they made, from TMDB, grouped by what they did (directed, wrote, acted…),
 * each group best known first. A title page names its cast and crew without TMDB's ids, so a name is looked up among
 * that title's own credits first, where two people can't share it, and only then by TMDB's person search.
 */

export type PersonTitle = SearchResult & { character?: string };
export type PersonGroup = { title: string; titles: PersonTitle[] };
export type PersonPage = {
  id: number;
  name: string;
  role: string;
  photo?: string;
  bio?: string;
  born?: string;
  died?: string;
  place?: string;
  groups: PersonGroup[];
};

type Credit = TmdbItem & { department?: string };
type Person = {
  id: number;
  name: string;
  biography?: string;
  birthday?: string | null;
  deathday?: string | null;
  place_of_birth?: string | null;
  profile_path?: string | null;
  known_for_department?: string;
  combined_credits: { cast: Credit[]; crew: Credit[] };
};

/** What each group holds, in the order they show when nothing says otherwise. */
const GROUPS: { title: string; department: string; jobs?: string[] }[] = [
  { title: "Director", department: "Directing", jobs: ["Director"] },
  { title: "Writer", department: "Writing", jobs: ["Screenplay", "Writer", "Story", "Novel", "Teleplay", "Author"] },
  { title: "Creator", department: "Writing", jobs: ["Creator"] },
  { title: "Actor", department: "Acting" },
  { title: "Composer", department: "Sound", jobs: ["Original Music Composer", "Music"] },
  { title: "Cinematographer", department: "Camera", jobs: ["Director of Photography"] },
  { title: "Producer", department: "Production", jobs: ["Producer"] },
];
/** Titles a group keeps: more than a row shows, few enough that a first visit maps their IMDb ids in a second or two. */
const PER_GROUP = 30;
// Talk shows, news and reality TV: appearances as themselves, not roles.
const NOT_ROLES = new Set([10767, 10763, 10764]);
const AS_SELF = /\b(self|himself|herself|themselves|narrator \(voice\))\b/i;

const norm = (x: string) => x.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Each title once, the most-voted first, with this person's part in it. */
function pick(credits: Credit[]) {
  const seen = new Set<string>();
  return credits
    .filter((c) => (c.media_type === "movie" || c.media_type === "tv") && c.poster_path && (c.vote_count ?? 0) >= 10)
    .sort((a, b) => (b.vote_count ?? 0) - (a.vote_count ?? 0))
    .filter((c) => {
      const key = `${c.media_type}:${c.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, PER_GROUP);
}

function groupsOf(person: Person) {
  const { cast, crew } = person.combined_credits;
  const roles = cast.filter(
    (c) => !c.genre_ids?.some((g) => NOT_ROLES.has(g)) && !AS_SELF.test(c.character ?? "") && !(c.media_type === "tv" && (c.episode_count ?? 99) < 2),
  );
  const groups = GROUPS.map((g) => ({
    ...g,
    credits: pick(g.jobs ? crew.filter((c) => g.jobs!.includes(c.job ?? "")) : roles),
  })).filter((g) => g.credits.length > 0);
  // What they're known for leads; the rest by how much of it there is.
  const known = person.known_for_department;
  return groups.sort((a, b) => Number(b.department === known) - Number(a.department === known) || b.credits.length - a.credits.length);
}

const roleOf = (department: string | undefined) =>
  GROUPS.find((g) => g.department === department)?.title ?? department ?? "";

/** One person's page by TMDB id, or null when TMDB has nobody there. Kept a week. */
export function personPage(keys: ApiKeys, id: number): Promise<PersonPage | null> {
  return cached(`person:${id}`, (p) => (p ? 7 * DAY : DAY), async () => {
    const person = await tmdb<Person>(keys.tmdb, `/person/${id}`, { append_to_response: "combined_credits" }).catch((error: unknown) => {
      if (error instanceof Error && error.message.includes(" 404 ")) return null;
      throw error;
    });
    if (!person) return null;
    const groups = groupsOf(person);
    const ids = await imdbForTmdb(keys, groups.flatMap((g) => g.credits.map((c) => ({ tmdbId: c.id, tmdbType: c.media_type as TmdbType }))));
    return {
      id: person.id,
      name: person.name,
      role: groups[0]?.title ?? roleOf(person.known_for_department),
      photo: tmdbImage(person.profile_path, "w500"),
      bio: person.biography?.trim() || undefined,
      born: person.birthday ?? undefined,
      died: person.deathday ?? undefined,
      place: person.place_of_birth ?? undefined,
      groups: groups.flatMap((g) => {
        const titles = g.credits.flatMap((c): PersonTitle[] => {
          const t = c.media_type as TmdbType;
          const imdb = ids.get(`${t}:${c.id}`);
          if (!imdb) return [];
          return [{
            id: imdb,
            type: kindOf(t),
            name: c.title ?? c.name ?? c.original_name ?? "Untitled",
            poster: tmdbImage(c.poster_path, "w342"),
            year: yearOf(c),
            rating: c.vote_count && c.vote_count >= 20 && c.vote_average ? Math.round(c.vote_average * 10) / 10 : undefined,
            character: (g.department === "Acting" && c.character?.replace(/\s*\(uncredited\)/i, "").trim()) || undefined,
          }];
        });
        return titles.length ? [{ title: g.title, titles }] : [];
      // A side job with one title (a director's cameo) would be a row of one: left out.
      }).filter((g, i) => i === 0 || g.titles.length > 1),
    };
  });
}

/**
 * TMDB's id for a person a title page names: from that title's credits when it has an IMDb id, else the best-known
 * person by that name. Kept a month.
 */
export function personIdFor(keys: ApiKeys, name: string, titleId?: string): Promise<number | null> {
  const key = norm(name);
  return cached(`person-of:${titleId ?? ""}:${key}`, (id) => (id ? 30 * DAY : DAY), async () => {
    const title = titleId?.startsWith("tt") ? await found(keys, titleId) : null;
    if (title) {
      // A show's credits across all its seasons; a film's own.
      const path = title.tmdbType === "tv" ? `/tv/${title.tmdbId}/aggregate_credits` : `/movie/${title.tmdbId}/credits`;
      const credits = await tmdb<{ cast: TmdbItem[]; crew: TmdbItem[] }>(keys.tmdb, path);
      const match = [...credits.cast, ...credits.crew].find((p) => norm(p.name ?? "") === key);
      if (match) return match.id;
    }
    const { results } = await tmdb<{ results: TmdbItem[] }>(keys.tmdb, "/search/person", { query: name, include_adult: "false" });
    const [best] = results.filter((p) => norm(p.name ?? "") === key).sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0));
    return (best ?? results[0])?.id ?? null;
  });
}
