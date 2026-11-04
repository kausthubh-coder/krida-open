import { v, type Infer } from "convex/values";
import { action, internalQuery, query } from "./_generated/server";
import { internalMutation, mutation } from "./functions";
import { internal } from "./_generated/api";
import { profileFromToken, sessionOf } from "./lib/auth";
import { accountOf, canPlayAlone, debridServiceValidator, debridValidator, keysRow, requireAccount } from "./lib/accounts";
import { askProvider } from "./lib/keyCheck";

/*
 * Onboarding, as docs/models/Onboarding.tla describes it: after a profile, the account's TMDB key (or a skip), its
 * debrid service (or a skip), this profile's addons (or a skip), then the optional keys, then Home. `status` is all the
 * app routes on (src/features/onboarding/route.ts); progress lives on the account and the profile, so it resumes on
 * another device. Keys are checked when pasted (accounts.save) and again now and then (`recheck`), so a key its
 * provider stops accepting sends the person back to fix it.
 */

const statusValidator = v.object({
  tmdb: v.union(v.literal("none"), v.literal("valid"), v.literal("invalid")),
  // Past the TMDB step: a key that works, or skipped (since the saved key last stopped working). Unset from servers
  // before it, when the step couldn't be skipped.
  tmdbAsked: v.optional(v.boolean()),
  debrid: v.union(v.object({ service: debridServiceValidator, valid: v.boolean() }), v.null()),
  // Parties, timeline previews and playing any file in the browser: a TorBox key TorBox still accepts.
  torbox: v.boolean(),
  // Playing alone: any debrid key its service still accepts (another service's files play in the browser when they're
  // MP4 or WebM, else in the desktop app or an external player), or a stream addon, whose plain web videos play with
  // no debrid service (lib/accounts.ts canPlayAlone). Unset from servers before it.
  play: v.optional(v.boolean()),
  debridAsked: v.boolean(),
  addons: v.union(v.literal("todo"), v.literal("installed"), v.literal("skipped")),
  extrasAsked: v.boolean(),
  mdblist: v.boolean(),
});
export type OnboardingStatus = Infer<typeof statusValidator>;

/** Where this session's account and profile are in onboarding. Null for no session, or a party guest (no account). */
export const status = query({
  args: { token: v.string() },
  returns: v.union(statusValidator, v.null()),
  handler: async (ctx, { token }): Promise<OnboardingStatus | null> => {
    const profile = await profileFromToken(ctx, token);
    const account = profile && (await accountOf(ctx, profile));
    if (!profile || !account) return null;
    const row = await keysRow(ctx, account._id);
    const debrid = row?.debrid ? { service: row.debrid.service, valid: row.debridRefusedAt === undefined } : null;
    const hasAddon = (await ctx.db.query("addons").withIndex("by_profile", (q) => q.eq("profileId", profile._id)).first()) !== null;
    const tmdb = !row?.tmdb ? "none" : row.tmdbRefusedAt === undefined ? "valid" : "invalid";
    const debridAsked = account.debridAskedAt !== undefined || debrid !== null;
    const skipped = account.tmdbAskedAt;
    return {
      tmdb,
      // A key that stopped working asks again until it's replaced or skipped after that. Past the debrid step with no
      // key, the account went past this step before (a key removed in Settings leaves it there).
      tmdbAsked:
        tmdb === "valid" ||
        (tmdb === "invalid" ? skipped !== undefined && skipped >= row!.tmdbRefusedAt! : skipped !== undefined || debridAsked),
      debrid,
      torbox: debrid?.service === "torbox" && debrid.valid,
      play: await canPlayAlone(ctx, profile),
      debridAsked,
      addons: profile.addonsStep ?? (hasAddon ? "installed" : "todo"),
      extrasAsked: account.extrasAskedAt !== undefined || !!row?.mdblist,
      mdblist: !!row?.mdblist,
    };
  },
});

/**
 * Goes past the TMDB step without a key that works: Home, Search and title pages then use the addons and Cinemeta,
 * and leave out what only TMDB has. Asked again only when a key saved later stops working.
 */
export const skipTmdb = mutation({
  args: { token: v.string() },
  returns: v.null(),
  handler: async (ctx, { token }) => {
    const { account } = await requireAccount(ctx, token);
    await ctx.db.patch(account._id, { tmdbAskedAt: Date.now() });
    return null;
  },
});

/**
 * Goes past a step that can be skipped: the debrid service and the optional keys for the account, the addons for
 * this profile (installed when it has any by then, else skipped).
 */
export const pass = mutation({
  args: { token: v.string(), step: v.union(v.literal("debrid"), v.literal("addons"), v.literal("extras")) },
  returns: v.null(),
  handler: async (ctx, { token, step }) => {
    const { profile, account } = await requireAccount(ctx, token);
    if (step === "debrid") {
      if (account.debridAskedAt === undefined) await ctx.db.patch(account._id, { debridAskedAt: Date.now() });
    } else if (step === "extras") {
      if (account.extrasAskedAt === undefined) await ctx.db.patch(account._id, { extrasAskedAt: Date.now() });
    } else {
      const hasAddon = (await ctx.db.query("addons").withIndex("by_profile", (q) => q.eq("profileId", profile._id)).first()) !== null;
      await ctx.db.patch(profile._id, { addonsStep: hasAddon ? "installed" : "skipped" });
    }
    return null;
  },
});

// Opening Krida asks again at most this often; a refusal /api just saw (`force`) at most this often.
const RECHECK_MS = 6 * 60 * 60_000;
const FORCED_RECHECK_MS = 60_000;

/**
 * Asks TMDB and the debrid service whether the account's saved keys still work, and marks each one its provider now
 * turns down (an unreachable provider changes nothing). The app calls it when it opens and when /api says TMDB
 * refused the key; the providers decide, so a browser can't mark a working key dead.
 */
export const recheck = action({
  args: { token: v.string(), force: v.optional(v.boolean()) },
  returns: v.null(),
  handler: async (ctx, { token, force }) => {
    const due = await ctx.runQuery(internal.onboarding.recheckDue, { token, force: force ?? false });
    if (!due) return null;
    const [tmdb, debrid] = await Promise.all([
      due.tmdb ? askProvider("tmdb", due.tmdb) : null,
      due.debrid ? askProvider("debrid", due.debrid.key, due.debrid.service) : null,
    ]);
    await ctx.runMutation(internal.onboarding.recordCheck, {
      accountId: due.accountId,
      tmdb: due.tmdb && tmdb ? { key: due.tmdb, refused: tmdb === "refused", known: tmdb === "ok" || tmdb === "refused" } : undefined,
      debrid: due.debrid && debrid ? { key: due.debrid.key, refused: debrid === "refused", known: debrid === "ok" || debrid === "refused" } : undefined,
    });
    return null;
  },
});

export const recheckDue = internalQuery({
  args: { token: v.string(), force: v.boolean() },
  returns: v.union(v.object({ accountId: v.id("accounts"), tmdb: v.optional(v.string()), debrid: v.optional(debridValidator) }), v.null()),
  handler: async (ctx, { token, force }) => {
    // Only a Clerk sign-in's keys: a QA sign-in (local and dev) runs on seeded stand-in keys no provider knows.
    if (!(await sessionOf(ctx, token))?.clerkUserId) return null;
    const profile = await profileFromToken(ctx, token);
    if (!profile?.accountId) return null;
    const row = await keysRow(ctx, profile.accountId);
    if (!row || (!row.tmdb && !row.debrid)) return null;
    if (row.checkedAt !== undefined && Date.now() - row.checkedAt < (force ? FORCED_RECHECK_MS : RECHECK_MS)) return null;
    return { accountId: profile.accountId, tmdb: row.tmdb, debrid: row.debrid };
  },
});

const verdictValidator = v.optional(v.object({ key: v.string(), refused: v.boolean(), known: v.boolean() }));

/** Writes what the providers said, for keys still the ones asked about (someone may have pasted a new one meanwhile). */
export const recordCheck = internalMutation({
  args: { accountId: v.id("accounts"), tmdb: verdictValidator, debrid: verdictValidator },
  returns: v.null(),
  handler: async (ctx, { accountId, tmdb, debrid }) => {
    const row = await keysRow(ctx, accountId);
    if (!row) return null;
    const now = Date.now();
    const patch: { checkedAt: number; tmdbRefusedAt?: number; debridRefusedAt?: number } = { checkedAt: now };
    if (tmdb?.known && row.tmdb === tmdb.key) patch.tmdbRefusedAt = tmdb.refused ? (row.tmdbRefusedAt ?? now) : undefined;
    else patch.tmdbRefusedAt = row.tmdbRefusedAt;
    if (debrid?.known && row.debrid?.key === debrid.key) patch.debridRefusedAt = debrid.refused ? (row.debridRefusedAt ?? now) : undefined;
    else patch.debridRefusedAt = row.debridRefusedAt;
    await ctx.db.patch(row._id, patch);
    return null;
  },
});
