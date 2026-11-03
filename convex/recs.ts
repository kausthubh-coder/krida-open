import { ConvexError, v } from "convex/values";
import { housemates } from "./lib/accounts";
import type { Id } from "./_generated/dataModel";
import { action, query, type MutationCtx } from "./_generated/server";
import { mutation } from "./functions";
import { fromApi } from "./legacy";
import { publicProfile, requireProfile } from "./lib/auth";
import { recItemValidator, seedValidator, tasteValidator } from "./schema";

/*
 * Each profile's personal rows on Home. They're worked out from its taste (shared/taste.ts, in the browser) by the
 * recommender on Vercel (server/recs.ts, POST /api/recs) and saved here, with the taste, which the others' "For you
 * and…" rows use. Nothing here reads anyone's history.
 */

type RecItem = typeof recItemValidator.type;

const builtRowValidator = v.object({
  kind: v.union(v.literal("picks"), v.literal("because"), v.literal("together"), v.literal("taste")),
  title: v.string(),
  seedId: v.optional(v.string()),
  seed: v.optional(seedValidator),
  genres: v.optional(v.array(v.string())),
  langs: v.optional(v.array(v.string())),
  items: v.array(recItemValidator),
});
export type Built = typeof builtRowValidator.type;

/** JSON with keys in a fixed order, so a stored row compares equal to the same row built again. */
const stable = (x: unknown): string =>
  Array.isArray(x) ? `[${x.map(stable).join(",")}]`
    : x && typeof x === "object" ? `{${Object.keys(x).filter((k) => (x as Record<string, unknown>)[k] !== undefined).sort()
      .map((k) => `${JSON.stringify(k)}:${stable((x as Record<string, unknown>)[k])}`).join(",")}}`
      : JSON.stringify(x);

/**
 * Replaces a profile's rows. Unchanged picks aren't rewritten, so Home doesn't fetch the same rows again; only the taste
 * row's time (and digest) moves, which says when they were last worked out.
 */
export async function storeRows(ctx: MutationCtx, profileId: Id<"profiles">, rows: Built[], digests: { digest: string; othersDigest: string }) {
  const old = (await ctx.db.query("recs").withIndex("by_profile", (q) => q.eq("profileId", profileId)).collect()).sort((a, b) => a.order - b.order);
  const now = Date.now();
  const fields = (r: Built) => stable([r.kind, r.title, r.seedId, r.seed, r.genres, r.langs, r.items]);
  if (old.length === rows.length && rows.every((r, i) => fields(old[i]) === fields(r))) {
    const taste = old.find((o) => o.kind === "taste");
    if (taste) await ctx.db.patch(taste._id, { computedAt: now, ...digests });
    return;
  }
  for (const o of old) await ctx.db.delete(o._id);
  // The taste row goes first, so the others can read just it (`othersDigest`).
  const ordered = [...rows.filter((r) => r.kind === "taste"), ...rows.filter((r) => r.kind !== "taste")];
  for (const [order, r] of ordered.entries())
    await ctx.db.insert("recs", { profileId, ...r, order, computedAt: now, ...(r.kind === "taste" ? digests : {}) });
}

/**
 * Saves the rows the recommender worked out for this profile (POST /api/recs) and the taste they came from, which the
 * others' "For you and…" rows use.
 */
export const save = mutation({
  args: { token: v.string(), rows: v.array(builtRowValidator), taste: tasteValidator, digest: v.string(), othersDigest: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { token, rows, taste, digest, othersDigest = "" }) => {
    const me = await requireProfile(ctx, token);
    if (rows.length > 12 || rows.some((r) => r.items.length > 30)) throw new ConvexError("Too many rows");
    await storeRows(ctx, me._id, rows, { digest, othersDigest });
    const kept = await ctx.db.query("tastes").withIndex("by_profile", (q) => q.eq("profileId", me._id)).first();
    if (kept?.digest === digest) return null;
    if (kept) await ctx.db.replace(kept._id, { profileId: me._id, taste, digest, at: Date.now() });
    else await ctx.db.insert("tastes", { profileId: me._id, taste, digest, at: Date.now() });
    return null;
  },
});

/** The other profiles' tastes, for this profile's "For you and…" rows. Asked once per recompute. */
export const others = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const me = await requireProfile(ctx, token);
    const out = [];
    for (const p of await housemates(ctx, me)) {
      const kept = await ctx.db.query("tastes").withIndex("by_profile", (q) => q.eq("profileId", p._id)).first();
      if (kept) out.push({ name: p.name, taste: kept.taste, at: kept.at });
    }
    // The recommender takes five; the ones in use lately.
    return out.sort((a, b) => b.at - a.at).slice(0, 5).map(({ name, taste }) => ({ name, taste }));
  },
});

/** A personal row on Home: why it's there, and for "Because you watched" and "For you and…" whose taste it comes from. */
export type PersonalRow = {
  key: string;
  title: string;
  style: "poster";
  /** Why the row is here, in one quiet line under the title's baseline. */
  subtitle?: string;
  seed?: typeof seedValidator.type;
  people?: ReturnType<typeof publicProfile>[];
  items: RecItem[];
};

/**
 * This profile's rows on Home (the catalog rows come from /api/rows), and what decides the rest: the genres it
 * watches most, its own row order, and whether Krida has anything to go on yet. It reads only this profile's
 * picks, so it runs again when they're recomputed, never on playback.
 */
export const rows = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const me = await requireProfile(ctx, token);
    const recs = await ctx.db.query("recs").withIndex("by_profile", (q) => q.eq("profileId", me._id)).collect();
    const profiles = await housemates(ctx, me);
    const rows: PersonalRow[] = [];
    for (const r of recs.filter((r) => r.kind !== "taste").sort((a, b) => a.order - b.order)) {
      if (r.items.length < 4) continue;
      // The first "For you and…" keeps the plain key (saved row orders use it); any more get their own.
      const key = r.kind === "because" || (r.kind === "together" && rows.some((x) => x.key === "together")) ? `${r.kind}:${r.order}` : r.kind;
      const row: PersonalRow = { key, title: r.title, style: "poster", items: r.items };
      if (r.kind === "picks") row.subtitle = r.title === "Top picks for you" ? "From what you watch and rate" : "Well rated and popular right now";
      if (r.kind === "together") {
        // Rows only carry the friend's name, in their title.
        const friend = profiles.find((p) => p._id !== me._id && r.title === `For you and ${p.name}`);
        if (friend) row.people = [publicProfile(me), publicProfile(friend)];
        row.subtitle = "From what you both watch and rate";
      }
      if (r.kind === "because") row.seed = r.seed;
      rows.push(row);
    }
    // Nothing to go on yet (no history, ratings or Simkl): Home invites this profile to change that. The
    // connection is read only then: Simkl sends write to it, and that shouldn't re-run Home.
    const personal = recs.some((r) => r.kind === "picks" && r.title === "Top picks for you");
    const simkl = personal ? null : await ctx.db
      .query("connections")
      .withIndex("by_profile", (q) => q.eq("profileId", me._id).eq("provider", "simkl"))
      .first();
    const tasteRow = recs.find((r) => r.kind === "taste");
    // The others' tastes as of their last recompute (each one's taste row, a few bytes): when one changes, "For you
    // and…" is worked out again.
    const others = [];
    for (const p of profiles) {
      const row = await ctx.db.query("recs").withIndex("by_profile", (q) => q.eq("profileId", p._id).eq("order", 0)).first();
      if (row?.kind === "taste" && row.digest) others.push(`${p._id}:${row.digest}`);
    }
    return {
      rows,
      // The genres this profile watches most, for the genre rows; null until picks have learned them.
      taste: tasteRow?.genres ?? null,
      // When these were worked out, and from which taste, so the browser knows when to work them out again.
      computedAt: tasteRow?.computedAt ?? 0,
      digest: tasteRow?.digest ?? null,
      others: others.join(","),
      othersDigest: tasteRow?.othersDigest ?? null,
      hidden: me.prefs.hiddenRows ?? [],
      order: me.prefs.rowOrder ?? [],
      coldStart: !personal && !simkl,
    };
  },
});

// For tabs on the build from before /api (convex/legacy.ts).
export const moreLikeThis = action({
  args: { token: v.string(), type: v.union(v.literal("movie"), v.literal("series")), id: v.string() },
  handler: async (_ctx, { token, type, id }) => await fromApi<unknown>("more-like", { id, type }, token),
});
