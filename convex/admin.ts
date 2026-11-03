import { v } from "convex/values";
import { internalMutation } from "./functions";
import { assertSafeTarget } from "./lib/deployment";

/** Clears watch activity (rooms, chat, invites, progress, saved lists, sessions). Profiles stay. */
export const resetActivity = internalMutation({
  args: { confirmProd: v.optional(v.boolean()) },
  handler: async (ctx, { confirmProd }) => {
    assertSafeTarget("admin:resetActivity", confirmProd);
    const tables = ["messages", "invites", "roomMembers", "rooms", "progress", "library", "sessions", "sourceLists", "sourceFetches", "streams"] as const;
    const counts: Record<string, number> = {};
    for (const table of tables) {
      const rows = await ctx.db.query(table).collect();
      for (const r of rows) {
        if ("file" in r && r.file) await ctx.storage.delete(r.file);
        await ctx.db.delete(r._id);
      }
      counts[table] = rows.length;
    }
    return counts;
  },
});
