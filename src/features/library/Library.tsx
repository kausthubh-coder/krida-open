import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { useMutation } from "convex/react";
import { useQuery } from "convex-helpers/react/cache/hooks";
import type { FunctionReturnType } from "convex/server";
import {
  BookmarkSimpleIcon, BooksIcon, CaretLeftIcon, CaretRightIcon, ChartBarIcon, CheckCircleIcon, MagnifyingGlassIcon, PauseCircleIcon,
  PlayCircleIcon, PlugsConnectedIcon, SparkleIcon, StarIcon, XCircleIcon, type Icon,
} from "@phosphor-icons/react";
import { api } from "../../../convex/_generated/api";
import { useAuthed } from "../../data/session";
import { useStored } from "../../data/stored";
import { useBacklog, useOverview, type Backlog, type Overview } from "./libraryData";
import { art } from "../../data/cinemeta";
import { activeFilters, allEntries, filtersLabel, genreIndex, libraryFilter, matchesFilters, NO_FILTERS, type Filters, type Sort } from "./filters";
import { plural } from "../../ui/format";
import { Art } from "../../ui/artwork";
import { Button, ButtonLink, cx, EmptyState } from "../../ui/ui";
import { FilterMenu, PosterSkeletons, SearchField, SortSelect, WideSkeletons, type SortChoice } from "./components/shared";
import { UpNext } from "./components/UpNext";
import { PlanToWatch, Watched } from "./components/Watched";
import { ToRate } from "./components/ToRate";
import { UnwatchWarnings } from "./components/UnwatchWarnings";
import { StatsView } from "./components/Stats";
import { Wrapped } from "./components/Wrapped";

export type Collection = "plan" | "watching" | "watched" | "rate" | "hold" | "dropped" | "stats";
type Titles = Exclude<Collection, "stats">;

const COLLECTIONS: Collection[] = ["plan", "watching", "watched", "rate", "hold", "dropped", "stats"];
// Addresses from before, so old links still land somewhere sensible.
const LEGACY: Record<string, Collection> = { next: "watching", list: "plan", all: "plan" };

const TITLES: Record<Collection, string> = {
  plan: "Plan to watch", watching: "Watching", watched: "Watched", rate: "To rate", hold: "On hold", dropped: "Dropped", stats: "Stats",
};
const ICONS: Record<Collection, Icon> = {
  plan: BookmarkSimpleIcon, watching: PlayCircleIcon, watched: CheckCircleIcon, rate: StarIcon, hold: PauseCircleIcon, dropped: XCircleIcon, stats: ChartBarIcon,
};
const NOTES: Record<Titles, string> = {
  plan: "Your watchlist: saved here or on Simkl.",
  watching: "What you’re in the middle of. Nearly finished comes first.",
  watched: "Your diary, newest first.",
  rate: "Titles you finished but haven’t scored. Scores sharpen your picks.",
  hold: "Paused for now. Your progress is kept.",
  dropped: "Titles you stopped. They stay out of your picks.",
};
// The sorts each collection offers, its own order first under the name that fits it.
const SORTS: Partial<Record<Titles, { options: Sort[]; recent: string }>> = {
  plan: { options: ["recent", "released", "title"], recent: "Date added" },
  watching: { options: ["recent", "title", "released"], recent: "Last watched" },
  watched: { options: ["recent", "score", "released", "title"], recent: "Most recent" },
  hold: { options: ["recent", "title", "released"], recent: "Last watched" },
  dropped: { options: ["recent", "title", "released"], recent: "Last watched" },
};
// Only the diary has enough scores to filter by.
const scoresIn = (c: Collection) => c === "watched";

const wide = () => window.matchMedia("(min-width: 768px)");
/** Phones show the list of collections first; wider screens keep it beside the open one. */
function useWide() {
  return useSyncExternalStore((cb) => {
    const m = wide();
    m.addEventListener("change", cb);
    return () => m.removeEventListener("change", cb);
  }, () => wide().matches);
}

export function LibraryPage() {
  const { token, me } = useAuthed();
  // Opening the Library shows what it last held while the live list loads.
  const data = useStored("library:overview", { token, separateStatuses: true }, useOverview());
  return <LibraryView key={me._id} data={data} />;
}

export function LibraryView({ data }: { data: Overview | undefined }) {
  const { token, me } = useAuthed();
  const isWide = useWide();
  const [params, setParams] = useSearchParams();
  const raw = params.get("tab") ?? "";
  const asked = LEGACY[raw] ?? (COLLECTIONS.includes(raw as Collection) ? (raw as Collection) : null);
  // On a phone, no collection means the list of them; wider screens open Plan to watch beside it.
  const current: Collection | null = asked ?? (isWide ? "plan" : null);
  // Search and sort belong to the collection they were set in; filters follow you between them.
  const [queries, setQueries] = useState<Partial<Record<Collection, string>>>({});
  const query = (current && queries[current]) ?? "";
  const setQuery = (q: string) => current && setQueries((v) => ({ ...v, [current]: q }));
  const [sorts, setSorts] = useState<Partial<Record<Collection, Sort>>>({});
  const sort = (current && sorts[current]) ?? "recent";
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const filtersFor = (c: Collection): Filters => (scoresIn(c) ? filters : { ...filters, score: "all" });
  const [wrapped, setWrapped] = useState(false);
  const [now] = useState(Date.now);
  const [refreshError, setRefreshError] = useState(false);
  const backlog = useBacklog();
  const [genresWanted, setGenresWanted] = useState(false);
  const genres = useGenres(data, backlog, genresWanted || filters.genres.length > 0);
  const genreOptions = useMemo(() => genres && genreChoices(genres, filters.genres), [genres, filters.genres]);
  const simkl = useQuery(api.simkl.syncState, { token });
  // Stats are read only while they're shown: rebuilding them rewrites this row.
  const result = useQuery(api.wrapped.get, current === "stats" || wrapped ? { token, now } : "skip");
  const refresh = useMutation(api.wrapped.refreshSoon);
  const refreshStats = () => {
    setRefreshError(false);
    void refresh({ token, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }).catch(() => setRefreshError(true));
  };
  useEffect(() => {
    if (current === "stats" || wrapped) void refresh({ token, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }).catch(() => setRefreshError(true));
  }, [current, wrapped, refresh, token]);

  const totals = countsOf(data, backlog, () => () => true);
  const counts = countsOf(data, backlog, (c) => matchesFilters(filtersFor(c), genres));
  const firstRun = data !== undefined && backlog !== undefined && Object.values(totals).every((n) => !n);
  const filtering = current ? activeFilters(filtersFor(current)) > 0 : activeFilters(filters) > 0;
  const searched = libraryFilter("all", query);
  const filtered = current && matchesFilters(filtersFor(current), genres);
  const show = (e: { type: "movie" | "series"; id: string; name: string; year?: string; rating?: number }) => searched(e) && (!filtered || filtered(e));
  const clear = () => { setQuery(""); setFilters(NO_FILTERS); };
  const noMatch = <EmptyState icon={<MagnifyingGlassIcon />}
    title={query.trim() ? `Nothing here matches “${query.trim()}”` : "Nothing here matches your filters"}
    description={query.trim() && filtering ? "Try fewer words, or clear the filters too." : query.trim() ? "Check the spelling, or try fewer words." : "Try another filter, or clear them to see everything here."}
    action={<Button onClick={clear}>{query.trim() && filtering ? "Clear search and filters" : query.trim() ? "Clear search" : "Clear filters"}</Button>} />;
  const filterNote = (c: Collection | null) => (c ? activeFilters(filtersFor(c)) : activeFilters(filters)) > 0 && (
    <p className="flex flex-wrap items-center gap-x-1 text-body text-fg-muted">
      <span>{filtersLabel(c ? filtersFor(c) : filters)}
        {c && c !== "stats" && totals[c] !== undefined && <span className="text-fg-faint tabular-nums"> · {counts[c]?.toLocaleString()} of {totals[c]!.toLocaleString()}</span>}</span>
      <button onClick={() => setFilters(NO_FILTERS)} className="-my-2 rounded-full px-2 py-2 font-medium text-fg underline-offset-4 hover:underline">Clear filters</button>
    </p>
  );

  const nav = <CollectionNav current={current} counts={counts} data={data} backlog={backlog} onWrapped={() => setWrapped(true)} />;
  const offered = current && current !== "stats" ? SORTS[current] : undefined;
  const sortChoice: SortChoice | undefined = current && offered ? { ...offered, value: sort, onChange: (s) => setSorts((v) => ({ ...v, [current]: s })) } : undefined;
  return <main className="flex flex-col px-4 pt-20 pb-16 md:px-12 md:pt-24 short:pt-16">
    {firstRun ? <><h1 className="font-display text-display font-semibold md:text-hero">Library</h1><FirstRun simkl={simkl} /></>
      : !current ? <><h1 className="font-display text-display font-semibold">Library</h1>
        {filtering && <div className="mt-3">{filterNote(null)}</div>}{nav}</>
        : <div className="flex gap-10 short:gap-6">
          {isWide && <aside className="sticky top-24 w-52 shrink-0 self-start lg:w-56 short:top-16">{nav}</aside>}
          <div className="min-w-0 flex-1">
            {!isWide && <Link to="/library" className="-ml-2 inline-flex min-h-11 items-center gap-1 rounded-control px-2 text-body font-medium text-fg-muted hover:text-fg">
              <CaretLeftIcon aria-hidden /> Library</Link>}
            {current !== "stats" && <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-4">
              <div className="min-w-0">
                <h1 className="flex items-baseline gap-3 font-display text-display font-semibold md:text-hero">{TITLES[current]}
                  {counts[current] !== undefined && <span aria-hidden className="font-sans text-subhead font-medium text-fg-faint tabular-nums">{counts[current]!.toLocaleString()}</span>}</h1>
                {/* One line under the title either way, so nothing below moves when a filter is set. */}
                <div className="mt-2 min-h-5">{filterNote(current) || <p className="text-body text-fg-muted">{NOTES[current]}</p>}</div>
              </div>
              {totals[current] ? <div className="flex w-full items-center gap-2 lg:w-auto">
                <SearchField value={query} onChange={setQuery} />
                {sortChoice && <SortSelect {...sortChoice} />}
                <FilterMenu value={filters} onChange={setFilters} scores={scoresIn(current)} sort={sortChoice}
                  genres={genreOptions} onIntent={() => setGenresWanted(true)} />
              </div> : null}
            </header>}
            <div className={cx("min-w-0", current !== "stats" && "mt-8")}>
              <CollectionView current={current} data={data} show={show} sort={sort} noMatch={noMatch} result={result}
                refreshError={refreshError} onRefresh={refreshStats} onWrapped={() => setWrapped(true)}
                onRate={() => setParams({ tab: "rate" })} backlog={backlog} narrowed={filtering || !!query.trim()} />
            </div>
          </div>
        </div>}
    {wrapped && <Wrapped stats={result?.stats} name={me.name} computing={result?.computing} onClose={() => setWrapped(false)} onRefresh={refreshStats} />}
  </main>;
}

/**
 * Genres for every title in the Library, asked for only once someone reaches for the filter. Titles nobody
 * has looked up yet are looked up once a visit, and arrive as they're found.
 */
function useGenres(data: Overview | undefined, backlog: Backlog | undefined, wanted: boolean) {
  const { token } = useAuthed();
  const types = useMemo(() => new Map([...(data ? allEntries(data) : []), ...backlog?.items ?? []].map((e) => [e.id, e.type])), [data, backlog]);
  // Sorted, so a reorder asks the same question and the cached answer holds.
  const ids = useMemo(() => [...types.keys()].sort(), [types]);
  const live = useQuery(api.library.genres, wanted && data && backlog ? { token, ids } : "skip");
  // The last answer stays while a changed Library asks again, so filtered grids don't blink empty.
  const [kept, setKept] = useState(live);
  if (live !== undefined && live !== kept) setKept(live);
  const fill = useMutation(api.library.fillGenres);
  const asked = useRef(false);
  useEffect(() => {
    if (!kept?.missing.length || asked.current) return;
    asked.current = true;
    void fill({ token, items: kept.missing.slice(0, 200).map((id) => ({ id, type: types.get(id) ?? "movie" })) }).catch(() => {});
  }, [kept, fill, token, types]);
  return useMemo(() => kept && genreIndex(kept.titles), [kept]);
}

/**
 * The genres a Library has most of, plus the chosen ones wherever they rank. Shown A–Z, so pills keep their
 * place while late lookups shift the counts.
 */
function genreChoices(genres: Map<string, string[]>, chosen: string[]) {
  const tally = new Map<string, number>();
  for (const list of genres.values()) for (const g of list) tally.set(g, (tally.get(g) ?? 0) + 1);
  const top = [...tally].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([g]) => g);
  for (const g of chosen) if (!top.includes(g)) top.push(g);
  return top.sort((a, b) => a.localeCompare(b)).map((g) => ({ value: g, label: g }));
}

type Show = (e: { type: "movie" | "series"; id: string; name: string; year?: string; rating?: number }) => boolean;
type Counts = Record<Collection, number | undefined>;
function countsOf(data: Overview | undefined, backlog: Backlog | undefined, match: (c: Collection) => Show): Counts {
  const count = (c: Collection, list: Parameters<Show>[0][] | undefined) => list?.filter(match(c)).length;
  return {
    plan: count("plan", data?.list),
    watching: count("watching", data && [...data.watching, ...data.rewatching]),
    watched: count("watched", data?.watched),
    rate: count("rate", backlog?.items),
    hold: count("hold", data?.hold),
    dropped: count("dropped", data?.dropped),
    stats: undefined,
  };
}

function CollectionView({ current, data, show, sort, noMatch, result, refreshError, onRefresh, onWrapped, onRate, backlog, narrowed }: {
  current: Collection; data: Overview | undefined; show: Show; sort: Sort; noMatch: ReactNode;
  result: FunctionReturnType<typeof api.wrapped.get> | undefined; refreshError: boolean; onRefresh: () => void; onWrapped: () => void;
  onRate: () => void; backlog: Backlog | undefined; narrowed: boolean;
}) {
  if (current === "stats") return <StatsView result={result} error={refreshError} onRefresh={onRefresh} onWrapped={onWrapped} />;
  if (current === "rate") return <><UnwatchWarnings /><ToRate show={show} noMatch={noMatch} /></>;
  if (data === undefined) return <div aria-busy="true"><p role="status" className="sr-only">Loading your Library…</p>
    {current === "watching" || current === "hold" || current === "dropped" ? <WideSkeletons /> : <PosterSkeletons />}</div>;
  if (current === "watching")
    return <UpNext data={{ ...data, watching: [...data.watching, ...data.rewatching] }} status="watching" sort={sort} show={show} noMatch={noMatch} />;
  if (current === "hold" || current === "dropped") return <UpNext data={data} status={current} sort={sort} show={show} noMatch={noMatch} />;
  if (current === "plan") return <PlanToWatch data={data} sort={sort} show={show} noMatch={noMatch} />;
  // The rating nudge is noise while you're looking for something.
  return <><UnwatchWarnings /><Watched data={data} sort={sort} show={show} noMatch={noMatch} onRate={onRate}
    toRate={backlog && !narrowed ? { count: backlog.items.length, posters: backlog.items.flatMap((i) => i.poster ?? art.poster(i.imdb ?? i.id) ?? []).slice(0, 4) } : undefined} /></>;
}

/**
 * The Library's collections, named and counted: a column beside the open one on wide screens, the page
 * itself on phones (with a few posters from each, so the list reads at a glance).
 */
function CollectionNav({ current, counts, data, backlog, onWrapped }: {
  current: Collection | null; counts: Counts; data: Overview | undefined; backlog: Backlog | undefined; onWrapped: () => void;
}) {
  const posters = (c: Collection): string[] => {
    if (!data) return [];
    const list = c === "plan" ? data.list : c === "watching" ? [...data.watching, ...data.rewatching]
      : c === "watched" ? data.watched : c === "rate" ? backlog?.items ?? [] : c === "hold" ? data.hold : c === "dropped" ? data.dropped : [];
    return list.slice(0, 3).flatMap((e) => e.poster ?? art.poster(("imdb" in e && e.imdb) || e.id) ?? []);
  };
  const item = (c: Collection) => <CollectionLink key={c} c={c} current={current} count={counts[c]} posters={current ? [] : posters(c)} />;
  const tile = (c: Collection) => <CollectionTile key={c} c={c} count={counts[c]} posters={posters(c)} />;
  const showHold = !!data?.hold.length || current === "hold";
  const showDropped = !!data?.dropped.length || current === "dropped";
  return <nav aria-label="Library" className={cx("flex flex-col", !current && "mt-6 gap-6")}>
    {/* On the phone's page the four you come here for are tiles, each showing what's in it. */}
    {current ? <Group>{item("plan")}{item("watching")}{item("watched")}{(!!backlog?.items.length || current === "rate") && item("rate")}</Group>
      : <div className="grid grid-cols-2 gap-3">{tile("plan")}{tile("watching")}{tile("watched")}{!!backlog?.items.length && tile("rate")}</div>}
    {(showHold || showDropped) && <Group label="Set aside">{showHold && item("hold")}{showDropped && item("dropped")}</Group>}
    <Group label="Look back">
      {item("stats")}
      <button onClick={onWrapped} className={cx(rowClass(false, !current), "text-left")}>
        <Lead page={!current} icon={SparkleIcon} active={false} /><span className="flex-1">Wrapped</span>
        {!current && <CaretRightIcon aria-hidden className="text-fg-faint" />}
      </button>
    </Group>
  </nav>;
}

function Group({ label, children }: { label?: string; children: ReactNode }) {
  return <div className="flex flex-col max-md:overflow-hidden max-md:rounded-sheet max-md:bg-surface max-md:shadow-raised md:mt-6 md:first:mt-0">
    {label && <h2 className="px-3 pb-1 text-caption font-medium text-fg-faint max-md:pt-3 max-md:pl-4">{label}</h2>}
    {children}
  </div>;
}

const rowClass = (active: boolean, page: boolean) => cx(
  "group/row flex min-h-11 items-center gap-3 font-medium",
  page ? "min-h-16 border-t border-line px-4 py-2 text-subhead first:border-t-0 hover:bg-white/4"
    : cx("rounded-control px-3 text-body", active ? "fill-raised bg-white/8 text-fg" : "fill-hover text-fg-muted hover:bg-white/5 hover:text-fg"),
);

/** Every row starts on the same edge: an icon in the column, a poster stack (or an icon in its place) on the phone page. */
function Lead({ page, icon: I, active, posters = [] }: { page: boolean; icon: Icon; active: boolean; posters?: string[] }) {
  if (page && posters.length > 0) return <span aria-hidden className="flex w-16 shrink-0">
    {posters.map((p) => <Art key={p} src={p} alt="" className="-ml-4 aspect-2/3 w-8 rounded-[6px] shadow-[0_0_0_2px_var(--color-surface)] first:ml-0" />)}
  </span>;
  if (page) return <span aria-hidden className="grid h-12 w-16 shrink-0 place-items-center"><I className="text-[24px] text-fg-faint" /></span>;
  return <I aria-hidden weight={active ? "fill" : "regular"} className={cx("shrink-0 text-[18px]", active ? "text-fg" : "text-fg-faint group-hover/row:text-fg-muted")} />;
}

/** Three posters fanned at the top of the tile; the name and how many sit under them, where a thumb lands. */
function CollectionTile({ c, count, posters }: { c: Collection; count: number | undefined; posters: string[] }) {
  const Icon = ICONS[c];
  const fan = ["-rotate-12 -translate-x-11", "rotate-12 translate-x-11", ""];
  return <Link to={`/library?tab=${c}`} className="press-soft relative isolate flex h-48 flex-col justify-end overflow-hidden rounded-[24px] bg-surface p-3.5 img-outline">
    {posters.length ? <span aria-hidden className="absolute inset-x-0 top-3 -z-10 flex h-36 justify-center">
      {posters.slice(0, 3).map((p, i) => <Art key={p} src={p} alt="" className={cx("absolute aspect-2/3 w-22 rounded-[10px] shadow-[0_6px_16px_-4px_oklch(0_0_0/0.6)] img-outline", fan[posters.length === 1 ? 2 : i], i === 0 && posters.length > 1 && "z-0", i === 2 && "z-1")} />)}
    </span> : <span aria-hidden className="absolute inset-x-0 top-10 -z-10 grid place-items-center"><Icon className="text-[40px] text-fg-faint" /></span>}
    <span aria-hidden className="absolute inset-0 -z-10 bg-linear-to-t from-surface from-30% to-transparent to-70%" />
    <span className="text-subhead font-semibold">{TITLES[c]}</span>
    {count !== undefined && <span className="text-caption text-fg-muted tabular-nums">{plural(count, "title", "titles")}</span>}
  </Link>;
}

function CollectionLink({ c, current, count, posters }: { c: Collection; current: Collection | null; count: number | undefined; posters: string[] }) {
  const page = !current;
  const active = c === current;
  return <Link to={`/library?tab=${c}`} replace={!page} aria-current={active ? "page" : undefined} className={rowClass(active, page)}>
    <Lead page={page} icon={ICONS[c]} active={active} posters={posters} />
    <span className="flex min-w-0 flex-1 flex-col">
      {TITLES[c]}
      {page && count !== undefined && <span className="text-caption font-normal text-fg-faint tabular-nums">{plural(count, "title", "titles")}</span>}
    </span>
    {!page && count !== undefined && <span className="text-caption text-fg-faint tabular-nums">{count.toLocaleString()}</span>}
    {page && <CaretRightIcon aria-hidden className="text-fg-faint" />}
  </Link>;
}

/** Nothing anywhere yet: one welcome instead of empty collections. */
function FirstRun({ simkl }: { simkl: FunctionReturnType<typeof api.simkl.syncState> | undefined }) {
  return <div className="mt-10 flex flex-col items-center gap-4 rounded-sheet bg-surface px-6 py-16 text-center shadow-raised md:py-24">
    <BooksIcon aria-hidden className="text-[40px] text-fg-faint" />
    <h2 className="max-w-[24ch] font-display text-display font-semibold">Everything you watch collects here</h2>
    <p className="max-w-[48ch] text-body text-fg-muted">Start something and it waits in Watching. Choose Plan to watch to keep a title for later, and score what you finish to sharpen your picks.
      {simkl === null && " Already track what you watch on Simkl? Connect it to bring your whole history in."}</p>
    <div className="mt-2 flex flex-wrap justify-center gap-2">
      <ButtonLink to="/search" variant="primary" icon={<MagnifyingGlassIcon />}>Find something to watch</ButtonLink>
      {simkl === null && <ButtonLink to="/settings/taste" icon={<PlugsConnectedIcon />}>Connect Simkl</ButtonLink>}
    </div>
  </div>;
}
