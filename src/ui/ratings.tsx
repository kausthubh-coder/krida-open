import { PopcornIcon } from "@phosphor-icons/react";
import type { PublicScore, ScoreSource } from "./scoreValues";
import { cx } from "./ui";

/** A source's wordmark as a small knocked-out tag, the shape people know from IMDb and TMDB. */
function Wordmark({ children }: { children: string }) {
  return (
    <span className="rounded-[3px] bg-fg-muted px-[3px] text-[10px] leading-[14px] font-extrabold tracking-[-0.02em] text-page">
      {children}
    </span>
  );
}

function Tomato({ fresh }: { fresh: boolean }) {
  return (
    <svg viewBox="0 0 16 16" className="size-4" fill="currentColor" aria-hidden>
      {fresh ? (
        <>
          <path d="M8 4.3 5.6 2.2l1.6.3L8 1.2l.8 1.3 1.6-.3z" />
          <circle cx="8" cy="10" r="5.2" />
        </>
      ) : (
        // Rotten: the splat.
        <path d="m8 2.4 1.3 2.4 2.6-1-.6 2.7 2.5 1.1-2.3 1.5 1.3 2.4-2.7-.2-.4 2.6L8 12.2l-1.7 1.7-.4-2.6-2.7.2 1.3-2.4-2.3-1.5 2.5-1.1-.6-2.7 2.6 1z" />
      )}
    </svg>
  );
}

function Dots() {
  return (
    <svg viewBox="0 0 20 16" className="h-4 w-5" fill="currentColor" aria-hidden>
      <circle cx="3.6" cy="8" r="3.3" opacity="0.5" />
      <circle cx="10" cy="8" r="3.3" opacity="0.75" />
      <circle cx="16.4" cy="8" r="3.3" />
    </svg>
  );
}

function Mark({ score }: { score: PublicScore }) {
  const marks: Record<ScoreSource, () => React.ReactNode> = {
    imdb: () => <Wordmark>IMDb</Wordmark>,
    mal: () => <Wordmark>MAL</Wordmark>,
    tmdb: () => <Wordmark>TMDB</Wordmark>,
    kitsu: () => <Wordmark>Kitsu</Wordmark>,
    tomatoes: () => <Tomato fresh={Number.parseInt(score.value) >= 60} />,
    popcorn: () => <PopcornIcon weight="fill" className="size-4" aria-hidden />,
    metacritic: () => (
      <span className="grid size-4 place-items-center rounded-full bg-fg-muted text-[9px] leading-none font-extrabold text-page">M</span>
    ),
    letterboxd: () => <Dots />,
  };
  return <span className="inline-flex shrink-0 items-center text-fg-muted">{marks[score.source]()}</span>;
}

/**
 * Public ratings, one source mark and value each. Neutral on purpose: the accent star is the viewer's own
 * score, on the Rate button. The row holds its height while ratings load, so nothing below it moves.
 */
export function RatingsStrip({ scores, loading, className }: { scores: PublicScore[]; loading?: boolean; className?: string }) {
  if (!scores.length && !loading) return null;
  return (
    <ul aria-label="Ratings" aria-busy={loading || undefined} className={cx("flex min-h-5 flex-wrap items-center gap-x-4 gap-y-2", className)}>
      {scores.map((score) => (
        <li key={score.source} title={score.label} className="inline-flex items-center gap-1.5">
          <Mark score={score} />
          <span aria-hidden className="text-body font-medium text-fg tabular-nums">{score.value}</span>
          <span className="sr-only">{score.spoken}</span>
        </li>
      ))}
      {loading &&
        [0, 1, 2].slice(scores.length ? 1 : 0).map((i) => (
          <li key={`loading-${i}`} aria-hidden className="skeleton h-4 w-12 rounded-full" />
        ))}
    </ul>
  );
}
