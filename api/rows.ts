import { proxyAddon } from "../server/addonProxy.js";
import { shownRows } from "../server/catalogs.js";
import { endpoint, json, optional } from "../server/http.js";
import { apiKeys, sessionKeys } from "../server/session.js";

// GET /api/rows: Krida's built-in rows for Home (a profile's addon catalogs come from its browser, and its own rows
// from Convex).
// GET /api/rows?addon=<url>: an addon's manifest, catalog, metadata or subtitles, for an addon that doesn't send CORS
// headers. It lives here because Vercel's free plan deploys at most 12 endpoints.
export default endpoint(async (params, request) => {
  const addon = optional(params, "addon", 4000);
  if (addon) {
    // Signed-in people only, so it isn't an open proxy.
    await sessionKeys(request);
    return json(await proxyAddon(addon), { cdn: 600, stale: 3600 });
  }
  const keys = await apiKeys(request);
  // Without MDBList, the scores are missing: kept a minute, so it never stands in for the full rows for long.
  return json({ rows: await shownRows(keys) }, keys.mdblist ? { cdn: 1800, stale: 86400 } : { cdn: 60, stale: 0 });
});
