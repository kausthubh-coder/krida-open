import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";

// Stats opened this recently are kept up to date as things change; otherwise they wait until Stats is opened
// again (wrapped.refreshSoon). A rebuild reads the whole history, and marking a season used to start one per tap.
export const STATS_VIEWING_MS = 15 * 60 * 1000;
// Changes this close together share one rebuild.
export const STATS_SETTLE_MS = 8_000;

/** Hide old insights immediately after a correction; a running computation cannot restore them. */
export async function invalidateStats(ctx: MutationCtx, profileId: Id<"profiles">) {
  const row = await ctx.db.query("wrapped").withIndex("by_profile", (q) => q.eq("profileId", profileId)).first();
  if (!row) return;
  const job = row.jobId ? await ctx.db.system.get(row.jobId) : null;
  const running = job?.state.kind === "pending" || job?.state.kind === "inProgress";
  const watched = row.viewedAt !== undefined && Date.now() - row.viewedAt < STATS_VIEWING_MS;
  // Already hidden with nothing to tell: no write, so nothing re-runs.
  if (!running && !watched && row.stats === undefined && row.computedAt === 0 && !row.jobId) return;
  const jobId = running ? row.jobId : watched ? await ctx.scheduler.runAfter(STATS_SETTLE_MS, internal.wrapped.compute, { profileId }) : undefined;
  await ctx.db.patch(row._id, { revision: (row.revision ?? 0) + 1, stats: undefined, computedAt: 0, jobId });
}
