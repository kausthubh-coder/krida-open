import { useCallback, useRef } from "react";
import { useConvex, type ConvexReactClient } from "convex/react";
import { api } from "../../convex/_generated/api";
import { prefetchCatalogRows } from "./api";
import { useAuthed } from "./session";
import { getMeta, type MediaType } from "./cinemeta";

// Long enough to cover the click and the page's first render, short enough not to linger.
const KEEP_MS = 30_000;
const INTENT_MS = 80;

/**
 * Starts loading a title page while the pointer rests on (or focus lands on) a link to it, so the
 * page opens with its details already here. Brushing past a card doesn't count.
 */
export function usePrefetchTitle(to: string) {
  const convex = useConvex();
  const { token } = useAuthed();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const start = useCallback(() => {
    const m = /^\/title\/(movie|series)\/([^/?#]+)/.exec(to);
    if (!m) return;
    const [, type, raw] = m;
    const id = decodeURIComponent(raw);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void getMeta(type as MediaType, id).catch(() => {});
      for (const query of [api.progress.forTitle] as const) convex.prewarmQuery({ query, args: { token, imdbId: id }, extendSubscriptionFor: KEEP_MS });
      for (const query of [api.simkl.forTitle, api.ratings.details] as const)
        convex.prewarmQuery({ query, args: { token, id }, extendSubscriptionFor: KEEP_MS });
    }, INTENT_MS);
  }, [convex, token, to]);
  const cancel = useCallback(() => clearTimeout(timer.current), []);
  return { onPointerEnter: start, onFocus: start, onPointerLeave: cancel };
}

/**
 * Starts loading a place in the nav while the pointer rests on (or focus lands on) it. After the first visit
 * the place is kept (Pages in main.tsx), so this matters for the first one.
 */
export function usePrefetchPlace(id: string) {
  const convex = useConvex();
  const { token } = useAuthed();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const start = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => warmPlace(convex, token, id), INTENT_MS);
  }, [convex, token, id]);
  const cancel = useCallback(() => clearTimeout(timer.current), []);
  return { onPointerEnter: start, onFocus: start, onPointerLeave: cancel };
}

/** Subscribes, for a little while, to what a place in the nav shows first. */
export function warmPlace(convex: ConvexReactClient, token: string, id: string) {
  const keep = { extendSubscriptionFor: KEEP_MS };
  if (id === "home") {
    prefetchCatalogRows();
    for (const query of [api.recs.rows, api.catalogs.friends] as const) convex.prewarmQuery({ query, args: { token }, ...keep });
  }
  // The Library is built from this profile's synced tables, which are already here.
  if (id === "library") convex.prewarmQuery({ query: api.simkl.syncState, args: { token }, ...keep });
}
