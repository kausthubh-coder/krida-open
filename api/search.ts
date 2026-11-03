import { BadRequest, endpoint, json, optional, param } from "../server/http.js";
import { personIdFor, personPage } from "../server/people.js";
import { search } from "../server/search.js";
import { apiKeys } from "../server/session.js";

// GET /api/search?q=…: titles, people, anime and tag browsing for a query.
// GET /api/search?person=525, or ?person=<name>&title=tt…: one person's page, a name found among that title's credits.
// A person's page lives here because Vercel's free plan deploys at most 12 endpoints.
export default endpoint(async (params, request) => {
  const keys = await apiKeys(request);
  const person = optional(params, "person", 100);
  if (person) {
    const id = /^\d+$/.test(person) ? Number(person) : await personIdFor(keys, person, optional(params, "title", 40));
    const page = id ? await personPage(keys, id) : null;
    if (!page) throw new BadRequest("No such person");
    return json(page, { cdn: 86400, stale: 7 * 86400, browser: 3600 });
  }
  const { found, partial } = await search(keys, param(params, "q", 100));
  // Missing a source: kept only a minute, so the next search has it again.
  return json(found, partial ? { cdn: 60, stale: 0 } : { cdn: 3600, stale: 86400, browser: 300 });
});
