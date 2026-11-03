import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Film } from "../../../ui/film";
import { useDismiss } from "../../../ui/dismiss";
import { Grow } from "../../../ui/grow";
import { Link, useLocation } from "react-router";
import { CaretDownIcon, FunnelSimpleIcon, MagnifyingGlassIcon, StarIcon, XIcon } from "@phosphor-icons/react";
import { art } from "../../../data/cinemeta";
import { useBlurOnLeave } from "../../../ui/keyboard";
import { Art } from "../../../ui/artwork";
import { Button, cx } from "../../../ui/ui";
import { activeFilters, ERAS, FORMATS, NO_FILTERS, SCORES, type Filters, type Sort } from "../filters";

/** Poster grids across the Library: two on phones, then posters at least as wide as Home's, as many as fit beside the side list. */
export const POSTER_GRID = "grid grid-cols-2 gap-x-4 gap-y-7 sm:grid-posters";
/** Things in progress: rows on phones, 16:9 cards from 640px. */
export const WIDE_GRID = "grid grid-cols-1 gap-y-3 sm:grid-wide sm:gap-x-4 sm:gap-y-7";

/** The toolbar's field and controls share one look: 44px, a faint fill, and a hairline edge. */
const toolbar = "h-11 rounded-full ring-1 ring-line ring-inset";

export function SearchField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useBlurOnLeave(ref);
  return (
    <div className="fill-quiet relative min-w-0 flex-1 rounded-full lg:w-64 lg:flex-none">
      <Film />
      <MagnifyingGlassIcon aria-hidden className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-[18px] text-fg-faint" />
      <input ref={ref} type="search" value={value} onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape" && value) { e.preventDefault(); onChange(""); } }}
        aria-label="Search your Library" placeholder="Search titles" autoComplete="off" spellCheck={false} enterKeyHint="search"
        className={cx(toolbar, "w-full bg-white/6 pr-10 pl-10 text-subhead text-fg placeholder:text-fg-faint hover:bg-white/8 focus:bg-white/8 focus:ring-white/25 focus-visible:outline-transparent md:text-body [&::-webkit-search-cancel-button]:hidden")} />
      {value && <button aria-label="Clear search" onClick={() => { onChange(""); ref.current?.focus(); }}
        className="absolute top-1/2 right-1 grid size-9 -translate-y-1/2 place-items-center rounded-full text-fg-muted hover:bg-white/10 hover:text-fg">
        <XIcon className="text-[16px]" />
      </button>}
    </div>
  );
}

export type SortChoice = { value: Sort; options: Sort[]; recent: string; onChange: (s: Sort) => void };
const sortLabel = (s: Sort, recent: string) => ({ recent, score: "Your score", title: "Title A–Z", released: "Release year" })[s];

/** Beside search from 768px. Phones sort from the filter sheet, so the search keeps its width. */
export function SortSelect({ value, options, onChange, recent }: SortChoice) {
  return (
    <label className="fill-quiet relative shrink-0 rounded-full max-md:hidden">
      <Film />
      <span className="sr-only">Sort by</span>
      <select value={value} onChange={(e) => onChange(e.target.value as Sort)}
        className={cx(toolbar, "cursor-pointer appearance-none bg-white/6 pr-9 pl-4 text-body font-medium text-fg-muted hover:bg-white/8 hover:text-fg")}>
        {options.map((o) => <option key={o} value={o} className="bg-overlay text-fg">{sortLabel(o, recent)}</option>)}
      </select>
      <CaretDownIcon aria-hidden className="pointer-events-none absolute top-1/2 right-3.5 -translate-y-1/2 text-[14px] text-fg-faint" />
    </label>
  );
}

const pill = (on: boolean) => cx("press relative inline-flex h-10 cursor-pointer items-center rounded-full px-3.5 text-body font-medium has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-accent",
  on ? "lens text-fg" : "fill-quiet bg-white/6 text-fg-muted hover:bg-white/10 hover:text-fg");
const hiddenInput = "absolute inset-0 cursor-pointer opacity-0";

/** One group of choices in the filter sheet. Radios give each group arrow keys for free. */
function Choices<T extends string>({ name, legend, value, options, onChange, className }: {
  name: string; legend: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; className?: string;
}) {
  return (
    <fieldset className={cx("flex flex-col", className)}>
      <legend className="mb-2 text-caption font-medium text-fg-faint">{legend}</legend>
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => (
          <label key={o.value} className={pill(value === o.value)}>
            <input type="radio" name={name} checked={value === o.value} onChange={() => onChange(o.value)} className={hiddenInput} />
            {o.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Genres add up, so each is a checkbox; "Any genre" clears them. */
function GenreChoices({ value, options, onChange }: { value: string[]; options: { value: string; label: string }[]; onChange: (v: string[]) => void }) {
  return (
    <fieldset className="flex flex-col">
      <legend className="mb-2 text-caption font-medium text-fg-faint">Genre</legend>
      <div className="flex flex-wrap gap-1.5">
        <label className={pill(!value.length)}>
          <input type="checkbox" checked={!value.length} onChange={() => onChange([])} className={hiddenInput} />
          Any genre
        </label>
        {options.map((o) => {
          const on = value.includes(o.value);
          return (
            <label key={o.value} className={pill(on)}>
              <input type="checkbox" checked={on} onChange={() => onChange(on ? value.filter((g) => g !== o.value) : [...value, o.value])} className={hiddenInput} />
              {o.label}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/**
 * Every filter behind one button, so the header stays search, sort and this. A native popover: outside
 * clicks and Escape close it, and focus goes back to the button.
 */
export function FilterMenu({ value, onChange, scores, sort, genres, onIntent }: {
  value: Filters; onChange: (f: Filters) => void; scores: boolean; sort?: SortChoice;
  /** The Library's genres, most common first; undefined while they load. */
  genres: { value: string; label: string }[] | undefined;
  /** Pointing at or focusing the button, so genres can load before it opens. */
  onIntent: () => void;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const active = activeFilters(scores ? value : { ...value, score: "all" });
  useDismiss(open, (refocus) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  }, trigger, menu);
  // The first group shown: phones open on Sort by, wider screens on Type.
  const focusFirst = () => [...menu.current?.querySelectorAll<HTMLInputElement>("input:checked") ?? []].find((i) => i.offsetParent)?.focus();
  // It stops above the floating dock or tab bar, so Done never ends up under it. Measured as it opens.
  const [room, setRoom] = useState<number>();
  const toggle = () => {
    const bar = [...document.querySelectorAll('nav[aria-label="Main"]')].map((n) => n.getBoundingClientRect()).find((r) => r.height > 0);
    if (trigger.current) setRoom(Math.min(window.innerHeight, bar?.top ?? Infinity) - trigger.current.getBoundingClientRect().bottom - 16);
    setOpen(!open);
  };
  const set = <K extends keyof Filters>(key: K) => (v: Filters[K]) => onChange({ ...value, [key]: v });
  return (
    <>
      <button ref={trigger} aria-haspopup="dialog" aria-controls={id} aria-expanded={open} onClick={() => { onIntent(); toggle(); }}
        onPointerEnter={onIntent} onFocus={onIntent}
        aria-label={active ? `Filters, ${active} on` : "Filters"}
        className={cx(toolbar, "press relative inline-flex shrink-0 items-center gap-2 px-3.5 text-body font-medium md:pr-4",
          active ? "fill-raised bg-white/12 text-fg hover:bg-white/15" : "fill-quiet bg-white/6 text-fg-muted hover:bg-white/8 hover:text-fg")}>
        <Film />
        <FunnelSimpleIcon aria-hidden className="text-[18px]" />
        <span className="max-md:sr-only">Filter</span>
        {active > 0 && <span aria-hidden className="grid size-5 place-items-center rounded-full bg-accent text-caption font-semibold text-on-accent tabular-nums max-md:absolute max-md:-top-0.5 max-md:-right-0.5">{active}</span>}
      </button>
      <Grow ref={menu} id={id} role="dialog" aria-label="Filter your Library" open={open} from={trigger} placement="bottom-end" radius={28} onPlaced={focusFirst}
        className="w-80 max-w-[calc(100vw-16px)]" style={room !== undefined ? { maxHeight: room } : undefined}>
        <div className="p-4">
        <div className="flex flex-col gap-5">
          {sort && <Choices name={`${id}-sort`} legend="Sort by" value={sort.value} onChange={sort.onChange} className="md:hidden"
            options={sort.options.map((o) => ({ value: o, label: sortLabel(o, sort.recent) }))} />}
          <Choices name={`${id}-format`} legend="Type" value={value.format} options={FORMATS} onChange={set("format")} />
          {genres ? genres.length > 0 && <GenreChoices value={value.genres} options={genres} onChange={set("genres")} />
            : <div aria-busy className="flex flex-col">
              <p className="mb-2 text-caption font-medium text-fg-faint">Genre</p>
              <p role="status" className="sr-only">Finding genres…</p>
              {/* Two rows of pills, about what most libraries need, so little moves when they arrive. */}
              <div aria-hidden className="flex flex-wrap gap-1.5">{[88, 64, 76, 72, 96, 60].map((w, i) => <span key={i} className="skeleton h-10 rounded-full" style={{ width: w }} />)}</div>
            </div>}
          <Choices name={`${id}-era`} legend="Released" value={value.era} options={ERAS} onChange={set("era")} />
          {scores && <Choices name={`${id}-score`} legend="Your score" value={value.score} options={SCORES} onChange={set("score")} />}
        </div>
        <div className="mt-5 flex items-center justify-end gap-2 border-t border-line pt-3">
          {active > 0 && <Button variant="ghost" className="mr-auto -ml-3" onClick={() => onChange(NO_FILTERS)}>Clear filters</Button>}
          <Button onClick={() => { setOpen(false); trigger.current?.focus(); }}>Done</Button>
        </div>
        </div>
      </Grow>
    </>
  );
}

export function ScoreBadge({ score }: { score: number }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-black/70 px-2 py-0.5 text-caption font-medium text-fg tabular-nums">
      <StarIcon weight="fill" className="text-accent" aria-hidden />
      <span className="sr-only">Your score: </span>{score}
    </span>
  );
}

export function SectionHead({ title, note, action }: { title: string; note?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h2 className="text-title font-semibold">{title}</h2>
      {note && <p className="text-body text-fg-faint tabular-nums">{note}</p>}
      {action && <div className="ml-auto">{action}</div>}
    </div>
  );
}

/**
 * Something in progress. A row with a 16:9 thumbnail on phones, a 16:9 card from 640px. Anime has no wide
 * artwork on Metahub by Kitsu id, so it uses the show's IMDb id when there is one, and otherwise its own
 * poster, blurred, with the poster set inside.
 */
export function WideCard({ to, id, imdb, poster, title, subtitle, progress, left, actions }: {
  to: string; id: string; imdb?: string; poster?: string; title: string; subtitle?: string;
  progress?: number; left?: number; actions?: ReactNode;
}) {
  const wide = art.background(imdb ?? id);
  const tall = poster ?? art.poster(imdb ?? id);
  return (
    <div className="group/card relative min-w-0 transition-transform duration-100 ease-out has-[>a:active]:scale-[0.985]">
      <Link to={to} className={cx("flex min-w-0 items-center gap-3 rounded-card outline-offset-4 sm:flex-col sm:items-stretch sm:gap-2", !!actions && "max-sm:pr-24")}>
        <div className="relative aspect-video w-32 shrink-0 overflow-hidden rounded-control img-outline sm:w-full sm:rounded-card">
          {wide ? <Art src={wide} alt="" fallbackTitle={title} className="absolute inset-0 group-hover/card:brightness-110" />
            : <>
              <Art src={tall} alt="" className="absolute inset-0" imgClassName="scale-125 blur-xl brightness-50" />
              <Art src={tall} alt="" fallbackTitle={title} className="absolute inset-y-2 left-2 aspect-2/3 rounded-[6px] img-outline sm:inset-y-3 sm:left-3 sm:rounded-control" />
            </>}
          <div className="absolute inset-0 bg-linear-to-t from-black/70 via-transparent to-transparent" />
          {left !== undefined && (
            <p className={cx("absolute bottom-2 flex items-baseline gap-1 sm:bottom-4 sm:gap-1.5", wide ? "left-2 sm:left-3" : "right-3 sm:right-4")}>
              <span className="font-display text-title font-semibold tabular-nums sm:text-display">{left}</span>
              <span className="text-caption font-medium text-fg-muted">left</span>
            </p>
          )}
          {progress !== undefined && progress > 0 && left === undefined && (
            <div className="absolute inset-x-2 bottom-2 h-1 overflow-hidden rounded-full bg-white/20 sm:inset-x-3 sm:bottom-3">
              <div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(100, Math.max(2, progress * 100))}%` }} />
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1 sm:px-0.5">
          <p className="line-clamp-2 text-body font-medium break-words sm:line-clamp-1" title={title}>{title}</p>
          {subtitle && <p className="line-clamp-2 text-caption text-fg-faint sm:line-clamp-1">{subtitle}</p>}
        </div>
      </Link>
      {actions && (
        <div className={cx("absolute flex gap-1.5 max-sm:top-1/2 max-sm:right-0 max-sm:-translate-y-1/2",
          "sm:pointer-events-none sm:top-2 sm:right-2 sm:opacity-0 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100",
          "group-hover/card:pointer-events-auto group-hover/card:opacity-100 group-has-focus-visible/card:pointer-events-auto group-has-focus-visible/card:opacity-100",
          "group-has-[[aria-expanded=true]]/card:pointer-events-auto group-has-[[aria-expanded=true]]/card:opacity-100")}>
          {actions}
        </div>
      )}
    </div>
  );
}

// How far each list had grown, per history entry, so Back finds the page as tall as it was left.
const grown = new Map<string, number>();

/**
 * How many of `total` to render: `step` more whenever the end comes within a screen. A fresh observer per step
 * reports where the end is after it lands, so a tall window keeps filling and a short one waits for scrolling.
 * `id` tells apart the lists on one page.
 */
export function useGrowing(total: number, step: number, id: string) {
  const memory = `${useLocation().key}:${id}`;
  const [shown, setShown] = useState(() => grown.get(memory) ?? step);
  useEffect(() => { grown.set(memory, shown); }, [memory, shown]);
  const [end, setEnd] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!end || shown >= total || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      observer.disconnect();
      setShown((n) => n + step);
    }, { rootMargin: "100% 0px" });
    observer.observe(end);
    return () => observer.disconnect();
  }, [end, shown, total, step]);
  const sentinel = shown < total ? <div ref={setEnd} aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-px" /> : null;
  return { shown, sentinel };
}

/** A long list that renders as you scroll, so a library of hundreds stays quick to open. */
export function Growing<T>({ id, items, render, className, step = 60 }: {
  id: string; items: T[]; render: (i: T) => ReactNode; className: string; step?: number;
}) {
  const { shown, sentinel } = useGrowing(items.length, step, id);
  return <div className="relative"><ul className={className}>{items.slice(0, shown).map(render)}</ul>{sentinel}</div>;
}

/** Placeholders in the final shapes, so nothing jumps when the titles land. */
export function PosterSkeletons({ count = 12 }: { count?: number }) {
  return <ul aria-hidden className={POSTER_GRID}>{Array.from({ length: count }, (_, i) => (
    <li key={i} className="flex flex-col gap-2"><div className="skeleton aspect-2/3 rounded-card" /><div className="skeleton h-3.5 w-3/4 rounded-full" /><div className="skeleton h-3 w-1/3 rounded-full" /></li>
  ))}</ul>;
}

export function WideSkeletons({ count = 8 }: { count?: number }) {
  return <ul aria-hidden className={WIDE_GRID}>{Array.from({ length: count }, (_, i) => (
    <li key={i} className="flex items-center gap-3 sm:flex-col sm:items-stretch sm:gap-2"><div className="skeleton aspect-video w-32 shrink-0 rounded-control sm:w-full sm:rounded-card" />
      <div className="flex flex-1 flex-col gap-1.5"><div className="skeleton h-3.5 w-2/3 rounded-full" /><div className="skeleton h-3 w-1/3 rounded-full" /></div></li>
  ))}</ul>;
}
