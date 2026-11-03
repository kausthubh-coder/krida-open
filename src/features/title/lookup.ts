// What artwork lookups need to find a title that has no IMDb link.
import type { Meta } from "../../data/cinemeta";

/**
 * The page's backdrop. New anime that only Kitsu knows gets TMDB's (`useAnimeFill`); when TMDB has none either,
 * the poster fills in, blurred, rather than leaving the page dark.
 */
/** What TMDB is searched for when its artwork isn't linked to the IMDb id. */
export const lookupOf = (meta: Meta) => ({ name: meta.name, year: meta.year ?? meta.releaseInfo, type: meta.type });
