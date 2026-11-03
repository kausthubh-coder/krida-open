// A title's ratings, certification and trailer from /api/title, cached for the visit.
import { useEffect, useState } from "react";
import { titleInfo, type TitleInfo } from "../../data/api";
import type { Meta } from "../../data/cinemeta";

const infoCache = new Map<string, TitleInfo>();

/**
 * MDBList's ratings, certification and trailer for a title, fetched once per visit. Anime with a Kitsu id
 * asks with the IMDb id the Kitsu addon maps it to. Undefined while loading, null when there's nothing.
 */
export function useTitleInfo(type: Meta["type"], imdbId: string | undefined) {
  const [info, setInfo] = useState<TitleInfo | undefined>(() => (imdbId ? infoCache.get(imdbId) : null));
  useEffect(() => {
    if (!imdbId || infoCache.has(imdbId)) return;
    let alive = true;
    titleInfo(imdbId, type).then(
      (r) => {
        infoCache.set(imdbId, r);
        if (alive) setInfo(r);
      },
      () => alive && setInfo(null),
    );
    return () => {
      alive = false;
    };
  }, [imdbId, type]);
  return info;
}
