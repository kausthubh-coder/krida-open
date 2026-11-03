/**
 * Home row order. Like Netflix: what you're in the middle of, then rows about you, broken up by catalogs for
 * everyone, so the page alternates between "for you" and "for everyone". A profile's addon catalogs take the
 * "for everyone" places in its addon order. What the profile set in Settings → Home wins: pinned rows first, then its
 * own order; rows it never placed fall back to this.
 */
const RANKS: [string, number][] = [
  ["continue", 10],
  // Settings → Home can give a show's next episode that isn't out yet a row of its own, under Continue watching.
  ["upcoming", 15],
  ["picks", 20],
  ["simkl:watching", 25],
  ["netflix:top10:series", 30],
  ["together", 40],
  ["tmdb:trending:series", 65],
  ["friend:", 80],
  ["netflix:top10:movie", 90],
  ["genre:0", 100],
  ["tmdb:trending:movie", 105],
  ["mylist", 120],
  ["simkl:planned", 125],
  ["genre:1", 130],
  ["genre:2", 160],
];

/** Rows that begin with these keys are a family ("friend:<id>"); the rest are matched whole. */
const rankOf = (key: string) => RANKS.find(([k]) => (k.endsWith(":") ? key.startsWith(k) : key === k))?.[1];

/** The places addon catalogs fill, between Krida's own rows; past the last, every 30. */
const ADDON_SLOTS = [35, 55, 70, 85, 95, 110, 115, 140, 150, 170, 180, 190, 200];

export function defaultRank(key: string, addonIndex = new Map<string, number>(), becauseIndex = new Map<string, number>()) {
  const addon = addonIndex.get(key);
  if (addon !== undefined) return ADDON_SLOTS[addon] ?? 200 + (addon - ADDON_SLOTS.length + 1) * 30;
  // "Because you watched" rows come in order, so the second one sorts after a catalog row.
  const because = becauseIndex.get(key);
  if (because !== undefined) return 50 + because * 45;
  return rankOf(key) ?? 250;
}

/** What Settings → Home keeps about the order: rows pinned to the top, the profile's own order, hidden rows. */
export type RowPrefs = { order: string[]; hidden: string[]; pinned?: string[] };

/** Rows in the profile's order, hidden ones left out. Addon rows are keyed `addon:…` and keep their addon order. */
export function orderRows<T extends { key: string }>(rows: T[], { order, hidden, pinned = [] }: RowPrefs) {
  const because = new Map(rows.filter((r) => r.key.startsWith("because:")).map((r, i) => [r.key, i]));
  const addons = new Map(rows.filter((r) => r.key.startsWith("addon:")).map((r, i) => [r.key, i]));
  const pin = new Map(pinned.map((k, i) => [k, i]));
  const position = new Map(order.map((k, i) => [k, i]));
  const hiddenSet = new Set(hidden);
  // Pinned rows first; rows the profile placed next, in its order; rows that appeared since go after, by default rank.
  const value = (key: string) => pin.get(key) ?? 100 + (position.get(key) ?? 1000 + defaultRank(key, addons, because));
  return rows.filter((r) => !hiddenSet.has(r.key)).sort((a, b) => value(a.key) - value(b.key));
}

/** Every row a profile could see, in its current order, for the Settings list (hidden ones included). */
export function allRowsInOrder<T extends { key: string }>(rows: T[], prefs: Omit<RowPrefs, "hidden">) {
  return orderRows(rows, { ...prefs, hidden: [] });
}

/** A row's name: the profile's own for it, else its own, with its kind after an addon catalog's unless turned off. */
export function rowTitle(row: { key: string; title: string; type?: string }, names: { key: string; name: string }[] = [], typeHidden: string[] = []) {
  const name = names.find((n) => n.key === row.key)?.name || row.title;
  if (!row.type || typeHidden.includes(row.key)) return name;
  return `${name} · ${KINDS[row.type] ?? row.type[0].toUpperCase() + row.type.slice(1)}`;
}
const KINDS: Record<string, string> = { movie: "Movies", series: "Shows", anime: "Anime" };

const HOUR = 60 * 60 * 1000;

/** How fresh a catalog row is, in words: "Updated 3 h ago". */
export function updatedLabel(at: number, now: number) {
  const hours = Math.floor((now - at) / HOUR);
  if (hours < 1) return "Updated in the last hour";
  if (hours < 24) return `Updated ${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "Updated yesterday" : `Updated ${days} days ago`;
}

/** Where an addon catalog's "See all" goes: every title in it, with its genres when it has them. */
export const seeAllPath = (row: { addonId: string; type: string; catalog: { id: string } }) =>
  `/browse/${encodeURIComponent(row.addonId)}/${encodeURIComponent(row.type)}/${encodeURIComponent(row.catalog.id)}`;
