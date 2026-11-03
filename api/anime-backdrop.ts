import { BadRequest, endpoint, json, kind, param } from "../server/http.js";
import { apiKeys } from "../server/session.js";
import { animeBackdrop } from "../server/titles.js";

// GET /api/anime-backdrop?tmdbId=…&type=…: TMDB's best backdrop for an anime matched through ani.zip.
export default endpoint(async (params, request) => {
  const tmdbId = param(params, "tmdbId", 12);
  if (!/^\d+$/.test(tmdbId)) throw new BadRequest("tmdbId must be a number");
  return json(await animeBackdrop(await apiKeys(request), tmdbId, kind(params)), { cdn: 7 * 86400, stale: 30 * 86400, browser: 86400 });
});
