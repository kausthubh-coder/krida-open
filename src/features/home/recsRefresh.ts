import { useEffect, useRef, useState } from "react";
import { useConvex, useMutation } from "convex/react";
import { useQuery } from "convex-helpers/react/cache/hooks";
import { api } from "../../../convex/_generated/api";
import { tasteDigest, tasteOf } from "../../../shared/taste";
import type { BuiltRow } from "../../../server/recs";
import { CONVEX_URL } from "../../data/backend";
import { historyOf } from "../../data/rows";
import { useAuthed } from "../../data/session";
import { useTables } from "../../data/sync";
import { catalogPage, loadedCatalogRow, useAddons, type InstalledAddon } from "../../data/addons";
import { addonRowsOf } from "./useHome";
import { useNeedsTmdbKey } from "../../data/keys";

/** Catalogs whose titles join the recommender's candidates, and how many titles go in all. */
const CATALOGS = 8;
const CATALOG_TITLES = 150;

/** Titles from the profile's first addon catalogs (IMDb ids only: the recommender scores by IMDb), as Home has them. */
async function catalogTitles(addons: InstalledAddon[]) {
  const rows = addonRowsOf(addons).slice(0, CATALOGS);
  const pages = await Promise.all(rows.map(async (r) => loadedCatalogRow(r.base, r.catalog) ?? (await catalogPage(r.base, r.catalog).catch(() => []))));
  const seen = new Set<string>();
  return pages.flat().filter((i) => i.id.startsWith("tt") && !seen.has(i.id) && seen.add(i.id)).slice(0, CATALOG_TITLES).map(({ id, type }) => ({ id, type }));
}

// The catalogs refresh every 6 hours, so picks worked out longer ago than that are worked out again.
const STALE_MS = 6 * 60 * 60 * 1000;
// How often an open tab checks whether its picks have gone stale, with nothing else changing.
const CHECK_MS = 30 * 60_000;
// After a change (a rating, a status, a finished title) picks wait for things to settle, so ten ratings in a row are
// one recompute; on opening Krida a short wait lets the first screens load first.
const AFTER_CHANGE_MS = 60_000;
const ON_OPEN_MS = 5000;
// Never more often than this, whatever happens.
const MIN_GAP_MS = 2 * 60_000;

/**
 * Keeps this profile's picks up to date. Its taste is worked out here from its synced tables, the rows on the server
 * (POST /api/recs), and they're saved with the taste (recs.save), which the others' "For you and…" rows use. Nothing
 * reads the profile's history from the database. Picks are scored on TMDB, so without the account's key none are asked for.
 */
export function useRecsRefresh() {
  const { token } = useAuthed();
  const needsKey = useNeedsTmdbKey();
  const convex = useConvex();
  const tables = useTables();
  const saved = useQuery(api.recs.rows, { token });
  const save = useMutation(api.recs.save);
  const addons = useAddons();
  // Read when the picks are worked out, not a reason to work them out again.
  const addonsNow = useRef(addons);
  useEffect(() => {
    addonsNow.current = addons;
  }, [addons]);
  const job = useRef<{ key?: string; timer?: ReturnType<typeof setTimeout>; running: boolean; ranAt: number; seen: boolean }>(
    { running: false, ranAt: 0, seen: false });
  // Re-checks staleness now and then, for a tab left open.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), CHECK_MS);
    return () => clearInterval(id);
  }, []);
  const known = saved !== undefined;
  const digest = saved?.digest ?? null;
  const computedAt = saved?.computedAt ?? 0;
  // The others' tastes now, and as these picks used them: "For you and…" follows theirs too.
  const others = saved?.others ?? "";
  const othersUsed = saved?.othersDigest ?? null;

  useEffect(() => {
    const state = job.current;
    if (needsKey) {
      clearTimeout(state.timer);
      state.timer = undefined;
      return;
    }
    if (!tables || !known) return;
    const first = !state.seen;
    state.seen = true;
    const taste = tasteOf(historyOf(tables), Date.now());
    const mine = tasteDigest(taste);
    const key = `${mine}|${others}`;
    if (mine === digest && others === othersUsed && Date.now() - computedAt < STALE_MS) {
      clearTimeout(state.timer);
      state.timer = undefined;
      return;
    }
    // Already waiting to work out this taste, or working it out: a play saving its position doesn't push it back,
    // and the answer arriving runs this again.
    if (state.running || (state.timer && state.key === key)) return;
    clearTimeout(state.timer);
    state.key = key;
    const delay = Math.max(first ? ON_OPEN_MS : AFTER_CHANGE_MS, state.ranAt + MIN_GAP_MS - Date.now());
    state.timer = setTimeout(async () => {
      state.timer = undefined;
      state.running = true;
      state.ranAt = Date.now();
      try {
        const [friends, catalog] = await Promise.all([convex.query(api.recs.others, { token }), catalogTitles(addonsNow.current ?? [])]);
        const res = await fetch("/api/recs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ backend: CONVEX_URL, token, taste, others: friends, catalog }),
        });
        if (!res.ok) throw new Error(`Recommendations answered ${res.status}`);
        const { rows } = (await res.json()) as { rows: BuiltRow[] };
        await save({ token, rows, taste, digest: mine, othersDigest: others });
      } catch (error) {
        // Picks stay as they were; the next change, check or visit tries again (at most every 2 minutes).
        console.warn("Couldn't refresh picks", error);
      } finally {
        state.running = false;
        state.key = undefined;
      }
    }, delay);
  }, [tables, known, needsKey, digest, computedAt, others, othersUsed, tick, convex, token, save]);

  useEffect(() => () => {
    clearTimeout(job.current.timer);
    job.current.timer = undefined;
    job.current.seen = false;
  }, []);
}
