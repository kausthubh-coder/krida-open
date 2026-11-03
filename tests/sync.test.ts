/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import { sha256 } from "../convex/lib/auth";
import { SyncStore, type Tables } from "../src/data/sync";

const modules = import.meta.glob(["../convex/**/*.ts", "../convex/**/*.js", "!../convex/**/*.d.ts"]);
const token = "sync-session";
const prefs = { audioLang: "en", sounds: false };
const movie = { id: "tt0000001", type: "movie" as const, name: "A movie" };

async function fixture() {
  const t = convexTest(schema, modules);
  const profileId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("profiles", { name: "Sync test", hue: 1, passwordHash: "x", salt: "x", order: 0, failedAttempts: 0, prefs });
    const other = await ctx.db.insert("profiles", { name: "Other", hue: 2, passwordHash: "x", salt: "x", order: 1, failedAttempts: 0, prefs });
    await ctx.db.insert("sessions", { profileId: id, tokenHash: await sha256(token), createdAt: 0 });
    await ctx.db.insert("sessions", { profileId: other, tokenHash: await sha256("other"), createdAt: 0 });
    return id;
  });
  return { t, profileId };
}

describe("the change log", () => {
  test("a pull brings only what changed since, as it is now, and deletions as null", async () => {
    const { t } = await fixture();
    const start = await t.query(api.sync.snapshot, { token, table: "tracked", cursor: null });
    expect(start).toMatchObject({ docs: [], cursor: null, head: 0 });
    await t.mutation(api.ratings.save, { token, item: movie, rating: 8 });
    const first = await t.query(api.sync.pull, { token, since: 0 });
    if (first.reset) throw new Error("unexpected reset");
    expect(first.changes.map((c) => c.table).sort()).toEqual(["feedback", "viewing"]);
    expect(first.changes.find((c) => c.table === "feedback")?.doc).toMatchObject({ id: movie.id, rating: 8 });

    // Saved again: still one change per row, now with the new score.
    await t.mutation(api.ratings.save, { token, item: movie, rating: 6 });
    const again = await t.query(api.sync.pull, { token, since: 0 });
    if (again.reset) throw new Error("unexpected reset");
    expect(again.changes.filter((c) => c.table === "feedback")).toHaveLength(1);
    expect(again.changes.find((c) => c.table === "feedback")?.doc).toMatchObject({ rating: 6 });

    // Removed from Plan to watch after being added: the library row arrives as deleted.
    await t.mutation(api.library.toggle, { token, item: { imdbId: "tt0000002", type: "movie", name: "Another" }, saved: true });
    await t.mutation(api.library.toggle, { token, item: { imdbId: "tt0000002", type: "movie", name: "Another" }, saved: false });
    const later = await t.query(api.sync.pull, { token, since: 0 });
    if (later.reset) throw new Error("unexpected reset");
    expect(later.changes.find((c) => c.table === "library")?.doc).toBeNull();

    // Another profile sees none of it.
    const theirs = await t.query(api.sync.pull, { token: "other", since: 0 });
    expect(theirs).toMatchObject({ reset: false, changes: [] });
  });

  test("a copy from before a forgotten change starts again; one with nothing forgotten never does", async () => {
    const { t } = await fixture();
    vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-10-01T00:00:00Z") });
    try {
      await t.mutation(api.ratings.save, { token, item: movie, rating: 8 });
      vi.setSystemTime(Date.parse("2026-12-01T00:00:00Z"));
      await t.mutation(internal.sync.prune, {});
      expect(await t.query(api.sync.pull, { token, since: Date.parse("2026-09-30T00:00:00Z") })).toEqual({ reset: true });
      // The other profile changed nothing, so an old copy of it is still good.
      expect(await t.query(api.sync.pull, { token: "other", since: 1 })).toMatchObject({ reset: false, changes: [] });
      // A fresh copy starts from the floor, so it can pull from there.
      const fresh = await t.query(api.sync.snapshot, { token, table: "tracked", cursor: null });
      expect(await t.query(api.sync.pull, { token, since: fresh.head! })).toMatchObject({ reset: false, changes: [] });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the browser's copy", () => {
  const empty = (): Tables => ({ tracked: [], viewing: [], library: [], feedback: [], partRatings: [], unwatched: [], progress: [] });
  const viewing = (id: string, state: string) => ({ _id: `v-${id}`, _creationTime: 1, profileId: "p", id, type: "movie", name: id, state, at: 1 });
  const store = () => {
    const s = new SyncStore("test");
    (s as unknown as { reset(t: Tables, c: number): void }).reset({ ...empty(), viewing: [viewing("a", "watching")] as Tables["viewing"] }, 10);
    return s;
  };
  const pull = (changes: { table: "viewing"; id: string; doc: ReturnType<typeof viewing> | null }[], cursor = 20) =>
    ({ reset: false as const, cursor, changes }) as Parameters<SyncStore["apply"]>[0];

  test("pulled rows replace the copy's, and other tables keep their arrays", () => {
    const s = store();
    const before = s.tables()!;
    s.apply(pull([{ table: "viewing", id: "v-a", doc: viewing("a", "completed") }, { table: "viewing", id: "v-b", doc: viewing("b", "hold") }]));
    const after = s.tables()!;
    expect(after.viewing.map((v) => [v.id, v.state])).toEqual([["a", "completed"], ["b", "hold"]]);
    expect(after.tracked).toBe(before.tracked);
    s.apply(pull([{ table: "viewing", id: "v-a", doc: null }]));
    expect(s.tables()!.viewing).toEqual([]);
  });

  test("a change shows until the server has answered it, and is undone if it fails", async () => {
    const s = store();
    let fail!: (e: Error) => void;
    const failing = s.optimistic((t) => ({ viewing: [...t.viewing, viewing("c", "dropped")] }) as Partial<Tables>,
      new Promise((_, reject) => { fail = reject; }));
    expect(s.tables()!.viewing.map((v) => v.id)).toEqual(["a", "c"]);
    fail(new Error("no"));
    await expect(failing).rejects.toThrow("no");
    expect(s.tables()!.viewing.map((v) => v.id)).toEqual(["a"]);

    await s.optimistic((t) => ({ viewing: [...t.viewing, viewing("d", "hold")] }) as Partial<Tables>, Promise.resolve());
    // Answered, but still shown until a pull brings the server's row.
    expect(s.tables()!.viewing.map((v) => v.id)).toEqual(["a", "d"]);
    s.apply(pull([{ table: "viewing", id: "v-d", doc: viewing("d", "hold") }]));
    expect(s.tables()!.viewing.map((v) => v.id)).toEqual(["a", "d"]);
  });

  test("signed out, the store keeps nothing more; reopened (React's dev mode), it carries on", () => {
    const s = store();
    s.close();
    (s as unknown as { reset(t: Tables, c: number): void }).reset(empty(), 50);
    expect(s.cursor).toBe(10);
    s.open();
    (s as unknown as { reset(t: Tables, c: number): void }).reset(empty(), 50);
    expect(s.cursor).toBe(50);
  });

  test("the cursor moves on only once enough has piled up and nothing is on its way", () => {
    const s = store();
    s.apply(pull([{ table: "viewing", id: "v-b", doc: viewing("b", "hold") }]));
    expect(s.advance()).toBe(false);
    const many = Array.from({ length: 120 }, (_, i) => ({ table: "viewing" as const, id: `v-${i}`, doc: viewing(String(i), "hold") }));
    s.apply(pull(many, 99));
    const rows = s.tables()!.viewing;
    expect(s.advance()).toBe(true);
    expect(s.cursor).toBe(99);
    // Folding the pull into the copy changes nothing on screen.
    expect(s.tables()!.viewing).toBe(rows);
  });
});
