import { ConvexError, v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { fileLink as torboxFileLink, resolveDirect, torboxKeyOf } from "./lib/providers";

/**
 * The stream's own file, for whatever plays it as it is: Krida for Windows and Mac (mpv, at its full quality instead of
 * TorBox's HLS), and the browser and external players for another debrid service's files. A TorBox file's link carries
 * the account's TorBox key; a direct stream's comes from following the addon's link (which carries the account's
 * debrid key) afresh, since a debrid service's links run out. So only profiles of the stream's account get it; anyone
 * else (a guest in someone else's party) gets null and plays the HLS stream. Null too when the stream is gone.
 */
export const fileLink = action({
  args: { token: v.string(), streamId: v.id("streams") },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, { token, streamId }): Promise<string | null> => {
    const profileId = await ctx.runQuery(internal.profiles.validate, { token });
    if (!profileId) throw new ConvexError({ code: "UNAUTHENTICATED", message: "Sign in to continue" });
    const stream = await ctx.runQuery(internal.engine.getStream, { streamId });
    if (!stream) return null;
    const { accountId, keys } = await ctx.runQuery(internal.accounts.keysOfProfile, { profileId });
    if (!accountId || stream.accountId !== accountId) return null;
    if (stream.direct) return (await resolveDirect({ url: stream.direct.link, filename: stream.source?.filename }).catch(() => null))?.url ?? null;
    if (keys.debrid?.service !== "torbox" || stream.torrentId === undefined || stream.fileId === undefined) return null;
    return await torboxFileLink(torboxKeyOf(keys), stream.torrentId, stream.fileId);
  },
});
