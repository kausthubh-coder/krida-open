import { imdbTrailers, type ImdbTrailer } from "../shared/imdb.js";
import { cachedMany, HOUR } from "./cache.js";

/**
 * IMDb's trailer files for these titles, for Home's muted previews. Kept until 6 hours before their signed links
 * expire (about a day), so whoever gets one has hours to play it. Titles IMDb didn't answer for are left out.
 */
export async function trailersFor(ids: string[]): Promise<ImdbTrailer[]> {
  const ttl = (t: ImdbTrailer) => Math.max(0, Math.min(12 * HOUR, Math.floor((t.expires - Date.now()) / 1000) - 6 * HOUR));
  // IMDb failing outright fails the request, so the browser's retry asks again instead of reading an empty answer.
  const found = await cachedMany<ImdbTrailer>("imdb-trailer", ids, ttl, async (missing) =>
    new Map((await imdbTrailers(missing)).map((t) => [t.id, t])));
  return ids.flatMap((id) => found.get(id) ?? []);
}
