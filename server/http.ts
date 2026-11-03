import { reported } from "./telemetry.js";
import { isImdbId, isTitleId } from "../shared/ids.js";
import { TmdbKeyRefused } from "../shared/tmdb.js";
/*
 * Krida's endpoints on Vercel (/api/*). Most are public data (titles, ratings, search, catalogs, trailers), the same for
 * everyone. Answers are kept by Vercel's CDN, so a repeat costs no function run at all, and they never touch Convex.
 */

export class BadRequest extends Error {}
export class Unauthorized extends Error {}

/** The keys an endpoint asks TMDB and MDBList with: the caller's account's (server/session.ts). */
export type ApiKeys = { tmdb: string; mdblist?: string };

/** The caller's account has no key for what this needs: a 403 the app shows as "Add your … key in Settings". */
export class NeedsKey extends Error {
  readonly key: "tmdb" | "mdblist" | "torbox";
  constructor(key: "tmdb" | "mdblist" | "torbox", message: string) {
    super(message);
    this.key = key;
  }
}
/** The service behind an endpoint failed or refused (not this code): a 502 that says so. */
export class UpstreamError extends Error {}

/** The service behind an endpoint asked to slow down (a 429). Answered as a 429 with its wait, never retried here. */
export class SlowDown extends Error {
  readonly seconds: number;
  constructor(seconds: number) {
    super("Asked to slow down");
    this.seconds = seconds;
  }
}

type Caching = {
  /** Seconds Vercel's CDN keeps the answer, and how long after that it may still serve it while refreshing. */
  cdn: number;
  stale?: number;
  /** Seconds the browser keeps it. */
  browser?: number;
};

export function json(body: unknown, { cdn, stale = cdn, browser = 0 }: Caching): Response {
  return Response.json(body, {
    headers: {
      "Cache-Control": `public, max-age=${browser}`,
      "Vercel-CDN-Cache-Control": `max-age=${cdn}, stale-while-revalidate=${stale}, stale-if-error=${stale}`,
    },
  });
}

const fail = (status: number, message: string, extra: Record<string, string> = {}) =>
  Response.json({ error: message, ...extra }, { status, headers: { "Cache-Control": "no-store" } });

/** A 429 that says how long to wait. */
export const slowDown = (error: SlowDown, headers: Record<string, string> = {}) =>
  Response.json({ error: "TorBox asked to slow down" }, { status: 429, headers: { ...headers, "Cache-Control": "no-store", "Retry-After": String(error.seconds) } });

/** An endpoint: its query string (and request) in, an answer out (`json` for a cached one). Failures are never cached. */
export function endpoint(handle: (params: URLSearchParams, request: Request) => Promise<Response>) {
  return {
    async fetch(request: Request) {
      if (request.method !== "GET" && request.method !== "POST") return fail(405, "Method not allowed");
      return reported(request, async (failed) => {
        try {
          return await handle(new URL(request.url).searchParams, request);
        } catch (error) {
          if (error instanceof BadRequest) return fail(400, error.message);
          if (error instanceof Unauthorized) return fail(401, error.message);
          if (error instanceof NeedsKey) return fail(403, error.message, { needs: error.key });
          // The app asks Convex to check the key again (onboarding.recheck), which sends the account to fix it.
          if (error instanceof TmdbKeyRefused) return fail(403, "TMDB stopped accepting your key. Add a new one in Settings → Connections.", { needs: "tmdb", refused: "tmdb" });
          if (error instanceof SlowDown) return slowDown(error);
          console.error(new URL(request.url).pathname, error);
          failed(error);
          return fail(502, "Couldn't reach the service behind this. Try again in a moment.");
        }
      });
    },
  };
}


export function param(params: URLSearchParams, name: string, max = 200) {
  const value = params.get(name)?.trim();
  if (!value) throw new BadRequest(`Missing ${name}`);
  return value.slice(0, max);
}

export const optional = (params: URLSearchParams, name: string, max = 200) => params.get(name)?.trim().slice(0, max) || undefined;

export function kind(params: URLSearchParams, name = "type"): "movie" | "series" {
  const value = params.get(name);
  if (value !== "movie" && value !== "series") throw new BadRequest(`${name} must be movie or series`);
  return value;
}

export const optionalKind = (params: URLSearchParams, name = "type") => (params.get(name) ? kind(params, name) : undefined);

export function titleId(params: URLSearchParams, name = "id") {
  const id = param(params, name, 20);
  if (!isTitleId(id)) throw new BadRequest(`${name} isn't an IMDb or Kitsu id`);
  return id;
}

export function imdbIds(params: URLSearchParams, name: string, max: number) {
  const ids = [...new Set((params.get(name) ?? "").split(",").map((x) => x.trim()).filter(isImdbId))];
  if (ids.length > max) throw new BadRequest(`At most ${max} ids`);
  return ids.sort();
}

const whole = (s: string | null, min = 0) => (s !== null && /^-?\d+$/.test(s) && Number.isSafeInteger(Number(s)) && Number(s) >= min ? Number(s) : null);

/** Where one keyframe of a film is (from its index, server/mkv.ts), for /api/frame and the frames Worker. */
export function keyframePlace(params: URLSearchParams) {
  const size = whole(params.get("size"), 1);
  const cluster = whole(params.get("cluster"));
  const relative = whole(params.get("relative"), -1);
  const track = whole(params.get("track"), 1);
  if (size === null || cluster === null || relative === null || track === null || cluster >= size) throw new BadRequest("Malformed keyframe");
  return { size, cluster, relative, track };
}
