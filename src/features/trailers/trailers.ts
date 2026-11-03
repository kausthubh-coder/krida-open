import type { Meta } from "../../data/cinemeta";
import { isYoutubeId, youtubeId } from "../../../shared/youtube";

export { youtubeId };

/**
 * YouTube ids of a title's trailers, best first: Cinemeta's and Kitsu's own (newest first, real
 * trailers before teasers), then MDBList's. Only well-formed ids, so nothing else reaches the embed.
 */
export function trailerIds(meta: Pick<Meta, "trailers" | "trailerStreams">, mdblist?: string | null) {
  const listed = meta.trailers ?? [];
  const ids = [
    ...listed.filter((t) => t.type === "Trailer").map((t) => t.source),
    ...(meta.trailerStreams ?? []).map((t) => t.ytId),
    ...listed.map((t) => t.source),
    mdblist ? youtubeId(mdblist) : null,
  ];
  return [...new Set(ids.filter(isYoutubeId))];
}
