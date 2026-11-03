import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalQuery, type MutationCtx } from "./_generated/server";
import { internalMutation, mutation } from "./functions";
import { profileFromToken } from "./lib/auth";
import { DETAIL_MAX, MESSAGE_MAX, scrub } from "../shared/logs";

/*
 * What failed in someone's browser or app, so a bug they saw once can be looked up afterwards: Cinemeta not answering,
 * an /api call failing, playback not starting, an uncaught error. Browsers send it (src/data/log.ts); read it with
 * `node scripts/logs.mjs`. Rows are written only when something fails and kept 14 days.
 */

const KEEP_MS = 14 * 24 * 60 * 60 * 1000;
// More than this in a minute, from everyone, is a loop or a flood: the rest are dropped.
const PER_MINUTE = 60;

export const report = mutation({
  args: {
    token: v.optional(v.string()),
    kind: v.string(),
    message: v.string(),
    detail: v.optional(v.string()),
    page: v.string(),
    platform: v.string(),
    build: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { token, kind, message, detail, page, platform, build }) => {
    if (await flooded(ctx)) return null;
    // A signed-out screen, or a token that has expired, still reports; it just has no profile.
    const profile = await profileFromToken(ctx, token);
    await ctx.db.insert("clientLogs", {
      at: Date.now(),
      profileId: profile?._id,
      kind: scrub(kind, 40),
      message: scrub(message, MESSAGE_MAX),
      detail: detail === undefined ? undefined : scrub(detail, DETAIL_MAX),
      page: scrub(page, 300),
      platform: scrub(platform, 100),
      build: build === undefined ? undefined : scrub(build, 40),
    });
    return null;
  },
});

/**
 * A copy of a title that was slow to reach TorBox, and the service it was waiting on (engine.ts), as the person only
 * sees a long "Adding to TorBox".
 */
export const slowSource = internalMutation({
  args: { videoId: v.string(), host: v.string(), ms: v.number(), file: v.string() },
  handler: async (ctx, { videoId, host, ms, file }) => {
    if (await flooded(ctx)) return;
    await ctx.db.insert("clientLogs", {
      at: Date.now(),
      kind: "source",
      message: `${host} took ${Math.round(ms / 1000)} s to reach TorBox`,
      detail: scrub(JSON.stringify({ file, ms }), DETAIL_MAX),
      page: videoId,
      platform: "server",
    });
  },
});

/** A Play that ended on an error, with what the loading screen said; the browser only sees the room change. */
export const playFailed = internalMutation({
  args: { videoId: v.string(), message: v.string() },
  handler: async (ctx, { videoId, message }) => {
    if (await flooded(ctx)) return;
    await ctx.db.insert("clientLogs", {
      at: Date.now(),
      kind: "play",
      message: scrub(message, MESSAGE_MAX),
      page: videoId,
      platform: "server",
    });
  },
});

async function flooded(ctx: MutationCtx) {
  const recent = await ctx.db.query("clientLogs").withIndex("by_at", (q) => q.gt("at", Date.now() - 60_000)).take(PER_MINUTE);
  return recent.length >= PER_MINUTE;
}

/** The newest rows first, with the profile's name. For scripts/logs.mjs. */
export const recent = internalQuery({
  args: { since: v.optional(v.number()), limit: v.optional(v.number()), kind: v.optional(v.string()) },
  handler: async (ctx, { since = 0, limit = 50, kind }) => {
    const rows = await ctx.db
      .query("clientLogs")
      .withIndex("by_at", (q) => q.gt("at", since))
      .order("desc")
      .filter((q) => (kind ? q.eq(q.field("kind"), kind) : true))
      .take(Math.min(limit, 1000));
    const names = new Map<string, string>();
    for (const row of rows)
      if (row.profileId && !names.has(row.profileId)) names.set(row.profileId, (await ctx.db.get(row.profileId))?.name ?? "(gone)");
    return rows.map(({ _id, _creationTime, profileId, ...row }) => ({ ...row, profile: profileId ? names.get(profileId) : undefined }));
  },
});

export const prune = internalMutation({
  args: {},
  handler: async (ctx) => {
    const old = await ctx.db.query("clientLogs").withIndex("by_at", (q) => q.lt("at", Date.now() - KEEP_MS)).take(500);
    for (const row of old) await ctx.db.delete(row._id);
    if (old.length === 500) await ctx.scheduler.runAfter(0, internal.logs.prune, {});
  },
});
