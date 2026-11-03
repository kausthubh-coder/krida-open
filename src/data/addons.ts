import { useQuery } from "convex-helpers/react/cache/hooks";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";
import { resourceUrl, type AddonCatalog } from "../../shared/stremio";
import { peekShared, proxied, useShared, type RecItem } from "./api";
import { useAuthed } from "./session";

/*
 * A profile's Stremio addons in the browser: the list (Convex), and what the browser reads from them itself: catalogs
 * for Home, See all and Search, and subtitles. Streams are never fetched here; Convex asks the stream addons.
 */

export type InstalledAddon = FunctionReturnType<typeof api.addons.list>[number];

/** The session's profile's addons, in its order; undefined while they load. */
export function useAddons(): InstalledAddon[] | undefined {
  const { token } = useAuthed();
  return useQuery(api.addons.list, { token });
}

// Addons that didn't answer the browser (no CORS headers, usually) are asked through /api/rows from then on.
const viaProxy = new Set<string>();
const TIMEOUT_MS = 12_000;

/**
 * An addon's answer at `url`: straight from the addon (Stremio addons send CORS headers), or through Krida's proxy when
 * the browser can't read it. Throws when neither answers.
 */
export async function addonJson<T>(url: string): Promise<T> {
  const host = new URL(url).host;
  if (!viaProxy.has(host)) {
    let res: Response | undefined;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (error) {
      // A timeout is the addon being slow, not CORS: the proxy would wait just as long.
      if (error instanceof DOMException && error.name === "TimeoutError") throw new Error(`${host} took too long to answer`);
      viaProxy.add(host);
    }
    if (res) {
      if (!res.ok) throw new Error(`${host} answered ${res.status}`);
      return (await res.json()) as T;
    }
  }
  return await proxied<T>(url);
}

/** Title ids Krida can open: IMDb's, and Kitsu's for anime. Other ids (an addon's own) have no title page yet. */
const OPENABLE = /^(tt\d+|kitsu:\d+)$/;

/** A Stremio meta preview as a Home card. Anime catalogs ("anime" type) hold shows. Null for what Krida can't open. */
export function toRowItem(meta: any, catalogType: string): RecItem | null {
  if (!meta || typeof meta.id !== "string" || typeof meta.name !== "string" || !OPENABLE.test(meta.id)) return null;
  const kind = meta.type ?? catalogType;
  const type = kind === "movie" ? "movie" : kind === "series" || kind === "anime" || kind === "tv" ? "series" : null;
  if (!type) return null;
  const year = /\d{4}/.exec(String(meta.releaseInfo ?? meta.year ?? ""))?.[0];
  const rating = Number.parseFloat(meta.imdbRating);
  const genres = (Array.isArray(meta.genres) ? meta.genres : Array.isArray(meta.genre) ? meta.genre : []).filter((g: unknown) => typeof g === "string");
  const image = (x: unknown) => (typeof x === "string" && /^https?:\/\//.test(x) ? x : undefined);
  return {
    id: meta.id,
    type,
    name: meta.name.slice(0, 200),
    poster: image(meta.poster),
    background: image(meta.background),
    logo: image(meta.logo),
    year,
    description: typeof meta.description === "string" ? meta.description.slice(0, 280) : undefined,
    rating: Number.isFinite(rating) && rating > 0 ? rating : undefined,
    genres: genres.slice(0, 3),
  };
}

/** Whether a title is out yet, by its year (a catalog gives no dates): next year's titles aren't. */
export const released = (item: Pick<RecItem, "year">, now = new Date()) => !item.year || Number(item.year) <= now.getFullYear();

/** One page of a catalog's titles, with its extras (genre, search, skip). */
export async function catalogPage(base: string, catalog: Pick<AddonCatalog, "type" | "id">, extra: Record<string, string | number | undefined> = {}) {
  const body = await addonJson<{ metas?: unknown[] }>(resourceUrl(base, "catalog", catalog.type, catalog.id, extra));
  const seen = new Set<string>();
  return (body.metas ?? []).flatMap((m) => {
    const item = toRowItem(m, catalog.type);
    if (!item || seen.has(item.id)) return [];
    seen.add(item.id);
    return [item];
  });
}

const ROW_MAX_AGE = 30 * 60_000;
const rowKey = (base: string, c: Pick<AddonCatalog, "type" | "id">) => `addon-row:${base}:${c.type}:${c.id}`;

/**
 * A catalog's first page as a Home row, shared by every screen and fetched again after 30 minutes. Undefined while it
 * loads, null when the addon didn't answer.
 */
export function useCatalogRow(base: string, catalog: Pick<AddonCatalog, "type" | "id">) {
  return useShared(rowKey(base, catalog), () => catalogPage(base, catalog), ROW_MAX_AGE);
}

const NO_ROW = async () => [] as RecItem[];
/** `useCatalogRow` for a catalog that may not be there (undefined: nothing is asked). */
export function useMaybeCatalogRow(base?: string, catalog?: Pick<AddonCatalog, "type" | "id">) {
  const value = useShared(base && catalog ? rowKey(base, catalog) : "addon-row:none", base && catalog ? () => catalogPage(base, catalog) : NO_ROW, ROW_MAX_AGE);
  return base && catalog ? value : undefined;
}

/** A catalog's first page, if Home has loaded it this visit (for the recommender's candidates). */
export const loadedCatalogRow = (base: string, catalog: Pick<AddonCatalog, "type" | "id">) => peekShared<RecItem[]>(rowKey(base, catalog));
