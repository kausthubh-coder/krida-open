import { createContext, createElement, useContext, useEffect, useLayoutEffect, useState, useSyncExternalStore, type ReactNode } from "react";
// The pull's cursor changes on every answer; the cached hook would keep each old cursor's subscription open.
// oxlint-disable-next-line no-restricted-imports
import { useConvex, useQuery, type ConvexReactClient } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";
import type { Doc } from "../../convex/_generated/dataModel";
import { SYNCED, type Synced } from "../../convex/lib/synced";
import { CONVEX_URL } from "./backend";
import { useAuthed } from "./session";

/*
 * This profile's own tables (Simkl history, statuses, Plan to watch, scores, plays), kept in the browser. Opening Krida reads
 * the copy from IndexedDB and then only what changed since (convex/sync.ts), so a rating or a play saving its position
 * reads one row from the database instead of the whole library. Everything built from these tables (posters' statuses,
 * the Library, Home's rows, To rate) is worked out here with the server's own rules.
 *
 * Changes made here show before the server answers: `optimistic` patches the tables until the server's version of
 * the change has arrived.
 */

export type Tables = { [T in Synced]: Doc<T>[] };
type Pull = Extract<FunctionReturnType<typeof api.sync.pull>, { reset: false }>;
/** A change made here, before the server has it: returns only the tables it changed. */
export type Patch = (tables: Tables) => Partial<Tables>;

// Bumped when what's kept changes shape, so an older copy is fetched again. (A copy too old to catch up by pulling
// is fetched again too: the server says so.)
const VERSION = 1;
// A pull's cursor moves on (and the copy is saved) once this much has piled up, or this long has passed.
const ADVANCE_CHANGES = 100;
const ADVANCE_MS = 10 * 60_000;
// A change the server has answered stops being patched in once a pull has brought it, or after this long.
const SETTLE_MS = 3000;

type Copy = { version: number; cursor: number; tables: Tables };

// ---------------------------------------------------------------------------------------------
// IndexedDB: one record per profile and backend.

const DB = "krida-sync";
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore("copies");
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}
async function request<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await database();
  return await new Promise<T>((resolve, reject) => {
    const req = run(db.transaction("copies", mode).objectStore("copies"));
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error);
  }).finally(() => db.close());
}
const readCopy = (key: string) => request<Copy | undefined>("readonly", (s) => s.get(key)).catch(() => undefined);
const writeCopy = (key: string, copy: Copy) => request("readwrite", (s) => s.put(copy, key)).catch(() => {});

/** Forgets every kept copy, for signing out. */
export const forgetSynced = () => request("readwrite", (s) => s.clear()).catch(() => {});

// ---------------------------------------------------------------------------------------------

export class SyncStore {
  private base: { [T in Synced]: Map<string, Doc<T>> } | null = null;
  private pulled: Pull | null = null;
  private pending: { patch: Patch; settled?: boolean }[] = [];
  private listeners = new Set<() => void>();
  private merged: Tables | undefined;
  // Each table's rows as last built, so a change to one table leaves the others' arrays (and what's built from them) as they were.
  private built = new Map<Synced, { key: string; rows: Doc<Synced>[] }>();
  private revision = 0;
  private advancedAt = 0;
  // Signed out (or another profile): nothing more is kept. A full fetch under way holds settled patches back.
  private closed = false;
  private fetching = false;
  cursor = 0;

  private key: string;
  constructor(key: string) {
    this.key = key;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private changed() {
    this.merged = undefined;
    for (const listener of [...this.listeners]) listener();
  }

  /** The tables as they are now, with changes still on their way to the server. Undefined until loaded. */
  tables = (): Tables | undefined => {
    if (!this.base) return undefined;
    if (this.merged) return this.merged;
    const pulled = new Map<Synced, Map<string, Doc<Synced> | null>>();
    for (const c of this.pulled?.changes ?? []) {
      const byId = pulled.get(c.table) ?? pulled.set(c.table, new Map()).get(c.table)!;
      byId.set(c.id, c.doc as Doc<Synced> | null);
    }
    const tables = {} as Tables;
    for (const table of SYNCED) {
      const changes = pulled.get(table);
      const key = `${this.revision}:${JSON.stringify([...(changes ?? [])])}`;
      let built = this.built.get(table);
      if (built?.key !== key) {
        const rows = new Map<string, Doc<Synced>>(this.base[table] as Map<string, Doc<Synced>>);
        for (const [id, doc] of changes ?? []) {
          if (doc) rows.set(id, doc);
          else rows.delete(id);
        }
        built = { key, rows: [...rows.values()] };
        this.built.set(table, built);
      }
      (tables as Record<Synced, Doc<Synced>[]>)[table] = built.rows;
    }
    let out = tables;
    for (const { patch } of this.pending) out = { ...out, ...patch(out) };
    this.merged = out;
    return out;
  };

  /** Starts from the copy kept in this browser, or a fresh one from the server. */
  async load(convex: ConvexReactClient, token: string) {
    const copy = await readCopy(this.key);
    if (copy?.version === VERSION) this.reset(copy.tables, copy.cursor);
    else await this.fetchAll(convex, token);
  }

  /** Every row, page by page, then pulls from where the changes stood when it began. */
  async fetchAll(convex: ConvexReactClient, token: string) {
    this.fetching = true;
    try {
      await this.fetchPages(convex, token);
    } finally {
      this.fetching = false;
    }
  }

  private async fetchPages(convex: ConvexReactClient, token: string) {
    let head = 0;
    const tables = {} as Tables;
    for (const table of SYNCED) {
      const docs: Doc<Synced>[] = [];
      let cursor: string | null = null;
      do {
        const page: FunctionReturnType<typeof api.sync.snapshot> = await convex.query(api.sync.snapshot, { token, table, cursor });
        if (page.head !== null && table === SYNCED[0]) head = page.head;
        docs.push(...(page.docs as Doc<Synced>[]));
        cursor = page.cursor;
      } while (cursor);
      (tables as Record<Synced, Doc<Synced>[]>)[table] = docs;
    }
    this.reset(tables, head);
    this.save();
  }

  private reset(tables: Tables, cursor: number) {
    if (this.closed) return;
    const byId = <T extends Synced>(rows: Doc<T>[]) => new Map(rows.map((r) => [r._id as string, r]));
    this.base = Object.fromEntries(SYNCED.map((t) => [t, byId(tables[t])])) as SyncStore["base"];
    this.pulled = null;
    this.revision++;
    this.cursor = cursor;
    this.advancedAt = Date.now();
    this.changed();
  }

  /**
   * Keeps the copy, with what's been pulled since the cursor. Those rows are pulled again next time (the cursor
   * hasn't moved past them), which changes nothing; they're in the copy so that reopening shows them at once.
   */
  private save() {
    clearTimeout(this.saving);
    if (!this.base || this.closed) return;
    const tables = Object.fromEntries(SYNCED.map((t) => {
      const rows = new Map<string, Doc<Synced>>(this.base![t] as Map<string, Doc<Synced>>);
      for (const c of this.pulled?.changes ?? [])
        if (c.table === t) {
          if (c.doc) rows.set(c.id, c.doc as Doc<Synced>);
          else rows.delete(c.id);
        }
      return [t, [...rows.values()]];
    })) as Tables;
    void writeCopy(this.key, { version: VERSION, cursor: this.cursor, tables });
  }
  private saving: ReturnType<typeof setTimeout> | undefined;

  /** A pull's answer: the rows changed since the cursor. Changes it carries are no longer patched in. */
  apply(pull: Pull) {
    this.pulled = pull;
    this.pending = this.pending.filter((p) => !p.settled);
    this.changed();
    clearTimeout(this.saving);
    this.saving = setTimeout(() => this.save(), 2000);
  }

  /** Folds what was pulled into the copy and moves the cursor on, when enough has piled up and nothing is on its way. */
  advance(): boolean {
    const pull = this.pulled;
    if (!pull || !this.base || this.pending.length) return false;
    if (pull.changes.length < ADVANCE_CHANGES && Date.now() - this.advancedAt < ADVANCE_MS) return false;
    for (const c of pull.changes) {
      const rows = this.base[c.table] as Map<string, Doc<Synced>>;
      if (c.doc) rows.set(c.id, c.doc as Doc<Synced>);
      else rows.delete(c.id);
    }
    this.pulled = null;
    this.cursor = pull.cursor;
    this.advancedAt = Date.now();
    this.save();
    // The rows are the same as before, so each table keeps its array and nothing re-renders.
    this.revision++;
    for (const [table, built] of this.built) this.built.set(table, { key: `${this.revision}:[]`, rows: built.rows });
    return true;
  }

  /**
   * Shows `patch` until `change` (the mutation making it) has been answered and its result pulled, or at once undoes
   * it if the mutation fails.
   */
  optimistic<T>(patch: Patch, change: Promise<T>): Promise<T> {
    const entry: { patch: Patch; settled?: boolean } = { patch };
    this.pending.push(entry);
    this.changed();
    const drop = (): void => {
      if (!this.pending.includes(entry)) return;
      // A full fetch may have read the tables before this change: keep it until that's in.
      if (this.fetching) return void setTimeout(drop, SETTLE_MS);
      this.pending = this.pending.filter((p) => p !== entry);
      this.changed();
    };
    return change.then(
      (result) => {
        entry.settled = true;
        setTimeout(drop, SETTLE_MS);
        return result;
      },
      (error: unknown) => {
        this.pending = this.pending.filter((p) => p !== entry);
        this.changed();
        throw error;
      },
    );
  }

  /** Stops keeping anything: signed out, or switched profile. (React's dev mode closes and reopens it once.) */
  close() {
    this.closed = true;
    clearTimeout(this.saving);
  }

  open() {
    this.closed = false;
  }
}

const SyncContext = createContext<SyncStore | null>(null);

/** Keeps this profile's tables in step with the server for as long as it's signed in. */
export function SyncProvider({ children }: { children: ReactNode }) {
  const { token, me } = useAuthed();
  const convex = useConvex();
  const [store] = useState(() => new SyncStore(`${CONVEX_URL}:${me._id}`));
  useEffect(() => {
    store.open();
    return () => store.close();
  }, [store]);
  const [since, setSince] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    let retry: ReturnType<typeof setTimeout>;
    const start = () => store.load(convex, token).then(() => alive && setSince(store.cursor), () => {
      // Offline or the server didn't answer: try again shortly. A kept copy shows meanwhile only once loaded.
      if (alive) retry = setTimeout(start, 5000);
    });
    void start();
    return () => {
      alive = false;
      clearTimeout(retry);
    };
  }, [store, convex, token]);
  const pull = useQuery(api.sync.pull, since === null ? "skip" : { token, since });
  useLayoutEffect(() => {
    if (!pull) return;
    // Too far behind (away a long time, or a big import): everything again.
    if (pull.reset) {
      let alive = true;
      let retry: ReturnType<typeof setTimeout>;
      const again = () => store.fetchAll(convex, token).then(() => alive && setSince(store.cursor), () => {
        if (alive) retry = setTimeout(again, 5000);
      });
      void again();
      return () => {
        alive = false;
        clearTimeout(retry);
      };
    }
    store.apply(pull);
    if (store.advance()) setSince(store.cursor);
  }, [store, pull, convex, token]);
  return createElement(SyncContext.Provider, { value: store }, children);
}

export function useSyncStore() {
  const store = useContext(SyncContext);
  if (!store) throw new Error("useSyncStore outside SyncProvider");
  return store;
}

/** This profile's tables, undefined until the copy has loaded. */
export function useTables(): Tables | undefined {
  const store = useSyncStore();
  return useSyncExternalStore(store.subscribe, store.tables);
}
