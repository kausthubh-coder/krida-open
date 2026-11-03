import type { PreviewItem } from "./expandingPoster";
import { useAmbientTrailers } from "./ambient";
import { getMeta } from "../../data/cinemeta";
import { warmYouTube } from "./trailerPlayer";
import { askImdb } from "./trailerSources";

// Titles in a row got ready as the pointer enters it: about what a screen shows.
const WARM_ROW = 10;

/**
 * Gets a row's previews ready as a mouse enters it, before any poster is rested on: which titles IMDb has a
 * trailer file for (anime once its details give its IMDb id), the details of titles that will need YouTube
 * instead, and a YouTube player when any will. Undefined where posters don't preview.
 */
export function useWarmRow(items: PreviewItem[]) {
  const enabled = useAmbientTrailers("(hover: hover) and (pointer: fine)");
  if (!enabled) return undefined;
  return (e: React.PointerEvent) => {
    if (e.pointerType !== "mouse") return;
    const hasFile = (id: string) => askImdb(id).then((files) => files.length > 0);
    // Asked together in one request; anime joins once its details say its IMDb id.
    const found = items.slice(0, WARM_ROW).map((item) => {
      const details = () => getMeta(item.type, item.id);
      if (!item.id.startsWith("tt")) return details().then((m) => (m.imdb_id ? hasFile(m.imdb_id) : false), () => false);
      return hasFile(item.id).then((has) => {
        // Its YouTube ids are in its details, unless its row carries one.
        if (!has && !item.trailer) details().catch(() => {});
        return has;
      });
    });
    void Promise.all(found).then((has) => has.includes(false) && warmYouTube("poster"));
  };
}
