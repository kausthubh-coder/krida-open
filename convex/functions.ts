import { customCtx, customMutation } from "convex-helpers/server/customFunctions";
import { Triggers } from "convex-helpers/server/triggers";
import type { DataModel } from "./_generated/dataModel";
// oxlint-disable-next-line no-restricted-imports
import { internalMutation as rawInternalMutation, mutation as rawMutation } from "./_generated/server";
import { SYNCED, type Synced } from "./lib/synced";

/*
 * Every mutation is defined with these, never with _generated/server's: a write to one of a profile's own tables also
 * notes the change, so browsers keep their copy of those tables in step by fetching only what changed (sync.ts).
 */

export { SYNCED, type Synced };

const triggers = new Triggers<DataModel>();
for (const table of SYNCED)
  triggers.register(table, async (ctx, change) => {
    const profileId = (change.newDoc ?? change.oldDoc).profileId;
    // One row per document, moved forward on each change: a play saving every minute stays one row.
    const row = await ctx.innerDb.query("changes").withIndex("by_doc", (q) => q.eq("docId", change.id)).first();
    if (row) await ctx.innerDb.patch(row._id, { at: Date.now() });
    else await ctx.innerDb.insert("changes", { profileId, table, docId: change.id, at: Date.now() });
  });

export const mutation = customMutation(rawMutation, customCtx(triggers.wrapDB));
export const internalMutation = customMutation(rawInternalMutation, customCtx(triggers.wrapDB));
