// What the Home banner shows and what its Play and Resume buttons start.
import { art, getMeta, nextEpisode } from "../../data/cinemeta";
import { mediaFor, usePlay, type Media } from "../play";
import type { HomeData } from "./useHome";
import { useMaybeCatalogRow } from "../../data/addons";
import type { ProgressRow, RowItem } from "./Home";

// ---------------------------------------------------------------------------------------------
// Hero

export type Slide =
  | { kind: "resume"; key: string; row: ProgressRow }
  | { kind: "title"; key: string; item: RowItem; eyebrow: string };

/** The row the profile chose for the banner (Settings → Home): its name and titles, once they're in. */
export type HeroRow = { title: string; items: RowItem[] };

export function useHeroItems(home: HomeData | undefined, key: string | undefined): HeroRow | undefined {
  const addon = key ? home?.addonRows.find((r) => r.key === key) : undefined;
  const loaded = useMaybeCatalogRow(addon?.base, addon?.catalog);
  if (!key || !home) return undefined;
  if (addon) return loaded ? { title: addon.title, items: loaded } : undefined;
  const row = home.rows.find((r) => r.key === key) ?? home.friends.find((r) => r.key === key);
  return row ? { title: row.title, items: row.items } : undefined;
}

/**
 * What the hero rotates through: where you left off, then the row the profile chose for it, or else its best picks and
 * today's #1.
 */
export function buildSlides(continueRows: ProgressRow[] | undefined, home: HomeData | undefined, hero?: HeroRow): Slide[] | undefined {
  if (continueRows === undefined || home === undefined) return undefined;
  const slides: Slide[] = [];
  const used = new Set<string>();
  const first = continueRows[0];
  if (first) {
    slides.push({ kind: "resume", key: `resume:${first._id}`, row: first });
    used.add(first.media.imdbId);
  }
  if (hero) {
    for (const item of hero.items) {
      if (slides.length >= 5) break;
      if (used.has(item.id) || !(item.background ?? art.background(item.id))) continue;
      used.add(item.id);
      slides.push({ kind: "title", key: `hero:${item.id}`, item, eyebrow: hero.title });
    }
    if (slides.length > (first ? 1 : 0)) return slides;
  }
  const picks = home.rows.find((r) => r.key === "picks");
  for (const item of picks?.items ?? []) {
    if (slides.length >= 4) break;
    if (used.has(item.id) || !(item.background ?? art.background(item.id))) continue;
    used.add(item.id);
    slides.push({
      kind: "title",
      key: `pick:${item.id}`,
      item,
      // Until Krida knows the profile, its picks are just well liked, not chosen for it.
      eyebrow: item.reason?.startsWith("Like ") ? `Because you watched ${item.reason.slice(5)}` : home.coldStart ? "Well liked right now" : "Top pick for you",
    });
  }
  for (const row of home.rows.filter((r) => r.style === "top10")) {
    const item = row.items[0];
    if (!item || used.has(item.id) || slides.length >= 5) continue;
    used.add(item.id);
    slides.push({ kind: "title", key: `top:${item.id}`, item, eyebrow: `#1 ${item.type === "movie" ? "movie" : "show"} on Netflix` });
  }
  return slides;
}

/** What Resume plays: the same spot, or the next episode of a finished one. */
export async function resumeTarget(row: ProgressRow): Promise<{ media: Media; startAt: number }> {
  const media = row.media as Media;
  if (row.finished && media.type === "series") {
    const meta = await getMeta("series", media.imdbId).catch(() => undefined);
    const next = meta && nextEpisode(meta, media.videoId);
    if (meta && next) return { media: mediaFor(meta, next), startAt: 0 };
  }
  return { media, startAt: row.finished ? 0 : row.position };
}

export function useResume() {
  const play = usePlay();
  return async (row: ProgressRow) => {
    const { media, startAt } = await resumeTarget(row);
    return play(media, { startAt });
  };
}

