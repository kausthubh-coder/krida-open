import { type ActionCtx, type QueryCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  simkl,
  SimklAuthError,
  SimklRateError,
  tokenGrant,
} from "./simkl";

/**
 * Simkl, per profile, kept in step both ways.
 *
 * Simkl → Krida: one full import (watched, watching, dropped, ratings, plan to watch, and which
 * episodes), then only what /sync/activities says moved. It runs while someone is using Krida (on
 * open and on coming back to the tab, at most every ten minutes) or on Sync now, never on a timer.
 *
 * Krida → Simkl: finishing a movie or an episode, and adding or removing a title from Plan to watch, go
 * into an outbox. It's sent in batches (one request per kind of change, a second apart, as Simkl
 * asks), retried with backoff, and sent first in every sync so Simkl's answer already includes it.
 *
 * Simkl's daily allowance is per user and shared with their other apps, so Krida keeps itself to a
 * budget and stops when Simkl says to slow down.
 */

export const MINUTE = 60 * 1000;

export const DAY = 24 * 60 * MINUTE;

// Changes wait this long so a run of them goes as one request.
export const BATCH_WAIT = 45_000;

// Of the user's 500 requests a day (free plan), shared with their other Simkl apps.
export const DAILY_BUDGET = 250;

export const today = () => new Date().toISOString().slice(0, 10);

export const usedToday = (c: Doc<"connections">) => (c.usage?.day === today() ? c.usage.count : 0);

export class SimklStoppedError extends Error {}

export async function connectionFor(ctx: QueryCtx, profileId: Id<"profiles">) {
  return await ctx.db
    .query("connections")
    .withIndex("by_profile", (q) => q.eq("profileId", profileId).eq("provider", "simkl"))
    .first();
}

/** A token that works for the next few minutes, refreshing it first if it's close to expiring. */
export async function freshToken(ctx: ActionCtx, c: Doc<"connections">, force = false) {
  if (!force && (!c.expiresAt || c.expiresAt - Date.now() > DAY)) return c.accessToken;
  if (!c.refreshToken) throw new SimklAuthError("expired");
  const t = await tokenGrant({ grant_type: "refresh_token", refresh_token: c.refreshToken });
  await ctx.runMutation(internal.simkl.patchConnection, {
    profileId: c.profileId,
    expectedConnectedAt: c.connectedAt,
    patch: { accessToken: t.accessToken, refreshToken: t.refreshToken ?? c.refreshToken, expiresAt: t.expiresAt, scope: t.scope || c.scope },
  });
  return t.accessToken;
}

/** One Simkl session: a token that refreshes once on a surprise 401, and a count of requests made. */
export function session(ctx: ActionCtx, conn: Doc<"connections">) {
  let token: string | null = null;
  let refreshed = false;
  const state = { calls: 0 };
  const call = async <T>(path: string, options?: Parameters<typeof simkl>[2]): Promise<T> => {
    const check = async () => {
      const current: Doc<"connections"> | null = await ctx.runQuery(internal.simkl.connection, { profileId: conn.profileId });
      if (!current || current.connectedAt !== conn.connectedAt || current.needsReconnect ||
        (options?.method === "POST" && (!current.writeBack || !current.scope.includes("media:write"))))
        throw new SimklStoppedError("Simkl connection changed");
      if (current.backoffUntil && current.backoffUntil > Date.now())
        throw new SimklRateError(current.backoffUntil - Date.now());
      if (usedToday(current) + state.calls >= DAILY_BUDGET)
        throw new SimklRateError(Date.parse(`${today()}T00:00:00Z`) + DAY - Date.now());
    };
    await check();
    token ??= await freshToken(ctx, conn);
    // Refreshing a token is network I/O too: the connection can change while it is pending.
    await check();
    try {
      state.calls++;
      return await simkl<T>(path, token, options);
    } catch (error) {
      if (!(error instanceof SimklAuthError) || refreshed) throw error;
      refreshed = true;
      await check();
      token = await freshToken(ctx, conn, true);
      await check();
      state.calls++;
      return await simkl<T>(path, token, options);
    }
  };
  return { call, state };
}
