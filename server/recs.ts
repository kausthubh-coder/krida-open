import { franchise } from "../shared/franchise.js";
import type { Seed as TasteSeed, Taste } from "../shared/taste.js";
import { mapLimit } from "../shared/tmdb.js";
import { languageRow } from "./catalogs.js";
import type { ApiKeys } from "./http.js";
import { featuresFor, type CatalogItem, type RecItem } from "./meta.js";
import { candidatePool, featuresForMany } from "./moreLike.js";
import {
  cultureOf, diversify, fanTrust, FLOOR, formatOf, INDIAN, merge, onePerFranchise, PICKS_FLOOR, qualityFrom, similarity, toRec,
  type Format, type Quality,
} from "./score.js";
import { langsFor, ratingsFor, scoresFrom, similarFor, type SimilarEntry } from "./titles.js";

/**
 * Netflix-style rows from what each person actually watches. Candidates are Krida's own rows (TMDB, Cinemeta, the
 * languages you watch) and the titles of the profile's addon catalogs.
 *
 * Seeds are titles you watched in Krida (weighted by how recently and how much), titles you saved,
 * and your Simkl library (ratings count most; old history ages slowly), worked out in the browser
 * (shared/taste.ts). Every candidate is scored on how strongly your seeds' fans also liked it (TMDB
 * recommendations), how much it resembles your seeds (genres, cast, director, writer), quality
 * (MDBList's score across IMDb, Rotten Tomatoes, Metacritic and Letterboxd) and a little popularity.
 * That is then weighed by fit: the languages you watch in (anime and Indian films are their own
 * worlds), the era you watch from, and the mix of anime, films and shows you watch. Weak titles never
 * make a row. Rows are picked so they don't become ten versions of the same thing. Anything you've
 * watched, dropped or rated low stays out.
 */

const COLLAB_SEEDS = 20;

type Kind = "movie" | "series";
export type Seed = { item: CatalogItem; weight: number; seen: boolean; loved: boolean };
/** A taste with its seeds' features looked up, ready to score against. */
type Resolved = { seeds: Seed[]; exclude: Set<string>; disliked: CatalogItem[]; aliases: Map<string, string>; seenFranchises: Set<string> };
type Similar = Map<string, SimilarEntry[]>;
/** What every row shares: quality, public rating, original language and card scores per title. */
type Facts = {
  quality: Quality;
  rated: (x: CatalogItem) => number | undefined;
  langOf: (x: CatalogItem) => string | undefined;
  scores: (id: string) => RecItem["scores"];
  trailer: (id: string) => string | undefined;
};

export type BuiltRow = {
  kind: "picks" | "because" | "together" | "taste";
  title: string;
  seedId?: string;
  seed?: { id: string; name: string; loved: boolean; type?: Kind; poster?: string };
  genres?: string[];
  langs?: string[];
  items: RecItem[];
};

const yearOf = (x: { year?: string }) => {
  const y = Number.parseInt(x.year ?? "", 10);
  return Number.isFinite(y) ? y : undefined;
};

/** Seeds and turned-down titles with their genres, cast and crew. Simkl's English title beats Kitsu's romaji one. */
async function resolve(taste: Taste): Promise<Resolved> {
  const features = (x: { id: string; type: Kind }) => featuresFor(x.id, x.type).catch(() => null);
  const [items, disliked] = await Promise.all([mapLimit(taste.seeds, 8, features), mapLimit(taste.disliked, 8, features)]);
  const seeds: Seed[] = [];
  taste.seeds.forEach((s: TasteSeed, i) => {
    const item = items[i];
    if (item) seeds.push({ item: { ...item, name: s.name ?? item.name }, weight: s.weight, seen: s.seen, loved: s.loved });
  });
  const seenFranchises = new Set(taste.seenFranchises);
  for (const s of seeds) if (s.seen) seenFranchises.add(franchise(s.item.name));
  return {
    seeds,
    exclude: new Set(taste.exclude),
    disliked: disliked.filter((x): x is CatalogItem => x !== null),
    aliases: new Map(taste.seeds.flatMap((s) => (s.imdb ? [[s.id, s.imdb] as const] : []))),
    seenFranchises,
  };
}

/** How well a title fits a set of seeds by language and era, 0.3–1 (unknown counts as a fair fit). */
function fitFor(seeds: Seed[], langOf: Facts["langOf"]) {
  const cultures = new Map<string, number>();
  const formats = new Map<Format, number>();
  let total = 0;
  for (const s of seeds) {
    const c = cultureOf(s.item, langOf(s.item));
    formats.set(formatOf(s.item, c), (formats.get(formatOf(s.item, c)) ?? 0) + s.weight);
    total += s.weight;
    if (c) cultures.set(c, (cultures.get(c) ?? 0) + s.weight);
  }
  const top = Math.max(1e-9, ...cultures.values());
  const lang = (x: CatalogItem) => {
    const c = cultureOf(x, langOf(x));
    if (!c || cultures.size === 0) return 0.8;
    return 0.3 + 0.7 * Math.min(1, ((cultures.get(c) ?? 0) / top) * 1.5);
  };
  // The year most of what you watch is newer than: much older titles drift down.
  const years = seeds.flatMap((s) => (yearOf(s.item) ? [{ y: yearOf(s.item)!, w: s.weight }] : [])).sort((a, b) => a.y - b.y);
  let acc = 0;
  const half = years.reduce((n, x) => n + x.w, 0) * 0.15;
  const floorYear = years.find((x) => (acc += x.w) >= half)?.y;
  const era = (x: CatalogItem) => {
    const y = yearOf(x);
    if (!y || !floorYear || y >= floorYear - 3) return 1;
    return Math.max(0.4, 1 - (floorYear - 3 - y) * 0.03);
  };
  const share = new Map([...formats.entries()].map(([f, w]) => [f, w / Math.max(1e-9, total)]));
  return { fit: (x: CatalogItem) => lang(x) * era(x), share, cultures: [...cultures.entries()].sort((a, b) => b[1] - a[1]) };
}

/** The languages people watch enough of (Indian cinema as its top three languages) for candidate rows. */
function wantedLanguages(tastes: Resolved[], seedLang: (t: Resolved) => (x: CatalogItem) => string | undefined) {
  const wanted = new Set<string>();
  for (const t of tastes) {
    const { cultures } = fitFor(t.seeds, seedLang(t));
    const total = cultures.reduce((n, [, w]) => n + w, 0);
    for (const [c, w] of cultures) if (w / total >= 0.08 && c !== "en") wanted.add(c);
  }
  const indian = new Map<string, number>();
  for (const t of tastes)
    for (const s of t.seeds) {
      const l = seedLang(t)(s.item);
      if (l && INDIAN.has(l)) indian.set(l, (indian.get(l) ?? 0) + s.weight);
    }
  const indianTop = [...indian.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([l]) => l);
  return [...wanted].flatMap((c) => (c === "indian" ? indianTop : [c]));
}

/**
 * Home's personal rows for one profile, and "For you and…" with each of the others (their tastes come from their own
 * last recompute).
 */
/** Titles from the profile's own addon catalogs, which its browser sends: candidates beside Krida's own rows. */
export type CatalogTitle = { id: string; type: Kind };

export async function computeRows(keys: ApiKeys, mine: Taste, others: { name: string; taste: Taste }[], catalog: CatalogTitle[] = []): Promise<BuiltRow[]> {
  const [me, ...theirs] = await Promise.all([resolve(mine), ...others.map((o) => resolve(o.taste))]);
  const tastes = [me, ...theirs];
  const imdbOf = (id: string, taste: Resolved) => taste.aliases.get(id) ?? id;
  const seedLangs = await langsFor(keys, tastes.flatMap((t) => t.seeds.map((s) => imdbOf(s.item.id, t))), 120);
  const seedLang = (taste: Resolved) => (x: CatalogItem) => x.lang ?? seedLangs.get(imdbOf(x.id, taste));

  // Each language someone watches brings its own well-voted titles.
  const langs = wantedLanguages(tastes, seedLang).slice(0, 6);
  const languageItems = (await Promise.all(langs.flatMap((l) => (["movie", "series"] as const).map((type) => languageRow(keys, l, type).catch(() => []))))).flat();

  const shared = merge(await candidatePool(keys), languageItems);
  // The profile's catalogs, looked up like any title (Cinemeta or Kitsu), so they're scored the same way.
  const base = merge(shared, await featuresForMany(catalog, shared));
  const similars = await Promise.all(tastes.map((t) => similarFor(keys, t.seeds.map((s) => ({ id: imdbOf(s.item.id, t) })).filter((s) => s.id.startsWith("tt")).slice(0, COLLAB_SEEDS))));
  const fans = similars.flatMap((m) => [...m.values()].flat()).filter((x) => (x.vote ?? 10) >= FLOOR);
  const pool = [...base, ...(await featuresForMany(fans, base))];
  const { ratings, trailers } = await ratingsFor(keys, pool, 8);
  const poolLangs = await langsFor(keys, pool.filter((x) => !x.lang).map((x) => x.id), 150);
  const simLang = new Map(similars.flatMap((m) => [...m.values()].flat()).flatMap((x) => (x.lang ? [[x.id, x.lang] as const] : [])));
  const facts: Facts = {
    quality: qualityFrom(ratings),
    rated: (x) => {
      const r = ratings.get(x.id);
      return r?.imdb ?? (r?.score ? r.score / 10 : undefined) ?? x.rating;
    },
    langOf: (x) => x.lang ?? simLang.get(x.id) ?? poolLangs.get(x.id) ?? seedLangs.get(x.id),
    scores: (id) => scoresFrom(ratings.get(id)),
    trailer: (id) => trailers.get(id),
  };
  return buildRows(me, similars[0], pool, others.map((o, i) => ({ name: o.name, taste: theirs[i] })), facts);
}

/** How strongly your seeds' fans point at each title, 0–1, and which seed points hardest. */
function collabScores(seeds: Seed[], similar: Similar, aliases: Map<string, string>, langOf: Facts["langOf"]) {
  const acc = new Map<string, { value: number; best: Seed; bestValue: number }>();
  for (const s of seeds) {
    const lang = langOf(s.item);
    (similar.get(aliases.get(s.item.id) ?? s.item.id) ?? []).forEach((c, rank) => {
      const value = s.weight * (1 - rank / 25) * fanTrust(lang, c);
      const cur = acc.get(c.id);
      if (!cur) acc.set(c.id, { value, best: s, bestValue: value });
      else {
        cur.value += value;
        if (value > cur.bestValue) {
          cur.best = s;
          cur.bestValue = value;
        }
      }
    });
  }
  const max = Math.max(1e-9, ...[...acc.values()].map((a) => a.value));
  return new Map([...acc.entries()].map(([id, a]) => [id, { value: a.value / max, best: a.best }]));
}

function buildRows(taste: Resolved, similar: Similar, pool: CatalogItem[], others: { name: string; taste: Resolved }[], facts: Facts): BuiltRow[] {
  const { seeds, exclude, disliked, aliases, seenFranchises } = taste;
  const { quality, rated, langOf } = facts;
  const rec = (item: CatalogItem, reason?: string) => toRec(item, reason, facts.scores(item.id), facts.trailer(item.id));
  // Close to something you turned down: pushed down the list, not hidden.
  const penalty = (c: CatalogItem) => {
    if (disliked.length === 0) return 0;
    const worst = Math.max(...disliked.map((d) => similarity(d, c)));
    return worst > 0.35 ? 0.3 * worst : 0;
  };
  const above = (floor: number) => (c: CatalogItem) => {
    const r = rated(c);
    return r === undefined || r >= floor;
  };
  const seedIds = new Set(seeds.map((s) => s.item.id));
  const fresh = pool.filter((c) => !seedIds.has(c.id) && !exclude.has(c.id) && above(FLOOR)(c));
  const pops = fresh.map((c) => Math.log1p(c.popularity ?? 0));
  const maxPop = Math.max(1, ...pops);
  const popularity = new Map(fresh.map((c, i) => [c.id, pops[i] / maxPop]));
  const { fit, share, cultures } = fitFor(seeds, langOf);
  const rows: BuiltRow[] = [];

  // Taste: the genres you watch most, for the genre rows on the home screen, and the languages, for candidates.
  const genreWeight = new Map<string, number>();
  for (const s of seeds) for (const g of s.item.genres) genreWeight.set(g, (genreWeight.get(g) ?? 0) + s.weight);
  const tasteGenres = [...genreWeight.entries()].sort((a, b) => b[1] - a[1]).map(([g]) => g).slice(0, 4);
  const cultureTotal = cultures.reduce((n, [, w]) => n + w, 0);
  const indian = new Map<string, number>();
  for (const s of seeds) {
    const l = langOf(s.item);
    if (l && INDIAN.has(l)) indian.set(l, (indian.get(l) ?? 0) + s.weight);
  }
  // Indian cinema is asked for by its languages, the ones you watch most.
  const langs = cultures
    .filter(([, w]) => w / cultureTotal >= 0.08)
    .flatMap(([c]) => (c === "indian" ? [...indian.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([l]) => l) : [c]))
    .slice(0, 5);
  rows.push({ kind: "taste", title: "Taste", genres: tasteGenres, langs, items: [] });

  const affinity = (c: CatalogItem, from: Seed[]) => {
    let total = 0;
    let weight = 0;
    let best: { seed: Seed; value: number } | null = null;
    for (const s of from) {
      const sim = similarity(s.item, c);
      total += s.weight * sim;
      weight += s.weight;
      if (!best || s.weight * sim > best.value) best = { seed: s, value: s.weight * sim };
    }
    return { value: weight ? total / weight : 0, best };
  };

  // Top picks
  if (seeds.length === 0) {
    // Nothing watched yet: the best-rated popular titles.
    const ranked = fresh
      .filter(above(PICKS_FLOOR))
      .map((item) => ({ item, score: 0.6 * quality(item) + 0.4 * (popularity.get(item.id) ?? 0) }))
      .sort((a, b) => b.score - a.score);
    rows.push({ kind: "picks", title: "Top picks to start with", items: diversify(ranked, 24).map((r) => rec(r.item)) });
    return rows;
  }
  const collab = collabScores(seeds, similar, aliases, langOf);
  const maxSeed = Math.max(...seeds.map((s) => s.weight));
  const scored = fresh
    .filter(above(PICKS_FLOOR))
    .map((item) => {
      const a = affinity(item, seeds);
      const c = collab.get(item.id);
      const score =
        (0.4 * (c?.value ?? 0) + 0.3 * Math.min(1, a.value * 2.2) + 0.2 * quality(item) + 0.1 * (popularity.get(item.id) ?? 0)) *
          fit(item) -
        penalty(item);
      return { item, a, c, score };
    })
    .sort((x, y) => y.score - x.score);
  // Anime, films and shows in about the mix you watch them, with room either way.
  const quota = (f: Format) => Math.max(3, Math.ceil(24 * (share.get(f) ?? 0)) + 3);
  const formatCount = (picked: { item: CatalogItem }[], f: Format) =>
    picked.filter((p) => formatOf(p.item, cultureOf(p.item, langOf(p.item))) === f).length;
  // Not more of something you've already watched (recap films, spin-offs): those belong in "Because".
  const picks = diversify(onePerFranchise(scored, new Set(seenFranchises)), 24, 0.75, (x, picked) => {
    const f = formatOf(x.item, cultureOf(x.item, langOf(x.item)));
    return formatCount(picked, f) < quota(f);
  });
  const reasonUses = new Map<string, number>();
  rows.push({
    kind: "picks",
    title: "Top picks for you",
    items: picks.map(({ item, a, c }) => {
      // Name each seed at most twice, so the reasons don't all read the same.
      const named = (seed: Seed) => {
        const uses = reasonUses.get(seed.item.id) ?? 0;
        if (uses >= 2) return false;
        reasonUses.set(seed.item.id, uses + 1);
        return true;
      };
      if (c && c.value > 0.25 && named(c.best)) return rec(item, `Fans of ${c.best.item.name} love it`);
      if (a.best && a.best.value > 0.15 * maxSeed && named(a.best.seed)) return rec(item, `Like ${a.best.seed.item.name}`);
      const shared = a.best ? a.best.seed.item.genres.filter((g) => item.genres.includes(g)).slice(0, 2) : [];
      return rec(item, shared.length ? shared.join(" · ") : undefined);
    }),
  });
  const topPickIds = new Set(picks.slice(0, 8).map((p) => p.item.id));

  // Because you watched: the strongest recent things you actually watched, as long as they lead
  // somewhere different (a show and its movie would give the same row twice). What the seed's fans
  // also liked leads; resemblance fills in, mostly from the seed's own world (a Kannada film's row
  // is Indian cinema, not any action film).
  const becauseRows: Set<string>[] = [];
  const usedFranchises = new Set<string>();
  const strong = seeds.filter((x) => x.seen);
  // Loved titles that carry real weight get a row before plainly watched ones.
  const ordered = [
    ...strong.filter((x) => x.loved && x.weight > 0.35 * maxSeed),
    ...strong.filter((x) => !(x.loved && x.weight > 0.35 * maxSeed)),
  ];
  for (const s of ordered) {
    if (becauseRows.length >= 3) break;
    const key = franchise(s.item.name);
    if (usedFranchises.has(key)) continue;
    const seedLang = langOf(s.item);
    const seedCulture = cultureOf(s.item, seedLang);
    const fans = new Map((similar.get(aliases.get(s.item.id) ?? s.item.id) ?? []).map((f, i) => [f.id, (1 - i / 25) * fanTrust(seedLang, f)]));
    const world = (c: CatalogItem) => {
      const culture = cultureOf(c, langOf(c));
      if (!seedCulture || seedCulture === "en") return culture && culture !== "en" ? 0.85 : 1;
      if (!culture) return 0.6;
      return culture === seedCulture ? 1 : 0.45;
    };
    const ranked = fresh
      .filter((c) => !topPickIds.has(c.id))
      .map((item) => ({ item, sim: similarity(s.item, item), fan: fans.get(item.id) ?? 0 }))
      .filter((r) => r.sim > 0.18 || r.fan > 0.1)
      .map((r) => ({ ...r, score: (0.5 * r.fan + 0.3 * r.sim + 0.2 * quality(r.item)) * world(r.item) * fit(r.item) - penalty(r.item) }))
      .sort((a, b) => b.score - a.score);
    const items = diversify(onePerFranchise(ranked), 20, 0.85).map((r) => rec(r.item));
    if (items.length < 6) continue;
    const ids = new Set(items.map((i) => i.id));
    const repeats = becauseRows.some((prev) => items.filter((i) => prev.has(i.id)).length > items.length * 0.4);
    if (repeats) continue;
    becauseRows.push(ids);
    usedFranchises.add(key);
    rows.push({
      kind: "because",
      title: `${s.loved ? "Because you loved" : "Because you watched"} ${s.item.name}`,
      seedId: s.item.id,
      seed: { id: s.item.id, name: s.item.name, loved: s.loved, type: s.item.type, poster: s.item.poster },
      items,
    });
  }

  // For you two: where both people's taste agrees, and neither has seen it.
  for (const other of others) {
    if (other.taste.seeds.length === 0) continue;
    const theirFit = fitFor(other.taste.seeds, langOf).fit;
    const ranked = fresh
      .filter((c) => !other.taste.exclude.has(c.id) && above(PICKS_FLOOR)(c))
      .map((item) => {
        const mine = affinity(item, seeds);
        const theirs = affinity(item, other.taste.seeds);
        const both = Math.sqrt(fit(item) * theirFit(item));
        return { item, mine, theirs, score: (0.75 * Math.sqrt(mine.value * theirs.value) * 2.2 + 0.25 * quality(item)) * both };
      })
      .sort((a, b) => b.score - a.score);
    const items = diversify(onePerFranchise(ranked), 20).map((r) =>
      rec(r.item, togetherReason(other.name, r.mine.best?.value ? r.mine.best.seed : undefined, r.theirs.best?.value ? r.theirs.best.seed : undefined)),
    );
    if (items.length >= 6) rows.push({ kind: "together", title: `For you and ${other.name}`, items });
  }
  return rows;
}

/** Why a title suits you both: the titles of each person's it most resembles. */
export function togetherReason(friend: string, mine?: Seed, theirs?: Seed) {
  if (mine && theirs && mine.item.id === theirs.item.id) {
    const both = mine.loved && theirs.loved ? " you both loved" : mine.seen && theirs.seen ? " you both watched" : "";
    return both ? `Like ${mine.item.name}, which${both}` : `Like ${mine.item.name}`;
  }
  if (mine && theirs) return `Like ${mine.item.name} and ${friend}’s ${theirs.item.name}`;
  if (mine) return `Like ${mine.item.name}`;
  if (theirs) return `Like ${friend}’s ${theirs.item.name}`;
  return undefined;
}
