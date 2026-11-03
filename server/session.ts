import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import { NeedsKey, Unauthorized, type ApiKeys } from "./http.js";

declare const process: { env: Record<string, string | undefined> };

const PRODUCTION = "https://industrious-axolotl-949.convex.cloud";
// Keys this instance has read lately, so a page asking for several titles reads them once. Short, so a key someone
// just changed in Settings is used within a minute.
const KEYS_MS = 60_000;
const known = new Map<string, { keys: AccountKeys; until: number }>();

/** An account's keys as Convex keeps them (convex/accounts.ts `keys`). */
export type AccountKeys = { tmdb?: string; mdblist?: string; debrid?: { service: string; key: string } };

/**
 * Checks a Krida session against the Convex deployment the browser uses, and reads its account's keys: every endpoint
 * that asks TMDB, MDBList or TorBox asks with the caller's own keys. Production only trusts production; a preview
 * trusts its own Convex preview.
 */
export async function requireSession(backend: unknown, token: unknown) {
  if (typeof backend !== "string" || typeof token !== "string" || token.length > 200) throw new Unauthorized("Sign in to ask for this");
  const trusted = process.env.VERCEL_ENV === "production" ? backend === PRODUCTION : /^https:\/\/[a-z0-9-]+\.convex\.cloud$/.test(backend)
    // Outside Vercel (npm run dev), a worktree's own local backend (scripts/setup.mjs).
    || (!process.env.VERCEL_ENV && /^http:\/\/127\.0\.0\.1:\d+$/.test(backend));
  if (!trusted) throw new Unauthorized("Unknown backend");
  const client = new ConvexHttpClient(backend);
  const [me, keys] = await Promise.all([client.query(anyApi.profiles.me, { token }), client.query(anyApi.accounts.keys, { token })]);
  if (!me) throw new Unauthorized("Sign in again");
  return { me: me as { _id: string; name: string }, keys: (keys ?? {}) as AccountKeys };
}

/** The keys of the account whose session sent this request (the x-krida-backend and x-krida-session headers). */
export async function sessionKeys(request: Request): Promise<AccountKeys> {
  const backend = request.headers.get("x-krida-backend");
  const token = request.headers.get("x-krida-session");
  const cacheKey = `${backend} ${token}`;
  const hit = known.get(cacheKey);
  if (hit && hit.until > Date.now()) return hit.keys;
  const { keys } = await requireSession(backend, token);
  // Only an account that has its TMDB key is remembered: one that just added it shouldn't wait a minute to use it.
  if (keys.tmdb) known.set(cacheKey, { keys, until: Date.now() + KEYS_MS });
  if (known.size > 1000) known.clear();
  return keys;
}

export const NEEDS_TMDB = "Add your TMDB key in Settings → Connections to see titles.";

/**
 * The caller's TMDB key (required) and MDBList key (optional), for endpoints that ask them. Answers stay shared in the
 * caches: TMDB's data isn't personal, so whoever's key fetched it, everyone gets the same answer.
 */
export async function apiKeys(request: Request): Promise<ApiKeys> {
  const { tmdb, mdblist } = await sessionKeys(request);
  if (!tmdb) throw new NeedsKey("tmdb", NEEDS_TMDB);
  return { tmdb, mdblist };
}

/** The caller's TorBox key, for reading a film's own file (the timeline's preview pictures). */
export async function torboxKey(request: Request): Promise<string> {
  const { debrid } = await sessionKeys(request);
  if (debrid?.service !== "torbox") throw new NeedsKey("torbox", "Preview pictures need a TorBox key in Settings → Connections.");
  return debrid.key;
}
