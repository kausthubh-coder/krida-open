// A title's id is an IMDb id ("tt0903747") or a Kitsu id ("kitsu:1376"). One rule for the browser, Convex and Vercel.
// The digit limits keep a malformed or hostile id from reaching a provider; real ids are well inside them.

export const isImdbId = (id: string) => /^tt\d{1,10}$/.test(id);
export const isKitsuId = (id: string) => /^kitsu:\d{1,8}$/.test(id);
export const isTitleId = (id: string) => isImdbId(id) || isKitsuId(id);
