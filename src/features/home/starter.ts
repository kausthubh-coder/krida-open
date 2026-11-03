import { scoreOf } from "../../../convex/lib/ratings";
import type { OwnRows, SimklRow } from "../../../convex/lib/libraryViews";
import type { RecItem } from "../../data/api";

export type StarterItem = Pick<RecItem, "id" | "type" | "name" | "poster" | "year"> & { rating: number | null };
export type StarterBatch = { items: StarterItem[]; fromHistory: number };

/**
 * Titles for a new profile to rate: what it watched on Simkl but never rated, most recent first, then well-known titles
 * from every genre (/api/starter). Ones already rated keep their score.
 */
export function starterBatch(simkl: SimklRow[], own: OwnRows, popular: StarterItem[]): StarterBatch {
  const rated = new Map(own.feedback.map((f) => [f.id, scoreOf(f)]));
  const history = simkl
    .filter((t) => (t.status === "completed" || t.status === "watching") && (rated.has(t.id) ? rated.get(t.id) === null : t.rating === undefined))
    .sort((a, b) => (b.lastWatchedAt ?? 0) - (a.lastWatchedAt ?? 0))
    .slice(0, 32)
    .map((t) => ({ id: t.id, type: t.type, name: t.name, poster: t.id.startsWith("tt") ? undefined : t.poster, year: t.year, rating: null }));
  const seen = new Set(history.map((h) => h.id));
  const others = popular.filter((x) => !seen.has(x.id)).map((x) => ({ ...x, rating: rated.get(x.id) ?? null }));
  return { items: [...history, ...others].slice(0, 48), fromHistory: history.length };
}
