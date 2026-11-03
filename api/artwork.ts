import { endpoint, json, optional, optionalKind, titleId } from "../server/http.js";
import { apiKeys } from "../server/session.js";
import { artworkFor } from "../server/titles.js";

// GET /api/artwork?id=…&name=…&year=…&type=…: TMDB's poster and backdrop for a title whose usual artwork is missing.
export default endpoint(async (params, request) =>
  json(await artworkFor(await apiKeys(request), titleId(params), optional(params, "name"), optional(params, "year", 12), optionalKind(params)),
    { cdn: 7 * 86400, stale: 30 * 86400, browser: 86400 }));
