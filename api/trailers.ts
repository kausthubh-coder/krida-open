import { endpoint, imdbIds, json } from "../server/http.js";
import { trailersFor } from "../server/trailers.js";

// GET /api/trailers?ids=tt1,tt2: IMDb's trailer files for up to 30 titles. Their links are signed for about a day.
export default endpoint(async (params) => json(await trailersFor(imdbIds(params, "ids", 30)), { cdn: 3600, stale: 3600 }));
