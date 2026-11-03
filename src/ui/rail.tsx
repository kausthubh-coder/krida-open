import { useEffect, useId, useRef, useState, type PointerEventHandler, type ReactNode, type RefObject } from "react";
import { CaretLeftIcon, CaretRightIcon } from "@phosphor-icons/react";
import { HoverFilm } from "./film";
import { useNear } from "./near";
import { cx } from "./ui";

/** A poster's width in a row, from `--poster-w` (styles.css): it grows with the screen's height. */
export const POSTER_WIDTH = "w-(--poster-w)";
/** Cards a row renders at first and adds at a time: more than the widest screen shows. */
const BATCH = 12;

/**
 * A titled, horizontally scrolling row. `subtitle` says why the row is here, quietly, on the title's
 * baseline. `hideTitle` keeps the heading for screen readers when the row's first tile says it instead.
 *
 * Cards cost more to mount than to show, and Home has hundreds, so a row renders only what's in reach: two
 * cards while it's far down the page (a row may open with its own tile, and the rest are alike, so that keeps
 * its height: nothing moves and scroll positions still restore), then about two screens' width, then more as
 * it scrolls toward them.
 */
export function Rail({
  title,
  subtitle,
  hideTitle,
  action,
  children,
  itemWidth = POSTER_WIDTH,
  gap = "gap-3 md:gap-4",
  onPointerEnter,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  hideTitle?: boolean;
  action?: ReactNode;
  children: ReactNode[];
  itemWidth?: string;
  gap?: string;
  /** The pointer entering the row, e.g. to get its posters' previews ready. */
  onPointerEnter?: PointerEventHandler;
}) {
  const headingId = useId();
  const section = useRef<HTMLElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: true });
  const near = useNear(section);
  useSkipWhenAway(section, near);
  const [count, setCount] = useState(BATCH);
  const shown = Math.min(children.length, near ? count : 2);
  const more = shown < children.length;

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const update = () => {
      const left = el.scrollWidth - el.scrollLeft - el.clientWidth;
      setEdges({ start: el.scrollLeft <= 4, end: left <= 4 && !more });
      if (near && more && left < el.clientWidth) setCount((c) => c + BATCH);
    };
    el.addEventListener("scroll", update, { passive: true });
    // The observer's first report (just after the next layout) is the first measure. Measuring here instead
    // would force a layout, and for a row off screen, lay out what content-visibility is skipping.
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
    // Again after each batch: the row keeps about two screens of cards ahead without waiting for a scroll.
  }, [children.length, near, more, shown]);

  const page = (dir: 1 | -1) => {
    const el = scroller.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.85, behavior: "smooth" });
  };

  return (
    <section ref={section} data-film-zone aria-labelledby={headingId} className="group/rail flex flex-col gap-3" onPointerEnter={onPointerEnter}>
      {hideTitle && !subtitle && !action ? (
        <h2 id={headingId} className="sr-only">
          {title}
        </h2>
      ) : (
        <div className="flex items-baseline justify-between gap-4 px-4 md:px-12">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-3">
            <h2 id={headingId} className={hideTitle ? "sr-only" : "text-[1.0625rem] leading-6 font-semibold tracking-[-0.01em] md:text-title"}>
              {title}
            </h2>
            {/* Why the row's here: on a phone there's only room for what it is. */}
            {subtitle && <p className="min-w-0 text-body text-fg-faint max-md:hidden">{subtitle}</p>}
          </div>
          {action}
        </div>
      )}
      <div className="relative">
        <div
          ref={scroller}
          data-rail
          className={cx(
            "scroll-fade-x flex snap-x snap-mandatory scroll-px-4 overflow-x-auto overscroll-x-contain px-4 pb-1 scrollbar-none md:scroll-px-12 md:px-12",
            gap,
          )}
        >
          {children.slice(0, shown).map((child, i) => (
            <div key={i} className={cx("shrink-0 snap-start", itemWidth)}>
              {child}
            </div>
          ))}
        </div>
        <RailArrow side="left" hidden={edges.start} onClick={() => page(-1)} />
        <RailArrow side="right" hidden={edges.end} onClick={() => page(1)} />
      </div>
    </section>
  );
}

/**
 * Once a row has come near the screen and filled in, it skips layout and paint while away from it
 * (content-visibility), holding the height it had, so showing Home again or resizing lays out the few rows in
 * view rather than thirty. Not before: a row still filling in would hold a height it's about to outgrow, and
 * a row far down costs little anyway with its two cards. Set on the element directly: React draws none of it.
 */
function useSkipWhenAway(ref: RefObject<HTMLElement | null>, near: boolean) {
  useEffect(() => {
    const el = ref.current;
    if (!el || !near) return;
    const observer = new ResizeObserver(([entry]) => {
      const height = entry.borderBoxSize[0]?.blockSize;
      if (!height) return;
      el.style.containIntrinsicSize = `auto ${Math.round(height)}px`;
      el.style.contentVisibility = "auto";
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, near]);
}

/**
 * A button over the row's end posters. Not displayed until the pointer is on the row, and only then a bubble: Home has two
 * arrows per row.
 */
function RailArrow({ side, hidden, onClick }: { side: "left" | "right"; hidden: boolean; onClick: () => void }) {
  return (
    <button
      aria-label={side === "left" ? "Scroll back" : "Scroll forward"}
      tabIndex={-1}
      onClick={onClick}
      className={cx(
        "press fill-scrim bg-black/60 hover:bg-black/75 absolute top-[calc(50%-24px)] hidden size-10 -translate-y-1/2 place-items-center rounded-full text-[18px] text-fg",
        side === "left" ? "left-3" : "right-3",
        !hidden && "md:group-hover/rail:grid",
      )}
    >
      <HoverFilm />
      {side === "left" ? <CaretLeftIcon /> : <CaretRightIcon />}
    </button>
  );
}
