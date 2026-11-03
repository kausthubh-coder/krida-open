// What a browser reports when something fails (convex/logs.ts keeps it, src/data/log.ts sends it).

/** Longest message and detail kept; a stack trace's first lines are enough. */
export const MESSAGE_MAX = 500;
export const DETAIL_MAX = 2000;

/**
 * Takes secrets out of text before it's kept: session tokens ride in stream URLs (`t=`), and provider links carry
 * API keys. Run in the browser before sending and again on the server, so a missed caller can't store one. Session
 * replays send whole requests through it too, so it also covers JSON fields, OAuth codes and a join link's `#code=`.
 */
export function scrub(text: string, max = Infinity) {
  return text
    .replace(/([?&#](?:t|token|key|apikey|api_key|password|ticket|code|state)=)[^&#\s"']+/gi, "$1<redacted>")
    .replace(/("(?:token|ticket|key|apiKey|api_key|password|code|secret)"\s*:\s*")[^"]*/gi, "$1<redacted>")
    .replace(/((?:x-krida-session|authorization)["':\s]+(?:Bearer\s+)?)[\w.~+/=-]+/gi, "$1<redacted>")
    .slice(0, max);
}
