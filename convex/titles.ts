import { v } from "convex/values";
import { action } from "./_generated/server";
import { fromApi } from "./legacy";

const kind = v.union(v.literal("movie"), v.literal("series"));
const page = (p: number | null) => (p === null ? "-" : String(p));

// For tabs on the build from before /api (convex/legacy.ts).
export const search = action({
  args: { token: v.string(), q: v.string() },
  handler: async (_ctx, { q }) => await fromApi<unknown>("search", { q }),
});

export const searchPage = action({
  args: { token: v.string(), q: v.string(), cursor: v.object({ movie: v.union(v.number(), v.null()), tv: v.union(v.number(), v.null()), multi: v.union(v.number(), v.null()) }) },
  handler: async (_ctx, { q, cursor }) => await fromApi<unknown>("search-page", { q, cursor: [cursor.movie, cursor.tv, cursor.multi].map(page).join(",") }),
});

export const info = action({
  args: { token: v.string(), type: kind, id: v.string() },
  handler: async (_ctx, { token, type, id }) => (id.startsWith("tt") ? await fromApi<unknown>("title", { id, type }, token) : null),
});

export const artwork = action({
  args: { token: v.string(), id: v.string(), name: v.optional(v.string()), year: v.optional(v.string()), type: v.optional(kind) },
  handler: async (_ctx, { id, name, year, type }) => await fromApi<unknown>("artwork", { id, name, year, type }),
});

export const animeBackdrop = action({
  args: { token: v.string(), tmdbId: v.string(), type: kind },
  handler: async (_ctx, { tmdbId, type }) => await fromApi<unknown>("anime-backdrop", { tmdbId, type }),
});
