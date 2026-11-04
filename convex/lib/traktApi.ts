import { type ActionCtx, type QueryCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { env } from "./providers";

/**
 * Trakt, per profile, kept in step both ways (docs/trakt.md).
 *
 * Connecting uses Trakt's device code: Krida shows a short code, the person enters it at trakt.tv/activate on any
 * device, and the server asks Trakt every few seconds until they approve, for at most the ten minutes the code lives.
 * No page has to come back from Trakt, so it works the same in the browser, the installed PWA, the Android app's
 * WebView, Krida for Windows and on a TV. Tokens and the client secret stay on the server.
 *
 * Trakt → Krida: one import (plays into progress, the watchlist into Plan to watch, ratings), then only what
 * /sync/last_activities says moved. It runs while someone uses Krida, never on a timer.
 * Krida → Trakt: an outbox (convex/lib/traktOutbox.ts), batched and retried.
 */

const API = "https://api.trakt.tv";
// Trakt's Cloudflare turns away requests without one.
const USER_AGENT = "krida/1.0";
// What a device-code app sends as its redirect when refreshing.
const OOB = "urn:ietf:wg:oauth:2.0:oob";

export const MINUTE = 60 * 1000;

// Changes wait this long so a run of them goes as one request.
export const BATCH_WAIT = 45_000;

// Trakt allows one write a second per user.
export const WRITE_GAP = 1_100;

/** Whether this deployment has its own Trakt app, so Settings can offer to connect it. */
export const traktConfigured = () => !!process.env.TRAKT_CLIENT_ID && !!process.env.TRAKT_CLIENT_SECRET;

// Convex provides process.env in every runtime; declared here so the web app's typecheck agrees.
declare const process: { env: Record<string, string | undefined> };

export class TraktAuthError extends Error {}
/** 429: Trakt asked us to slow down; `retryAfter` is in ms. */
export class TraktRateError extends Error {
  retryAfter: number;
  constructor(retryAfter: number) {
    super("rate limited");
    this.retryAfter = retryAfter;
  }
}
/** Any other 4xx (420 is a free account's list limit): the request itself won't be taken, so retrying can't help. */
export class TraktRejectedError extends Error {}
/** The connection changed (disconnected, reconnected, write-back off) while a run was going. */
export class TraktStoppedError extends Error {}

const headers = (accessToken?: string) => ({
  "content-type": "application/json",
  "user-agent": USER_AGENT,
  "trakt-api-version": "2",
  "trakt-api-key": env("TRAKT_CLIENT_ID"),
  ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
});

/** One Trakt request. Returns the body and how many pages a paginated list has. */
export async function trakt<T>(
  path: string,
  accessToken: string,
  { method = "GET", params = {}, body }: { method?: string; params?: Record<string, string>; body?: unknown } = {},
): Promise<{ body: T; pages: number }> {
  const url = new URL(API + path);
  for (const [k, value] of Object.entries(params)) url.searchParams.set(k, value);
  const res = await fetch(url, {
    method,
    signal: AbortSignal.timeout(30_000),
    headers: headers(accessToken),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) throw new TraktAuthError("unauthorized");
  if (res.status === 429) {
    const seconds = Number(res.headers.get("retry-after"));
    throw new TraktRateError((Number.isFinite(seconds) && seconds > 0 ? seconds : 60) * 1000);
  }
  if (res.status >= 400 && res.status < 500) throw new TraktRejectedError(`Trakt answered ${res.status} for ${path}`);
  if (!res.ok) throw new Error(`Trakt answered ${res.status} for ${path}`);
  const text = await res.text();
  const pages = Number(res.headers.get("x-pagination-page-count"));
  return { body: (text ? JSON.parse(text) : {}) as T, pages: Number.isFinite(pages) && pages > 0 ? pages : 1 };
}

export type TokenSet = { accessToken: string; refreshToken?: string; expiresAt?: number };

const tokenSet = (body: any): TokenSet => ({
  accessToken: body.access_token,
  refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : undefined,
  expiresAt: typeof body.expires_in === "number"
    ? (typeof body.created_at === "number" ? body.created_at * 1000 : Date.now()) + body.expires_in * 1000
    : undefined,
});

/** Step 1 of connecting: a code for the person to enter at Trakt, and the device code the server polls with. */
export async function deviceCode() {
  const res = await fetch(`${API}/oauth/device/code`, {
    method: "POST",
    signal: AbortSignal.timeout(30_000),
    headers: headers(),
    body: JSON.stringify({ client_id: env("TRAKT_CLIENT_ID") }),
  });
  const body = (await res.json().catch(() => ({}))) as any;
  if (!res.ok || typeof body.device_code !== "string" || typeof body.user_code !== "string")
    throw new Error(`Trakt answered ${res.status} for a device code`);
  return {
    deviceCode: body.device_code as string,
    userCode: body.user_code as string,
    verificationUrl: typeof body.verification_url === "string" ? body.verification_url : "https://trakt.tv/activate",
    // Seconds, as Trakt gives them.
    interval: typeof body.interval === "number" && body.interval > 0 ? body.interval : 5,
    expiresIn: typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 600,
  };
}

/** What Trakt says about a device code: approved (tokens), still waiting, slow down, or over (denied, expired, used). */
export type DeviceAnswer =
  | { kind: "tokens"; tokens: TokenSet }
  | { kind: "pending" }
  | { kind: "slowDown" }
  | { kind: "over"; reason: "denied" | "expired" };

export async function deviceToken(code: string): Promise<DeviceAnswer> {
  const res = await fetch(`${API}/oauth/device/token`, {
    method: "POST",
    signal: AbortSignal.timeout(30_000),
    headers: headers(),
    body: JSON.stringify({ code, client_id: env("TRAKT_CLIENT_ID"), client_secret: env("TRAKT_CLIENT_SECRET") }),
  });
  if (res.status === 200) {
    const body = (await res.json().catch(() => ({}))) as any;
    if (typeof body.access_token === "string") return { kind: "tokens", tokens: tokenSet(body) };
    return { kind: "pending" };
  }
  if (res.status === 400) return { kind: "pending" };
  if (res.status === 429) return { kind: "slowDown" };
  if (res.status === 418) return { kind: "over", reason: "denied" };
  // 404 unknown code, 409 already used, 410 expired.
  if (res.status === 404 || res.status === 409 || res.status === 410) return { kind: "over", reason: "expired" };
  // Trakt itself is having trouble: keep asking until the code runs out.
  return { kind: "pending" };
}

export async function refreshTokens(refreshToken: string): Promise<TokenSet> {
  const res = await fetch(`${API}/oauth/token`, {
    method: "POST",
    signal: AbortSignal.timeout(30_000),
    headers: headers(),
    body: JSON.stringify({
      refresh_token: refreshToken,
      client_id: env("TRAKT_CLIENT_ID"),
      client_secret: env("TRAKT_CLIENT_SECRET"),
      redirect_uri: OOB,
      grant_type: "refresh_token",
    }),
  });
  const body = (await res.json().catch(() => ({}))) as any;
  if (!res.ok || typeof body.access_token !== "string") {
    console.warn("trakt token", res.status, body?.error);
    if (res.status === 400 || res.status === 401) throw new TraktAuthError(body?.error ?? "invalid_grant");
    throw new Error(`Trakt answered ${res.status}`);
  }
  return tokenSet(body);
}

export async function revoke(token: string) {
  const res = await fetch(`${API}/oauth/revoke`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ token, client_id: env("TRAKT_CLIENT_ID"), client_secret: env("TRAKT_CLIENT_SECRET") }),
  }).catch(() => null);
  // Krida has already forgotten the tokens; a revoke Trakt didn't take is left in the logs to see.
  if (!res?.ok) console.warn("trakt revoke", res?.status ?? "unreachable");
}

export async function traktConnectionFor(ctx: QueryCtx, profileId: Id<"profiles">) {
  return await ctx.db.query("traktConnections").withIndex("by_profile", (q) => q.eq("profileId", profileId)).first();
}

/** A token that works for the next while, refreshing it first if it's close to expiring. */
async function freshToken(ctx: ActionCtx, c: Doc<"traktConnections">, force = false) {
  if (!force && (!c.expiresAt || c.expiresAt - Date.now() > 60 * MINUTE)) return c.accessToken;
  if (!c.refreshToken) throw new TraktAuthError("expired");
  const t = await refreshTokens(c.refreshToken);
  await ctx.runMutation(internal.trakt.patchConnection, {
    profileId: c.profileId,
    expectedConnectedAt: c.connectedAt,
    patch: { accessToken: t.accessToken, refreshToken: t.refreshToken ?? c.refreshToken, expiresAt: t.expiresAt },
  });
  return t.accessToken;
}

/**
 * One Trakt session: a token that refreshes once on a surprise 401. Every request first checks the connection is
 * still the one the run started with, so a disconnect stops a run between requests.
 */
export function session(ctx: ActionCtx, conn: Doc<"traktConnections">) {
  let token: string | null = null;
  let refreshed = false;
  const check = async (write: boolean) => {
    const current: Doc<"traktConnections"> | null = await ctx.runQuery(internal.trakt.connection, { profileId: conn.profileId });
    if (!current || current.connectedAt !== conn.connectedAt || current.needsReconnect || (write && !current.writeBack))
      throw new TraktStoppedError("Trakt connection changed");
    if (current.backoffUntil && current.backoffUntil > Date.now()) throw new TraktRateError(current.backoffUntil - Date.now());
    return current;
  };
  const call = async <T>(path: string, options?: Parameters<typeof trakt>[2]): Promise<{ body: T; pages: number }> => {
    const write = (options?.method ?? "GET") !== "GET";
    await check(write);
    // A refresh made by an earlier run (the refresh token works once) is in the stored connection.
    token ??= await freshToken(ctx, await check(write));
    try {
      return await trakt<T>(path, token, options);
    } catch (error) {
      if (!(error instanceof TraktAuthError) || refreshed) throw error;
      refreshed = true;
      token = await freshToken(ctx, await check(write), true);
      return await trakt<T>(path, token, options);
    }
  };
  /** Every page of a list (Trakt pages some lists and not others). */
  const all = async <T>(path: string, params: Record<string, string> = {}): Promise<T[]> => {
    const out: T[] = [];
    for (let page = 1, pages = 1; page <= pages && page <= 50; page++) {
      const answer = await call<T[]>(path, { params: { ...params, page: String(page), limit: "250" } });
      // An answer in a shape we don't know must never read as "empty" and empty Plan to watch.
      if (!Array.isArray(answer.body)) throw new Error(`Trakt sent something unexpected for ${path}`);
      out.push(...answer.body);
      pages = answer.pages;
    }
    return out;
  };
  return { call, all };
}
