import { type ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  parseLibrary,
  SimklAuthError,
  SimklRateError,
  SimklTooBigError,
  type SimklEntry,
} from "./simkl";
import { mapLimit } from "../../shared/tmdb";
import { SimklStoppedError, session } from "./simklApi";
import { KITSU } from "../../shared/addons";

/** Krida opens anime by Kitsu id; Simkl may only know its MyAnimeList id. */
async function resolveId(e: SimklEntry): Promise<string | undefined> {
  if (e.anime && e.kitsu) return `kitsu:${e.kitsu}`;
  if (e.anime && e.mal) {
    try {
      const res = await fetch(`${KITSU}/meta/${e.type}/mal:${e.mal}.json`);
      const id = res.ok ? (await res.json())?.meta?.id : undefined;
      if (typeof id === "string" && id.startsWith("kitsu:")) return id;
    } catch {
      // Fall back to IMDb below.
    }
  }
  return e.imdb;
}

export async function store(ctx: ActionCtx, profileId: Id<"profiles">, entries: SimklEntry[],
  expectedConnectedAt: number, ratingsOnly = false) {
  if (entries.length === 0) return 0;
  const known: { externalId: number; id: string }[] = await ctx.runQuery(internal.simkl.knownIds, { profileId });
  const idFor = new Map(known.map((k) => [k.externalId, k.id]));
  const resolved = await mapLimit(entries, 6, async (e) => {
    const id = idFor.get(e.simklId) ?? (await resolveId(e));
    if (!id) return null;
    const { simklId, anime: _anime, imdb, kitsu: _kitsu, mal: _mal, ...rest } = e;
    return { externalId: simklId, id, imdb: imdb && imdb !== id ? imdb : undefined, ...rest };
  });
  const rows = resolved.filter((r): r is NonNullable<typeof r> => r !== null);
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    await ctx.runMutation(internal.simkl.applyEntries, { profileId, entries: chunk, ratingsOnly, expectedConnectedAt });
    if (ratingsOnly) continue;
    // The Simkl watchlist is part of Plan to watch.
    await ctx.runMutation(internal.library.fromSimkl, {
      profileId,
      expectedConnectedAt,
      planned: chunk
        .filter((r) => r.status === "plantowatch")
        .map((r) => ({ id: r.id, type: r.type, name: r.name, poster: r.id.startsWith("tt") ? undefined : r.poster, year: r.year, addedAt: r.addedAt })),
      notPlanned: chunk.filter((r) => r.status !== "plantowatch").map((r) => r.id),
    });
  }
  const aliased = rows.filter((r) => r.imdb).map((r) => r.id);
  for (let i = 0; i < aliased.length; i += 100)
    await ctx.runMutation(internal.simkl.mergeAfterPull, { profileId, ids: aliased.slice(i, i + 100), expectedConnectedAt });
  return rows.length;
}

export const simklIds = (body: any) => {
  const out: number[] = [];
  for (const kind of ["movies", "shows", "anime"])
    for (const row of Array.isArray(body?.[kind]) ? body[kind] : []) {
      const id = (row?.movie ?? row?.show ?? row?.anime ?? row)?.ids?.simkl;
      if (typeof id === "number") out.push(id);
    }
  return out;
};

const STATUSES_BY_TYPE: Record<string, string[]> = {
  shows: ["watching", "plantowatch", "hold", "completed", "dropped"],
  anime: ["watching", "plantowatch", "hold", "completed", "dropped"],
  movies: ["plantowatch", "completed", "dropped"],
};

/** The whole library of one type, episodes included, split by status if Simkl finds it too big. */
export async function pullType(call: ReturnType<typeof session>["call"], type: string) {
  // Runtimes and per-episode times are for Library stats.
  const params = { language: "en", extended: "full", ...(type === "movies" ? {} : { include_all_episodes: "yes", episode_watched_at: "yes" }) };
  try {
    return parseLibrary(await call<any>(`/sync/all-items/${type}`, { params }));
  } catch (error) {
    if (!(error instanceof SimklTooBigError)) throw error;
    const out: SimklEntry[] = [];
    for (const status of STATUSES_BY_TYPE[type])
      out.push(...parseLibrary(await call<any>(`/sync/all-items/${type}/${status}`, { params })));
    return out;
  }
}

/** Record why a run stopped, and when it may try again. */
export async function failed(ctx: ActionCtx, profileId: Id<"profiles">, error: unknown, calls: number, expectedConnectedAt: number) {
  if (error instanceof SimklStoppedError) {
    await ctx.runMutation(internal.simkl.patchConnection, { profileId, expectedConnectedAt, patch: { done: true }, calls });
    return;
  }
  console.warn("simkl", error instanceof Error ? error.message : error);
  const auth = error instanceof SimklAuthError;
  const rate = error instanceof SimklRateError;
  await ctx.runMutation(internal.simkl.patchConnection, {
    profileId,
    expectedConnectedAt,
    patch: {
      lastError: auth
        ? "Simkl signed Krida out. Connect again to keep your history in sync."
        : rate
          ? "Simkl asked Krida to slow down. It catches up in a few minutes."
          : "Couldn’t reach Simkl. Krida tries again next time you open it.",
      needsReconnect: auth ? true : undefined,
      backoffUntil: rate ? Date.now() + error.retryAfter : undefined,
      done: true,
    },
    calls,
  });
}
