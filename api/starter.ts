import { starterTitles } from "../server/catalogs.js";
import { endpoint, json } from "../server/http.js";
import { apiKeys } from "../server/session.js";

// GET /api/starter: well-known titles from every genre, for a new profile to rate.
export default endpoint(async (_params, request) => {
  const items = (await starterTitles(await apiKeys(request))).map(({ id, type, name, poster, year }) => ({ id, type, name, poster, year }));
  if (items.length === 0) throw new Error("TMDB didn't answer");
  return json({ items }, items.length >= 30 ? { cdn: 3600, stale: 86400, browser: 3600 } : { cdn: 60, stale: 0 });
});
