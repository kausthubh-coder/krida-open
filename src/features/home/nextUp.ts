// Continue watching's shows that are between episodes: which episode comes next, and whether it's out yet.
import { useEffect, useMemo, useState } from "react";
import { followingEpisode, getMeta, type Video } from "../../data/cinemeta";
import type { ProgressRow } from "./Home";

export type NextEpisode = { video: Video; upcoming: boolean };

/**
 * The next episode of each finished show in `rows`, by row id, once its details are in (null when the show has no
 * more). Played or unfinished rows aren't asked about.
 */
export function useNextEpisodes(rows: ProgressRow[] | undefined) {
  const asked = useMemo(() => (rows ?? []).filter((r) => r.finished && r.media.type === "series"), [rows]);
  const key = asked.map((r) => `${r._id}:${r.media.videoId}`).join("|");
  const [found, setFound] = useState<Map<string, NextEpisode | null>>(new Map());
  useEffect(() => {
    let alive = true;
    void Promise.all(
      asked.map(async (r) => {
        const meta = await getMeta("series", r.media.imdbId).catch(() => undefined);
        return [r._id as string, meta ? followingEpisode(meta, r.media.videoId) ?? null : null] as const;
      }),
    ).then((pairs) => alive && setFound(new Map(pairs)));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return found;
}

/**
 * Continue watching split by Settings → Home's "Upcoming episodes": kept in the row (unset), given a row of their
 * own, or left out. A show is upcoming once its next episode is known not to be out yet.
 */
export function splitUpcoming(rows: ProgressRow[], next: Map<string, NextEpisode | null>, upcoming: "row" | "hide" | undefined) {
  if (!upcoming) return { current: rows, upcoming: [] };
  const later = (r: ProgressRow) => next.get(r._id)?.upcoming === true;
  return { current: rows.filter((r) => !later(r)), upcoming: upcoming === "row" ? rows.filter(later) : [] };
}
