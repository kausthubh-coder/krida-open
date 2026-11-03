import { useEffect, useSyncExternalStore } from "react";
import { useAuthed } from "../../data/session";

/**
 * What the muted trailers on Home share: whether sound is on (for the visit, so turning it on once
 * carries to the next preview), and whether a poster preview is open (the banner pauses for it, so
 * only one trailer plays at a time).
 */
let soundOn = false;
let previews = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useTrailerSound() {
  const on = useSyncExternalStore(subscribe, () => soundOn);
  return [
    on,
    (next: boolean) => {
      soundOn = next;
      emit();
    },
  ] as const;
}

export const usePreviewOpen = () => useSyncExternalStore(subscribe, () => previews > 0);

/** Marks a poster preview as open while `open` is true. */
export function useMarkPreview(open: boolean) {
  useEffect(() => {
    if (!open) return;
    previews++;
    emit();
    return () => {
      previews--;
      emit();
    };
  }, [open]);
}

/**
 * Whether Home may play muted trailers here: the profile hasn't turned them off, motion isn't
 * reduced, the browser isn't saving data, and the media query fits (a wide screen for the banner, a
 * mouse for posters).
 */
export function useAmbientTrailers(query: string) {
  const { me } = useAuthed();
  const fits = useMedia(`${query} and (prefers-reduced-motion: no-preference)`);
  const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData;
  return me.prefs.trailers !== false && fits && !saveData;
}

// Every poster asks the same question; one store per query answers them all.
type MediaStore = { subscribe: (onChange: () => void) => () => void; matches: () => boolean };
const media = new Map<string, MediaStore>();

function mediaStore(query: string): MediaStore {
  let store = media.get(query);
  if (!store) {
    const list = matchMedia(query);
    store = {
      subscribe: (onChange) => {
        list.addEventListener("change", onChange);
        return () => list.removeEventListener("change", onChange);
      },
      matches: () => list.matches,
    };
    media.set(query, store);
  }
  return store;
}

function useMedia(query: string) {
  const { subscribe, matches } = mediaStore(query);
  return useSyncExternalStore(subscribe, matches);
}
