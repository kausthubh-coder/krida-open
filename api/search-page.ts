import { endpoint, json, param } from "../server/http.js";
import { parseCursor, searchPage } from "../server/search.js";
import { apiKeys } from "../server/session.js";

// GET /api/search-page?q=…&cursor=movie,tv,multi: the next batch of a search ("-" marks a kind with no more pages).
export default endpoint(async (params, request) => {
  const { found, partial } = await searchPage(await apiKeys(request), param(params, "q", 100), parseCursor(params.get("cursor")));
  return json(found, partial ? { cdn: 60, stale: 0 } : { cdn: 3600, stale: 86400, browser: 300 });
});
