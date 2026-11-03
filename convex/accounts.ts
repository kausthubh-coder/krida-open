import { ConvexError, v } from "convex/values";
import { action, internalQuery, query } from "./_generated/server";
import { internalMutation, mutation } from "./functions";
import { internal } from "./_generated/api";
import { profileFromToken } from "./lib/auth";
import {
  accountNamed,
  accountOf,
  debridServiceValidator,
  debridValidator,
  hint,
  keyKindValidator,
  keysOf,
  requireAccount,
  writeKey,
  type AccountKeys,
} from "./lib/accounts";
import { checkKey } from "./lib/keyCheck";

/*
 * Settings → Connections: the account's TMDB, MDBList and debrid keys. Any profile in the account may see and change
 * them; nobody else can. A key is saved only once its provider accepted it (`save`).
 */

const keysValidator = v.object({ tmdb: v.optional(v.string()), mdblist: v.optional(v.string()), debrid: v.optional(debridValidator) });

/**
 * The session's account's keys, whole, for Krida's own server (/api asks with the browser's session, server/session.ts)
 * and the account's own browsers. Null for a session with no account (a temporary guest) or no session.
 */
export const keys = query({
  args: { token: v.string() },
  returns: v.union(keysValidator, v.null()),
  handler: async (ctx, { token }): Promise<AccountKeys | null> => {
    const profile = await profileFromToken(ctx, token);
    const account = profile && (await accountOf(ctx, profile));
    return account ? await keysOf(ctx, account._id) : null;
  },
});

/** What Settings shows: which keys are saved, by their last four characters. Null without an account. */
export const connections = query({
  args: { token: v.string() },
  returns: v.union(
    v.object({
      tmdb: v.union(v.string(), v.null()),
      mdblist: v.union(v.string(), v.null()),
      debrid: v.union(v.object({ service: debridServiceValidator, hint: v.string() }), v.null()),
    }),
    v.null(),
  ),
  handler: async (ctx, { token }) => {
    const profile = await profileFromToken(ctx, token);
    const account = profile && (await accountOf(ctx, profile));
    if (!account) return null;
    const { tmdb, mdblist, debrid } = await keysOf(ctx, account._id);
    return {
      tmdb: tmdb ? hint(tmdb) : null,
      mdblist: mdblist ? hint(mdblist) : null,
      debrid: debrid ? { service: debrid.service, hint: hint(debrid.key) } : null,
    };
  },
});

/** Checks a key with its provider and saves it to the session's account when the provider accepts it. */
export const save = action({
  args: { token: v.string(), kind: keyKindValidator, key: v.string(), service: v.optional(debridServiceValidator) },
  returns: v.union(v.object({ ok: v.literal(true) }), v.object({ ok: v.literal(false), message: v.string() })),
  handler: async (ctx, { token, kind, key, service }): Promise<{ ok: true } | { ok: false; message: string }> => {
    const accountId = await ctx.runQuery(internal.accounts.accountOfSession, { token });
    if (!accountId) throw new ConvexError({ code: "FORBIDDEN", message: "Only profiles in an account have keys" });
    const trimmed = key.trim();
    if (!trimmed || trimmed.length > 300) return { ok: false, message: "Paste the whole key." };
    if (kind === "debrid" && !service) return { ok: false, message: "Pick your debrid service first." };
    const checked = await checkKey(kind, trimmed, service);
    if (!checked.ok) return checked;
    await ctx.runMutation(internal.accounts.setKey, { accountId, kind, key: trimmed, service });
    return { ok: true };
  },
});

/** Removes one of the session's account's keys. */
export const clear = mutation({
  args: { token: v.string(), kind: keyKindValidator },
  returns: v.null(),
  handler: async (ctx, { token, kind }) => {
    const { account } = await requireAccount(ctx, token);
    await writeKey(ctx, account._id, kind, undefined);
    return null;
  },
});

export const accountOfSession = internalQuery({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const profile = await profileFromToken(ctx, token);
    return profile?.accountId ?? null;
  },
});

/** Saves a key `save` checked. Not public, so no key reaches an account without its provider accepting it. */
export const setKey = internalMutation({
  args: { accountId: v.id("accounts"), kind: keyKindValidator, key: v.string(), service: v.optional(debridServiceValidator) },
  returns: v.null(),
  handler: async (ctx, { accountId, kind, key, service }) => {
    await writeKey(ctx, accountId, kind, kind === "debrid" ? { service: service!, key } : key);
    // A debrid key is onboarding's debrid step done, wherever it was added.
    if (kind === "debrid" && !(await ctx.db.get(accountId))?.debridAskedAt) await ctx.db.patch(accountId, { debridAskedAt: Date.now() });
    return null;
  },
});

/** For seeds and the CLI: keys for the account named `account`, made if there's none. Nothing is checked. */
export const setKeysFor = internalMutation({
  args: { account: v.string(), keys: keysValidator },
  returns: v.id("accounts"),
  handler: async (ctx, { account, keys }) => {
    const accountId = await accountNamed(ctx, account);
    for (const kind of ["tmdb", "mdblist", "debrid"] as const) if (keys[kind] !== undefined) await writeKey(ctx, accountId, kind, keys[kind]);
    return accountId;
  },
});

/** The keys of the account a profile is in (empty for a guest), for the stream pipeline. */
export const keysOfProfile = internalQuery({
  args: { profileId: v.id("profiles") },
  handler: async (ctx, { profileId }) => {
    const profile = await ctx.db.get(profileId);
    return { accountId: profile?.accountId ?? null, keys: await keysOf(ctx, profile?.accountId) };
  },
});

export const keysOfAccount = internalQuery({
  args: { accountId: v.id("accounts") },
  handler: async (ctx, { accountId }) => await keysOf(ctx, accountId),
});
