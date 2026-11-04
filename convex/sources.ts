import { ConvexError, v } from "convex/values";
import { action, internalAction, internalQuery, type ActionCtx, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internalMutation, mutation } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireProfile, sha256 } from "./lib/auth";
import { originOfProfile, type SourceOrigin } from "./lib/addons";
import { fetchSources, fileLink as torboxFileLink, isTorrent, NoList, PlainFile, resolveDirect, resolveToTorbox, SourceError, torboxKeyOf, viaTorBox, type RawSource } from "./lib/providers";
import { parseSource } from "./lib/parse";
import { contextFor, excluder, rankSources, sourceKey } from "./lib/rank";
import { containerOf, isBrowserContainer } from "../shared/formats";
import { trackError } from "./lib/telemetry";
import { screenValidator } from "./schema";

const FRESH_MS = 20 * 60 * 1000;
/** A fetch that hasn't finished by now has died with its action; the next request fetches again. */
const FETCH_TTL_MS = 45 * 1000;
const FETCH_POLL_MS = 400;
/** Busy or failing addons are asked once more after this. */
const RETRY_MS = 2000;
/** Lists are fetched again after 20 minutes anyway; older ones only take up space. */
const KEEP_MS = 2 * 24 * 60 * 60 * 1000;
/** Lists can be hundreds of KB, and a mutation may read 16 MiB. */
const SWEEP_BATCH = 20;

/**
 * Whether a list is fresh or being fetched lives apart from the list itself (often hundreds of KB), so checking
 * and waiting read a few bytes. Lists from before this have no status and are simply fetched again.
 */
const statusOf = (ctx: QueryCtx, key: string) =>
  ctx.db
    .query("sourceFetches")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();
type Status = Doc<"sourceFetches"> | null;
const fresh = (status: Status, now: number) => !!status?.fetchedAt && now - status.fetchedAt < FRESH_MS;
const fetching = (status: Status, now: number) => !!status?.fetchingSince && now - status.fetchingSince < FETCH_TTL_MS;

/**
 * The cached list, or the right to fetch it now. One fetch per list at a time, so Play pressed
 * while the title page's prefetch is still out waits for that answer instead of asking again.
 */
export const claimList = internalMutation({
  args: { key: v.string() },
  handler: async (ctx, { key }): Promise<{ file: Id<"_storage">; failedLinks?: string[] } | { items: RawSource[]; failedLinks?: string[] } | { wait: true } | { claimedAt: number }> => {
    const now = Date.now();
    const status = await statusOf(ctx, key);
    if (fresh(status, now)) {
      const list = await ctx.db.query("sourceLists").withIndex("by_key", (q) => q.eq("key", key)).first();
      if (list?.file) return { file: list.file, failedLinks: status?.failedLinks };
      if (list?.items) return { items: list.items, failedLinks: status?.failedLinks };
    }
    if (fetching(status, now)) return { wait: true };
    if (status) await ctx.db.patch(status._id, { fetchingSince: now });
    else await ctx.db.insert("sourceFetches", { key, fetchingSince: now });
    return { claimedAt: now };
  },
});

export const markUnavailable = internalMutation({
  args: { key: v.string(), linkHash: v.string() },
  returns: v.null(),
  handler: async (ctx, { key, linkHash }) => {
    const status = await statusOf(ctx, key);
    if (status && !(status.failedLinks ?? []).includes(linkHash))
      await ctx.db.patch(status._id, { failedLinks: [...(status.failedLinks ?? []), linkHash].slice(-150) });
    return null;
  },
});

async function withFailures(items: RawSource[], failedLinks: string[] = []) {
  if (!failedLinks.length) return items;
  return await Promise.all(items.map(async item => failedLinks.includes(await sha256(item.url)) ? { ...item, unavailable: true } : item));
}

/** A failed fetch lets go, so whoever is waiting tries for themselves rather than waiting it out. */
export const releaseList = internalMutation({
  args: { key: v.string(), claimedAt: v.number() },
  handler: async (ctx, { key, claimedAt }) => {
    const status = await statusOf(ctx, key);
    if (status?.fetchingSince === claimedAt) await ctx.db.patch(status._id, { fetchingSince: undefined });
  },
});

/** Drops a list and its file. */
async function dropList(ctx: MutationCtx, list: Doc<"sourceLists">) {
  if (list.file) await ctx.storage.delete(list.file);
  await ctx.db.delete(list._id);
}

/** Keeps a list fetched just now (its file already stored), replacing the one before. */
export const putList = internalMutation({
  args: { key: v.string(), file: v.id("_storage") },
  handler: async (ctx, { key, file }) => {
    const existing = await ctx.db
      .query("sourceLists")
      .withIndex("by_key", (q) => q.eq("key", key))
      .collect();
    for (const e of existing) await dropList(ctx, e);
    const now = Date.now();
    await ctx.db.insert("sourceLists", { key, file, fetchedAt: now });
    const status = await statusOf(ctx, key);
    if (status) await ctx.db.patch(status._id, { fetchedAt: now, fetchingSince: undefined, failedLinks: undefined });
    else await ctx.db.insert("sourceFetches", { key, fetchedAt: now });
  },
});

/** Drops lists older than two days, a batch at a time, with their status unless a fetch is under way. */
export const sweep = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const old = await ctx.db
      .query("sourceLists")
      .withIndex("by_fetchedAt", (q) => q.lt("fetchedAt", now - KEEP_MS))
      .take(SWEEP_BATCH);
    for (const list of old) {
      await dropList(ctx, list);
      const status = await statusOf(ctx, list.key);
      if (status && !fetching(status, now)) await ctx.db.delete(status._id);
    }
    if (old.length === SWEEP_BATCH) await ctx.scheduler.runAfter(0, internal.sources.sweep, {});
  },
});

/** The last list fetched for a title, however old (lists are kept two days), for when the addons give none. */
export const olderList = internalQuery({
  args: { key: v.string() },
  handler: async (ctx, { key }): Promise<{ file?: Id<"_storage">; items?: RawSource[]; fetchedAt: number } | null> => {
    const list = await ctx.db.query("sourceLists").withIndex("by_key", (q) => q.eq("key", key)).first();
    return list && { file: list.file, items: list.items, fetchedAt: list.fetchedAt };
  },
});

/** A list's key: by title, and by account and set of addons, since its links carry their keys (`SourceOrigin`). */
export const listKey = (type: string, videoId: string, scope: string) => `${scope}:${type}:${videoId}`;

/** A title's sources. `olderFrom` says when they were found, if the addons gave none just now and these are older. */
export type Sources = { items: RawSource[]; olderFrom?: number };

export async function loadSources(
  ctx: ActionCtx,
  type: string,
  videoId: string,
  origin: SourceOrigin,
  { force = false, onNote }: { force?: boolean; onNote?: (note: string) => Promise<void> } = {},
): Promise<Sources> {
  const key = listKey(type, videoId, origin.scope);
  let claimedAt: number | undefined;
  let gone = 0;
  while (!force) {
    const claim = await ctx.runMutation(internal.sources.claimList, { key });
    if ("items" in claim) return { items: await withFailures(claim.items, claim.failedLinks) };
    if ("file" in claim) {
      const blob = await ctx.storage.get(claim.file);
      if (blob) return { items: await withFailures(JSON.parse(await blob.text()) as RawSource[], claim.failedLinks) };
      // Replaced a moment ago: ask again, which finds the new one (or, past a few tries, fetch it ourselves).
      if (++gone >= 3) break;
      continue;
    }
    if ("claimedAt" in claim) {
      claimedAt = claim.claimedAt;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, FETCH_POLL_MS));
  }
  try {
    const items = await fetchOnceMore(type, videoId, origin, onNote);
    const file = await ctx.storage.store(new Blob([JSON.stringify(items)], { type: "application/json" }));
    await ctx.runMutation(internal.sources.putList, { key, file });
    return { items };
  } catch (error) {
    if (claimedAt !== undefined) await ctx.runMutation(internal.sources.releaseList, { key, claimedAt });
    if (error instanceof NoList) {
      const older = await ctx.runQuery(internal.sources.olderList, { key });
      const blob = older?.file && (await ctx.storage.get(older.file));
      const items = blob ? (JSON.parse(await blob.text()) as RawSource[]) : older?.items;
      if (older && items?.length) {
        console.warn(`using sources for ${key} from ${Math.round((Date.now() - older.fetchedAt) / 60_000)} min ago`);
        return { items, olderFrom: older.fetchedAt };
      }
    }
    throw error;
  }
}

/** A blip at the source (a rate limit, a 502, a timeout) often clears in a moment, so one more try. */
async function fetchOnceMore(type: string, videoId: string, origin: SourceOrigin, onNote?: (note: string) => Promise<void>) {
  try {
    return await fetchSources(type, videoId, origin);
  } catch (error) {
    if (!(error instanceof NoList)) throw error;
    console.warn(`the addons gave no list for ${videoId}, asking again`, error.message);
    await onNote?.("Your addons didn’t answer. Asking again…");
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
    return await fetchSources(type, videoId, origin);
  }
}

/** Where a profile's sources come from: its enabled stream addons (lib/addons.ts). */
export const originOf = (ctx: ActionCtx, profileId: Id<"profiles">): Promise<SourceOrigin> => ctx.runQuery(internal.addons.originOf, { profileId });

/** A title page opened: fetch its sources now, so pressing Play doesn't start by waiting for them. TorBox isn't involved. */
export const warm = mutation({
  args: { token: v.string(), type: v.union(v.literal("movie"), v.literal("series")), videoId: v.string() },
  returns: v.null(),
  handler: async (ctx, { token, type, videoId }) => {
    const profile = await requireProfile(ctx, token);
    const origin = await originOfProfile(ctx, profile);
    // No stream addon: nothing to fetch with. Play says so.
    if (origin.addons.length === 0) return null;
    const now = Date.now();
    const status = await statusOf(ctx, listKey(type, videoId, origin.scope));
    if (!fresh(status, now) && !fetching(status, now))
      await ctx.scheduler.runAfter(0, internal.sources.prefetch, { type, videoId, profileId: profile._id });
    return null;
  },
});

export const prefetch = internalAction({
  // Whose addons to ask; schedules from before addons have none, and fetch nothing.
  args: { type: v.union(v.literal("movie"), v.literal("series")), videoId: v.string(), profileId: v.optional(v.id("profiles")) },
  handler: async (ctx, { type, videoId, profileId }) => {
    if (!profileId) return;
    try {
      await loadSources(ctx, type, videoId, await originOf(ctx, profileId));
    } catch (error) {
      // Nothing waits on a prefetch; Play fetches again and reports any problem.
      console.warn(`prefetch ${videoId} failed`, error instanceof Error ? error.message : error);
    }
  },
});

/**
 * The source sheet's list: Krida's pick, the files to choose from, when they were found if the addons gave none, and
 * how many the profile's "Hide sources containing" left out.
 */
type Ranked = {
  options: ReturnType<typeof rankSources>["options"];
  pick: number | null;
  olderFrom?: number;
  hidden?: number;
  /** In a browser, on an account whose files play as they are (another debrid service, or none): MP4, WebM and HLS play here. */
  direct?: boolean;
  /** The account has no debrid service: its torrents are listed as unavailable (`needsDebrid`) and its web videos play. */
  noDebrid?: boolean;
};

export const listRanked = action({
  args: {
    token: v.string(),
    type: v.union(v.literal("movie"), v.literal("series")),
    videoId: v.string(),
    name: v.optional(v.string()),
    season: v.optional(v.number()),
    episode: v.optional(v.number()),
    refresh: v.optional(v.boolean()),
    screen: v.optional(screenValidator),
  },
  handler: async (ctx, { token, type, videoId, name, season, episode, refresh, screen }): Promise<Ranked> => {
    const profileId = await ctx.runQuery(internal.profiles.validate, { token });
    if (!profileId) throw new ConvexError({ code: "UNAUTHENTICATED", message: "Sign in to continue" });
    try {
      const [{ items: listed, olderFrom }, prefs, { keys }] = await Promise.all([
        loadSources(ctx, type, videoId, await originOf(ctx, profileId), { force: refresh }),
        ctx.runQuery(internal.profiles.prefsOf, { profileId }),
        ctx.runQuery(internal.accounts.keysOfProfile, { profileId }),
      ]);
      const noDebrid = !keys.debrid;
      // Without a debrid service nothing plays a torrent: it shows, but can't be picked (as Play leaves it out).
      const items = noDebrid ? listed.map((item) => (isTorrent(item) ? { ...item, unavailable: true, needsDebrid: true } : item)) : listed;
      const base = contextFor(type, videoId);
      const { options, pick, best } = rankSources(items, {
        ...base,
        name,
        season: season ?? base.season,
        episode: episode ?? base.episode,
        audioLang: prefs?.audioLang,
        subLang: prefs?.subLang,
        screen,
        exclude: prefs?.sourceFilter,
      });
      const excluded = excluder(prefs?.sourceFilter);
      const hidden = excluded ? items.filter(excluded).length : 0;
      // A browser plays files from their links as they are, so Krida's pick there is one it can play, as Play's is.
      const direct = !viaTorBox(keys) && screen !== "app";
      const plays = (o: { indices: number[] }) => o.indices.some((i) => !!items[i] && isBrowserContainer(containerOf(items[i].filename, items[i].url)));
      const shown = direct && pick && !plays(pick) ? (best.find((o) => plays(o) && !o.mismatch) ?? pick) : pick;
      // Only display fields leave the server; the playback URLs carry account credentials.
      return {
        options, pick: shown?.index ?? null, olderFrom,
        ...(hidden ? { hidden } : {}), ...(direct ? { direct } : {}), ...(noDebrid ? { noDebrid } : {}),
      };
    } catch (error) {
      console.error("sources.list failed", error);
      // The browser only sees the friendly message; PostHog keeps the cause.
      await trackError(error, { action: "sources.list", type, videoId });
      const message = error instanceof SourceError ? error.message : "Couldn't load sources. Try again.";
      throw new ConvexError({ code: "SOURCES", message });
    }
  },
});

// Keep the array response for tabs opened before the ranked picker.
export const list = action({
  args: {
    token: v.string(),
    type: v.union(v.literal("movie"), v.literal("series")),
    videoId: v.string(),
    refresh: v.optional(v.boolean()),
  },
  handler: async (ctx, { token, type, videoId, refresh }) => {
    const profileId = await ctx.runQuery(internal.profiles.validate, { token });
    if (!profileId) throw new ConvexError({ code: "UNAUTHENTICATED", message: "Sign in to continue" });
    try {
      const { items } = await loadSources(ctx, type, videoId, await originOf(ctx, profileId), { force: refresh });
      // Only display fields leave the server; the playback URLs carry account credentials.
      return items.map((s, index) => {
        const { path: _path, ...info } = parseSource(s.name, s.description, s.filename, s.size);
        return { index, ...info };
      });
    } catch (error) {
      console.error("sources.list failed", error);
      // The browser only sees the friendly message; PostHog keeps the cause.
      await trackError(error, { action: "sources.list", type, videoId });
      const message = error instanceof SourceError ? error.message : "Couldn't load sources. Try again.";
      throw new ConvexError({ code: "SOURCES", message });
    }
  },
});

/**
 * One listed file's own link, for an external player (VLC, Infuse, IINA, a playlist): through TorBox for a TorBox
 * account (a torrent too, when TorBox has it), else, and for a plain web video on any account, by following the addon's
 * link to the file. The link plays the account's file, so only that account's sessions ask for it, and only for a file
 * in their own list.
 */
export const fileLink = action({
  args: { token: v.string(), type: v.union(v.literal("movie"), v.literal("series")), videoId: v.string(), key: v.string() },
  returns: v.object({ url: v.string() }),
  handler: async (ctx, { token, type, videoId, key }): Promise<{ url: string }> => {
    const profileId = await ctx.runQuery(internal.profiles.validate, { token });
    if (!profileId) throw new ConvexError({ code: "UNAUTHENTICATED", message: "Sign in to continue" });
    const { keys } = await ctx.runQuery(internal.accounts.keysOfProfile, { profileId });
    try {
      const { items } = await loadSources(ctx, type, videoId, await originOf(ctx, profileId));
      const item = items.find((i) => sourceKey(i) === key);
      if (!item) throw new SourceError("That source isn’t listed anymore. Pick another one.");
      if (viaTorBox(keys)) {
        const torbox = torboxKeyOf(keys);
        const found = await resolveToTorbox(torbox, item, contextFor(type, videoId)).catch((error) => {
          if (error instanceof PlainFile) return { url: error.url };
          throw error;
        });
        return "url" in found ? found : { url: await torboxFileLink(torbox, found.torrentId, found.fileId) };
      }
      return { url: (await resolveDirect(item)).url };
    } catch (error) {
      console.error("sources.fileLink failed", error);
      const message = error instanceof SourceError ? error.message : "Couldn’t get this file’s link. Try another source.";
      throw new ConvexError({ code: "SOURCES", message });
    }
  },
});
