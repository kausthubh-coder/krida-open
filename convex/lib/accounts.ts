import { ConvexError, v, type Infer } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { addonsOf } from "./addons";
import { requireProfile } from "./auth";

/*
 * An account is one Clerk sign-in holding up to 8 profiles and the keys they all use: TMDB, MDBList and one debrid
 * service. Keys live in `accountKeys`, one row per account, and only sessions of a profile in that account can read or
 * change them. Temporary party guests have no account, so they have no keys.
 */

export const MAX_PROFILES = 8;

type Identity = { subject: string; name?: string; email?: string };

/** The account of the Clerk user signed in on the caller's device, if it has been made. */
export async function accountOfClerk(ctx: QueryCtx, identity: Identity | null) {
  if (!identity) return null;
  return await ctx.db.query("accounts").withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", identity.subject)).unique();
}

/** The Clerk user's account, made on their first sign-in. */
export async function ensureAccount(ctx: MutationCtx, identity: Identity): Promise<Doc<"accounts">> {
  const found = await accountOfClerk(ctx, identity);
  if (found) return found;
  const id = await ctx.db.insert("accounts", { name: identity.name || identity.email || "Krida", clerkUserId: identity.subject, createdAt: Date.now() });
  return (await ctx.db.get(id))!;
}

/**
 * Parties and browser playback need TorBox: it turns the file into a stream every browser plays. A TorBox key TorBox
 * turned down since (onboarding.recheck) counts as none.
 */
export async function hasTorBox(ctx: QueryCtx, accountId: Id<"accounts"> | undefined) {
  const row = accountId === undefined ? null : await keysRow(ctx, accountId);
  return row?.debrid?.service === "torbox" && row.debridRefusedAt === undefined;
}

export function needsTorBox() {
  return new ConvexError({ code: "NEEDS_TORBOX", message: "Parties need TorBox. Add a TorBox key in Settings → Connections." });
}

/**
 * Playing alone needs a debrid service the service still accepts: TorBox streams any file to the browser; another
 * service's files play in the browser when they're MP4 or WebM, and otherwise in the desktop app or an external player.
 */
export async function hasDebrid(ctx: QueryCtx, accountId: Id<"accounts"> | undefined) {
  const row = accountId === undefined ? null : await keysRow(ctx, accountId);
  return !!row?.debrid && row.debridRefusedAt === undefined;
}

/** Said before any stream job starts, rather than letting Play fail on the way (docs/models/Onboarding.tla). */
export function playNeedsDebrid() {
  return new ConvexError({ code: "NEEDS_DEBRID", message: "Playing needs a debrid service. Add one in Settings → Connections." });
}

export const DEBRID_SERVICES = ["torbox", "realdebrid", "alldebrid", "premiumize", "debridlink", "offcloud", "easydebrid"] as const;
export type DebridService = (typeof DEBRID_SERVICES)[number];
export const debridServiceValidator = v.union(...DEBRID_SERVICES.map((s) => v.literal(s)));
export const debridValidator = v.object({ service: debridServiceValidator, key: v.string() });
export const keyKindValidator = v.union(v.literal("tmdb"), v.literal("mdblist"), v.literal("debrid"));
export type KeyKind = Infer<typeof keyKindValidator>;

/** An account's keys. Each is unset until someone in the account adds it. */
export type AccountKeys = { tmdb?: string; mdblist?: string; debrid?: { service: DebridService; key: string } };

/** The account a profile belongs to; null for temporary guests and profiles from before accounts. */
export async function accountOf(ctx: QueryCtx, profile: Doc<"profiles">): Promise<Doc<"accounts"> | null> {
  return profile.accountId ? await ctx.db.get(profile.accountId) : null;
}

/**
 * The other profiles in a profile's account, for "For you and…", friends' rows, shared picks and Wrapped's friend.
 * Never another account's; a guest (no account) has none.
 */
export async function housemates(ctx: QueryCtx, profile: Doc<"profiles">) {
  const accountId = profile.accountId;
  if (!accountId) return [];
  const all = await ctx.db.query("profiles").withIndex("by_account", (q) => q.eq("accountId", accountId)).take(MAX_PROFILES * 2);
  return all.filter((p) => p._id !== profile._id && p.expiresAt === undefined);
}

/** The session's profile and its account; refuses a session whose profile has no account (a temporary guest). */
export async function requireAccount(ctx: QueryCtx, token: string | null | undefined) {
  const profile = await requireProfile(ctx, token);
  const account = await accountOf(ctx, profile);
  if (!account) throw new ConvexError({ code: "FORBIDDEN", message: "Only profiles in an account have keys" });
  return { profile, account };
}

export async function keysRow(ctx: QueryCtx, accountId: Id<"accounts">) {
  return await ctx.db.query("accountKeys").withIndex("by_account", (q) => q.eq("accountId", accountId)).unique();
}

export async function keysOf(ctx: QueryCtx, accountId: Id<"accounts"> | undefined): Promise<AccountKeys> {
  const row = accountId ? await keysRow(ctx, accountId) : null;
  return { tmdb: row?.tmdb, mdblist: row?.mdblist, debrid: row?.debrid };
}

/**
 * Saves one key (already checked with its provider), or clears it with `undefined`. A new key, or none, is no longer
 * one the provider turned down.
 */
export async function writeKey(ctx: MutationCtx, accountId: Id<"accounts">, kind: KeyKind, value: string | AccountKeys["debrid"] | undefined) {
  const row = await keysRow(ctx, accountId);
  const patch = {
    [kind]: value,
    updatedAt: Date.now(),
    ...(kind === "tmdb" && { tmdbRefusedAt: undefined }),
    ...(kind === "debrid" && { debridRefusedAt: undefined }),
  };
  if (row) await ctx.db.patch(row._id, patch);
  else if (value !== undefined) await ctx.db.insert("accountKeys", { accountId, ...patch });
  // Suggested addons carry the debrid key in their links: a new one remakes them, and removing it removes them.
  if (kind !== "debrid" || JSON.stringify(row?.debrid) === JSON.stringify(value)) return;
  if (value) await ctx.scheduler.runAfter(0, internal.addons.rebuildSuggested, { accountId });
  else
    for (const profile of await profilesOfAccount(ctx, accountId))
      for (const addon of await addonsOf(ctx, profile._id)) if (addon.suggestion) await ctx.db.delete(addon._id);
}

/** Every profile in an account, its party guests aside (they have none). */
export async function profilesOfAccount(ctx: QueryCtx, accountId: Id<"accounts">) {
  return await ctx.db.query("profiles").withIndex("by_account", (q) => q.eq("accountId", accountId)).take(MAX_PROFILES * 2);
}

/** The account named `name`, made if there's none: seeds and the CLI put QA profiles in one account this way. */
export async function accountNamed(ctx: MutationCtx, name: string): Promise<Id<"accounts">> {
  const found = await ctx.db.query("accounts").withIndex("by_name", (q) => q.eq("name", name)).first();
  return found?._id ?? (await ctx.db.insert("accounts", { name, createdAt: Date.now() }));
}

/** The last four characters, so Settings can show which key is saved without showing the key. */
export const hint = (key: string) => `…${key.slice(-4)}`;
