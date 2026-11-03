import { useMemo } from "react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../convex/_generated/api";
import type { Doc } from "../../../convex/_generated/dataModel";
import type { PersonalRow } from "../../../convex/recs";
import { useCatalogRows, type RecItem, type ShownRow } from "../../data/api";
import { useAddons, type InstalledAddon } from "../../data/addons";
import { catalogRowKey, isRow, type AddonCatalog } from "../../../shared/stremio";
import { useStored, useStoredQuery } from "../../data/stored";
import { useTables, type Tables } from "../../data/sync";

type Personal = FunctionReturnType<typeof api.recs.rows>;

export type HomeRow = Omit<PersonalRow, "style"> & {
  style: "poster" | "top10";
  /** When a catalog row was last fetched, for "Updated 3 h ago". */
  updatedAt?: number;
  items: RecItem[];
};
/** One catalog of one of the profile's addons, as a Home row. Its titles load in the browser (`useCatalogRow`). */
export type AddonRow = { key: string; title: string; type: string; base: string; addon: string; addonId: string; catalog: AddonCatalog };
export type HomeData = Omit<Personal, "rows" | "taste"> & {
  rows: HomeRow[];
  /** The profile's addon catalogs, in its addon order. */
  addonRows: AddonRow[];
  friends: FunctionReturnType<typeof api.catalogs.friends>;
  /** No catalog rows at all: no addon catalogs, and Krida's own couldn't be reached. */
  empty: boolean;
};

/** Every catalog of the profile's enabled addons that can be a row (one that needs a search or a filter can't). */
export function addonRowsOf(addons: InstalledAddon[]): AddonRow[] {
  const rows: AddonRow[] = [];
  for (const a of addons) {
    if (!a.enabled) continue;
    for (const c of a.manifest.catalogs) {
      const key = catalogRowKey(a.manifest.id, c);
      if (!isRow(c) || rows.some((r) => r.key === key)) continue;
      rows.push({ key, title: c.name, type: c.type, base: a.url, addon: a.manifest.name, addonId: a.manifest.id, catalog: c });
    }
  }
  return rows;
}

const NO_ROWS: ShownRow[] = [];
// Genre rows before Krida has learned what someone watches.
const DEFAULT_GENRES = ["Drama", "Comedy", "Action"];

/** From Simkl: shows you're partway through elsewhere, and your plan-to-watch list. */
function simklRows(t: Pick<Tables, "tracked" | "progress" | "viewing">): HomeRow[] {
  const item = (row: Doc<"tracked">, reason?: string): RecItem => ({
    id: row.id, type: row.type, name: row.name,
    // IMDb titles use the same artwork as every other row; anime brings Simkl's.
    poster: row.id.startsWith("tt") ? undefined : row.poster, year: row.year, genres: [], reason,
  });
  const started = new Set([...t.progress].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 200).map((p) => p.media.imdbId));
  // A status set here (watched, on hold, dropped…) moves the show out now, not after the Simkl round trip.
  const movedOn = new Set(t.viewing.filter((v) => v.state !== "watching" && v.state !== "rewatching").map((v) => v.id));
  const rows: HomeRow[] = [];
  const watching = t.tracked
    // Played or moved on under the anime's IMDb id counts too (lib/titleIds).
    .filter((r) => r.status === "watching" && r.type === "series" && ![r.id, r.imdb].some((id) => id && (started.has(id) || movedOn.has(id))))
    .sort((a, b) => (b.lastWatchedAt ?? 0) - (a.lastWatchedAt ?? 0))
    .slice(0, 24);
  if (watching.length >= 2)
    rows.push({
      key: "simkl:watching", title: "Still watching", subtitle: "Partway through on Simkl", style: "poster",
      items: watching.map((r) => item(r, r.watchedEpisodes && r.totalEpisodes ? `${r.watchedEpisodes} of ${r.totalEpisodes} episodes` : r.year)),
    });
  const planned = t.tracked
    .filter((r) => r.status === "plantowatch" && !started.has(r.id))
    .sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0))
    .slice(0, 24);
  if (planned.length >= 2) rows.push({ key: "simkl:planned", title: "On your Simkl watchlist", style: "poster", items: planned.map((r) => item(r)) });
  return rows;
}

/**
 * Home's rows from Krida: this profile's picks, its Simkl rows, Netflix's Top 10 and TMDB's trending titles, and the
 * genres it watches most (movies and shows alternating). The profile's addon catalogs join them in `orderRows`.
 */
export function homeRows(personal: Personal, simkl: HomeRow[], catalog: ShownRow[]) {
  const lookup = (key: string) => catalog.find((r) => r.key === key);
  const shown = catalog.filter((r) => r.source === "netflix" || r.source === "tmdb");
  const rows: HomeRow[] = [...personal.rows, ...simkl,
    ...shown.map(({ key, title, style, updatedAt, items }) => ({ key, title, style, updatedAt, items }))];
  for (const [i, genre] of (personal.taste ?? DEFAULT_GENRES).slice(0, 3).entries()) {
    const c = lookup(`cinemeta:genre:${i % 2 === 0 ? "series" : "movie"}:${genre}`) ?? lookup(`cinemeta:genre:movie:${genre}`);
    // Only a claim about taste when it was learned, not the default genres.
    if (c) rows.push({ key: `genre:${i}`, title: c.title, subtitle: personal.taste ? "One of the genres you watch most" : undefined, style: "poster", items: c.items });
  }
  return { rows, empty: shown.length === 0 };
}

/**
 * Home's rows. Krida's own catalogs come from /api/rows (the same for everyone, cached by Vercel), the profile's addon
 * catalogs from its addons (each row loads its own titles), its picks and its friends' plays from two small queries,
 * and its Simkl rows from its synced tables. Opening Krida shows the rows it last saw while these load.
 */
export function useHome(token: string): HomeData | undefined {
  const personal = useStoredQuery(api.recs.rows, { token });
  const friends = useStoredQuery(api.catalogs.friends, { token });
  const t = useTables();
  const [tracked, progress, viewing] = [t?.tracked, t?.progress, t?.viewing];
  const simkl = useMemo(() => (tracked && progress && viewing ? simklRows({ tracked, progress, viewing }) : undefined), [tracked, progress, viewing]);
  const fetched = useCatalogRows();
  // Kept across deploys: a deploy empties Vercel's cache too, and rebuilding the catalogs takes 5 to 15 s.
  const catalog = useStored("api.rows", {}, fetched ?? undefined, { acrossBuilds: true });
  const rows = catalog?.rows ?? (fetched === null ? NO_ROWS : undefined);
  const addons = useAddons();
  return useMemo(() => {
    if (!personal || !simkl || !friends || !rows || !addons) return undefined;
    const { taste: _taste, rows: _rows, ...rest } = personal;
    const built = homeRows(personal, simkl, rows);
    const addonRows = addonRowsOf(addons);
    return { ...rest, ...built, addonRows, empty: built.empty && addonRows.length === 0, friends };
  }, [personal, simkl, friends, rows, addons]);
}
