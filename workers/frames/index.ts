/*
 * The frames Worker: /api/frame on Cloudflare. It reads one keyframe of a film out of the asking account's TorBox
 * (server/mkv.ts, server/torbox.ts) for the timeline's preview. Cloudflare doesn't charge for bandwidth and Vercel's free plan pauses
 * the site past 10 GB a month, so a picture every 10 s comes from here; /api/frame stays as the fallback.
 *
 * GET /frame?size&cluster&relative&track&expires&ticket. The ticket comes from /api/frames?ticket, which checks the
 * session; the Worker opens only the ticket (server/frameTicket.ts), so it never calls Convex. The ticket carries the
 * account's TorBox key sealed to that one file and day; the Worker holds no TorBox key of its own.
 * Secret: FRAMES_SECRET. Deploy: docs/ops.md.
 */
import { openTicket } from "../../server/frameTicket.js";
import { BadRequest, keyframePlace, SlowDown, slowDown, UpstreamError } from "../../server/http.js";
import { readKeyframe } from "../../server/mkv.js";
import { fileReader } from "../../server/torbox.js";

export type Env = { FRAMES_SECRET: string };

// Any page may ask: the ticket is what lets it in, and the answer is the same bytes for everyone with one.
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "Retry-After, X-Frames-Error" };
const fail = (status: number, error: string, about?: "file") =>
  Response.json({ error }, { status, headers: { ...CORS, "Cache-Control": "no-store", ...(about && { "X-Frames-Error": about }) } });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "GET") return fail(405, "Method not allowed");
    if (!url.pathname.endsWith("/frame")) return fail(404, "Not found");
    try {
      const { size, cluster, relative, track } = keyframePlace(url.searchParams);
      const key = await openTicket(env.FRAMES_SECRET, size, Number(url.searchParams.get("expires")), url.searchParams.get("ticket") ?? "");
      if (!key) return fail(401, "Ask /api/frames?ticket for a ticket");
      const read = await fileReader(key, size);
      const frame = read ? await readKeyframe(read, cluster, relative, track) : null;
      if (!frame) return fail(404, "No keyframe there", "file");
      return new Response(frame.buffer as ArrayBuffer, { headers: { ...CORS, "Content-Type": "application/octet-stream", "Cache-Control": "private, max-age=86400" } });
    } catch (error) {
      if (error instanceof BadRequest) return fail(400, error.message);
      if (error instanceof SlowDown) return slowDown(error, CORS);
      // TorBox took too long for this stretch of the file: the Worker is fine, the page tries another keyframe.
      // X-Frames-Error: file says the Worker is fine and TorBox or this keyframe isn't: the page doesn't fall back for it.
      if (error instanceof DOMException && error.name === "TimeoutError") return fail(504, "TorBox took too long. Try again in a moment.", "file");
      if (error instanceof UpstreamError) return fail(502, "Couldn't read the file. Try again in a moment.", "file");
      // Anything else is the Worker's own failure (a missing secret, a bug), which the page counts toward falling back.
      console.error(JSON.stringify({ message: "frame failed", path: url.pathname, error: String(error) }));
      return fail(500, "The frames Worker failed.");
    }
  },
};
