import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { ConvexError } from "convex/values";
import { isTitleId } from "../../shared/ids";

// The browser imports this file too; runtime imports must stay browser-safe.

/*
 * One title can have two ids: an anime opens by its IMDb id from Home, Search and TMDB, and by its Kitsu id from
 * the Kitsu addon and Simkl's import. A profile's choices about a title (Plan to watch, status, whole-title score,
 * "I didn't watch this") live under the id Simkl tracks it by; the other id is an alias of it. Plays, episode
 * marks and season or episode scores stay under the id they were made with, since episodes are numbered
 * differently (Kitsu entries are one season, numbered flat).
 *
 * An IMDb id shared by several tracked entries (each season of an anime is its own Kitsu entry) is ambiguous
 * and stays its own title.
 */

type Tracked = { id: string; imdb?: string };

/** Each alias in a profile's Simkl history, and the id its title lives under. */
export function aliasesOf(tracked: readonly Tracked[]): Map<string, string> {
  const ids = new Set(tracked.map((t) => t.id));
  const entries = new Map<string, number>();
  for (const t of tracked) if (t.imdb && t.imdb !== t.id) entries.set(t.imdb, (entries.get(t.imdb) ?? 0) + 1);
  const out = new Map<string, string>();
  for (const t of tracked) if (t.imdb && entries.get(t.imdb) === 1 && !ids.has(t.imdb)) out.set(t.imdb, t.id);
  return out;
}

/** The id a title's choices live under, given `aliasesOf` for the profile. */
export const canonicalWith = (aliases: Map<string, string>) => (id: string) => aliases.get(id) ?? id;

/** The same rule with indexes: the id a title's choices live under, then its alias if it has one. */
export async function titleIds(ctx: QueryCtx, profileId: Id<"profiles">, id: string): Promise<[string] | [string, string]> {
  const entriesFor = (imdb: string) =>
    ctx.db.query("tracked").withIndex("by_profile_imdb", (q) => q.eq("profileId", profileId).eq("imdb", imdb)).take(2);
  const own = await ctx.db.query("tracked").withIndex("by_profile_id", (q) => q.eq("profileId", profileId).eq("id", id)).first();
  if (own) {
    const imdb = own.imdb;
    if (!imdb || imdb === id || (await entriesFor(imdb)).length !== 1) return [id];
    const taken = await ctx.db.query("tracked").withIndex("by_profile_id", (q) => q.eq("profileId", profileId).eq("id", imdb)).first();
    return taken ? [id] : [id, imdb];
  }
  if (!id.startsWith("tt")) return [id];
  const entries = await entriesFor(id);
  return entries.length === 1 ? [entries[0].id, id] : [id];
}

/** The id a title's choices live under. Only an IMDb id can be an alias, so other ids cost no reads. */
export async function canonicalId(ctx: QueryCtx, profileId: Id<"profiles">, id: string) {
  return id.startsWith("tt") ? (await titleIds(ctx, profileId, id))[0] : id;
}

/** A title as a choice about it is stored: under its canonical id, named as Simkl knows it. */
export async function canonicalTitle<T extends { id: string; type: "movie" | "series"; name: string; poster?: string; year?: string }>(
  ctx: QueryCtx, profileId: Id<"profiles">, item: T): Promise<T> {
  const id = await canonicalId(ctx, profileId, item.id);
  if (id === item.id) return item;
  const t = (await ctx.db.query("tracked").withIndex("by_profile_id", (q) => q.eq("profileId", profileId).eq("id", id)).first())!;
  // Simkl posters are kept for anime only; IMDb titles have Metahub artwork.
  return { ...item, id, type: t.type, name: t.name, poster: id.startsWith("tt") ? undefined : t.poster ?? item.poster,
    // Only items that carry a year get one: some go straight into tables without it.
    ...("year" in item ? { year: t.year ?? item.year } : {}) };
}

/** Refuses an id that isn't an IMDb or Kitsu id, before anything is written under it. */
export function assertTitleId(id: string) {
  if (!isTitleId(id)) throw new ConvexError("This title does not have a supported ID yet.");
}
