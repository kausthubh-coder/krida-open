import { endpoint, json, kind, titleId } from "../server/http.js";
import { moreLike } from "../server/moreLike.js";
import { apiKeys } from "../server/session.js";

// GET /api/more-like?id=…&type=…: "More like this" for a title page.
export default endpoint(async (params, request) => {
  const id = titleId(params);
  const type = kind(params);
  const keys = await apiKeys(request);
  // Without MDBList, the scores are missing: kept a minute, so it never stands in for the full answer for long.
  return json(await moreLike(keys, id, type), keys.mdblist ? { cdn: 86400, stale: 7 * 86400, browser: 3600 } : { cdn: 60, stale: 0 });
});
