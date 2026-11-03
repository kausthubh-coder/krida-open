import { v, type Infer } from "convex/values";

const type = v.union(v.literal("movie"), v.literal("series"));
const kind = v.union(v.literal("anime"), v.literal("show"), v.literal("movie"));
const ref = { id: v.string(), type, name: v.string(), poster: v.optional(v.string()) };

export const STATS_VERSION = 1;

/** One stretch of time: everything ("all") or a calendar year ("2026"). Minutes are estimates from runtimes. */
const periodValidator = v.object({
  key: v.string(),
  minutes: v.number(),
  // Share of those minutes that used a typical runtime because the real one is unknown.
  estimatedShare: v.number(),
  episodes: v.number(),
  movies: v.number(),
  showsFinished: v.number(),
  titles: v.number(),
  animeShare: v.number(),
  // Minutes by kind; missing on stats computed before it was kept.
  kinds: v.optional(v.object({ anime: v.number(), show: v.number(), movie: v.number() })),
  // Real, dated watching only. Bulk-logged history is counted once in `bulkMinutes` instead.
  months: v.array(v.object({ month: v.string(), anime: v.number(), show: v.number(), movie: v.number() })),
  bulkMinutes: v.number(),
  bulkTitles: v.number(),
  // Starts by local hour and weekday (0 is Sunday), from watching with a real time.
  clock: v.array(v.number()),
  weekdays: v.array(v.number()),
  sessions: v.number(),
  medianStart: v.optional(v.number()),
  top: v.array(v.object({ ...ref, minutes: v.number(), episodes: v.number() })),
  genres: v.array(v.object({ name: v.string(), share: v.number() })),
  scores: v.object({ count: v.number(), average: v.optional(v.number()), hist: v.array(v.number()), tens: v.number() }),
  binge: v.optional(v.object({ ...ref, episodes: v.number(), days: v.number(), from: v.number(), to: v.number() })),
  gap: v.optional(v.object({ from: v.number(), to: v.number(), days: v.number() })),
});

export const statsValidator = v.object({
  coverage: v.object({
    titles: v.number(),
    since: v.optional(v.number()),
    kridaSince: v.optional(v.number()),
    bulkTitles: v.number(),
    // Titles with genres and people known, out of those wanted.
    factsFor: v.number(),
    factsWanted: v.number(),
    // Simkl history imported before per-episode times were kept.
    undated: v.boolean(),
  }),
  periods: v.array(periodValidator),
  finish: v.object({ animeStarted: v.number(), animeFinished: v.number(), showsStarted: v.number(), showsFinished: v.number() }),
  decades: v.array(v.object({ decade: v.number(), count: v.number() })),
  people: v.array(v.object({ name: v.string(), role: v.union(v.literal("cast"), v.literal("director")), count: v.number(), ids: v.array(v.string()) })),
  taste: v.object({
    points: v.array(v.object({ id: v.string(), name: v.string(), x: v.number(), y: v.number(), kind, score: v.optional(v.number()) })),
    drift: v.array(v.object({ year: v.number(), x: v.number(), y: v.number() })),
    labels: v.array(v.object({ x: v.number(), y: v.number(), text: v.string() })),
  }),
  friend: v.optional(v.object({
    name: v.string(), hue: v.number(), bothScored: v.number(), agreement: v.optional(v.number()),
    averageGap: v.optional(v.number()),
    split: v.optional(v.object({ ...ref, mine: v.number(), theirs: v.number() })),
    togetherMinutes: v.number(), parties: v.number(),
    // Titles you scored that they have probably seen too, to ask them about.
    ask: v.array(v.object(ref)),
  })),
  insights: v.array(v.object({ key: v.string(), title: v.string(), detail: v.optional(v.string()), ref: v.optional(v.object(ref)) })),
  persona: v.object({ name: v.string(), line: v.string(), tags: v.array(v.string()) }),
  planned: v.object({ count: v.number(), oldest: v.optional(v.object({ ...ref, addedAt: v.number() })), monthsToClear: v.optional(v.number()) }),
});

export type Stats = Infer<typeof statsValidator>;
export type Period = Infer<typeof periodValidator>;
export type Kind = Infer<typeof kind>;
