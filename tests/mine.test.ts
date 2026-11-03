import type { OptimisticLocalStore, OptimisticUpdate } from "convex/browser";
import { getFunctionName, type FunctionReturnType } from "convex/server";
import { describe, expect, test, vi } from "vitest";
import { api } from "../convex/_generated/api";
import { MineStore, useRate, useSetSaved, useSetStatus } from "../src/data/mine";
import { mineFrom, type MineRow } from "../convex/lib/libraryViews";
import { ownRowsOf, simklRowsOf } from "../src/data/rows";
import type { Patch, Tables } from "../src/data/sync";

type Rows = MineRow[];
type Details = FunctionReturnType<typeof api.ratings.details>;
const captured = vi.hoisted(() => ({ update: null as OptimisticUpdate<any> | null, patches: [] as Patch[] }));

vi.mock("../src/data/session", () => ({ useAuthed: () => ({ token: "me" }) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("../src/data/sync", () => ({
  useTables: vi.fn(),
  // Changes made here are patches on the synced tables, shown until the server's version arrives.
  useSyncStore: () => ({ optimistic: (patch: Patch, change: Promise<unknown>) => (captured.patches.push(patch), change) }),
}));
vi.mock("convex/react", () => ({
  useQuery: vi.fn(),
  useMutation: () => Object.assign(vi.fn().mockResolvedValue(null), {
    withOptimisticUpdate: (update: OptimisticUpdate<any>) => {
      captured.update = update;
      return vi.fn().mockResolvedValue(null);
    },
  }),
}));

const doc = <T,>(fields: T) => ({ _id: "row", _creationTime: 1, profileId: "me", ...fields });

/** The tables behind these poster rows: an imported status, your own status, My list and your score. */
function tablesOf(rows: Rows): Tables {
  const title = (id: string) => ({ type: "movie" as const, name: id });
  return {
    tracked: rows.flatMap((r) => (r.tracked ? [doc({ id: r.id, ...title(r.id), status: r.tracked, source: "simkl", externalId: 1 })] : [])),
    viewing: rows.flatMap((r) => (r.local ? [doc({ id: r.id, ...title(r.id), state: r.local, at: 1 })] : [])),
    library: rows.flatMap((r) => (r.saved ? [doc({ imdbId: r.id, ...title(r.id), addedAt: 1 })] : [])),
    feedback: rows.flatMap((r) => (r.rating !== undefined ? [doc({ id: r.id, ...title(r.id), value: null, rating: r.rating, at: 1 })] : [])),
    partRatings: [], unwatched: [], progress: [],
  } as unknown as Tables;
}

function cache(mine: Rows) {
  let tables = tablesOf(mine);
  captured.patches.length = 0;
  const queries: Record<string, unknown> = {
    "me:ratings:details": { rating: 9, state: "completed", watchStatus: "completed", parts: [], sync: "on", syncError: undefined } satisfies Details,
  };
  const key = (query: Parameters<typeof getFunctionName>[0], args: { token: string }) => `${args.token}:${getFunctionName(query)}`;
  const store = {
    getQuery: (query: Parameters<typeof getFunctionName>[0], args: { token: string }) => queries[key(query, args)],
    setQuery: (query: Parameters<typeof getFunctionName>[0], args: { token: string }, value: unknown) => { queries[key(query, args)] = value; },
    getAllQueries: () => [],
  } as unknown as OptimisticLocalStore;
  /** Applies what the last change patched in, as the synced store does. */
  const settle = () => {
    for (const patch of captured.patches.splice(0)) tables = { ...tables, ...patch(tables) };
  };
  const rows = () => {
    settle();
    return mineFrom(simklRowsOf(tables), ownRowsOf(tables));
  };
  return {
    store,
    // A title with nothing left has no row; either way, a missing field reads as undefined.
    row: (id: string): MineRow => ({ local: undefined, tracked: undefined, saved: undefined, rating: undefined, ...rows().find((r) => r.id === id), id }),
    details: () => queries["me:ratings:details"] as Details,
  };
}

const film = { id: "title", type: "movie" as const, name: "Title" };
const show = { ...film, type: "series" as const };

describe("optimistic poster state", () => {
  test("bookmarking a watched title preserves its status", () => {
    const c = cache([{ id: "title", local: "completed", tracked: "completed" }]);
    void useSetSaved()({ imdbId: "title", type: "movie", name: "Title" }, true);
    expect(c.row("title")).toMatchObject({ local: "completed", tracked: "completed", saved: true });
  });

  test.each([null, 3, 5, 10] as const)("a whole-title score of %s updates my poster row and title details only", (rating) => {
    const c = cache([{ id: "other", rating: 3 }, { id: "title", tracked: "completed", rating: 9 }]);
    void useRate()(film, { rating });
    captured.update!(c.store, { token: "me", item: film, rating });
    expect(c.row("title")?.rating).toBe(rating ?? undefined);
    expect(c.row("other")).toMatchObject({ id: "other", rating: 3 });
    expect(c.details().rating).toBe(rating);
  });

  test("scoring an unmarked movie shows it Watched, as the server does", () => {
    const c = cache([{ id: "title", saved: true, local: "plantowatch" }, { id: "fresh" }]);
    const rate = useRate();
    void rate({ ...film, id: "new" }, { rating: 8 });
    expect(c.row("new")).toEqual({ id: "new", rating: 8, local: "completed", saved: undefined, tracked: undefined });
    void rate(film, { rating: 8 });
    expect(c.row("title")).toMatchObject({ local: "plantowatch", saved: true, rating: 8 });
  });

  test("scoped scores and status-only edits keep the whole-title score", () => {
    const c = cache([{ id: "title", tracked: "watching", rating: 9 }]);
    const rate = useRate();
    void rate(show, { season: 1, episode: 2, rating: 6 });
    captured.update!(c.store, { token: "me", item: show, season: 1, episode: 2, rating: 6 });
    void rate(show, { state: "rewatching" });
    expect(c.row("title")).toEqual({ id: "title", tracked: "watching", rating: 9, local: "rewatching", saved: undefined });
    expect(c.details().rating).toBe(9);
  });

  test("statuses mirror My list the way the server writes them", () => {
    const c = cache([{ id: "title", saved: true, local: "plantowatch" }]);
    const set = useSetStatus();
    void set(film, "watching");
    // Simkl can't store Watching for a movie, so it stays in My list.
    expect(c.row("title")).toMatchObject({ local: "watching", saved: true });
    void set(film, "dropped");
    expect(c.row("title")).toMatchObject({ local: "dropped", saved: undefined });
    void set(film, "plantowatch");
    expect(c.row("title")).toMatchObject({ local: "plantowatch", saved: true });
  });

  test("removing from My list clears Plan to watch and keeps other choices", () => {
    const c = cache([{ id: "title", saved: true, local: "plantowatch" }, { id: "kept", saved: true, local: "watching" }]);
    const save = useSetSaved();
    void save({ imdbId: "title", type: "movie", name: "Title" }, false);
    void save({ imdbId: "kept", type: "movie", name: "Kept" }, false);
    expect(c.row("title")).toMatchObject({ saved: undefined, local: undefined });
    expect(c.row("kept")).toMatchObject({ saved: undefined, local: "watching" });
  });

  test("a change under an anime's IMDb id lands on its Kitsu entry", () => {
    const tables = tablesOf([{ id: "kitsu:1", tracked: "completed" }]);
    (tables.tracked[0] as { imdb?: string }).imdb = "tt1";
    captured.patches.length = 0;
    void useRate()({ ...show, id: "tt1" }, { rating: 7 });
    const patched = { ...tables, ...captured.patches[0](tables) };
    expect(mineFrom(simklRowsOf(patched), ownRowsOf(patched))).toEqual([{ id: "kitsu:1", tracked: "completed", rating: 7 }]);
  });
});

describe("poster store", () => {
  test("a change notifies only the titles it touches", () => {
    const store = new MineStore();
    const heard: string[] = [];
    for (const id of ["a", "b", "c"]) store.subscribe(id, () => heard.push(id));
    expect(store.get("a")).toBeUndefined();
    store.update([{ id: "a", tracked: "watching" }, { id: "b", saved: true }], []);
    expect(heard.sort()).toEqual(["a", "b", "c"]);
    heard.length = 0;
    store.update([{ id: "a", tracked: "watching" }, { id: "b", saved: true, rating: 7 }], [{ id: "c", type: "series", finished: false }]);
    expect(heard.sort()).toEqual(["b", "c"]);
    expect(store.get("b")).toEqual({ status: "plantowatch", saved: true, rating: 7 });
    expect(store.get("c")?.status).toBe("watching");
    expect(store.get("unknown")).toEqual({ status: null, saved: false, rating: null });
  });

  test("a poster under an anime's IMDb id shows its Kitsu entry, played under either id", () => {
    const store = new MineStore();
    const heard: string[] = [];
    store.subscribe("tt1", () => heard.push("tt1"));
    const aliases = new Map([["tt1", "kitsu:1"]]);
    store.update([{ id: "kitsu:1", tracked: "plantowatch", saved: true, rating: 8 }], [], aliases);
    expect(store.get("tt1")).toEqual({ status: "plantowatch", saved: true, rating: 8 });
    heard.length = 0;
    store.update([{ id: "kitsu:1", tracked: "plantowatch", saved: true, rating: 8 }], [{ id: "tt1", type: "series", finished: false }], aliases);
    expect(heard).toEqual(["tt1"]);
    expect(store.get("tt1")).toBe(store.get("kitsu:1"));
    expect(store.get("kitsu:1")?.status).toBe("watching");
  });
});
