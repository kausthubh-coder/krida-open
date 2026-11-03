import { createContext, createElement, useCallback, useContext, useLayoutEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { useMutation } from "convex/react";
import type { FunctionArgs } from "convex/server";
import { ConvexError } from "convex/values";
import { toast } from "../ui/toast";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { syncableStatus, watchStatusOf } from "../../convex/lib/watchStatus";
import { mineFrom, type MineRow } from "../../convex/lib/libraryViews";
import { aliasesOf, canonicalWith } from "../../convex/lib/titleIds";
import { ownRowsOf, playedOf, simklRowsOf, useOwnRows, usePlayed, useSimklRows, type Played } from "./rows";
import { useAuthed } from "./session";
import { useSyncStore, type Patch, type Tables } from "./sync";
import type { WatchStatus } from "./watchStatus";

type Row = MineRow;
type SaveItem = FunctionArgs<typeof api.library.toggle>["item"];
type RateItem = FunctionArgs<typeof api.ratings.save>["item"];
type StatusItem = FunctionArgs<typeof api.library.setStatus>["item"];
export type RatingChange = Omit<FunctionArgs<typeof api.ratings.save>, "token" | "item">;

type Entry = { status: WatchStatus | null; saved: boolean; rating: number | null };
const NOTHING: Entry = { status: null, saved: false, rating: null };

/**
 * Where this profile stands with every title, built from its synced tables (Simkl history, your own choices, and
 * playback) with the server's own status rule. Each poster listens to its own title, so a change re-renders only its cards.
 */
export class MineStore {
  private entries = new Map<string, Entry>();
  private listeners = new Map<string, Set<() => void>>();
  private ready = false;

  /** `aliases`: another id of a title (an anime's IMDb id) and the id its rows are under (lib/titleIds). */
  update(rows: Row[], played: Played[], aliases = new Map<string, string>()) {
    const canonical = canonicalWith(aliases);
    // A title played under both ids counts as played if either is unfinished.
    const playedById = new Map<string, Played>();
    for (const p of played) {
      const other = playedById.get(canonical(p.id));
      if (!other || other.finished) playedById.set(canonical(p.id), p);
    }
    const next = new Map<string, Entry>();
    const add = (row: Row) => {
      const entry = { status: watchStatusOf({ ...row, played: playedById.get(row.id) }), saved: !!row.saved, rating: row.rating ?? null };
      const old = this.entries.get(row.id);
      next.set(row.id, old && old.status === entry.status && old.saved === entry.saved && old.rating === entry.rating ? old : entry);
    };
    for (const row of rows) add(row);
    for (const id of playedById.keys()) if (!next.has(id)) add({ id });
    // A poster under the other id shows the same entry.
    for (const [alias, id] of aliases) {
      const entry = next.get(id);
      if (entry) next.set(alias, entry);
    }
    const changed = this.ready
      ? [...[...next].filter(([id, entry]) => this.entries.get(id) !== entry).map(([id]) => id),
        ...[...this.entries.keys()].filter((id) => !next.has(id))]
      : [...this.listeners.keys()];
    this.entries = next;
    this.ready = true;
    for (const id of changed) for (const listener of [...(this.listeners.get(id) ?? [])]) listener();
  }

  subscribe(id: string, listener: () => void) {
    const set = this.listeners.get(id) ?? new Set();
    this.listeners.set(id, set);
    set.add(listener);
    return () => {
      set.delete(listener);
      if (!set.size) this.listeners.delete(id);
    };
  }

  /** Undefined until both subscriptions have answered. */
  get(id: string): Entry | undefined {
    return this.ready ? this.entries.get(id) ?? NOTHING : undefined;
  }
}

const MineContext = createContext<MineStore | null>(null);

export function MineProvider({ children }: { children: ReactNode }) {
  const simkl = useSimklRows();
  const own = useOwnRows();
  const rows = useMemo(() => (simkl && own ? mineFrom(simkl, own) : undefined), [simkl, own]);
  const aliases = useMemo(() => (simkl ? aliasesOf(simkl) : undefined), [simkl]);
  const played = usePlayed();
  const [store] = useState(() => new MineStore());
  useLayoutEffect(() => {
    if (rows && played && aliases) store.update(rows, played, aliases);
  }, [store, rows, played, aliases]);
  return createElement(MineContext.Provider, { value: store }, children);
}

function useEntry<T>(id: string, pick: (entry: Entry) => T): T | undefined {
  const store = useContext(MineContext);
  if (!store) throw new Error("useMine outside MineProvider");
  const subscribe = useCallback((listener: () => void) => store.subscribe(id, listener), [store, id]);
  return useSyncExternalStore(subscribe, () => {
    const entry = store.get(id);
    return entry && pick(entry);
  });
}

export const useSaved = (id: string): boolean | undefined => useEntry(id, (entry) => entry.saved);
export const useRating = (id: string): number | null | undefined => useEntry(id, (entry) => entry.rating);
export const useWatchStatus = (id: string): WatchStatus | null | undefined => useEntry(id, (entry) => entry.status);

type Title = { id: string; type: "movie" | "series"; name: string; poster?: string; year?: string };

// Rows made here before the server has them; they stand in until the server's arrive.
let pending = 0;
const pendingDoc = <T,>(fields: T) =>
  ({ _id: `pending:${++pending}` as Id<never>, _creationTime: Date.now(), profileId: "" as Id<"profiles">, ...fields });

/**
 * A change to one title's status, Plan to watch or score, as a patch on this profile's tables, so every card and the Library
 * show it before the server answers. It lands in the rows the server would write.
 */
function patchMine(item: Title, change: (row: Row, tables: Tables) => Row): Patch {
  return (tables) => {
    // Like the server, the change lands under the title's canonical id, replacing any row under its alias.
    const canonical = canonicalWith(aliasesOf(tables.tracked));
    const id = canonical(item.id);
    const own = ownRowsOf(tables);
    const before = mineFrom(simklRowsOf({ tracked: tables.tracked.filter((t) => t.id === id) }), {
      ...own, viewing: own.viewing.filter((r) => canonical(r.id) === id),
      list: own.list.filter((l) => canonical(l.imdbId) === id), feedback: own.feedback.filter((f) => canonical(f.id) === id),
    })[0] ?? { id };
    const after = change(before, tables);
    const now = Date.now();
    const out: Partial<Tables> = {};
    if (after.local !== before.local)
      out.viewing = [...tables.viewing.filter((r) => canonical(r.id) !== id),
        ...(after.local ? [pendingDoc({ id, type: item.type, name: item.name, poster: item.poster, state: after.local, at: now })] : [])];
    if (!!after.saved !== !!before.saved)
      out.library = after.saved
        ? [...tables.library, pendingDoc({ imdbId: id, type: item.type, name: item.name, poster: item.poster, year: item.year, addedAt: now })]
        : tables.library.filter((l) => canonical(l.imdbId) !== id);
    // A cleared score is a row too: it hides the one imported from Simkl.
    if (after.rating !== before.rating)
      out.feedback = [...tables.feedback.filter((f) => canonical(f.id) !== id),
        pendingDoc({ id, type: item.type, name: item.name, value: null, rating: after.rating ?? null, at: now })];
    return out;
  };
}

/** Mirrors an explicit status choice. Saving an already watched title can also keep a bookmark. */
const choose = (row: Row, item: { id: string; type: "movie" | "series" }, state: WatchStatus): Row => ({
  ...row,
  local: state,
  saved: state === "plantowatch" ? true : syncableStatus(item.type, item.id, state) ? undefined : row.saved,
});

const failure = (e: unknown, fallback: string) => e instanceof ConvexError && typeof e.data === "string" ? e.data : fallback;

/** Choose a watch status. Every place showing it changes at once; failures say so in a toast. */
export function useSetStatus() {
  const { token } = useAuthed();
  const sync = useSyncStore();
  const set = useMutation(api.library.setStatus);
  return (item: StatusItem, state: WatchStatus) => {
    const title = { id: item.id, type: item.type, name: item.name, poster: item.poster, year: item.year };
    return sync.optimistic(patchMine(title, (row) => choose(row, item, state)), set({ token, item: title, state }))
      .catch((e) => { toast.error(failure(e, `Couldn’t save your watch status for ${item.name}`)); });
  };
}

/** Add to or remove from Plan to watch. Every place showing it changes at once; resolves to when it was added, for Undo. */
export function useSetSaved() {
  const { token } = useAuthed();
  const sync = useSyncStore();
  const toggle = useMutation(api.library.toggle);
  return (item: SaveItem, saved: boolean, addedAt?: number) => {
    const id = item.imdbId;
    const patch = patchMine({ ...item, id }, (row, tables) => {
      if (!saved) return { ...row, saved: undefined, local: row.local === "plantowatch" ? undefined : row.local };
      if (row.saved) return row;
      const canonical = canonicalWith(aliasesOf(tables.tracked));
      const played: Played | undefined = playedOf(tables).find((p) => canonical(p.id) === canonical(id));
      return row.local === "completed" || row.local === "watching" || row.local === "rewatching" ||
        row.tracked === "completed" || row.tracked === "watching" || played?.finished || watchStatusOf({ ...row, played }) === "watching"
        ? { ...row, saved: true } : choose(row, { id, type: item.type }, "plantowatch");
    });
    return sync.optimistic(patch, toggle({ token, item, saved, addedAt })).catch(() => {
      toast.error(saved ? `Couldn’t add ${item.name} to Plan to watch` : `Couldn’t remove ${item.name} from Plan to watch`);
      return null;
    });
  };
}

export function useRate() {
  const { token } = useAuthed();
  const sync = useSyncStore();
  // The title page's own subscription to its score changes at once too.
  const set = useMutation(api.ratings.save).withOptimisticUpdate((store, { token, item, rating, season }) => {
    if (season !== undefined || rating === undefined) return;
    const details = store.getQuery(api.ratings.details, { token, id: item.id });
    if (details) store.setQuery(api.ratings.details, { token, id: item.id }, { ...details, rating });
  });
  // Leave errors to the open editor, where they remain visible and can be retried.
  return (item: RateItem, change: RatingChange) => {
    const { rating, season, state } = change;
    const whole = season === undefined && rating !== undefined;
    const patch = patchMine(item, (row) => {
      const scored = whole ? { ...row, rating: rating ?? undefined } : row;
      if (state) return choose(scored, item, state);
      // Mirrors ratings.save: scoring a movie you haven't marked means you saw it.
      return whole && rating !== null && item.type === "movie" && !row.local && row.tracked !== "completed"
        ? choose(scored, item, "completed") : scored;
    });
    return sync.optimistic(patch, set({ token, item, ...change }));
  };
}
