import { BadRequest, endpoint, json, kind, titleId } from "../server/http.js";
import { apiKeys } from "../server/session.js";
import { infoFor } from "../server/titles.js";

// GET /api/title?id=tt…&type=movie: a title page's ratings, certification and trailer link, from MDBList with the
// caller's key (a 403 asking for it when the account has none and nothing is kept).
export default endpoint(async (params, request) => {
  const id = titleId(params);
  if (!id.startsWith("tt")) throw new BadRequest("Ratings are by IMDb id");
  return json(await infoFor(await apiKeys(request), id, kind(params)), { cdn: 86400, stale: 7 * 86400, browser: 3600 });
});
