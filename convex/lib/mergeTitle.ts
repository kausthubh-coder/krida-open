import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { titleIds } from "./titleIds";

type Entry = Pick<Doc<"tracked">, "id" | "type" | "name" | "poster" | "year">;

/**
 * Move a profile's choices saved under a title's alias onto the id Simkl tracks it by (lib/titleIds): Plan to watch,
 * status, whole-title score and "I didn't watch this". The newest status and correction win and Plan to watch keeps the
 * earliest save; a score already under the canonical id stays, as the Library shows it. Plays and season or
 * episode scores stay where they are, numbered for their own id.
 * Waits while a change under the alias is still on its way to Simkl. Says what it moved (or would, if `dryRun`).
 */
export async function mergeTitle(ctx: MutationCtx, profileId: Id<"profiles">, entry: Entry, dryRun = false): Promise<string[]> {
  const [id, alias] = await titleIds(ctx, profileId, entry.id);
  if (id !== entry.id || alias === undefined) return [];
  const waiting = await Promise.all([`list:${alias}`, `status:${alias}`, `rate:${alias}`, `unwatch:${alias}`].map((key) =>
    ctx.db.query("syncOutbox").withIndex("by_key", (q) => q.eq("profileId", profileId).eq("key", key)).first()));
  if (waiting.some(Boolean)) return [];
  const display = { type: entry.type, name: entry.name, ...(id.startsWith("tt") || !entry.poster ? {} : { poster: entry.poster }) };
  const moved: string[] = [];
  const note = (table: string, what: string) => moved.push(`${profileId} ${table} ${alias} → ${id}: ${what} (${entry.name})`);

  const listed = await ctx.db.query("library").withIndex("by_profile_imdb", (q) => q.eq("profileId", profileId).eq("imdbId", alias)).collect();
  let kept = await ctx.db.query("library").withIndex("by_profile_imdb", (q) => q.eq("profileId", profileId).eq("imdbId", id)).first();
  for (const row of listed) {
    if (kept) {
      note("library", "duplicate removed");
      if (dryRun) continue;
      await ctx.db.patch(kept._id, { addedAt: Math.min(kept.addedAt, row.addedAt), source: kept.source ?? row.source });
      await ctx.db.delete(row._id);
    } else {
      note("library", "moved");
      if (!dryRun) await ctx.db.patch(row._id, { imdbId: id, ...display, year: entry.year ?? row.year });
      kept = { ...row, imdbId: id };
    }
  }

  // One row per title in each of these.
  const keepOne = async <T extends { _id: Id<"viewing"> | Id<"feedback">; at: number }>(
    table: "viewing" | "feedback", from: T | null, to: T | null, newest: boolean) => {
    if (!from) return;
    const keepTo = to && (!newest || to.at >= from.at);
    note(table, !to ? "moved" : keepTo ? "duplicate removed" : "newer copy kept");
    if (dryRun) return;
    if (keepTo) return await ctx.db.delete(from._id);
    if (to) await ctx.db.delete(to._id);
    await ctx.db.patch(from._id, { id, ...display });
  };
  const viewing = (key: string) => ctx.db.query("viewing").withIndex("by_title", (q) => q.eq("profileId", profileId).eq("id", key)).first();
  const feedback = (key: string) => ctx.db.query("feedback").withIndex("by_profile_id", (q) => q.eq("profileId", profileId).eq("id", key)).first();
  // A status Simkl has accepted follows Simkl from then on (as in simkl.applyEntries): its entry already says it.
  const status = await viewing(alias);
  if (status && status.syncedAt !== undefined && status.state !== "rewatching") {
    note("viewing", "synced, Simkl's copy kept");
    if (!dryRun) await ctx.db.delete(status._id);
  } else await keepOne("viewing", status, await viewing(id), true);
  await keepOne("feedback", await feedback(alias), await feedback(id), false);
  // "I didn't watch this" is kept under every id of a title (library.markUnwatched): copied, not moved.
  const correction = await ctx.db.query("unwatched").withIndex("by_title", (q) => q.eq("profileId", profileId).eq("id", alias)).first();
  const own = await ctx.db.query("unwatched").withIndex("by_title", (q) => q.eq("profileId", profileId).eq("id", id)).first();
  if (correction && (!own || own.at < correction.at)) {
    note("unwatched", "copied");
    if (!dryRun) {
      const copy = { profileId, id, type: display.type, name: display.name, at: correction.at };
      if (own) await ctx.db.replace(own._id, copy);
      else await ctx.db.insert("unwatched", copy);
    }
  }
  return moved;
}
