import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Film } from "../../../ui/film";
import { useDismiss } from "../../../ui/dismiss";
import { Grow } from "../../../ui/grow";
import { Link } from "react-router";
import { CaretDownIcon, CheckIcon, ClockCounterClockwiseIcon, XIcon } from "@phosphor-icons/react";
import { DECADES, decadeLabel, GENRES, LANGUAGES, languageName, type Tags } from "../../../../shared/tags";
import { useCatalogRows } from "../../../data/api";
import { art } from "../../../data/cinemeta";
import { Art } from "../../../ui/artwork";
import { cx } from "../../../ui/ui";
import { ART_FALLBACK, Delayed } from "./Results";

type Edit = (edit: (t: Tags) => Tags) => void;

/** One title per genre that everyone recognises from a single frame. Artwork comes from metahub, like every backdrop. */
const GENRE_ART: [genre: string, imdbId: string][] = [
  ["Action", "tt0468569"],
  ["Comedy", "tt0386676"],
  ["Horror", "tt7784604"],
  ["Sci-Fi", "tt0816692"],
  ["Romance", "tt5311514"],
  ["Thriller", "tt6751668"],
  ["Crime", "tt0903747"],
  ["Fantasy", "tt0944947"],
  ["Anime", "tt2560140"],
  ["Drama", "tt7660850"],
  ["Mystery", "tt5753856"],
  ["Documentary", "tt5491994"],
];

/** The languages the two of them watch in, written in their own script: the script is what tells them apart. */
const LANGUAGE_TILES = [
  { code: "te", script: "తెలుగు" },
  { code: "hi", script: "हिन्दी" },
  { code: "ta", script: "தமிழ்" },
  { code: "ml", script: "മലയാളം" },
  { code: "ko", script: "한국어" },
  { code: "ja", script: "日本語" },
];

const toggleGenre = (g: string) => (t: Tags) => ({
  ...t,
  genres: t.genres.includes(g) ? t.genres.filter((x) => x !== g) : [...t.genres, g],
});
const toggleLanguage = (code: string) => (t: Tags) => ({ ...t, language: t.language === code ? undefined : code });
const toggleDecade = (from: number) => (t: Tags) => ({
  ...t,
  years: t.years?.from === from && t.years.to === from + 9 ? undefined : { from, to: from + 9 },
});

export function Chip({
  on,
  onClick,
  label,
  className,
  children,
}: {
  on?: boolean;
  onClick: () => void;
  label?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      aria-label={label}
      onClick={onClick}
      className={cx(
        "press inline-flex h-11 shrink-0 items-center gap-2 rounded-full px-3.5 text-body font-medium md:h-9",
        // Lit like the selection everywhere else; white fill is kept for Play.
        on ? "lens text-fg" : "fill-quiet bg-white/6 text-fg-muted hover:bg-white/10 hover:text-fg",
        className,
      )}
    >
      {!on && <Film />}
      {children}
    </button>
  );
}

/** Recent searches as one quiet line under the field. */
export function RecentLine({ recent, onPick, onClear }: { recent: string[]; onPick: (q: string) => void; onClear: () => void }) {
  if (recent.length === 0) return null;
  const link = "inline-flex h-11 shrink-0 items-center gap-1.5 rounded-full px-3 text-body hover:bg-white/6 hover:text-fg md:h-9";
  return (
    <div
      role="group"
      aria-label="Recent searches"
      className="-mx-4 flex max-w-5xl items-center overflow-x-auto px-4 scrollbar-none scroll-fade-x md:mx-0 md:px-2"
    >
      {recent.map((r) => (
        <button key={r} onClick={() => onPick(r)} className={cx(link, "max-w-64 text-fg-muted")}>
          <ClockCounterClockwiseIcon aria-hidden className="shrink-0 text-fg-faint" />
          <span className="truncate">{r}</span>
        </button>
      ))}
      <button onClick={onClear} aria-label="Clear recent searches" className={cx(link, "text-fg-faint")}>
        Clear
      </button>
    </div>
  );
}

/**
 * Before typing: genres and languages to tap, decades, and what's trending. Tapping writes the tag into
 * the search ("telugu" then "comedy" reads "telugu comedy"), exactly as if it were typed.
 */
export function BrowseAll({ onEdit }: { onEdit: Edit }) {
  return (
    <div className="flex flex-col gap-10">
      <section aria-labelledby="browse-genres" className="flex flex-col gap-3">
        <h2 id="browse-genres" className="text-title font-semibold">
          Browse by genre
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {GENRE_ART.map(([genre, id]) => (
            <button
              key={genre}
              onClick={() => onEdit(toggleGenre(genre))}
              className="group/tile press-soft relative aspect-video overflow-hidden rounded-card text-left"
            >
              <Art
                src={art.background(id)}
                alt=""
                className={cx("absolute inset-0", ART_FALLBACK)}
                imgClassName="saturate-[.85] group-hover/tile:brightness-110"
              />
              <span aria-hidden className="absolute inset-0 bg-linear-200 from-transparent from-30% to-page/90" />
              <span aria-hidden className="absolute inset-0 rounded-[inherit] img-outline" />
              <span className="absolute right-3 bottom-2.5 left-3.5 truncate font-display text-title font-semibold text-fg">
                {genre}
              </span>
            </button>
          ))}
        </div>
      </section>

      <section aria-labelledby="browse-languages" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline gap-x-3">
          <h2 id="browse-languages" className="text-title font-semibold">
            Languages
          </h2>
          <p className="text-body text-fg-faint">Tap two to mix them, like Telugu + Comedy</p>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {LANGUAGE_TILES.map(({ code, script }) => (
            <button
              key={code}
              onClick={() => onEdit(toggleLanguage(code))}
              className="press-soft flex h-21 min-w-0 flex-col justify-between rounded-card bg-surface px-3.5 py-3 text-left shadow-raised hover:bg-raised"
            >
              <span lang={code} className="truncate text-display font-medium text-fg">
                {script}
              </span>
              <span className="text-caption text-fg-faint">{languageName(code)}</span>
            </button>
          ))}
        </div>
      </section>

      <section aria-labelledby="browse-decades" className="flex flex-col gap-3">
        <h2 id="browse-decades" className="text-title font-semibold">
          Decades
        </h2>
        <div role="group" aria-labelledby="browse-decades" className="-mx-4 flex gap-2 overflow-x-auto px-4 scrollbar-none md:mx-0 md:px-0">
          {DECADES.map((from) => (
            <Chip key={from} onClick={() => onEdit(toggleDecade(from))}>
              {decadeLabel(from)}
            </Chip>
          ))}
        </div>
      </section>

      <Trending />
    </div>
  );
}

/** TMDB's trending movies and shows, interleaved, as a short ranked list. */
function Trending() {
  const home = useCatalogRows();
  const items = useMemo(() => {
    const rows = (home?.rows ?? []).filter((r) => r.key.startsWith("tmdb:trending:"));
    const out: (typeof rows)[number]["items"] = [];
    for (let i = 0; out.length < 10 && rows.some((r) => r.items[i]); i++)
      for (const row of rows) if (row.items[i] && out.length < 10 && !out.some((x) => x.id === row.items[i].id)) out.push(row.items[i]);
    return out;
  }, [home]);
  if (home !== undefined && items.length === 0) return null;
  const list = "grid md:grid-flow-col md:grid-cols-2 md:grid-rows-5 md:gap-x-10";
  return (
    <section aria-labelledby="browse-trending" className="flex flex-col gap-3">
      <h2 id="browse-trending" className="text-title font-semibold">
        Trending this week
      </h2>
      {!home ? (
        <Delayed>
          <ul aria-hidden className={list}>
            {Array.from({ length: 10 }).map((_, i) => (
              <li key={i} className="flex h-18 items-center gap-3.5 border-b border-line last:border-0 md:nth-5:border-0">
                <span className="w-6 shrink-0" />
                <div className="skeleton aspect-2/3 w-10 shrink-0 rounded-[8px]" />
                <div className="skeleton h-4 w-1/2 rounded-full" />
              </li>
            ))}
          </ul>
        </Delayed>
      ) : (
        <ol className={list}>
          {items.map((item, i) => (
            // A line between rows only: none under the last in each column.
            <li key={item.id} className="border-b border-line last:border-0 md:nth-5:border-0">
              <Link
                to={`/title/${item.type}/${item.id}`}
                className="-mx-2 flex h-18 items-center gap-3.5 rounded-control px-2 hover:bg-white/6"
              >
                <span aria-hidden className="w-6 shrink-0 text-right font-display text-title text-fg-faint tabular-nums">
                  {i + 1}
                </span>
                <Art
                  src={item.poster ?? art.poster(item.id)}
                  alt=""
                  className={cx("aspect-2/3 w-10 shrink-0 rounded-[8px] img-outline", ART_FALLBACK)}
                />
                <span className="min-w-0">
                  <span className="block truncate font-medium text-fg" title={item.name}>
                    {item.name}
                  </span>
                  <span className="block truncate text-caption text-fg-faint">
                    {[item.year, item.type === "movie" ? "Movie" : "Show"].filter(Boolean).join(" · ")}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

const SORTS: { value: Tags["sort"]; label: string; hint: string }[] = [
  { value: undefined, label: "Popular", hint: "Most popular first" },
  { value: "best", label: "Highest rated", hint: "Highest rated first" },
  { value: "new", label: "New", hint: "Out in the last 18 months" },
];

/**
 * While tags are in the search: each one as a chip that removes it, then a menu per kind of tag to add or
 * swap one, all on one line with `end` (Movies or Shows) at its far side. Only one language and one decade
 * apply, so picking another swaps it; genres add up, so their menu stays open.
 */
export function TagBar({ tags, onEdit, end }: { tags: Tags | null; onEdit: Edit; end?: ReactNode }) {
  const active: { key: string; label: string; remove: (t: Tags) => Tags }[] = [];
  if (tags?.years) {
    const { from, to } = tags.years;
    active.push({ key: "years", label: from === to ? String(from) : decadeLabel(from), remove: (t) => ({ ...t, years: undefined }) });
  }
  if (tags?.language) active.push({ key: "language", label: languageName(tags.language), remove: toggleLanguage(tags.language) });
  for (const g of tags?.genres ?? []) active.push({ key: g, label: g, remove: toggleGenre(g) });

  const decade = (from: number) => tags?.years?.from === from && tags.years.to === from + 9;
  const sort = SORTS.find((o) => o.value === tags?.sort) ?? SORTS[0];
  return (
    // On a phone, Movies or Shows leads and the tags scroll sideways under it; from 768px it's one line.
    <div className="flex flex-col gap-3 md:flex-row md:items-center">
      {end && <div className="md:order-last md:ml-auto">{end}</div>}
      <div className="-mx-4 flex items-center gap-2 overflow-x-auto px-4 scrollbar-none max-md:scroll-fade-x md:mx-0 md:flex-wrap md:overflow-visible md:px-0">
        {active.length > 0 && (
          <>
            <div role="group" aria-label="Your tags" className="contents">
              {active.map((a) => (
                <Chip key={a.key} on onClick={() => onEdit(a.remove)} label={`Remove ${a.label}`} className="pr-2.5">
                  {a.label}
                  <XIcon aria-hidden weight="bold" className="text-fg-muted" />
                </Chip>
              ))}
            </div>
            <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-line" />
          </>
        )}
        <TagMenu
          label="Language"
          options={LANGUAGES.map((l) => ({ key: l.code, label: l.name, on: tags?.language === l.code, pick: () => onEdit(toggleLanguage(l.code)) }))}
        />
        <TagMenu
          label="Genre"
          multi
          options={GENRES.map((g) => ({ key: g.name, label: g.name, on: !!tags?.genres.includes(g.name), pick: () => onEdit(toggleGenre(g.name)) }))}
        />
        <TagMenu
          label="Decade"
          options={DECADES.map((from) => ({ key: String(from), label: decadeLabel(from), on: decade(from), pick: () => onEdit(toggleDecade(from)) }))}
        />
        {/* The order is a setting, not a tag: it names what's chosen instead of adding a chip. */}
        <TagMenu
          label="Sort"
          value={sort.value ? sort.label : undefined}
          options={SORTS.map((o) => ({
            key: o.label,
            label: o.label,
            hint: o.hint,
            on: o === sort,
            pick: () => onEdit((t) => ({ ...t, sort: o.value })),
          }))}
        />
      </div>
    </div>
  );
}

type TagOption = { key: string; label: string; hint?: string; on: boolean; pick: () => void };

/**
 * A chip that opens a menu of one kind of tag. `multi` keeps it open, so several can be picked in a row.
 * `value` replaces the label when the menu is a setting with something other than its default chosen.
 */
function TagMenu({ label, value, options, multi }: { label: string; value?: string; options: TagOption[]; multi?: boolean }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };
  const panel = useRef<HTMLDivElement>(null);
  useDismiss(open, close, trigger, panel);
  return (
    <>
      <button
        ref={trigger}
        aria-haspopup="menu"
        aria-controls={id}
        aria-expanded={open}
        aria-label={value ? `${label}: ${value}` : undefined}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
          e.preventDefault();
          setOpen(true);
        }}
        className={cx(
          "press inline-flex h-11 shrink-0 items-center gap-1.5 rounded-full pr-3 pl-3.5 text-body font-medium md:h-9",
          open ? "fill-raised bg-white/12 text-fg" : "fill-quiet bg-white/6 text-fg-muted hover:bg-white/10 hover:text-fg",
        )}
      >
        <Film />
        {value ?? label}
        <CaretDownIcon aria-hidden weight="bold" className="text-[0.8em] text-fg-faint" />
      </button>
      <Grow
        ref={panel}
        open={open}
        from={trigger}
        placement="bottom-start"
        radius={24}
        id={id}
        onPlaced={() => {
          // The one in use, or the first.
          (menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]') ?? menu.current?.querySelector<HTMLButtonElement>("button"))?.focus();
        }}
        className={cx("max-w-[calc(100vw-16px)]", multi ? "w-80" : "w-60")}
      >
      <div
        ref={menu}
        className="p-1.5"
        onKeyDown={(e) => {
          const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
          const at = items.indexOf(document.activeElement as HTMLButtonElement);
          // Up and down move through the list; in the two-column genre grid, left and right move along a row.
          const steps: Record<string, number> = multi
            ? { ArrowDown: 2, ArrowUp: -2, ArrowRight: 1, ArrowLeft: -1 }
            : { ArrowDown: 1, ArrowUp: -1 };
          const next =
            e.key in steps ? Math.min(items.length - 1, Math.max(0, at + steps[e.key])) : e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : null;
          if (next !== null) {
            e.preventDefault();
            items[next]?.focus();
          }
          if (e.key === "Tab") close();
        }}
      >
        <div role="menu" aria-label={label} className={cx(multi && "grid grid-cols-2")}>
          {options.map((o) => (
            <button
              key={o.key}
              role={multi ? "menuitemcheckbox" : "menuitemradio"}
              aria-checked={o.on}
              tabIndex={-1}
              onClick={() => {
                o.pick();
                if (!multi) close();
              }}
              className={cx(
                "flex min-h-11 w-full items-center gap-3 rounded-control px-3 py-2 text-left text-body hover:bg-white/8",
                o.on ? "text-accent" : "text-fg",
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate">{o.label}</span>
                {o.hint && <span className="block truncate text-caption text-fg-faint">{o.hint}</span>}
              </span>
              {o.on && <CheckIcon aria-hidden weight="bold" className="shrink-0" />}
            </button>
          ))}
        </div>
      </div>
      </Grow>
    </>
  );
}
