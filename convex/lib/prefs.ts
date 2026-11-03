import { v, type Infer } from "convex/values";
import type { prefsValidator } from "../schema";

type Prefs = Infer<typeof prefsValidator>;

/**
 * Some of a profile's settings. `null` clears a setting that can be unset (`subLang: null` turns subtitles off,
 * `heroRow: null` clears the banner's row); an absent field means "unchanged".
 */
export const prefsPatchValidator = v.object({
  audioLang: v.optional(v.string()),
  subLang: v.optional(v.union(v.string(), v.null())),
  sounds: v.optional(v.boolean()),
  hiddenRows: v.optional(v.array(v.string())),
  rowOrder: v.optional(v.array(v.string())),
  pinnedRows: v.optional(v.array(v.string())),
  // `null` goes back to Krida's own banner.
  heroRow: v.optional(v.union(v.string(), v.null())),
  rowNames: v.optional(v.array(v.object({ key: v.string(), name: v.string() }))),
  typeHiddenRows: v.optional(v.array(v.string())),
  hideUnreleased: v.optional(v.boolean()),
  skipIntro: v.optional(v.boolean()),
  skipRecap: v.optional(v.boolean()),
  autoNext: v.optional(v.boolean()),
  trailers: v.optional(v.boolean()),
  private: v.optional(v.boolean()),
  blurUnwatched: v.optional(v.boolean()),
  // `null` goes back to the default: the last episode played, upcoming episodes in Continue watching.
  nextUpFrom: v.optional(v.union(v.literal("furthest"), v.literal("last"), v.null())),
  upcoming: v.optional(v.union(v.literal("row"), v.literal("hide"), v.null())),
  reuseSource: v.optional(v.boolean()),
  sourceFilter: v.optional(v.union(v.string(), v.null())),
  subLang2: v.optional(v.union(v.string(), v.null())),
  subtitleSize: v.optional(v.union(v.literal("small"), v.literal("medium"), v.literal("large"), v.literal("huge"))),
  subtitleColor: v.optional(v.union(v.literal("white"), v.literal("yellow"), v.literal("cyan"))),
  subtitleEdge: v.optional(v.union(v.literal("shadow"), v.literal("outline"), v.literal("box"))),
});
export type PrefsPatch = Infer<typeof prefsPatchValidator>;

/** Shared by the server and the client's optimistic update, so both land on the same settings. */
export function mergePrefs<P extends Prefs>(prefs: P, patch: PrefsPatch): P {
  const merged: Record<string, unknown> = { ...prefs };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete merged[key];
    else if (value !== undefined) merged[key] = value;
  }
  return merged as P;
}
