import type { MutationCtx } from "../convex/_generated/server";

/**
 * An account for test profiles to share, as every profile but a temporary guest is in one. With `torbox` it has a
 * TorBox key, which parties need.
 */
export async function household(ctx: MutationCtx, name = "Home", torbox = true) {
  const accountId = await ctx.db.insert("accounts", { name, createdAt: Date.now() });
  if (torbox) await ctx.db.insert("accountKeys", { accountId, debrid: { service: "torbox", key: `${name}-torbox` }, updatedAt: Date.now() });
  return accountId;
}
