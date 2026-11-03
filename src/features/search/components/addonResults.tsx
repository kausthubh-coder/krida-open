// Search through the profile's addons: each catalog that answers a search is its own row under Krida's results.
import { useMemo } from "react";
import { catalogPage, useAddons } from "../../../data/addons";
import { useShared } from "../../../data/api";
import { isSearchable } from "../../../../shared/stremio";
import { TitleRail } from "./Results";

const SEARCH_MAX_AGE = 10 * 60_000;
const KINDS: Record<string, string> = { movie: "Movies", series: "Shows", anime: "Anime" };

type Searchable = { key: string; base: string; addon: string; title: string; catalog: { type: string; id: string } };

/** Rows of what the profile's searchable addon catalogs found for `query`; only the movie or show ones when filtered. */
export function AddonSearchRails({ query, filter }: { query: string; filter: "all" | "movie" | "series" }) {
  const addons = useAddons();
  const catalogs = useMemo(() => {
    const out: Searchable[] = [];
    for (const a of addons ?? []) {
      if (!a.enabled) continue;
      for (const c of a.manifest.catalogs) {
        const kind = c.type === "movie" ? "movie" : "series";
        if (!isSearchable(c) || (filter !== "all" && kind !== filter)) continue;
        out.push({ key: `${a._id}:${c.type}:${c.id}`, base: a.url, addon: a.manifest.name, title: `${c.name} · ${KINDS[c.type] ?? c.type}`, catalog: c });
      }
    }
    return out;
  }, [addons, filter]);
  return catalogs.map((c) => <AddonSearchRail key={c.key} found={c} query={query} />);
}

function AddonSearchRail({ found, query }: { found: Searchable; query: string }) {
  const items = useShared(
    `addon-search:${found.base}:${found.catalog.type}:${found.catalog.id}:${query.toLowerCase()}`,
    () => catalogPage(found.base, found.catalog, { search: query }),
    SEARCH_MAX_AGE,
  );
  // Nothing while it loads or when the addon found nothing or failed: Krida's own results stand on their own.
  if (!items?.length) return null;
  return <TitleRail title={found.title} subtitle={`From ${found.addon}`} items={items.slice(0, 24)} />;
}
