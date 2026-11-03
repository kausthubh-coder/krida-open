import { mapLimit } from "../shared/tmdb.js";
import { cached, DAY } from "./cache.js";
import type { ApiKeys } from "./http.js";
import { allRows } from "./catalogs.js";
import { featuresFor, type CatalogItem, type RecItem } from "./meta.js";
import { cultureOf, diversify, fanTrust, FLOOR, merge, qualityFrom, similarity, toRec } from "./score.js";
import { langsFor, ratingsFor, scoresFrom, similarTo, type SimilarEntry } from "./titles.js";

/** Features for titles that aren't already in the pool (TMDB suggestions), a few at a time. */
export async function featuresForMany(items: { id: string; type: "movie" | "series" }[], pool: CatalogItem[]) {
  const have = new Set(pool.map((p) => p.id));
  const wanted = [...new Map(items.filter((i) => !have.has(i.id)).map((i) => [i.id, i])).values()];
  const found = await mapLimit(wanted, 8, (i) => featuresFor(i.id, i.type).catch(() => null));
  return found.filter((x): x is CatalogItem => x !== null);
}

/** The recommender's candidates: every catalog row's titles, once each. */
export async function candidatePool(keys: ApiKeys) {
  return merge(...(await allRows(keys)).map((r) => r.items));
}

/**
 * "More like this" for a title page: what its fans also liked (TMDB), then the closest titles in the pool. The same
 * for everyone, so it's kept a week.
 */
export function moreLike(keys: ApiKeys, id: string, type: "movie" | "series"): Promise<RecItem[]> {
  return cached(`more-like:${type}:${id}`, (items) => (items.length ? 7 * DAY : DAY), async () => {
    const target = await featuresFor(id, type);
    if (!target) return [];
    const fans: SimilarEntry[] = id.startsWith("tt") ? ((await similarTo(keys, id).catch(() => null)) ?? []) : [];
    const base = await candidatePool(keys);
    if (base.length === 0) throw new Error("No catalogs to compare with");
    const pool = [...base, ...(await featuresForMany(fans, base))].filter((c) => c.id !== id);
    const targetLang = target.lang ?? (await langsFor(keys, [id], 1)).get(id);
    const fanRank = new Map(fans.map((f, i) => [f.id, (1 - i / 25) * fanTrust(targetLang, f)]));
    const fanLang = new Map(fans.flatMap((f) => (f.lang ? [[f.id, f.lang] as const] : [])));
    const { ratings } = await ratingsFor(keys, fans, 1);
    const quality = qualityFrom(ratings);
    const world = cultureOf(target, targetLang);
    const sameWorld = (c: CatalogItem) => {
      const culture = cultureOf(c, c.lang ?? fanLang.get(c.id));
      if (!world || world === "en" || !culture) return world && world !== "en" && !culture ? 0.6 : 1;
      return culture === world ? 1 : 0.45;
    };
    const ranked = pool
      .filter((item) => {
        const r = ratings.get(item.id)?.imdb ?? item.rating;
        return r === undefined || r >= FLOOR;
      })
      .map((item) => {
        const fan = fanRank.get(item.id) ?? 0;
        const sim = similarity(target, item);
        // Without TMDB's list (anime, or TMDB down) resemblance carries it alone.
        const score = fans.length ? 0.5 * fan + 0.35 * sim + 0.15 * quality(item) : 0.75 * sim + 0.25 * quality(item);
        return { item, fan, sim, score: score * sameWorld(item) };
      })
      .filter((r) => r.fan > 0.1 || (fans.length ? r.sim > 0.3 : r.score > 0.25))
      .sort((a, b) => b.score - a.score);
    const picked = diversify(ranked, 18, 0.85).map((r) => r.item);
    const { ratings: scores, trailers } = await ratingsFor(keys, picked, 1);
    return picked.map((item) => toRec(item, undefined, scoresFrom(scores.get(item.id)), trailers.get(item.id)));
  });
}
