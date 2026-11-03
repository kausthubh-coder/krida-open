import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { cardScores, ScoreStack, type ScoreSource } from "./scores";
import { cx } from "./ui";
import { usePrefetchTitle } from "../data/prefetch";
import { Art } from "./artwork";
import { useLongPress } from "./longPress";
import { Peek } from "./peek";

/**
 * A poster that opens its title. `actions` (status, rate) sit in its corner and show on hover or keyboard
 * focus, instantly, with the title's public scores stacked opposite them. Touch screens, which can't hover,
 * get them in the peek a long press opens, instead of covering every poster's art.
 */
export function PosterCard({
  to,
  poster,
  title,
  subtitle,
  badge,
  progress,
  score,
  actions,
  style,
  className,
}: {
  to: string;
  poster?: string;
  title: string;
  /** A year, a reason, or a short line of facts (year · ★ 8.4). */
  subtitle?: ReactNode;
  badge?: ReactNode;
  progress?: number;
  score?: ScoreSource;
  actions?: ReactNode;
  style?: React.CSSProperties;
  className?: string;
}) {
  const hasProgress = progress !== undefined && progress > 0;
  const hasScores = !!score && cardScores(score).length > 0;
  const prefetch = usePrefetchTitle(to);
  // Home has hundreds of posters: the sheet is drawn only once a poster has been held.
  const [peeking, setPeeking] = useState<boolean>();
  const longPress = useLongPress(() => setPeeking(true));
  // Pressing the poster gives under the pointer; pressing a button on it doesn't.
  return (
    <>
      <div
        className={cx("group/card @container relative min-w-0 transition-transform duration-100 ease-out has-[>a:active]:scale-[0.985]", className)}
        style={style}
        data-card
        {...longPress}
      >
        <Link to={to} className="flex min-w-0 flex-col gap-2 rounded-card outline-offset-4" {...prefetch}>
          <div className="relative">
            <Art
              src={poster}
              titleId={/^\/title\/[a-z]+\/(tt\d+)/.exec(to)?.[1]}
              alt=""
              fallbackTitle={title}
              className="aspect-2/3 w-full rounded-card img-outline group-hover/card:brightness-110"
            />
            {badge && <div className="absolute top-2 left-2">{badge}</div>}
            {hasProgress && (
              <div className="progress-groove absolute inset-x-2 bottom-2 h-1 overflow-hidden rounded-full bg-black/50">
                <div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(100, progress * 100)}%` }} />
              </div>
            )}
          </div>
          <div className="min-w-0">
            <p className="truncate text-body font-medium text-fg" title={title}>
              {title}
            </p>
            {subtitle && <p className="truncate text-caption text-fg-faint">{subtitle}</p>}
          </div>
        </Link>
        {(actions || hasScores) && (
          // Shown while hovered, while a key has focus inside, and while one of its menus is open.
          <div
            data-hover-reveal
            className={cx(
              "pointer-events-none absolute inset-x-0 top-0 aspect-2/3 opacity-0 [@media(hover:none)]:hidden",
              "group-hover/card:opacity-100 group-has-focus-visible/card:opacity-100 group-has-[[aria-expanded=true]]/card:opacity-100",
            )}
          >
            <div className="absolute inset-x-0 bottom-0 h-1/2 rounded-b-card bg-linear-to-t from-black/55 to-transparent" />
            {score && (
              <ScoreStack
                source={score}
                className={cx("absolute left-2", hasProgress ? "bottom-5" : "bottom-2")}
              />
            )}
            <div
              className={cx(
                "absolute right-2 flex items-center gap-1.5",
                hasProgress ? "bottom-5" : "bottom-2",
                "group-hover/card:pointer-events-auto group-has-focus-visible/card:pointer-events-auto group-has-[[aria-expanded=true]]/card:pointer-events-auto",
              )}
            >
              {actions}
            </div>
          </div>
        )}
      </div>
      {peeking !== undefined && (
        <Peek
          open={peeking}
          onClose={() => setPeeking(false)}
          to={to}
          title={title}
          poster={poster}
          titleId={/^\/title\/[a-z]+\/(tt\d+)/.exec(to)?.[1]}
          facts={subtitle}
          score={score}
          actions={actions}
        />
      )}
    </>
  );
}
