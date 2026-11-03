import { useEffect, useState } from "react";
import { artwork } from "../data/api";

type Found = { poster: string | null; background: string | null };
/** What TMDB is searched for when it has no link from the IMDb id (many regional titles). */
export type ArtLookup = { name?: string; year?: string; type?: "movie" | "series" };
const found = new Map<string, Promise<Found>>();

/** Which title and kind of artwork a Metahub URL is for (the service that has no art for many regional films). */
export function metahubRef(src: string | undefined) {
  const m = src && /images\.metahub\.space\/(poster|background)\/[a-z]+\/(tt\d+)\//.exec(src);
  return m ? { kind: m[1] as "poster" | "background", id: m[2] } : null;
}

/**
 * TMDB's poster or backdrop for a title once its Metahub image has failed (or there was none to try),
 * asked once per title and name per visit. Undefined while asking or when there's nothing to ask about.
 */
export function useArtFallback(ref: { kind: "poster" | "background"; id: string } | null, needed: boolean, lookup?: ArtLookup) {
  const [url, setUrl] = useState<string | null>();
  const key = ref && needed ? ref.id : null;
  const kind = ref?.kind;
  const { name, year, type } = lookup ?? {};
  useEffect(() => {
    if (!key) return;
    let alive = true;
    // Keyed by name too: an answer without one (no TMDB link) mustn't stand in for a search by name.
    const cacheKey = `${key} ${name ?? ""}`;
    let hit = found.get(cacheKey);
    if (!hit) {
      hit = artwork(key, { name, year, type }).catch(() => ({ poster: null, background: null }));
      found.set(cacheKey, hit);
    }
    void hit.then((r) => alive && setUrl(kind === "poster" ? r.poster : (r.background ?? r.poster)));
    return () => {
      alive = false;
    };
  }, [key, kind, name, year, type]);
  return key ? url : undefined;
}
