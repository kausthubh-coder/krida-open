import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { createStream, playlistUrl, torboxKeyOf } from "./lib/providers";

const http = httpRouter();

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "*",
};

/**
 * Serves TorBox's HLS playlist without exposing the account's key. Only this small text file passes
 * through Convex; the browser loads the video segments straight from TorBox's CDN, which needs no key.
 */
http.route({
  path: "/hls/playlist.m3u8",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const token = url.searchParams.get("t") ?? undefined;
    const streamId = url.searchParams.get("s") as Id<"streams"> | null;
    const audio = Math.max(0, Number(url.searchParams.get("a") ?? 0) | 0);

    const profileId = await ctx.runQuery(internal.profiles.validate, { token });
    if (!profileId || !streamId) return new Response("Unauthorized", { status: 401, headers: cors });

    const found = await ctx.runQuery(internal.engine.getStream, { streamId }).catch(() => null);
    // A direct stream (another debrid service) has no HLS: the file plays from its own link.
    if (!found?.accountId || found.torrentId === undefined || found.fileId === undefined || !found.domain || !found.presignedToken)
      return new Response("Not found", { status: 404, headers: cors });
    // A stream id alone isn't a ticket: out of the room (left, kicked, the party over), it stops playing.
    if (!(await ctx.runQuery(internal.engine.mayPlay, { profileId, streamId }).catch(() => false)))
      return new Response("Forbidden", { status: 403, headers: cors });
    let stream = { ...found, accountId: found.accountId, torrentId: found.torrentId, fileId: found.fileId, domain: found.domain, presignedToken: found.presignedToken };
    // The key of the account whose TorBox holds the file, whoever in the room is watching.
    let key: string;
    try {
      key = torboxKeyOf(await ctx.runQuery(internal.accounts.keysOfAccount, { accountId: stream.accountId }));
    } catch {
      return new Response("This stream's TorBox key was removed", { status: 410, headers: cors });
    }

    const fetchPlaylist = async (domain: string, presigned: string) => {
      const base = playlistUrl(domain, presigned, audio);
      const res = await fetch(`${base}playlist.m3u8?token=${key}&scrobbling_enabled=False`);
      return { res, base };
    };

    let { res, base } = await fetchPlaylist(stream.domain, stream.presignedToken);
    if (!res.ok) {
      // TorBox stream sessions expire. Start a fresh one for the same file and try once more.
      const { chapterIntro: _unused, ...fresh } = await createStream(key, stream.torrentId, stream.fileId);
      await ctx.runMutation(internal.engine.patchStream, {
        streamId,
        presignedToken: fresh.presignedToken,
        domain: fresh.domain,
      });
      stream = { ...stream, presignedToken: fresh.presignedToken, domain: fresh.domain };
      ({ res, base } = await fetchPlaylist(stream.domain, stream.presignedToken));
    }
    if (!res.ok) return new Response(`Upstream ${res.status}`, { status: 502, headers: cors });

    const body = (await res.text())
      .split("\n")
      .map((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) return line;
        if (/^https?:\/\//.test(trimmed)) return trimmed.replace(/([?&])token=[^&]*/g, "$1");
        return base + trimmed;
      })
      .join("\n");

    return new Response(body, {
      status: 200,
      headers: {
        ...cors,
        "content-type": "application/vnd.apple.mpegurl",
        "cache-control": "private, max-age=30",
      },
    });
  }),
});

http.route({
  path: "/hls/playlist.m3u8",
  method: "OPTIONS",
  handler: httpAction(async () => new Response(null, { status: 204, headers: cors })),
});

export default http;
