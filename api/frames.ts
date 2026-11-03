import { signTicket } from "../server/frameTicket.js";
import { BadRequest, endpoint } from "../server/http.js";
import { readIndex } from "../server/mkv.js";
import { torboxKey } from "../server/session.js";
import { fileReader } from "../server/torbox.js";

declare const process: { env: Record<string, string | undefined> };

// GET /api/frames?size=<bytes>: where a film's keyframes are, from its own file's index, for the timeline's preview
// (/api/frame reads one). The file is the one of exactly that size in the caller's account's TorBox. The answer never changes, so the CDN
// keeps it; null when the file has no index to read (the player then uses TorBox's HLS).
//
// GET /api/frames?size=<bytes>&ticket: where the frames Worker is and a ticket to read that film's keyframes there for
// a day (server/frameTicket.ts: it carries the account's TorBox key sealed to that file and day), never cached. The Worker answers on Cloudflare, so the pictures cost Vercel nothing.
// Null where it isn't set up (previews, local dev without it): the player then reads keyframes through /api/frame.
// It's this endpoint and not its own because Vercel's free plan allows 12 functions.
export default endpoint(async (params, request) => {
  const size = Number(params.get("size"));
  if (!Number.isSafeInteger(size) || size <= 0) throw new BadRequest("Give the file's size in bytes");
  const key = await torboxKey(request);
  if (params.has("ticket")) {
    const url = process.env.FRAMES_URL;
    const secret = process.env.FRAMES_SECRET;
    return Response.json(url && secret ? { url, ...(await signTicket(secret, size, key)) } : null, { headers: { "Cache-Control": "no-store" } });
  }
  const read = await fileReader(key, size);
  const index = read ? await readIndex(read) : null;
  return Response.json(index, {
    headers: index
      ? { "Cache-Control": "private, max-age=86400", "Vercel-CDN-Cache-Control": "max-age=31536000, immutable" }
      : { "Cache-Control": "no-store" },
  });
});
