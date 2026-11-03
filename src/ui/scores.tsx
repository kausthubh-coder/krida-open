import type { ReactNode } from "react";
import { cx } from "./ui";
import { publicScores } from "./scoreValues";

export type Scores = { imdb?: number; tomatoes?: number; metacritic?: number; letterboxd?: number; mal?: number };
/** What a card knows about a title's public reception: MDBList's scores, else the catalog's own rating. */
export type ScoreSource = { scores?: Scores; rating?: number; ratingSource?: "tmdb"; anime?: boolean };
export type CardScore = { key: string; label: string; short: string; value: string };

const SHORT: Record<string, string> = { imdb: "IMDb", mal: "MAL", tomatoes: "RT", metacritic: "MC", letterboxd: "LB", tmdb: "TMDB" };

/**
 * A card's public scores: the title page's order and formats (see `publicScores`) with short labels,
 * critics only, and TMDB only when nothing else is known.
 */
export function cardScores({ scores = {}, rating, ratingSource, anime }: ScoreSource): CardScore[] {
  const tmdb = ratingSource === "tmdb" ? rating : undefined;
  const list = publicScores({ ...scores, tmdb }, { imdb: scores.imdb ?? (ratingSource !== "tmdb" ? rating : undefined), anime })
    .filter((s) => s.source in SHORT);
  const known = list.some((s) => s.source !== "tmdb") ? list.filter((s) => s.source !== "tmdb") : list;
  return known.map((s) => ({ key: s.source, label: s.label, short: SHORT[s.source], value: s.value }));
}

/**
 * A card's scores, stacked in its corner over the artwork. Labelled by source so they never read as
 * your own score, which is on the rate button.
 */
export function ScoreStack({ source, max = 3, className }: { source: ScoreSource; max?: number; className?: string }) {
  const list = cardScores(source).slice(0, max);
  if (!list.length) return null;
  return (
    <ul className={cx("flex flex-col items-start gap-1", className)} aria-label="Ratings">
      {list.map((s) => (
        <li
          key={s.key}
          title={`${s.label} ${s.value}`}
          className="inline-flex items-baseline gap-1 rounded-full bg-black/70 px-2 py-0.5 text-caption leading-4"
        >
          <span className="text-fg-muted">{s.short}</span>
          <span className="font-semibold text-fg tabular-nums">{s.value}</span>
        </li>
      ))}
    </ul>
  );
}

type CardItem = { id: string; year?: string; genres: string[]; reason?: string } & Omit<ScoreSource, "anime">;

/** A title's scores, with anime known by its Kitsu id or its genre (MyAnimeList leads for it). */
export const scoreSource = (item: CardItem): ScoreSource => ({ ...item, anime: item.id.startsWith("kitsu:") || item.genres.includes("Animation") });

/** A card's line under its title: why it's here, else its best-known score, else its year. */
export function itemMeta(item: CardItem): ReactNode {
  if (item.reason) return item.reason;
  const best = cardScores(scoreSource(item))[0];
  if (!best) return item.year;
  return (
    <span className="text-fg-muted" title={`${best.label} ${best.value}`}>
      {best.short} <span className="font-medium tabular-nums">{best.value}</span>
    </span>
  );
}
