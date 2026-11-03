import { useConvex } from "convex/react";
import { toast } from "../../ui/toast";
import { api } from "../../../convex/_generated/api";
import { useAuthed } from "../../data/session";
import { getMeta, type MediaType } from "../../data/cinemeta";
import { mediaFor, playTarget, usePlay } from "./play";

/** What Play means for a title on a card or in the hero: where you left off, or the movie, or a show from its first episode. */
export function useTitleTarget() {
  const convex = useConvex();
  const { token } = useAuthed();
  return async (type: MediaType, id: string) => {
    const [meta, progress, simkl] = await Promise.all([
      getMeta(type, id),
      convex.query(api.progress.forTitle, { token, imdbId: id }),
      convex.query(api.simkl.forTitle, { token, id }),
    ]);
    const { video, row } = playTarget(meta, progress, simkl?.next);
    return { media: mediaFor(meta, video), startAt: row && !row.finished ? row.position : 0 };
  };
}

export function usePlayTitle() {
  const play = usePlay();
  const target = useTitleTarget();
  return async (type: MediaType, id: string) => {
    try {
      const { media, startAt } = await target(type, id);
      await play(media, { startAt });
    } catch {
      toast.error("Couldn't load that title. Try again.");
    }
  };
}
