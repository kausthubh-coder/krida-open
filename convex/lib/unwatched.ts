import type { QueryCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

/** Titles this profile said it didn't watch, and when: history from before then is hidden. */
export async function unwatchedFor(ctx: QueryCtx, profileId: Id<"profiles">) {
  const rows = await ctx.db.query("unwatched").withIndex("by_title", (q) => q.eq("profileId", profileId)).take(2000);
  return new Map(rows.map((r) => [r.id, r.at]));
}

/** Watching it again after saying you didn't brings it back. */
export const hiddenBy = (unwatched: Map<string, number>, id: string, at: number | undefined) => {
  const since = unwatched.get(id);
  return since !== undefined && (at === undefined || at <= since);
};
