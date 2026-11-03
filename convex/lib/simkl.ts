import { env } from "./providers";
import { expandEpisodes } from "./episodes";

export { expandEpisodes };

/**
 * Simkl (AUTH V2): OAuth with PKCE, 7-day access tokens refreshed with a 180-day sliding refresh token.
 * Tokens and the client secret stay on the server.
 */

const API = "https://api.simkl.com";
const APP_NAME = "krida";
const APP_VERSION = "1.0";
const USER_AGENT = `${APP_NAME}/${APP_VERSION}`;
export const ISSUER = "https://simkl.com";
export const SCOPE = "media:read media:write";

/** Where Simkl may send people back to: exactly the URLs registered on the Simkl app. */
export const REDIRECT_URIS = ["https://krida-open.vercel.app/connect/simkl", "http://localhost/connect/simkl"];

export class SimklAuthError extends Error {}
/** 429: Simkl asked us to slow down; `retryAfter` is in ms. */
export class SimklRateError extends Error {
  retryAfter: number;
  constructor(retryAfter: number) {
    super("rate limited");
    this.retryAfter = retryAfter;
  }
}
/** 400 max_items: the response would be too big to build; ask for less at a time. */
export class SimklTooBigError extends Error {}
/** Any other 4xx: the request itself is wrong, so retrying won't help. */
export class SimklRejectedError extends Error {}

function base64url(bytes: Uint8Array) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function pkcePair() {
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  const verifier = base64url(raw);
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  return { verifier, challenge };
}

export function authorizeUrl(state: string, challenge: string, redirectUri: string) {
  const url = new URL(`${ISSUER}/oauth2/authorize`);
  url.searchParams.set("client_id", env("SIMKL_CLIENT_ID"));
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export type TokenSet = { accessToken: string; refreshToken?: string; expiresAt?: number; scope: string };

/** The token endpoint, for the code exchange and refreshes. */
export async function tokenGrant(params: Record<string, string>): Promise<TokenSet> {
  const res = await fetch(`${API}/oauth2/token`, {
    method: "POST",
    signal: AbortSignal.timeout(30_000),
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": USER_AGENT },
    body: new URLSearchParams({
      ...params,
      client_id: env("SIMKL_CLIENT_ID"),
      client_secret: env("SIMKL_CLIENT_SECRET"),
    }),
  });
  const body = (await res.json().catch(() => ({}))) as any;
  if (!res.ok || typeof body.access_token !== "string") {
    console.warn("simkl token", res.status, body?.error, body?.error_description);
    if (res.status === 400 || res.status === 401) throw new SimklAuthError(body?.error ?? "invalid_grant");
    throw new Error(`Simkl answered ${res.status}`);
  }
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : undefined,
    expiresAt: typeof body.expires_in === "number" ? Date.now() + body.expires_in * 1000 : undefined,
    scope: typeof body.scope === "string" ? body.scope : "",
  };
}

export async function revoke(token: string) {
  await fetch(`${API}/oauth2/revoke`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": USER_AGENT },
    body: new URLSearchParams({
      token,
      client_id: env("SIMKL_CLIENT_ID"),
      client_secret: env("SIMKL_CLIENT_SECRET"),
    }),
  }).catch(() => {});
}

export async function simkl<T>(
  path: string,
  accessToken: string,
  { method = "GET", params = {}, body }: { method?: string; params?: Record<string, string>; body?: unknown } = {},
): Promise<T> {
  const url = new URL(API + path);
  url.searchParams.set("client_id", env("SIMKL_CLIENT_ID"));
  url.searchParams.set("app-name", APP_NAME);
  url.searchParams.set("app-version", APP_VERSION);
  for (const [k, value] of Object.entries(params)) url.searchParams.set(k, value);
  const res = await fetch(url, {
    method,
    signal: AbortSignal.timeout(30_000),
    headers: {
      "user-agent": USER_AGENT,
      authorization: `Bearer ${accessToken}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) throw new SimklAuthError("unauthorized");
  if (res.status === 429) {
    const seconds = Number(res.headers.get("retry-after"));
    throw new SimklRateError((Number.isFinite(seconds) && seconds > 0 ? seconds : 60) * 1000);
  }
  if (res.status === 400) {
    const body = await res.json().catch(() => null);
    if (body?.error === "max_items") throw new SimklTooBigError(String(body.message ?? "max_items"));
    throw new SimklRejectedError(`Simkl rejected ${path}: ${body?.error ?? 400}`);
  }
  if (res.status >= 400 && res.status < 500) throw new SimklRejectedError(`Simkl answered ${res.status} for ${path}`);
  if (!res.ok) throw new Error(`Simkl answered ${res.status} for ${path}`);
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

export const posterUrl = (path: unknown) =>
  typeof path === "string" && path ? `https://wsrv.nl/?url=https://simkl.in/posters/${path}_m.webp&q=90` : undefined;

export type Status = "watching" | "plantowatch" | "hold" | "completed" | "dropped";

/** One library entry from /sync/all-items or /sync/ratings, before its id is resolved. */
export type SimklEntry = {
  simklId: number;
  type: "movie" | "series";
  anime: boolean;
  imdb?: string;
  kitsu?: number;
  mal?: number;
  name: string;
  poster?: string;
  year?: string;
  status: Status;
  rating?: number;
  ratedAt?: number;
  watchedEpisodes?: number;
  totalEpisodes?: number;
  nextSeason?: number;
  nextEpisode?: number;
  // Watched episodes, compact: "1:1-12,14;2:1-3".
  watched?: string;
  // When each episode was marked watched: "1:1@<base36 seconds>,…".
  watchedAt?: string;
  runtime?: number;
  lastWatchedAt?: number;
  addedAt?: number;
};

const STATUSES = new Set(["watching", "plantowatch", "hold", "completed", "dropped"]);
const time = (value: unknown) => {
  const t = typeof value === "string" ? Date.parse(value) : NaN;
  // Simkl's "a very long time ago" placeholder is 1970; treat it as unknown.
  return Number.isFinite(t) && t > 86_400_000 ? t : undefined;
};
const int = (value: unknown) => {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/** "S02E05" (or "E05" for anime, which Simkl numbers as one season). */
function nextUp(value: unknown, anime: boolean) {
  if (typeof value !== "string") return {};
  const m = /^(?:S(\d+))?E(\d+)$/i.exec(value.trim());
  if (!m) return {};
  const season = m[1] ? Number(m[1]) : anime ? 1 : undefined;
  return season === undefined ? {} : { nextSeason: season, nextEpisode: Number(m[2]) };
}

/** Watched episodes as "season:ranges" joined by ";", e.g. "1:1-12,14;2:1-3". */
function compactEpisodes(seasons: unknown): string | undefined {
  if (!Array.isArray(seasons)) return undefined;
  const parts: string[] = [];
  for (const season of seasons) {
    const n = Number(season?.number ?? 1);
    const eps = (Array.isArray(season?.episodes) ? season.episodes : [])
      .map((e: any) => Number(e?.number))
      .filter((e: number) => Number.isInteger(e) && e > 0)
      .sort((a: number, b: number) => a - b);
    if (!Number.isInteger(n) || eps.length === 0) continue;
    const ranges: string[] = [];
    let start = eps[0];
    let prev = eps[0];
    for (const e of [...eps.slice(1), Infinity]) {
      if (e === prev || e === prev + 1) {
        prev = e;
        continue;
      }
      ranges.push(start === prev ? String(start) : `${start}-${prev}`);
      start = prev = e;
    }
    parts.push(`${n}:${ranges.join(",")}`);
  }
  return parts.length ? parts.join(";") : undefined;
}

/** When each watched episode was marked watched, compact: "1:1@<base36 seconds>,1:2@…". */
function episodeTimes(seasons: unknown): string | undefined {
  if (!Array.isArray(seasons)) return undefined;
  const parts: string[] = [];
  for (const season of seasons) {
    const n = Number(season?.number ?? 1);
    for (const e of Array.isArray(season?.episodes) ? season.episodes : []) {
      const t = time(e?.watched_at);
      if (Number.isInteger(n) && Number.isInteger(Number(e?.number)) && t !== undefined)
        parts.push(`${n}:${Number(e.number)}@${Math.floor(t / 1000).toString(36)}`);
    }
  }
  return parts.length ? parts.join(",") : undefined;
}

/** "1:1@kx2a,1:2@kx3b" → each episode key with its time in ms. */
export function expandWatchedAt(compact: string | undefined): { key: string; t: number }[] {
  if (!compact) return [];
  return compact.split(",").map((part) => {
    const [key, at] = part.split("@");
    return { key, t: Number.parseInt(at ?? "", 36) * 1000 };
  }).filter((e) => e.key && Number.isFinite(e.t));
}

/** A tracked row's episode fields with some "season:episode" keys taken out (unmarked in Krida). */
export function withoutEpisodes(row: { watched?: string; watchedAt?: string; watchedEpisodes?: number }, drop: Set<string>) {
  const seasons = new Map<number, { number: number }[]>();
  let removed = 0;
  for (const key of expandEpisodes(row.watched)) {
    if (drop.has(key)) {
      removed++;
      continue;
    }
    const [season, episode] = key.split(":").map(Number);
    const list = seasons.get(season) ?? [];
    list.push({ number: episode });
    seasons.set(season, list);
  }
  const watchedAt = row.watchedAt?.split(",").filter((part) => !drop.has(part.split("@")[0])).join(",");
  return {
    watched: compactEpisodes([...seasons].map(([number, episodes]) => ({ number, episodes }))),
    watchedAt: watchedAt || undefined,
    watchedEpisodes: row.watchedEpisodes === undefined ? undefined : Math.max(0, row.watchedEpisodes - removed),
  };
}

export function parseLibrary(body: any): SimklEntry[] {
  const out: SimklEntry[] = [];
  for (const kind of ["movies", "shows", "anime"] as const) {
    for (const row of Array.isArray(body?.[kind]) ? body[kind] : []) {
      const m = row?.movie ?? row?.show ?? row?.anime;
      const ids = m?.ids ?? {};
      const simklId = int(ids.simkl);
      const status = row?.status === "notinteresting" ? "dropped" : row?.status;
      if (!simklId || !STATUSES.has(status) || typeof m?.title !== "string") continue;
      const anime = kind === "anime";
      out.push({
        simklId,
        type: kind === "movies" || (anime && row.anime_type === "movie") ? "movie" : "series",
        anime,
        imdb: typeof ids.imdb === "string" && ids.imdb.startsWith("tt") ? ids.imdb : undefined,
        kitsu: int(ids.kitsu),
        mal: int(ids.mal),
        name: m.title,
        poster: posterUrl(m.poster),
        year: m.year ? String(m.year) : undefined,
        status,
        rating: int(row.user_rating),
        ratedAt: time(row.user_rated_at),
        watchedEpisodes: int(row.watched_episodes_count),
        totalEpisodes: int(row.total_episodes_count),
        ...(row.status === "watching" || row.status === "hold" ? nextUp(row.next_to_watch, anime) : {}),
        watched: compactEpisodes(row.seasons),
        watchedAt: episodeTimes(row.seasons),
        runtime: int(m.runtime),
        lastWatchedAt: time(row.last_watched_at),
        addedAt: time(row.added_to_watchlist_at),
      });
    }
  }
  return out;
}
