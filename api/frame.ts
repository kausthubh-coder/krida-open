import { endpoint, keyframePlace } from "../server/http.js";
import { readKeyframe } from "../server/mkv.js";
import { torboxKey } from "../server/session.js";
import { fileReader } from "../server/torbox.js";

// GET /api/frame?size=<bytes>&cluster=<offset>&relative=<offset or -1>&track=<n>: one keyframe of a film, as the
// compressed frame the browser decodes (a few hundred KB of a file that can be 30 GB). The places come from
// /api/frames, read from the caller's account's TorBox. A frame never changes, so the CDN keeps it and a second viewer costs TorBox nothing. The frames Worker
// (workers/frames) answers the same on Cloudflare; this is where the player falls back to without it.
export default endpoint(async (params, request) => {
  const { size, cluster, relative, track } = keyframePlace(params);
  const read = await fileReader(await torboxKey(request), size);
  const frame = read ? await readKeyframe(read, cluster, relative, track) : null;
  if (!frame) return Response.json({ error: "No keyframe there" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  return new Response(frame.buffer as ArrayBuffer, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "private, max-age=86400",
      "Vercel-CDN-Cache-Control": "max-age=31536000, immutable",
    },
  });
});
