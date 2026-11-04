import { ConvexError, v } from "convex/values";
import { action, type ActionCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { carriesSecret, fileLink as torboxFileLink, resolveDirect, torboxKeyOf } from "./lib/providers";

/**
 * The stream's own file, for whatever plays it as it is: Krida for Windows and Mac (mpv, at its full quality instead of
 * TorBox's HLS), and the browser and external players for another debrid service's files and plain web videos. A
 * TorBox file's link carries the account's TorBox key; a direct stream's comes from following the addon's link (which
 * can carry the account's debrid key) afresh, since a debrid service's links run out. So only profiles of the stream's
 * account get it, and for a plain web video the people in a room playing it (engine.mayHaveFile); anyone else (a guest
 * in someone else's party) gets null and plays the HLS stream. Null too when the stream is gone.
 */
export const fileLink = action({
  args: { token: v.string(), streamId: v.id("streams") },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, { token, streamId }): Promise<string | null> => {
    const profileId = await ctx.runQuery(internal.profiles.validate, { token });
    if (!profileId) throw new ConvexError({ code: "UNAUTHENTICATED", message: "Sign in to continue" });
    return await fileOf(ctx, profileId, streamId);
  },
});

/** `fileLink` for a profile already signed in; the HLS route plays a plain .m3u8 from it too (http.ts). */
export async function fileOf(ctx: ActionCtx, profileId: Id<"profiles">, streamId: Id<"streams">): Promise<string | null> {
  const stream = await ctx.runQuery(internal.engine.getStream, { streamId });
  if (!stream) return null;
  const { accountId, keys } = await ctx.runQuery(internal.accounts.keysOfProfile, { profileId });
  if (!accountId || stream.accountId !== accountId) {
    if (!stream.direct?.plain || !(await ctx.runQuery(internal.engine.mayHaveFile, { profileId, streamId }))) return null;
    // Followed afresh, so the file it lands on now must still be a plain one, holding none of the account's keys,
    // before it leaves the account. The addon's link held no secret when the stream was made (engine.buildStream).
    const file = await resolveDirect({ url: stream.direct.link, filename: stream.source?.filename }).catch(() => null);
    const owner = stream.accountId ? await ctx.runQuery(internal.accounts.keysOfAccount, { accountId: stream.accountId }) : {};
    return file?.plain && !carriesSecret(file.url, owner, []) ? file.url : null;
  }
  if (stream.direct) return (await resolveDirect({ url: stream.direct.link, filename: stream.source?.filename }).catch(() => null))?.url ?? null;
  if (keys.debrid?.service !== "torbox" || stream.torrentId === undefined || stream.fileId === undefined) return null;
  return await torboxFileLink(torboxKeyOf(keys), stream.torrentId, stream.fileId);
}
