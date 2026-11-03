import { parseTags } from "../../../../shared/tags";

type Named = { name: string; year?: string };

/** "The Lord of the Rings: Return…" and "lord of the rings return" read the same; scripts other than Latin keep their marks. */
export function normalizeTitle(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .trim()
    .replace(/^(the|a|an) (?=\S)/, "");
}

const compact = (normalized: string) => normalized.replace(/ /g, "");
/** "spiderman" for "Spider-Man", "dune" for "dune". */
const same = (a: string, b: string) => a === b || compact(a) === compact(b);
/** The name before its subtitle: "dune" for "Dune: Part Two". */
const mainTitle = (name: string) => normalizeTitle(name.split(/:| - | – /)[0]);
const startYear = (year?: string) => year?.match(/\d{4}/)?.[0];

/** One typo apart, for names long enough that a typo can't turn them into another word. */
function oneEditApart(a: string, b: string) {
  if (Math.min(a.length, b.length) < 5 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  const rest = (x: string, skip: number) => x.slice(i + skip);
  return rest(a, 1) === rest(b, 1) || rest(a, 1) === rest(b, 0) || rest(a, 0) === rest(b, 1);
}

/** How far down the server's ranking an exact name can sit and still be what was meant. */
const EXACT_WITHIN = 3;
const YEAR_WITHIN = 10;

/**
 * The one title a search clearly names, or null for broad searches. It has to be named exactly
 * ("dune", "the office", "amelie"), named with its year ("dune 1984", "dune 2024" for Dune: Part Two),
 * or one typo off with its year ("intersteller 2014"). An exact name lower than TMDB's top three is
 * an obscure namesake of a broad word ("spider"), so it doesn't count. Tags and people never do.
 */
export function pickTopResult<T extends Named>(query: string, results: T[], person?: { name: string } | null): T | null {
  const q = normalizeTitle(query);
  if (q.length < 2 || parseTags(query)) return null;
  if (person) {
    const name = normalizeTitle(person.name);
    if (name.includes(q) || q.includes(name)) return null;
  }
  const exact = results.slice(0, EXACT_WITHIN).find((r) => same(normalizeTitle(r.name), q));
  if (exact) return exact;
  const dated = /^(.+) ((?:19|20)\d{2})$/.exec(q);
  if (!dated) return null;
  const [, title, year] = dated;
  return (
    results.slice(0, YEAR_WITHIN).find((r) => {
      if (startYear(r.year) !== year) return false;
      const name = normalizeTitle(r.name);
      return same(name, title) || same(mainTitle(r.name), title) || oneEditApart(compact(name), compact(title));
    }) ?? null
  );
}

/** Other results named like the query ("Dune: Prophecy", "Jodorowsky's Dune"), in the server's order. */
export function alsoMatching<T extends Named>(query: string, results: T[], top: T, limit = 4): T[] {
  const q = normalizeTitle(query).replace(/ (?:19|20)\d{2}$/, "");
  const words = new RegExp(`(^| )${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( |$)`);
  return results
    .filter((r) => r !== top && (words.test(normalizeTitle(r.name)) || compact(normalizeTitle(r.name)).includes(compact(q))))
    .slice(0, limit);
}
