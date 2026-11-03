import { useEffect, useMemo, useState } from "react";
import { animeBackdrop } from "../../data/api";
import type { Meta } from "../../data/cinemeta";
import { animeSources, anilistIdFor, fillAnime, tmdbIdOf, type AnimeSources } from "./animeEpisodes";

type Fill = { sources: AnimeSources; backdrop: string | null } | null;
const asked = new Map<string, Promise<Fill>>();

/**
 * New anime that only Kitsu knows (no IMDb id yet, so no backdrop either) gets its episodes and backdrop from
 * AniList, ani.zip and TMDB (`animeEpisodes.ts`), asked once per title per visit. `pending` is true while
 * asking, so the page doesn't flash a stand-in first.
 */
export function useAnimeFill(meta: Meta | undefined): { meta: Meta | undefined; pending: boolean } {
  const [fill, setFill] = useState<{ id: string; value: Fill }>();
  const key = meta?.id.startsWith("kitsu:") && !meta.background ? meta.id : null;
  const type = meta?.type;
  useEffect(() => {
    if (!key || !type) return;
    let alive = true;
    let hit = asked.get(key);
    if (!hit) {
      hit = (async () => {
        const anilistId = await anilistIdFor(key.slice("kitsu:".length));
        if (!anilistId) return null;
        const sources = await animeSources(anilistId);
        if (!sources.anilist && !sources.anizip) return null;
        const tmdbId = tmdbIdOf(sources);
        const backdrop = tmdbId ? await animeBackdrop(tmdbId, type).catch(() => null) : null;
        return { sources, backdrop };
      })().catch(() => null);
      asked.set(key, hit);
    }
    void hit.then((value) => alive && setFill({ id: key, value }));
    return () => {
      alive = false;
    };
  }, [key, type]);
  return useMemo(() => {
    if (!meta || !key) return { meta, pending: false };
    if (fill?.id !== key) return { meta, pending: true };
    return { meta: fill.value ? fillAnime(meta, fill.value.sources, fill.value.backdrop) : meta, pending: false };
  }, [meta, key, fill]);
}
