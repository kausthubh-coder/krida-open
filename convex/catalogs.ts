import { v } from "convex/values";
import { housemates } from "./lib/accounts";
import { query, type QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { mutation } from "./functions";
import { publicProfile, requireProfile } from "./lib/auth";
import type { recItemValidator } from "./schema";

/*
 * Home's "<friend> has been watching" rows. Catalog rows come from /api/rows (server/catalogs.ts), and this profile's
 * picks from recs.rows.
 *
 * `rows`, `mine`, `home` and `warmup` (and the catalogCache, catalogRows and metaCache tables they read) are for tabs
 * still on the build from before /api: they stay until those have reloaded, then go.
 */

type RecItem = typeof recItemValidator.type;
type CatalogItem = Doc<"catalogCache">["items"][number];

const isTop10 = (title: string) => /top ?10/i.test(title);

/** What a row on Home needs of a title. Only a Top 10's titles can lead the hero, so only they keep a synopsis. */
function slim(c: { title: string; items: CatalogItem[] }): RecItem[] {
  const top10 = isTop10(c.title);
  return c.items.slice(0, top10 ? 10 : 24).map(({ id, type, name, poster, background, logo, year, description, rating, ratingSource, genres }) => ({
    id, type, name, poster, year, rating, ratingSource, genres: genres.slice(0, 3),
    ...(top10 ? { background, logo, description } : {}),
  }));
}

// ---------------------------------------------------------------------------------------------
// The home screen

/** Friendlier names for well-known catalogs; anything else keeps the name AIOStreams gives it. */
function rowTitle(c: { key: string; title: string; type: "movie" | "series"; source: string }, all: { title: string; source: string }[]) {
  const kind = c.type === "movie" ? "movies" : "shows";
  if (/netflix-top10/.test(c.key)) return `Top 10 ${kind} on Netflix`;
  if (/anilist_trending/.test(c.key)) return "Trending anime";
  if (/anilist_popular-this-season/.test(c.key)) return "This season’s anime";
  if (/anilist_all-time/.test(c.key)) return "All-time favourite anime";
  if (/\.nfx:/.test(c.key)) return `Popular ${kind} on Netflix`;
  if (/\.dnp:/.test(c.key)) return `Popular ${kind} on Disney+`;
  const both = all.filter((o) => o.source === c.source && o.title === c.title).length > 1;
  return both ? `${c.title} · ${kind}` : c.title;
}

export type Row = {
  key: string;
  title: string;
  style: "poster" | "top10";
  /** Why the row is here, in one quiet line under the title's baseline. */
  subtitle?: string;
  /** When a catalog row was last fetched; the client says "Updated 3 h ago" (queries can't read the clock). */
  updatedAt?: number;
  /** "Because you watched" rows: the title they grow from, shown as the row's first tile. */
  seed?: { id: string; name: string; loved: boolean; type?: "movie" | "series"; poster?: string };
  /** "For you and…" rows: both people, so the row can show whose taste it joins. */
  people?: ReturnType<typeof publicProfile>[];
  items: RecItem[];
};

type Shown = { key: string; title: string; type: "movie" | "series"; source: string; items: RecItem[]; fetchedAt: number };

/**
 * Catalog and recommendation rows for Home. It reads only slim rows and this profile's picks, so it
 * runs again when those change (a refresh, a recompute), never on playback ticks.
 */
async function catalogRowsFor(ctx: QueryCtx, me: Doc<"profiles">) {
  const recs = await ctx.db
    .query("recs")
    .withIndex("by_profile", (q) => q.eq("profileId", me._id))
    .collect();
  const learned = recs.find((r) => r.kind === "taste")?.genres;
  const taste = learned ?? ["Drama", "Comedy", "Action"];
  const sourced = async (source: string) => await ctx.db.query("catalogRows").withIndex("by_source", (q) => q.eq("source", source)).collect();
  let lookup = async (key: string): Promise<Shown | null> =>
    await ctx.db.query("catalogRows").withIndex("by_key", (q) => q.eq("key", key)).first();
  let shown: Shown[] = [...(await sourced("aio")), ...(await sourced("anime")), ...(await sourced("tmdb"))];
  // Before the first refresh that writes slim rows (a fresh deploy): the full rows, slimmed here.
  if (shown.length === 0 && !(await ctx.db.query("catalogRows").first())) {
    const full = (await ctx.db.query("catalogCache").collect()).map((c) => ({ ...c, items: slim(c) }));
    shown = full.filter((c) => c.source === "aio" || c.source === "anime" || c.source === "tmdb");
    lookup = async (key) => full.find((c) => c.key === key) ?? null;
  }
  const profiles = await housemates(ctx, me);

  const rows: Row[] = [];
  for (const r of recs.filter((r) => r.kind !== "taste").sort((a, b) => a.order - b.order)) {
    if (r.items.length < 4) continue;
    // The first "For you and…" keeps the plain key (saved row orders use it); any more get their own.
    const key =
      r.kind === "because" || (r.kind === "together" && rows.some((x) => x.key === "together"))
        ? `${r.kind}:${r.order}`
        : r.kind;
    const row: Row = { key, title: r.title, style: "poster", items: r.items };
    if (r.kind === "picks")
      row.subtitle = r.title === "Top picks for you" ? "From what you watch and rate" : "Well rated and popular right now";
    if (r.kind === "together") {
      // Rows only carry the friend's name, in their title.
      const friend = profiles.find((p) => p._id !== me._id && r.title === `For you and ${p.name}`);
      if (friend) row.people = [publicProfile(me), publicProfile(friend)];
      row.subtitle = "From what you both watch and rate";
    }
    const because = r.kind === "because" ? /^Because you (loved|watched) (.+)$/.exec(r.title) : null;
    if (because && r.seedId) {
      const seedId = r.seedId;
      const meta = await ctx.db
        .query("metaCache")
        .withIndex("by_item_id", (q) => q.eq("item.id", seedId))
        .first();
      row.seed = { id: seedId, name: because[2], loved: because[1] === "loved", type: meta?.item.type, poster: meta?.item.poster };
    }
    rows.push(row);
  }
  const recRows = rows.length;

  for (const c of shown)
    rows.push({
      key: c.key,
      title: rowTitle(c, shown),
      style: isTop10(c.title) ? "top10" : "poster",
      updatedAt: c.fetchedAt,
      items: c.items,
    });
  // Genre rows follow taste: the genres this person watches most, alternating movies and shows.
  for (const [i, genre] of taste.slice(0, 3).entries()) {
    const type = i % 2 === 0 ? "series" : "movie";
    const c = (await lookup(`cinemeta:genre:${type}:${genre}`)) ?? (await lookup(`cinemeta:genre:movie:${genre}`));
    if (c)
      rows.push({
        key: `genre:${i}`,
        title: c.title,
        // Only a claim about taste when it was learned, not the default genres.
        subtitle: learned ? "One of the genres you watch most" : undefined,
        style: "poster",
        items: c.items,
      });
  }
  let popular = false;
  for (const type of ["movie", "series"] as const) {
    const c = await lookup(`cinemeta:top:${type}`);
    if (c) rows.push({ key: `popular:${type}`, title: c.title, style: "poster", updatedAt: c.fetchedAt, items: c.items });
    popular ||= !!c;
  }

  // Nothing to go on yet (no history, ratings or Simkl): Home invites this profile to change that. The
  // connection is read only then: Simkl sends write to it, and that shouldn't re-run Home.
  const personal = recs.some((r) => r.kind === "picks" && r.title === "Top picks for you");
  const simkl = personal ? null : await ctx.db
    .query("connections")
    .withIndex("by_profile", (q) => q.eq("profileId", me._id).eq("provider", "simkl"))
    .first();
  return {
    rows,
    // Simkl rows (`mine`) go after this many rows, where they sat when Home was one query.
    recRows,
    hidden: me.prefs.hiddenRows ?? [],
    order: me.prefs.rowOrder ?? [],
    empty: shown.length === 0 && !popular,
    coldStart: !personal && !simkl,
  };
}

/** From Simkl: shows you're partway through elsewhere, and your plan-to-watch list. */
async function simklRowsFor(ctx: QueryCtx, me: Doc<"profiles">) {
  const tracked = async (status: "watching" | "plantowatch") =>
    await ctx.db
      .query("tracked")
      .withIndex("by_status", (q) => q.eq("profileId", me._id).eq("status", status))
      .take(300);
  const trackedItem = (t: Doc<"tracked">, reason?: string) => ({
    id: t.id,
    type: t.type,
    name: t.name,
    // IMDb titles use the same artwork as every other row; anime brings Simkl's.
    poster: t.id.startsWith("tt") ? undefined : t.poster,
    year: t.year,
    genres: [] as string[],
    reason,
  });
  const started = new Set<string>();
  for (const p of await ctx.db
    .query("progress")
    .withIndex("by_profile_updated", (q) => q.eq("profileId", me._id))
    .order("desc")
    .take(200))
    started.add(p.media.imdbId);
  // A status set here (watched, on hold, dropped…) moves the show out now, not after the Simkl round trip.
  const movedOn = new Set((await ctx.db.query("viewing").withIndex("by_profile", (q) => q.eq("profileId", me._id)).collect())
    .filter((v) => v.state !== "watching" && v.state !== "rewatching").map((v) => v.id));
  const rows: Row[] = [];
  const watching = (await tracked("watching"))
    // Played or moved on under the anime's IMDb id counts too (lib/titleIds).
    .filter((t) => ![t.id, t.imdb].some((id) => id && (started.has(id) || movedOn.has(id))) && t.type === "series")
    .sort((a, b) => (b.lastWatchedAt ?? 0) - (a.lastWatchedAt ?? 0))
    .slice(0, 24);
  if (watching.length >= 2)
    rows.push({
      key: "simkl:watching",
      title: "Still watching",
      subtitle: "Partway through on Simkl",
      style: "poster",
      items: watching.map((t) =>
        trackedItem(t, t.watchedEpisodes && t.totalEpisodes ? `${t.watchedEpisodes} of ${t.totalEpisodes} episodes` : t.year),
      ),
    });
  const planned = (await tracked("plantowatch"))
    .filter((t) => !started.has(t.id))
    .sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0))
    .slice(0, 24);
  if (planned.length >= 2)
    rows.push({ key: "simkl:planned", title: "On your Simkl watchlist", style: "poster", items: planned.map((t) => trackedItem(t)) });
  return rows;
}

/** What the others have been watching lately. */
async function friendRowsFor(ctx: QueryCtx, me: Doc<"profiles">) {
  const friends = [];
  for (const other of await housemates(ctx, me)) {
    const progress = await ctx.db
      .query("progress")
      .withIndex("by_profile_updated", (q) => q.eq("profileId", other._id))
      .order("desc")
      .take(60);
    const seen = new Set<string>();
    const items = [];
    for (const p of progress) {
      if (p.private || seen.has(p.media.imdbId)) continue;
      seen.add(p.media.imdbId);
      items.push({
        id: p.media.imdbId,
        type: p.media.type,
        name: p.media.name,
        poster: p.media.poster,
        background: p.media.background,
        logo: p.media.logo,
        year: p.media.year,
        genres: [] as string[],
        reason: p.finished ? "Finished" : p.media.season !== undefined ? `On S${p.media.season} E${p.media.episode}` : "Watching",
      });
    }
    if (items.length) friends.push({ key: `friend:${other._id}`, title: `${other.name} has been watching`, style: "poster" as const, items: items.slice(0, 20), profile: publicProfile(other) });
  }
  return friends;
}

/** Home's catalog and recommendation rows (`mine` and `friends` hold the live ones). */
export const rows = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => await catalogRowsFor(ctx, await requireProfile(ctx, token)),
});

/** Home's rows from this profile's Simkl library. */
export const mine = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => await simklRowsFor(ctx, await requireProfile(ctx, token)),
});

/** Home's "<friend> has been watching" rows. */
export const friends = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => await friendRowsFor(ctx, await requireProfile(ctx, token)),
});

/** Every Home row in one answer, for tabs still running the version from before Home was split. */
export const home = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const me = await requireProfile(ctx, token);
    const { recRows, rows, ...rest } = await catalogRowsFor(ctx, me);
    return {
      ...rest,
      rows: [...rows.slice(0, recRows), ...(await simklRowsFor(ctx, me)), ...rows.slice(recRows)],
      friends: await friendRowsFor(ctx, me),
    };
  },
});

/** For tabs on an older build, which call it when they find no rows: catalogs now come from /api/rows. */
export const warmup = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    await requireProfile(ctx, token);
  },
});
