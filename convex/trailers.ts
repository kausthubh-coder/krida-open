import { v } from "convex/values";
import { action } from "./_generated/server";
import { fromApi } from "./legacy";

// For tabs on the build from before /api (convex/legacy.ts).
export const imdb = action({
  args: { token: v.string(), ids: v.array(v.string()) },
  handler: async (_ctx, { ids }) => await fromApi<unknown>("trailers", { ids: [...new Set(ids)].slice(0, 30).sort().join(",") }),
});
