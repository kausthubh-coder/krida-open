import { ConvexError, v } from "convex/values";
import { action, internalAction, internalQuery, query, type ActionCtx, type MutationCtx } from "./_generated/server";
import { internalMutation, mutation } from "./functions";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { profileFromToken, requireProfile } from "./lib/auth";
import { keysOf, profilesOfAccount } from "./lib/accounts";
import { addonsOf, manifestValidator, MAX_ADDONS, originOfProfile, addonSuggestionValidator } from "./lib/addons";
import { addonBase, AddonUrlError, manifestUrl, parseManifest, SUGGESTIONS, suggestionBase, type AddonManifest, type SuggestionId } from "../shared/stremio";

/*
 * Settings → Addons: a profile's Stremio addons. Installing fetches and checks the manifest here, never in the browser,
 * so what's saved is always a manifest Krida can read. Every function reads and changes only the session's own
 * profile; copying reads another profile only when it's in the same account.
 */

// Convex provides process.env in every runtime; declared here so the web app's typecheck agrees.
declare const process: { env: Record<string, string | undefined> };

const addonView = v.object({
  _id: v.id("addons"),
  url: v.string(),
  manifest: manifestValidator,
  enabled: v.boolean(),
  suggestion: v.optional(addonSuggestionValidator),
});

const outcome = v.union(
  v.object({ ok: v.literal(true), name: v.string() }),
  v.object({ ok: v.literal(false), message: v.string(), configure: v.optional(v.string()) }),
);
type Outcome = { ok: true; name: string } | { ok: false; message: string; configure?: string };

/** The session's profile's addons, in its order. Their links go only to that profile's own browsers, for catalogs. */
export const list = query({
  args: { token: v.string() },
  returns: v.array(addonView),
  handler: async (ctx, { token }) => {
    const profile = await requireProfile(ctx, token);
    return (await addonsOf(ctx, profile._id)).map(({ _id, url, manifest, enabled, suggestion }) => ({ _id, url, manifest, enabled, suggestion }));
  },
});

/** The addons Krida can set up with the account's debrid key, and whether this profile has each one. */
export const suggestions = query({
  args: { token: v.string() },
  returns: v.object({
    service: v.union(v.string(), v.null()),
    items: v.array(v.object({ id: addonSuggestionValidator, name: v.string(), description: v.string(), installed: v.boolean() })),
  }),
  handler: async (ctx, { token }) => {
    const profile = await requireProfile(ctx, token);
    const { debrid } = await keysOf(ctx, profile.accountId);
    const mine = await addonsOf(ctx, profile._id);
    return {
      service: debrid?.service ?? null,
      items: debrid ? SUGGESTIONS.map((s) => ({ ...s, installed: mine.some((a) => a.suggestion === s.id) })) : [],
    };
  },
});

/** Only addons on the open internet, except on a backend on this machine (the regress stand-ins run on 127.0.0.1). */
function reachable(base: string) {
  const url = new URL(base);
  const local = /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(process.env.CONVEX_CLOUD_URL ?? "");
  const privateHost = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|\[?::1\]?$|0\.)/.test(url.hostname);
  if (local) return;
  if (url.protocol !== "https:") throw new AddonUrlError("Addons need a secure link (https://).");
  if (privateHost) throw new AddonUrlError("That addon runs on a private network, which Krida can’t reach.");
}

/** Fetches and checks a manifest. Failures come back as words for the person, never thrown. */
async function fetchManifest(base: string): Promise<{ ok: true; manifest: AddonManifest } | { ok: false; message: string; configure?: string }> {
  const host = new URL(base).host;
  let res: Response;
  try {
    res = await fetch(manifestUrl(base), { headers: { accept: "application/json" }, signal: AbortSignal.timeout(12_000) });
  } catch {
    return { ok: false, message: `Couldn’t reach ${host}. Check the link and try again.` };
  }
  if (!res.ok) return { ok: false, message: `${host} answered ${res.status}. Check the link and try again.` };
  const parsed = parseManifest(await res.json().catch(() => null));
  if (!parsed.ok) return parsed;
  if (parsed.manifest.configurationRequired)
    return {
      ok: false,
      message: `${parsed.manifest.name} needs setting up first. Set it up on its page, then paste the link it gives you.`,
      configure: `${base}/configure`,
    };
  return parsed;
}

async function sessionProfile(ctx: ActionCtx, token: string) {
  const who = await ctx.runQuery(internal.addons.whoIs, { token });
  if (!who) throw new ConvexError({ code: "UNAUTHENTICATED", message: "Sign in to continue" });
  return who;
}

async function installAt(ctx: ActionCtx, profileId: Id<"profiles">, base: string, suggestion?: SuggestionId): Promise<Outcome> {
  const fetched = await fetchManifest(base);
  if (!fetched.ok) return fetched;
  return await ctx.runMutation(internal.addons.insert, { profileId, url: base, manifest: fetched.manifest, suggestion });
}

/** Installs an addon from a pasted link: a manifest link, a stremio:// link or the addon's base address. */
export const install = action({
  args: { token: v.string(), url: v.string() },
  returns: outcome,
  handler: async (ctx, { token, url }): Promise<Outcome> => {
    const { profileId } = await sessionProfile(ctx, token);
    let base: string;
    try {
      base = addonBase(url.slice(0, 4000));
      reachable(base);
    } catch (error) {
      if (error instanceof AddonUrlError) return { ok: false, message: error.message };
      throw error;
    }
    return await installAt(ctx, profileId, base);
  },
});

/** Installs one of Krida's suggestions, set up here with the account's debrid key (the browser never builds it). */
export const installSuggestion = action({
  args: { token: v.string(), suggestion: addonSuggestionValidator },
  returns: outcome,
  handler: async (ctx, { token, suggestion }): Promise<Outcome> => await installSuggestionFor(ctx, token, suggestion),
});

/** The same, as sites built before MediaFusion was suggested call it (they offer only these two). */
export const installSuggested = action({
  args: { token: v.string(), suggestion: v.union(v.literal("torrentio"), v.literal("comet")) },
  returns: outcome,
  handler: async (ctx, { token, suggestion }): Promise<Outcome> => await installSuggestionFor(ctx, token, suggestion),
});

async function installSuggestionFor(ctx: ActionCtx, token: string, suggestion: SuggestionId): Promise<Outcome> {
  const { profileId, accountId } = await sessionProfile(ctx, token);
  const keys = accountId ? await ctx.runQuery(internal.accounts.keysOfAccount, { accountId }) : {};
  if (!keys.debrid) return { ok: false, message: "Add your debrid key in Settings → Connections first." };
  let base: string;
  try {
    base = await suggestionBase(suggestion, keys.debrid);
  } catch (error) {
    if (error instanceof AddonUrlError) return { ok: false, message: error.message };
    throw error;
  }
  return await installAt(ctx, profileId, base, suggestion);
}

/**
 * A suggestion's link carries the debrid key it was made with, so a new key (or service) remakes the account's
 * suggested addons with it, each profile's in place. One that can't be remade keeps its old link and says so in the
 * logs; Play then shows that addon's own error.
 */
export const rebuildSuggested = internalAction({
  args: { accountId: v.id("accounts") },
  returns: v.null(),
  handler: async (ctx, { accountId }) => {
    const keys = await ctx.runQuery(internal.accounts.keysOfAccount, { accountId });
    if (!keys.debrid) return null;
    const installed = await ctx.runQuery(internal.addons.suggestedOfAccount, { accountId });
    for (const suggestion of new Set(installed.map((a) => a.suggestion))) {
      try {
        const base = await suggestionBase(suggestion, keys.debrid);
        const fetched = await fetchManifest(base);
        if (!fetched.ok) throw new Error(fetched.message);
        const addonIds = installed.filter((a) => a.suggestion === suggestion).map((a) => a._id);
        await ctx.runMutation(internal.addons.relink, { addonIds, url: base, manifest: fetched.manifest });
      } catch (error) {
        console.error(`addons.rebuildSuggested: ${suggestion} kept its old link`, error instanceof Error ? error.message : error);
      }
    }
    return null;
  },
});

export const suggestedOfAccount = internalQuery({
  args: { accountId: v.id("accounts") },
  handler: async (ctx, { accountId }) => {
    const found: { _id: Id<"addons">; suggestion: SuggestionId }[] = [];
    for (const profile of await profilesOfAccount(ctx, accountId))
      for (const a of await addonsOf(ctx, profile._id)) if (a.suggestion) found.push({ _id: a._id, suggestion: a.suggestion });
    return found;
  },
});

export const relink = internalMutation({
  args: { addonIds: v.array(v.id("addons")), url: v.string(), manifest: manifestValidator },
  returns: v.null(),
  handler: async (ctx, { addonIds, url, manifest }) => {
    for (const id of addonIds) if (await ctx.db.get(id)) await ctx.db.patch(id, { url, manifest });
    return null;
  },
});

/**
 * Installs the addons of a Stremio account. The browser signs in to Stremio and reads the links itself (shared/stremio
 * `importableUrls`), so Krida never sees that account's email, password or key; each manifest is fetched and checked
 * here like a pasted link.
 */
export const importUrls = action({
  args: { token: v.string(), urls: v.array(v.string()) },
  returns: v.object({ added: v.array(v.string()), already: v.number(), failed: v.array(v.object({ host: v.string(), message: v.string() })) }),
  handler: async (ctx, { token, urls }) => {
    const { profileId } = await sessionProfile(ctx, token);
    const added: string[] = [];
    const failed: { host: string; message: string }[] = [];
    let already = 0;
    const bases = [...new Set(urls.slice(0, MAX_ADDONS).flatMap((u) => {
      try {
        const base = addonBase(u.slice(0, 4000));
        reachable(base);
        return [base];
      } catch {
        failed.push({ host: u.slice(0, 60), message: "Not an addon link Krida can reach." });
        return [];
      }
    }))];
    const fetched = await Promise.all(bases.map(async (base) => ({ base, result: await fetchManifest(base) })));
    // In the Stremio account's order, one at a time, so they keep it.
    for (const { base, result } of fetched) {
      if (!result.ok) {
        failed.push({ host: new URL(base).host, message: result.message });
        continue;
      }
      const saved = await ctx.runMutation(internal.addons.insert, { profileId, url: base, manifest: result.manifest });
      if (saved.ok) added.push(saved.name);
      else if (/already/.test(saved.message)) already++;
      else failed.push({ host: new URL(base).host, message: saved.message });
    }
    return { added, already, failed };
  },
});

/** Fetches an addon's manifest again, for new catalogs or a changed setup. */
export const reload = action({
  args: { token: v.string(), addonId: v.id("addons") },
  returns: outcome,
  handler: async (ctx, { token, addonId }): Promise<Outcome> => {
    const { profileId } = await sessionProfile(ctx, token);
    const addon = await ctx.runQuery(internal.addons.ownAddon, { profileId, addonId });
    if (!addon) throw new ConvexError({ code: "NOT_FOUND", message: "That addon isn’t installed anymore." });
    const fetched = await fetchManifest(addon.url);
    if (!fetched.ok) return fetched;
    await ctx.runMutation(internal.addons.setManifest, { profileId, addonId, manifest: fetched.manifest });
    return { ok: true, name: fetched.manifest.name };
  },
});

async function ownAddonOf(ctx: MutationCtx, profileId: Id<"profiles">, addonId: Id<"addons">) {
  const addon = await ctx.db.get(addonId);
  if (!addon || addon.profileId !== profileId) throw new ConvexError({ code: "NOT_FOUND", message: "That addon isn’t installed anymore." });
  return addon;
}

export const remove = mutation({
  args: { token: v.string(), addonId: v.id("addons") },
  returns: v.null(),
  handler: async (ctx, { token, addonId }) => {
    const profile = await requireProfile(ctx, token);
    await ownAddonOf(ctx, profile._id, addonId);
    await ctx.db.delete(addonId);
    return null;
  },
});

export const setEnabled = mutation({
  args: { token: v.string(), addonId: v.id("addons"), enabled: v.boolean() },
  returns: v.null(),
  handler: async (ctx, { token, addonId, enabled }) => {
    const profile = await requireProfile(ctx, token);
    await ownAddonOf(ctx, profile._id, addonId);
    await ctx.db.patch(addonId, { enabled });
    return null;
  },
});

/** Puts the profile's addons in this order (every one of its addons, by id). Earlier addons' streams list first. */
export const reorder = mutation({
  args: { token: v.string(), ids: v.array(v.id("addons")) },
  returns: v.null(),
  handler: async (ctx, { token, ids }) => {
    const profile = await requireProfile(ctx, token);
    const mine = await addonsOf(ctx, profile._id);
    const known = new Set(mine.map((a) => a._id));
    if (ids.length !== mine.length || new Set(ids).size !== ids.length || ids.some((id) => !known.has(id)))
      throw new ConvexError({ code: "BAD_ORDER", message: "Your addons changed meanwhile. Try again." });
    for (const [order, id] of ids.entries()) await ctx.db.patch(id, { order });
    return null;
  },
});

/** Copies another profile's addons in the same account onto this one, after its own; ones it has already are skipped. */
export const copyFrom = mutation({
  args: { token: v.string(), fromProfileId: v.id("profiles") },
  returns: v.object({ added: v.number() }),
  handler: async (ctx, { token, fromProfileId }) => {
    const profile = await requireProfile(ctx, token);
    const from = await ctx.db.get(fromProfileId);
    if (!from || from._id === profile._id || !profile.accountId || from.accountId !== profile.accountId || from.expiresAt !== undefined)
      throw new ConvexError({ code: "FORBIDDEN", message: "You can copy addons only from another profile in your account." });
    const mine = await addonsOf(ctx, profile._id);
    let order = (mine.at(-1)?.order ?? -1) + 1;
    let added = 0;
    for (const a of await addonsOf(ctx, from._id)) {
      if (mine.length + added >= MAX_ADDONS) break;
      if (mine.some((m) => m.url === a.url)) continue;
      await ctx.db.insert("addons", {
        profileId: profile._id, url: a.url, manifest: a.manifest, enabled: a.enabled, order: order++, suggestion: a.suggestion, installedAt: Date.now(),
      });
      added++;
    }
    return { added };
  },
});

export const whoIs = internalQuery({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const profile = await profileFromToken(ctx, token);
    return profile ? { profileId: profile._id, accountId: profile.accountId ?? null } : null;
  },
});

export const ownAddon = internalQuery({
  args: { profileId: v.id("profiles"), addonId: v.id("addons") },
  handler: async (ctx, { profileId, addonId }) => {
    const addon = await ctx.db.get(addonId);
    return addon?.profileId === profileId ? addon : null;
  },
});

/** Saves a manifest `install` checked, at the end of the profile's list. Also how seeds install the regress stand-in. */
export const insert = internalMutation({
  args: { profileId: v.id("profiles"), url: v.string(), manifest: manifestValidator, suggestion: v.optional(addonSuggestionValidator) },
  returns: outcome,
  handler: async (ctx, { profileId, url, manifest, suggestion }): Promise<Outcome> => {
    const mine = await addonsOf(ctx, profileId);
    if (mine.some((a) => a.url === url)) return { ok: false, message: `${manifest.name} is already installed.` };
    if (suggestion && mine.some((a) => a.suggestion === suggestion)) return { ok: false, message: `${manifest.name} is already installed.` };
    if (mine.length >= MAX_ADDONS) return { ok: false, message: `A profile can have up to ${MAX_ADDONS} addons. Remove one first.` };
    await ctx.db.insert("addons", {
      profileId, url, manifest, enabled: true, order: (mine.at(-1)?.order ?? -1) + 1, suggestion, installedAt: Date.now(),
    });
    return { ok: true, name: manifest.name };
  },
});

export const setManifest = internalMutation({
  args: { profileId: v.id("profiles"), addonId: v.id("addons"), manifest: manifestValidator },
  returns: v.null(),
  handler: async (ctx, { profileId, addonId, manifest }) => {
    const addon = await ctx.db.get(addonId);
    if (addon?.profileId === profileId) await ctx.db.patch(addonId, { manifest });
    return null;
  },
});

/** Where a profile's sources come from (lib/addons.ts `originFrom`), for the stream pipeline. */
export const originOf = internalQuery({
  args: { profileId: v.id("profiles") },
  handler: async (ctx, { profileId }) => await originOfProfile(ctx, await ctx.db.get(profileId)),
});
