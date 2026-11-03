import { useMemo } from "react";
import { overviewFrom, toRateFrom, type Backlog, type Overview } from "../../../convex/lib/libraryViews";
import { useOwnRows, useProgressRows, useSimklRows } from "../../data/rows";

/*
 * The Library, built here from this profile's synced tables (lib/sync.tsx) with the server's own rules, so a rating
 * re-reads nothing from the database at all.
 */

export type { Backlog, Overview };

function useRows() {
  return { simkl: useSimklRows(), own: useOwnRows(), progress: useProgressRows() };
}

/** Plan to watch and the collections. Undefined while loading, or when not `enabled`. */
export function useOverview(enabled = true): Overview | undefined {
  const { simkl, own, progress } = useRows();
  return useMemo(() => (enabled && simkl && own && progress ? overviewFrom(own, progress, simkl, true) : undefined), [enabled, simkl, own, progress]);
}

/** What's watched but not scored yet. */
export function useBacklog(): Backlog | undefined {
  const { simkl, own, progress } = useRows();
  return useMemo(() => (simkl && own && progress ? toRateFrom(own, progress, simkl) : undefined), [simkl, own, progress]);
}
