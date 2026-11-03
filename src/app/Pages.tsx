import { Suspense, useMemo, useState, type ReactNode } from "react";
import { Outlet, useLocation } from "react-router";
import { keptPlace } from "./places";
import { Home } from "../features/home";
import { Library } from "../features/library";
import { PageShown } from "../ui/pageShown";

/**
 * The page. Home and Library stay mounted once visited and are only hidden while you're elsewhere (`kept-away`), so going
 * back shows them as you left them at once instead of building every row again. Hidden they keep their layout, which
 * display: none and so <Activity> throw away: laying out all of Home again was the wait on every switch back (114 → 72 ms
 * from a press to the next frame at 4× CPU throttling). Nothing paints in there and trailers ask `usePageShown`; only their
 * queries stay live. Every other page is routed as usual.
 *
 * Switching is instant, like a tab bar; the dock's lens carries the movement. A fade over the whole page
 * composites every glass surface on it for each frame, and dropped frames on every switch.
 */
export function Pages() {
  const { pathname } = useLocation();
  const kept = keptPlace(pathname);
  const [visited, setVisited] = useState<string[]>([]);
  if (kept && !visited.includes(kept)) setVisited([...visited, kept]);
  // The same elements each time, so a press in the nav doesn't render a whole kept page again.
  const home = useMemo(() => <Home />, []);
  const library = useMemo(() => <Library />, []);
  const keep = (id: string, page: ReactNode) =>
    visited.includes(id) && (
      <div className={kept === id ? undefined : "kept-away"} inert={kept !== id}>
        <PageShown.Provider value={kept === id}>
          <Suspense>{page}</Suspense>
        </PageShown.Provider>
      </div>
    );
  // Pages other than Home load their code after start-up (lazyPage); one opened first draws once it arrives.
  return (
    <>
      {keep("home", home)}
      {keep("library", library)}
      {!kept && (
        <Suspense>
          <Outlet />
        </Suspense>
      )}
    </>
  );
}
