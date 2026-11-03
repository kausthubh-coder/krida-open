import { franchise } from "../shared/franchise.js";
import type { Ratings } from "../shared/mdblist.js";
import type { CatalogItem, RecItem } from "./meta.js";
import type { SimilarEntry } from "./titles.js";

/*
 * The recommender's measures, shared by every row: how alike two titles are, what world a title belongs to, how good
 * it is, and picking a row that isn't ten versions of one thing.
 */

// Public ratings (IMDb scale) below which a title never makes a row, and the bar for Top picks.
export const FLOOR = 6.0;
export const PICKS_FLOOR = 6.5;

export type Quality = (x: CatalogItem) => number;
export type Format = "anime" | "movie" | "series";

const jaccard = (a: string[], b: string[]) => {
  if (!a.length || !b.length) return 0;
  const sa = new Set(a);
  const inter = b.filter((x) => sa.has(x)).length;
  return inter / (a.length + b.length - inter);
};
const overlap = (a: string[], b: string[]) => {
  if (!a.length || !b.length) return 0;
  const sa = new Set(a);
  return Math.min(1, b.filter((x) => sa.has(x)).length / 2);
};
export const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** One title per franchise, so a row isn't three recap films of the same show. */
export function onePerFranchise<T extends { item: CatalogItem }>(ranked: T[], taken = new Set<string>()) {
  return ranked.filter((r) => {
    const key = franchise(r.item.name);
    if (!key || taken.has(key)) return false;
    taken.add(key);
    return true;
  });
}

/** How alike two titles are, 0–1. Animation vs live action matters more than any one genre. */
export function similarity(a: CatalogItem, b: CatalogItem) {
  const animated = (x: CatalogItem) => x.genres.includes("Animation") || x.id.startsWith("kitsu:");
  const sameKind = animated(a) === animated(b) ? 1 : 0.4;
  const score =
    0.5 * jaccard(a.genres, b.genres) +
    0.25 * overlap(a.cast, b.cast) +
    0.15 * overlap(a.director, b.director) +
    0.1 * overlap(a.writer, b.writer);
  return score * sameKind;
}

export const INDIAN = new Set(["te", "ta", "ml", "kn", "hi", "mr", "bn", "pa"]);

/**
 * The world a title belongs to for taste: anime, Indian cinema (people who watch Telugu films watch
 * Tamil and Malayalam ones too, often dubbed), or its original language.
 */
export function cultureOf(x: { id: string; genres: string[] }, lang: string | undefined) {
  if (x.id.startsWith("kitsu:") || (lang === "ja" && x.genres.includes("Animation"))) return "anime";
  if (lang && INDIAN.has(lang)) return "indian";
  return lang || undefined;
}

export const formatOf = (x: CatalogItem, culture: string | undefined): Format => (culture === "anime" ? "anime" : x.type);

/** 0–1 from MDBList's overall score when we have it, else the catalog's IMDb rating. */
export function qualityFrom(ratings: Map<string, Ratings>): Quality {
  return (x) => {
    const score = ratings.get(x.id)?.score;
    if (score) return clamp01((score - 50) / 40);
    return x.rating ? clamp01((x.rating - 5) / 4) : 0.45;
  };
}

export function toRec(item: CatalogItem, reason?: string, scores?: RecItem["scores"], trailer?: string): RecItem {
  const { id, type, name, poster, background, logo, year, description, rating, ratingSource, genres } = item;
  return { id, type, name, poster, background, logo, year, description, rating, ratingSource, genres, reason, scores, trailer };
}

/**
 * Greedy pick that trades a little score for variety (maximal marginal relevance). `allowed` can
 * refuse a candidate given what's been picked so far (a quota per format).
 */
export function diversify<T extends { item: CatalogItem; score: number }>(ranked: T[], count: number, lambda = 0.75, allowed?: (x: T, picked: T[]) => boolean) {
  const picked: T[] = [];
  const pool = [...ranked];
  while (picked.length < count && pool.length) {
    let best = -1;
    let bestValue = -Infinity;
    for (let i = 0; i < Math.min(pool.length, 120); i++) {
      if (allowed && !allowed(pool[i], picked)) continue;
      const redundancy = picked.length ? Math.max(...picked.map((p) => jaccard(p.item.genres, pool[i].item.genres))) : 0;
      const value = lambda * pool[i].score - (1 - lambda) * redundancy;
      if (value > bestValue) {
        bestValue = value;
        best = i;
      }
    }
    if (best < 0) break;
    picked.push(pool.splice(best, 1)[0]);
  }
  return picked;
}

/**
 * How much to trust one of TMDB's "fans also liked" for a seed. For a regional film TMDB's audience
 * is thin, and its list drifts to unrelated foreign titles; those barely count.
 */
export function fanTrust(seedLang: string | undefined, c: SimilarEntry) {
  let trust = c.vote !== undefined && c.vote < FLOOR ? 0.4 : 1;
  if (seedLang && seedLang !== "en" && c.lang && c.lang !== seedLang && !(INDIAN.has(seedLang) && INDIAN.has(c.lang))) trust *= 0.25;
  return trust;
}

/** Titles from several sources, once each, keeping the copy that knows its cast and crew. */
export function merge(...lists: CatalogItem[][]) {
  const byId = new Map<string, CatalogItem>();
  for (const list of lists)
    for (const item of list) {
      const current = byId.get(item.id);
      if (!current || (current.cast.length === 0 && item.cast.length > 0)) byId.set(item.id, { ...item, lang: item.lang ?? current?.lang });
    }
  return [...byId.values()];
}
