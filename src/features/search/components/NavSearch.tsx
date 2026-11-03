import { useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { createPortal } from "react-dom";
import type { Bubble } from "bubli/engine";
import { CaretRightIcon, ClockCounterClockwiseIcon, MagnifyingGlassIcon, PlayIcon, SquaresFourIcon, XIcon } from "@phosphor-icons/react";
import { art } from "../../../data/cinemeta";
import { allEntries, libraryFilter, useOverview } from "../../library";
import { addRecent, clearRecent, removeRecent, useRecentSearches } from "../recentSearches";
import { Art } from "../../../ui/artwork";
import { Grow } from "../../../ui/grow";
import { cx, Kbd, Spinner } from "../../../ui/ui";
import { ART_FALLBACK, useStartTitle, type Result } from "./Results";
import { useSearch } from "./useSearch";
import { useSearchDraft } from "./draft";
import { visibleSearchField } from "./shortcut";

type Kind = Result["type"];
type Option =
  | { kind: "browse" }
  | { kind: "recent"; q: string }
  | { kind: "library"; id: string; imdb?: string; type: Kind; name: string; poster?: string; note?: string; progress?: number; resume: boolean }
  | { kind: "person"; name: string; role: string; photo?: string; count: number }
  | { kind: "title"; item: Result }
  | { kind: "all" };

const LIBRARY_ROWS = 3;
const TITLE_ROWS = 4;
const RECENT_ROWS = 5;
const kindLabel = (type: Kind) => (type === "movie" ? "Movie" : "Show");

function useDebounced<T>(value: T, ms: number) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

/** What's typed stays light and the rest of the name carries the weight, so similar names are told apart. */
function Marked({ name, query }: { name: string; query: string }) {
  const at = query ? name.toLowerCase().indexOf(query.toLowerCase()) : -1;
  if (at < 0) return <>{name}</>;
  return (
    <>
      {name.slice(0, at)}
      <span className="font-normal text-fg-muted">{name.slice(at, at + query.length)}</span>
      {name.slice(at + query.length)}
    </>
  );
}

/**
 * Search in the dock, the same on every page. Resting, it's a round search button beside the places;
 * focused (click, Tab, / or ⌘K) it stretches into the field. It suggests as you type, your Library first,
 * in a panel that rises above the dock; on the Search page it hands over to the page's own field. The button
 * at its end opens Browse (the Search page).
 */
export function NavSearch({
  anchor,
  bubble,
  onExpanded,
  phone = false,
}: {
  /** The search capsule: suggestions rise above it, lined up with its right edge. */
  anchor: RefObject<HTMLElement | null>;
  /** The capsule's bubble: it gives a little under each key. */
  bubble: RefObject<Bubble | null>;
  /** Whether it's a field now, for the bar around it to make room. */
  onExpanded?: (expanded: boolean) => void;
  /** On a phone the field and its suggestions take the bar's whole width. */
  phone?: boolean;
}) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [stored, setDraft] = useSearchDraft();
  // What was typed on one page doesn't follow you to the next; the Search page keeps its own in the URL.
  // Until the effect clears it, the old page's text reads as nothing, or leaving the Search page would
  // stretch this field open with its query for a frame and fold it again.
  const [typedOn, setTypedOn] = useState(pathname);
  const draft = typedOn === pathname ? stored : "";
  useEffect(() => {
    if (typedOn === pathname) return;
    setTypedOn(pathname);
    if (pathname !== "/search") setDraft("");
  }, [typedOn, pathname, setDraft]);
  const [focused, setFocused] = useState(false);
  const [selection, setSelection] = useState({ key: "", index: -1 });
  const [starting, setStarting] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const recent = useRecentSearches();
  const startTitle = useStartTitle();

  const onSearchPage = pathname === "/search";
  const q = draft.trim();
  const open = focused && !onSearchPage;
  // On the Search page the page's own field (right above the results) is the one you type in. On a phone the field
  // takes the places' room, so leaving it folds it back even with words in it; they're there when you come back.
  const expanded = !onSearchPage && (focused || (!phone && !!draft));
  useEffect(() => onExpanded?.(expanded), [expanded, onExpanded]);
  // Where the capsule is, kept current while it moves or changes size: a phone's keyboard lifts it after it opens.
  const [dock, setDock] = useState<DOMRect | null>(null);
  useEffect(() => {
    const el = anchor.current;
    if (!open || !el) return;
    let frame = 0;
    let last = "";
    const update = () => {
      // It moves without resizing when the keyboard rises, so it's read each frame; the page redraws only if it moved.
      const box = el.getBoundingClientRect();
      const key = `${box.left} ${box.top} ${box.width}`;
      if (key !== last) {
        last = key;
        setDock(box);
      }
      frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [open, anchor]);
  const panelWidth = phone ? innerWidth - 24 : Math.max(440, dock?.width ?? 440);
  const panelLeft = phone ? 12 : dock ? Math.max(16, dock.left + dock.width - panelWidth) : 16;

  // The highlight belongs to one list: typing or reopening starts again from the field.
  const listKey = `${open}:${q}`;
  const active = selection.key === listKey ? selection.index : -1;
  const setActive = (next: number | ((index: number) => number)) =>
    setSelection({ key: listKey, index: typeof next === "function" ? next(active) : next });

  const library = useOverview(open && !!q);
  const found = useSearch(useDebounced(open ? q : "", 250));
  const shown = found.data ?? found.stale?.data;

  const options = useMemo((): Option[] => {
    if (!q) return [{ kind: "browse" }, ...recent.slice(0, RECENT_ROWS).map((r) => ({ kind: "recent" as const, q: r }))];
    const out: Option[] = [];
    if (library) {
      const resumable = new Set([...library.watching, ...library.rewatching].map((e) => e.id));
      const match = libraryFilter("all", q);
      for (const e of allEntries(library).filter(match).slice(0, LIBRARY_ROWS))
        out.push({ kind: "library", id: e.id, imdb: ("imdb" in e && e.imdb) || undefined, type: e.type, name: e.name, poster: e.poster ?? art.poster(("imdb" in e && e.imdb) || e.id),
          note: e.note, progress: "progress" in e ? e.progress : undefined, resume: resumable.has(e.id) });
    }
    if (q.length >= 2 && shown) {
      if (shown.person && !shown.tags)
        out.push({ kind: "person", name: shown.person.name, role: shown.person.role, photo: shown.person.photo, count: shown.person.titles.length });
      // Not suggested again under its other id (an anime's IMDb id) either.
      const mine = new Set(out.flatMap((o) => (o.kind === "library" ? [o.id, ...(o.imdb ? [o.imdb] : [])] : [])));
      const titles = (shown.tags ? shown.genre?.results ?? [] : shown.results).filter((r) => !mine.has(r.id));
      for (const item of titles.slice(0, TITLE_ROWS)) out.push({ kind: "title", item });
    }
    if (q.length >= 2) out.push({ kind: "all" });
    return out;
  }, [q, recent, library, shown]);

  const done = () => {
    setDraft("");
    input.current?.blur();
  };
  const seeAll = (query = q) => {
    input.current?.blur();
    navigate(`/search?${new URLSearchParams({ q: query })}`);
  };
  const resume = async (id: string, type: Kind) => {
    setStarting(id);
    await startTitle({ id, type });
    setStarting(null);
    done();
  };
  const choose = (o: Option) => {
    if (o.kind === "browse") {
      done();
      navigate("/search");
    } else if (o.kind === "recent") {
      setDraft(o.q);
      input.current?.focus();
    } else if (o.kind === "library" || o.kind === "title") {
      addRecent(q);
      done();
      navigate(o.kind === "title" ? `/title/${o.item.type}/${o.item.id}` : `/title/${o.type}/${o.id}`);
    } else seeAll();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (open && active >= 0) setActive(-1);
      else if (draft) setDraft("");
      else input.current?.blur();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      // -1 is the field itself, so the list wraps through it.
      setActive((i) => {
        const next = i + step;
        return !options.length || next >= options.length ? -1 : next < -1 ? options.length - 1 : next;
      });
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const o = options[active];
      // A title you're in the middle of: Enter carries on, like the Continue button on its row.
      if (o?.kind === "library" && o.resume) void resume(o.id, o.type);
      else if (o) choose(o);
      else if (q.length >= 2) seeAll();
    }
  };

  const optionId = (i: number) => `${listId}-${i}`;
  const row = (i: number, children: ReactNode, className?: string) => (
    <div
      key={i}
      id={optionId(i)}
      role="option"
      aria-selected={i === active}
      onClick={() => choose(options[i])}
      onMouseMove={() => i !== active && setActive(i)}
      className={cx("group/row flex min-h-11 cursor-pointer items-center gap-3 rounded-[20px] px-2.5 py-2", i === active && "bg-white/10", className)}
    >
      {children}
    </div>
  );
  const poster = (src?: string, round?: boolean) => (
    <Art src={src} alt="" className={cx("w-9 shrink-0 img-outline", round ? "aspect-square rounded-full" : "aspect-2/3 rounded-[6px]", ART_FALLBACK)} />
  );
  const heading = (label: string) => <p className="px-2.5 pt-2.5 pb-1.5 text-caption font-medium text-fg-faint">{label}</p>;
  const text = (title: ReactNode, sub?: ReactNode) => (
    <span className="min-w-0 flex-1">
      <span className="block truncate font-medium text-fg">{title}</span>
      {sub && <span className="block truncate text-caption text-fg-faint">{sub}</span>}
    </span>
  );
  const chevron = <CaretRightIcon aria-hidden className="shrink-0 text-subhead text-fg-faint" />;

  const libraryCount = options.filter((o) => o.kind === "library").length;
  const firstTitle = options.findIndex((o) => o.kind === "person" || o.kind === "title");
  const titlesLoading = q.length >= 2 && !found.data;

  return (
    // On a phone it fills the capsule, since the field's width comes from the capsule's.
    <div className={cx("relative", phone && "min-w-0 flex-1")}>
      <form
        role="search"
        onSubmit={(e) => e.preventDefault()}
        // Anywhere on the resting button puts the cursor in the field.
        onMouseDown={(e) => {
          if (e.target === input.current || (e.target as HTMLElement).closest("a, button")) return;
          e.preventDefault();
          if (onSearchPage) {
            const field = visibleSearchField();
            field?.focus();
            field?.select();
          } else input.current?.focus();
        }}
        title={expanded ? undefined : "Search (/)"}
        className={cx(
          "flex h-13 cursor-text items-center rounded-full",
          phone ? "h-14 w-full" : "h-13",
          // Open, it's a field: an edge instead of a press, since clicks only move the cursor.
          expanded ? "pr-1.5 pl-3.5 text-fg" : "press-soft px-3.5 text-fg-muted hover:bg-white/8 hover:text-fg",
          // On the Search page it's where you are, so it wears the selection's lens.
          onSearchPage && "lens text-fg",
        )}
      >
        <MagnifyingGlassIcon aria-hidden className="shrink-0 text-[24px]" weight={onSearchPage ? "bold" : "regular"} />
        <input
          ref={input}
          value={draft}
          onChange={(e) => {
            bubble.current?.body.typed(e.target.value.length < draft.length);
            bubble.current?.wake();
            setDraft(e.target.value);
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={onKeyDown}
          data-search-field={onSearchPage ? undefined : true}
          tabIndex={onSearchPage ? -1 : undefined}
          role="combobox"
          aria-label="Search titles, people, genres and languages"
          aria-keyshortcuts="/ Control+K Meta+K"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
          placeholder={phone ? "Titles, people, genres" : "Search movies, shows, people"}
          enterKeyHint="search"
          autoComplete="off"
          spellCheck={false}
          className={cx(
            "min-w-0 bg-transparent text-body text-fg outline-hidden placeholder:text-fg-faint",
            "transition-[width,opacity,padding] duration-[360ms] ease-spring motion-reduce:duration-[1ms]",
            // The places stay beside it, so on a narrow window (or beside the Party panel) the field gives way.
            // On a phone the capsule's width (`dock-search`) moves it, so it can't hold the capsule open as a width of its own would.
            phone ? "w-0 flex-1" : expanded ? "w-[min(18.5rem,calc(100vw-26rem))]" : "w-0",
            expanded ? "pl-2.5 opacity-100" : "pl-0 opacity-0",
          )}
        />
        {/* On the Search page the draft is the page's query, and its own field has the clear button. */}
        {expanded && draft && (
          <button
            type="button"
            aria-label="Clear search"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setDraft("");
              input.current?.focus();
            }}
            className="grid size-8 shrink-0 place-items-center rounded-full text-fg-muted hover:bg-white/10 hover:text-fg"
          >
            <XIcon className="text-[14px]" />
          </button>
        )}
        {/* On a phone Browse is the panel's first row, and the field needs the room. */}
        {!phone && <span className="fold" data-folded={!expanded || undefined} inert={!expanded}>
          <span>
            <span className="flex items-center gap-1 pl-1">
              <span aria-hidden className="h-4 w-px shrink-0 bg-line" />
              <Link
                to="/search"
                // Pressing it would take focus from the field, which folds this away before the click lands.
                onMouseDown={(e) => e.preventDefault()}
                onClick={done}
                aria-label="Browse genres, languages and trending"
                title="Browse"
                className="grid size-10 shrink-0 place-items-center rounded-full text-[20px] text-fg-muted hover:bg-white/10 hover:text-fg"
              >
                <SquaresFourIcon />
              </Link>
            </span>
          </span>
        </span>}
      </form>

      {/* Out of the dock: it would dim the dock's own field from inside it, and the dock's transform would place the panel by the dock instead of the window. */}
      {createPortal(<>
      <div
        aria-hidden
        onPointerDown={() => input.current?.blur()}
        className={cx("fixed inset-0 z-30 bg-page/55 transition-opacity duration-150", open ? "opacity-100" : "pointer-events-none opacity-0")}
      />
      <Grow
        inline
        open={open && !!dock}
        // It grows out of the capsule.
        from={() => anchor.current!.getBoundingClientRect()}
        radius={28}
        // Keeps the cursor in the field while rows are clicked.
        onMouseDown={(e) => e.preventDefault()}
        className="z-50 max-w-none"
        style={{
          bottom: dock ? innerHeight - dock.top + 10 : undefined,
          left: panelLeft,
          width: panelWidth,
          maxHeight: dock ? dock.top - 24 : undefined,
        }}
      >
        <div className="p-2">
          <div id={listId} role="listbox" aria-label="Suggestions">
            {options.map((o, i) => {
              if (o.kind === "browse")
                return row(i, <>
                  <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-[8px] bg-white/6 text-[18px] text-fg-muted"><SquaresFourIcon /></span>
                  {text("Browse", "Genres, languages, decades and what’s trending")}
                  {chevron}
                </>);
              if (o.kind === "recent")
                return <div key={i}>
                  {i === 1 && heading("Recent searches")}
                  {row(i, <>
                    <span aria-hidden className="grid size-9 shrink-0 place-items-center text-[18px] text-fg-faint"><ClockCounterClockwiseIcon /></span>
                    <span className="min-w-0 flex-1 truncate text-fg-muted">{o.q}</span>
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-label={`Remove ${o.q} from recent searches`}
                      onClick={(e) => {
                        e.stopPropagation();
                        removeRecent(o.q);
                      }}
                      className="grid size-8 shrink-0 place-items-center rounded-full text-fg-faint opacity-0 group-hover/row:opacity-100 group-aria-selected/row:opacity-100 hover:bg-white/10 hover:text-fg"
                    >
                      <XIcon className="text-[14px]" />
                    </button>
                  </>)}
                </div>;
              if (o.kind === "library")
                return <div key={i}>
                  {i === 0 && heading("In your Library")}
                  {row(i, <>
                    {poster(o.poster)}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-fg"><Marked name={o.name} query={q} /></span>
                      <span className="block truncate text-caption text-fg-faint">{[kindLabel(o.type), o.note].filter(Boolean).join(" · ")}</span>
                      {o.progress !== undefined && o.progress > 0 && (
                        <span aria-hidden className="mt-1.5 block h-0.75 w-30 overflow-hidden rounded-full bg-white/15">
                          <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.round(o.progress * 100)}%` }} />
                        </span>
                      )}
                    </span>
                    {o.resume ? (
                      <button
                        type="button"
                        tabIndex={-1}
                        onClick={(e) => {
                          e.stopPropagation();
                          void resume(o.id, o.type);
                        }}
                        className="press relative inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full fill-primary bg-accent pr-3 pl-2.5 text-caption font-semibold text-on-accent hover:bg-accent-hover"
                      >
                        <span className={cx("inline-flex items-center gap-1.5", starting === o.id && "invisible")}>
                          <PlayIcon weight="fill" aria-hidden /> Continue
                        </span>
                        {starting === o.id && <span className="absolute inset-0 grid place-items-center"><Spinner /></span>}
                      </button>
                    ) : chevron}
                  </>)}
                </div>;
              if (o.kind === "person")
                return <div key={i}>
                  {i === firstTitle && heading(libraryCount ? "Everything else" : "Titles and people")}
                  {row(i, <>{poster(o.photo, true)}{text(o.name, `${o.role} · ${o.count} titles`)}{chevron}</>)}
                </div>;
              if (o.kind === "title")
                return <div key={i}>
                  {i === firstTitle && heading(libraryCount ? "Everything else" : "Titles")}
                  {row(i, <>
                    {poster(o.item.poster)}
                    {text(<Marked name={o.item.name} query={q} />, [o.item.year, kindLabel(o.item.type)].filter(Boolean).join(" · "))}
                    {chevron}
                  </>, !found.data ? "opacity-50" : undefined)}
                </div>;
              return <div key={i} className="mt-1 border-t border-line pt-1">
                {titlesLoading && firstTitle < 0 && (
                  <p role="status" className="px-2.5 pt-1.5 pb-2 text-caption text-fg-faint">Finding titles…</p>
                )}
                {row(i, <>
                  <span aria-hidden className="grid size-9 shrink-0 place-items-center text-[18px] text-fg-faint"><MagnifyingGlassIcon /></span>
                  <span className="min-w-0 flex-1 truncate text-fg-muted">See all results for “<span className="font-medium text-fg">{q}</span>”</span>
                  <span aria-hidden className="hidden shrink-0 items-center gap-3 text-caption text-fg-faint pointer-fine:flex">
                    <span className="flex items-center gap-1"><Kbd>↑↓</Kbd> move</span>
                    <span className="flex items-center gap-1"><Kbd>Enter</Kbd> open</span>
                  </span>
                </>)}
              </div>;
            })}
          </div>
          {!q && (
            <div className="mt-1 flex items-center justify-between border-t border-line px-2.5 pt-2.5 pb-1 text-caption text-fg-faint">
              <span className="flex items-center gap-1.5 pointer-coarse:invisible">Press <Kbd>/</Kbd> from any page</span>
              {recent.length > 0 && (
                <button type="button" onClick={clearRecent} className="-mr-1 rounded-full px-2 py-1 hover:bg-white/8 hover:text-fg">
                  Clear recent
                </button>
              )}
            </div>
          )}
        </div>
      </Grow>
      </>, document.body)}
    </div>
  );
}
