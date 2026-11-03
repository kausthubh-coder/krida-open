import { v, type Infer } from "convex/values";
import type { QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { digest, hasResource, type AddonManifest } from "../../shared/stremio";

/*
 * A profile's Stremio addons: links in its own order, each on or off. Their stream addons find what Play plays (the
 * host's, in a party), their catalogs fill Home and Search, and their subtitles join the player's list.
 */

export const MAX_ADDONS = 50;

const resourceValidator = v.object({ name: v.string(), types: v.array(v.string()), idPrefixes: v.optional(v.array(v.string())) });
const extraValidator = v.object({ name: v.string(), isRequired: v.optional(v.boolean()), options: v.optional(v.array(v.string())) });
const catalogValidator = v.object({ type: v.string(), id: v.string(), name: v.string(), extra: v.optional(v.array(extraValidator)) });

/** What Krida keeps of a manifest (shared/stremio.ts `parseManifest`). */
export const manifestValidator = v.object({
  id: v.string(),
  name: v.string(),
  version: v.string(),
  description: v.optional(v.string()),
  logo: v.optional(v.string()),
  types: v.array(v.string()),
  resources: v.array(resourceValidator),
  catalogs: v.array(catalogValidator),
  configurable: v.optional(v.boolean()),
  configurationRequired: v.optional(v.boolean()),
});
// The validator and the parser describe the same thing; this fails to compile when they drift apart.
const _sameShape: AddonManifest = {} as Infer<typeof manifestValidator>;
void _sameShape;

export const addonSuggestionValidator = v.union(v.literal("torrentio"), v.literal("comet"));

/** A profile's addons in its order. */
export async function addonsOf(ctx: QueryCtx, profileId: Id<"profiles">) {
  return await ctx.db.query("addons").withIndex("by_profile", (q) => q.eq("profileId", profileId)).take(MAX_ADDONS);
}

/** What the stream pipeline needs of an addon. Its link may hold a key, so it never leaves the server from here. */
export type StreamAddon = { url: string; name: string; manifest: Pick<AddonManifest, "resources"> };

/**
 * Where a profile's sources come from: its enabled stream addons, in its order. `scope` names the list they make:
 * links in it carry the addons' keys, so lists are kept per account and per set of addons.
 */
export type SourceOrigin = { addons: StreamAddon[]; scope: string };

export function originFrom(accountId: Id<"accounts"> | null | undefined, addons: Doc<"addons">[]): SourceOrigin {
  const streaming = addons.filter((a) => a.enabled && hasResource(a.manifest, "stream"));
  return {
    addons: streaming.map((a) => ({ url: a.url, name: a.manifest.name, manifest: { resources: a.manifest.resources } })),
    scope: `${accountId ?? "guest"}~${digest(streaming.map((a) => a.url).join("\n"))}`,
  };
}

export async function originOfProfile(ctx: QueryCtx, profile: Doc<"profiles"> | null): Promise<SourceOrigin> {
  return originFrom(profile?.accountId, profile ? await addonsOf(ctx, profile._id) : []);
}
