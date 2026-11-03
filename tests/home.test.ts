/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { api } from "../convex/_generated/api";
import schema from "../convex/schema";
import { household } from "./household";
import { sha256 } from "../convex/lib/auth";
import { togetherReason, type Seed } from "../server/recs";
import { cultureOf } from "../server/score";
import type { CatalogItem } from "../server/meta";
import type { ShownRow } from "../server/catalogs";
import { orderRows, rowTitle, updatedLabel } from "../src/features/home/homeRows";
import { homeRows } from "../src/features/home/useHome";

vi.mock("../src/data/sync", () => ({ useTables: vi.fn() }));

const modules = import.meta.glob(["../convex/**/*.ts", "../convex/**/*.js", "!../convex/**/*.d.ts"]);
const token = "home-session";
const now = Date.parse("2026-10-07T20:00:00Z");
const item = (id: string, name = id): CatalogItem => ({
  id, type: "movie", name, genres: ["Drama"], cast: [], director: [], writer: [],
});
const items = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `tt000000${i}`, type: "movie" as const, name: `Title ${i}`, genres: ["Drama"] }));
const prefs = { audioLang: "en", sounds: false };
const taste = { seeds: [{ id: "tt1", type: "movie" as const, weight: 1, seen: true, loved: true }], exclude: ["tt1"], disliked: [], seenFranchises: [] };

async function fixture() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const accountId = await household(ctx);
    const me = await ctx.db.insert("profiles", {
      name: "Maya", hue: 60, passwordHash: "unused", salt: "unused", order: 0, failedAttempts: 0, prefs, accountId,
    });
    const friend = await ctx.db.insert("profiles", {
      name: "Ravi", hue: 205, passwordHash: "unused", salt: "unused", order: 1, failedAttempts: 0, prefs, accountId,
    });
    await ctx.db.insert("sessions", { profileId: me, tokenHash: await sha256(token), createdAt: now });
    await ctx.db.insert("sessions", { profileId: friend, tokenHash: await sha256("friend"), createdAt: now });
    return { me, friend };
  });
  return { t, ...ids };
}

const rows = [
  { kind: "taste" as const, title: "Taste", genres: ["Drama", "Comedy"], items: [] },
  { kind: "picks" as const, title: "Top picks for you", items: items(6) },
  { kind: "because" as const, title: "Because you loved Dune: Part Two", seedId: "tt15239678", items: items(6),
    seed: { id: "tt15239678", name: "Dune: Part Two", loved: true, type: "movie" as const, poster: "https://example.com/dune.jpg" } },
  { kind: "because" as const, title: "Because you watched Frieren", seedId: "kitsu:46474", items: items(6),
    seed: { id: "kitsu:46474", name: "Frieren", loved: false } },
  { kind: "together" as const, title: "For you and Ravi", items: items(6) },
];

describe("personal rows", () => {
  test("rows say why they exist, with optional fields only where they apply", async () => {
    const { t } = await fixture();
    await t.mutation(api.recs.save, { token, rows, taste, digest: "a" });
    const personal = await t.query(api.recs.rows, { token });
    const row = (key: string) => personal.rows.find((r) => r.key === key)!;

    expect(row("picks").subtitle).toBe("From what you watch and rate");
    expect(row("together")).toMatchObject({
      subtitle: "From what you both watch and rate",
      people: [{ name: "Maya", hue: 60 }, { name: "Ravi", hue: 205 }],
    });
    expect(row("because:2").seed).toEqual(rows[2].seed);
    expect(row("because:3").seed).toEqual({ id: "kitsu:46474", name: "Frieren", loved: false });
    expect(row("picks").seed).toBeUndefined();
    expect(personal).toMatchObject({ taste: ["Drama", "Comedy"], digest: "a", coldStart: false });
  });

  test("saving the same rows again rewrites nothing but when they were worked out", async () => {
    const { t, me } = await fixture();
    await t.mutation(api.recs.save, { token, rows, taste, digest: "a" });
    const ids = async () => (await t.run(async (ctx) => await ctx.db.query("recs").collect())).filter((r) => r.profileId === me).map((r) => r._id);
    const before = await ids();
    await t.mutation(api.recs.save, { token, rows: rows.map((r) => ({ ...r })), taste, digest: "b" });
    expect(await ids()).toEqual(before);
    expect((await t.query(api.recs.rows, { token })).digest).toBe("b");
    await t.mutation(api.recs.save, { token, rows: rows.slice(0, 2), taste, digest: "c" });
    expect(await ids()).toHaveLength(2);
  });

  test("each profile's taste is there for the others' For you and… rows, never its own", async () => {
    const { t } = await fixture();
    expect(await t.query(api.recs.others, { token })).toEqual([]);
    const before = (await t.query(api.recs.rows, { token })).others;
    await t.mutation(api.recs.save, { token: "friend", rows: [rows[0]], taste, digest: "f" });
    expect(await t.query(api.recs.others, { token })).toEqual([{ name: "Ravi", taste }]);
    expect(await t.query(api.recs.others, { token: "friend" })).toEqual([]);
    // Their taste changing is how this profile knows to work out "For you and Ravi" again.
    const after = (await t.query(api.recs.rows, { token })).others;
    expect(after).not.toBe(before);
    expect(after).toContain(":f");
  });

  test("a profile with nothing to go on is invited to make Krida its own", async () => {
    const { t } = await fixture();
    expect(await t.query(api.recs.rows, { token })).toMatchObject({ rows: [], taste: null, coldStart: true, computedAt: 0 });
  });
});

describe("home rows", () => {
  const catalog = (key: string, title: string, source: string, style: ShownRow["style"] = "poster"): ShownRow =>
    ({ key, title, source, style, updatedAt: now - 3_600_000, items: items(10) });

  test("picks, Simkl rows, Krida's own catalogs and the genres you watch, in that order", () => {
    const personal = { rows: [{ key: "picks", title: "Top picks for you", style: "poster" as const, items: items(6) }],
      taste: ["Comedy"], hidden: [], order: [], coldStart: false, computedAt: now, digest: "a", others: "", othersDigest: "" };
    const simkl = [{ key: "simkl:watching", title: "Still watching", style: "poster" as const, items: items(2) }];
    const shown = [
      catalog("cinemeta:top:movie", "Popular movies", "cinemeta"),
      catalog("cinemeta:genre:series:Comedy", "Top-rated comedy shows", "genre"),
      catalog("tmdb:trending:movie", "Trending movies this week", "tmdb"),
      catalog("netflix:top10:series", "Top 10 shows on Netflix", "netflix", "top10"),
    ];
    const { rows: out, empty } = homeRows(personal, simkl, shown);
    // Cinemeta's popular rows are Cinemeta's catalogs: they show when the profile installs it.
    expect(out.map((r) => r.key)).toEqual(["picks", "simkl:watching", "tmdb:trending:movie", "netflix:top10:series", "genre:0"]);
    expect(out.find((r) => r.key === "genre:0")).toMatchObject({ title: "Top-rated comedy shows", subtitle: "One of the genres you watch most" });
    expect(out.find((r) => r.key === "netflix:top10:series")).toMatchObject({ style: "top10", updatedAt: now - 3_600_000 });
    expect(empty).toBe(false);
    expect(homeRows({ ...personal, taste: null }, [], []).empty).toBe(true);
  });
});

describe("a profile's row order", () => {
  const rows = (...keys: string[]) => keys.map((key) => ({ key }));
  const keys = (r: { key: string }[]) => r.map((x) => x.key);
  const mixed = rows("genre:0", "addon:cinemeta:movie:top", "picks", "addon:cinemeta:series:top", "netflix:top10:series", "continue", "addon:kitsu:anime:trending", "mylist", "because:3", "because:5");

  test("by default, addon catalogs take the places between Krida's own rows, in addon order", () => {
    expect(keys(orderRows(mixed, { order: [], hidden: [] }))).toEqual([
      "continue", "picks", "netflix:top10:series", "addon:cinemeta:movie:top", "because:3", "addon:cinemeta:series:top",
      "addon:kitsu:anime:trending", "because:5", "genre:0", "mylist",
    ]);
  });

  test("pinned rows lead, then the profile's own order; hidden rows go", () => {
    const out = orderRows(mixed, { order: ["mylist", "addon:kitsu:anime:trending"], hidden: ["genre:0", "because:5"], pinned: ["addon:cinemeta:series:top"] });
    expect(keys(out)).toEqual([
      "addon:cinemeta:series:top", "mylist", "addon:kitsu:anime:trending", "continue", "picks", "netflix:top10:series", "addon:cinemeta:movie:top", "because:3",
    ]);
  });

  test("forty catalogs all get a place", () => {
    const many = rows(...Array.from({ length: 40 }, (_, i) => `addon:big:movie:c${i}`), "continue");
    const out = keys(orderRows(many, { order: [], hidden: [] }));
    expect(out[0]).toBe("continue");
    expect(out.slice(1)).toEqual(Array.from({ length: 40 }, (_, i) => `addon:big:movie:c${i}`));
  });

  test("a row's name: the profile's own, with an addon catalog's kind unless it's turned off", () => {
    const row = { key: "addon:cinemeta:movie:top", title: "Popular", type: "movie" };
    expect(rowTitle(row)).toBe("Popular · Movies");
    expect(rowTitle(row, [{ key: row.key, name: "Big films" }])).toBe("Big films · Movies");
    expect(rowTitle(row, [], [row.key])).toBe("Popular");
    expect(rowTitle({ ...row, type: "anime" })).toBe("Popular · Anime");
    expect(rowTitle({ key: "mylist", title: "Plan to watch" }, [{ key: "mylist", name: "Later" }])).toBe("Later");
  });
});

describe("taste worlds", () => {
  test("anime and Indian cinema are their own worlds; other titles go by language", () => {
    expect(cultureOf({ id: "kitsu:1", genres: [] }, undefined)).toBe("anime");
    expect(cultureOf({ id: "tt1", genres: ["Animation"] }, "ja")).toBe("anime");
    expect(cultureOf({ id: "tt1", genres: ["Drama"] }, "ja")).toBe("ja");
    expect(cultureOf({ id: "tt1", genres: ["Drama"] }, "te")).toBe("indian");
    expect(cultureOf({ id: "tt1", genres: ["Drama"] }, "ml")).toBe("indian");
    expect(cultureOf({ id: "tt1", genres: ["Drama"] }, "en")).toBe("en");
    expect(cultureOf({ id: "tt1", genres: ["Drama"] }, undefined)).toBeUndefined();
  });
});

describe("reasons", () => {
  const seed = (id: string, name: string, extra: Partial<Seed> = {}): Seed => ({ item: item(id, name), weight: 1, seen: true, loved: false, ...extra });

  test("together picks name what each of you liked", () => {
    const arcane = seed("tt1", "Arcane", { loved: true });
    expect(togetherReason("Ravi", arcane, { ...arcane })).toBe("Like Arcane, which you both loved");
    expect(togetherReason("Ravi", seed("tt1", "Arcane"), seed("tt1", "Arcane"))).toBe("Like Arcane, which you both watched");
    expect(togetherReason("Ravi", seed("tt1", "Dune"), seed("tt2", "Arcane"))).toBe("Like Dune and Ravi’s Arcane");
    expect(togetherReason("Ravi", undefined, seed("tt2", "Arcane"))).toBe("Like Ravi’s Arcane");
    expect(togetherReason("Ravi")).toBeUndefined();
  });

  test("catalog freshness reads in hours, then days", () => {
    expect(updatedLabel(now - 20 * 60_000, now)).toBe("Updated in the last hour");
    expect(updatedLabel(now - 3 * 3_600_000, now)).toBe("Updated 3 h ago");
    expect(updatedLabel(now - 30 * 3_600_000, now)).toBe("Updated yesterday");
    expect(updatedLabel(now - 80 * 3_600_000, now)).toBe("Updated 3 days ago");
  });
});
