import { useLayoutEffect, useRef } from "react";
import { useLocation, useNavigationType } from "react-router";

/*
 * Back and Forward return to where you were on that page; following a link starts at the top.
 * React Router's <ScrollRestoration> needs a data router, and Krida uses <BrowserRouter>, so this
 * keeps positions by history entry (location.key) itself.
 */

const STORE = "krida.scroll";
const KEEP = 50;
// Pages fill in from Convex and the search cache a moment after they mount.
const WAIT_MS = 3000;

const positions = new Map<string, number>(read());

function read(): [string, number][] {
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(STORE) ?? "[]");
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

function remember(key: string, y: number) {
  positions.delete(key);
  positions.set(key, y);
  for (const old of positions.keys()) {
    if (positions.size <= KEEP) break;
    positions.delete(old);
  }
}

/**
 * The history entry a place is kept under. Every page opened by loading it (a typed or pasted link, a reload of the
 * first page) has the key "default", so those are kept by address: otherwise a title opened that way would restore
 * the place Home had.
 */
export function scrollKey({ key, pathname, search }: { key: string; pathname: string; search: string }) {
  return key === "default" ? `default ${pathname}${search}` : key;
}

export function useScrollMemory() {
  const location = useLocation();
  const { pathname, search } = location;
  const key = scrollKey(location);
  const type = useNavigationType();
  const page = useRef<string | null>(null);

  useLayoutEffect(() => {
    history.scrollRestoration = "manual";
    const persist = () => sessionStorage.setItem(STORE, JSON.stringify([...positions]));
    window.addEventListener("pagehide", persist);
    return () => window.removeEventListener("pagehide", persist);
  }, []);

  // A layout effect, so the old entry stops recording before the new page can move the scroll.
  useLayoutEffect(() => {
    const record = () => remember(key, window.scrollY);
    window.addEventListener("scroll", record, { passive: true });
    return () => window.removeEventListener("scroll", record);
  }, [key]);

  useLayoutEffect(() => {
    const previous = page.current;
    page.current = `${pathname}${search}`;
    if (type !== "POP") {
      // A hash or a same-page update (a new history key for the same URL) keeps its place.
      if (previous !== page.current) window.scrollTo(0, 0);
      return;
    }
    const target = positions.get(key) ?? 0;
    const start = performance.now();
    let frame = 0;
    // Wait until the page is tall enough to scroll there, or the person scrolls first.
    const attempt = () => {
      const room = document.documentElement.scrollHeight - window.innerHeight;
      if (room >= target || performance.now() - start > WAIT_MS) window.scrollTo(0, Math.min(target, room));
      else frame = requestAnimationFrame(attempt);
    };
    const stop = () => cancelAnimationFrame(frame);
    const events = ["wheel", "touchstart", "keydown", "pointerdown"] as const;
    for (const e of events) window.addEventListener(e, stop, { passive: true, once: true });
    attempt();
    return () => {
      stop();
      for (const e of events) window.removeEventListener(e, stop);
    };
  }, [key, type, pathname, search]);
}
