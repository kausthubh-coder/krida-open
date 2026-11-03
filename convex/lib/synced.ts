/**
 * A profile's own tables, which each of its browsers keeps a copy of (convex/sync.ts, src/data/sync.tsx). Written
 * once, here, so the server and the browser can't disagree. The first table's snapshot also fixes where the next pull
 * starts, so it stays first.
 */
export const SYNCED = ["tracked", "viewing", "library", "feedback", "partRatings", "unwatched", "progress"] as const;
export type Synced = (typeof SYNCED)[number];
