import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { barBubble } from "../../ui/barBubble";
import { useSearchParams } from "react-router";
import { Glass } from "bubli";
import type { Bubble } from "bubli/engine";
import { useReadyTiming } from "../../data/telemetry";
import { MagnifyingGlassIcon, XIcon } from "@phosphor-icons/react";
import { formatTags, GENRES, looksLikeTags, parseTags, tagsTitle, type Tags } from "../../../shared/tags";
import { addRecent, clearRecent, useRecentSearches } from "./recentSearches";
import { useBlurOnLeave } from "../../ui/keyboard";
import { Button, cx, EmptyState, IconButton, Segmented } from "../../ui/ui";
import { BrowseAll, RecentLine, TagBar } from "./components/Browse";
import {
  BestMatch,
  Delayed,
  PersonRail,
  ResultsGrid,
  ResultsSkeleton,
  TitleRail,
  type Found,
  type Result,
} from "./components/Results";
import { alsoMatching, pickTopResult } from "./components/topResult";
import { AddonSearchRails } from "./components/addonResults";
import { keepLoading } from "./components/paging";
import { paramsFor, useSearch, type SearchState } from "./components/useSearch";
import { useSearchDraft } from "./components/draft";
import { useNeedsTmdbKey } from "../../data/keys";
import { NeedsTmdbKey } from "../../ui/needsKey";

type Filter = "all" | "movie" | "series";
// Messages about the search sit under the field, centred on it rather than on the page.
const UNDER_FIELD = "max-w-3xl";

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  // Genre links from before tags (?genre=Comedy) read as the same tag.
  const urlQuery = params.get("q") ?? params.get("genre")?.toLowerCase() ?? "";
  // In the URL like the query, so Back and refresh keep it.
  const typeParam = params.get("type");
  const filter: Filter = typeParam === "movie" || typeParam === "series" ? typeParam : "all";
  // Shared with the dock's field, so what you typed elsewhere carries over to this page.
  const [input, setInput] = useSearchDraft();
  const inputRef = useRef<HTMLInputElement>(null);
  const bubble = useRef<Bubble | null>(null);
  const recent = useRecentSearches();

  // A URL update from our own typing must keep the draft's trailing space.
  useEffect(() => setInput((draft) => draft.trim() === urlQuery ? draft : urlQuery), [urlQuery, setInput]);

  // Keep the URL in step with typing, so back and refresh land on the same results.
  useEffect(() => {
    const q = input.trim();
    const t = setTimeout(() => {
      if (q !== urlQuery) setParams(paramsFor(q), { replace: true });
    }, 300);
    return () => clearTimeout(t);
  }, [input, urlQuery, setParams]);

  useBlurOnLeave(inputRef);
  useEffect(() => {
    if (!urlQuery) inputRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const query = urlQuery.trim();
  const browsing = query.length < 2;
  const tags = useMemo(() => parseTags(query), [query]);
  const needsKey = useNeedsTmdbKey();
  const found = useSearch(needsKey ? "" : query);
  useReadyTiming("search", !browsing && !!found.data, query);

  // Once per query, when its first results arrive; later pages don't touch the list.
  const d = found.data;
  const answered = !!d && (d.results.length > 0 || !!d.person || !!d.genre || d.anime.length > 0);
  useEffect(() => {
    if (query && answered) addRecent(query);
  }, [query, answered]);

  /** Tiles, chips and the Movies/Shows switch rewrite the query, so typing and tapping are one system. */
  const setQuery = (q: string) => {
    setInput(q);
    setParams(paramsFor(q));
  };
  const setFilter = (type: Filter) =>
    setParams((p) => {
      const next = new URLSearchParams(p);
      if (type === "all") next.delete("type");
      else next.set("type", type);
      return next;
    }, { replace: true });
  const typedTags = parseTags(input);
  const editTags = (edit: (t: Tags) => Tags) => setQuery(formatTags(edit(typedTags ?? { genres: [] })));
  const visible = useCallback((r: Result) => filter === "all" || r.type === filter, [filter]);

  const underField = !input.trim() ? (
    recent.length > 0 && <RecentLine recent={recent} onPick={setQuery} onClear={clearRecent} />
  ) : (
    // Once the search reads as tags, the bar moves under their heading, beside Movies or Shows.
    !browsing && !tags && looksLikeTags(input) && <TagBar tags={typedTags} onEdit={editTags} />
  );

  return (
    <main className="flex flex-col gap-8 px-4 pt-20 pb-16 md:px-12 md:pt-24">
      <h1 className="sr-only">Search</h1>
      <Glass
        as="form"
        {...barBubble("search-field")}
        preset="field"
        onBubble={(b: Bubble) => (bubble.current = b)}
        role="search"
        onSubmit={(e: React.FormEvent) => {
          e.preventDefault();
          setParams(paramsFor(input.trim()), { replace: true });
          inputRef.current?.blur();
        }}
        // It floats at the top as results pass under it, the page's own field at every size. Its focus is a soft outline, not a ring;
        // the transparent outline still paints in forced-colors mode.
        className="bubble-bar group/search sticky top-[calc(var(--inset-top)+12px)] z-45 flex h-14 w-full max-w-3xl items-center gap-3 rounded-full pr-2 pl-5 outline-2 outline-transparent focus-within:outline-white/25 md:top-[calc(var(--inset-top)+16px)]"
      >
        <MagnifyingGlassIcon size={20} className="shrink-0 text-fg-muted" />
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => {
            bubble.current?.body.typed(e.target.value.length < input.length);
            bubble.current?.wake();
            setInput(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape" && input) {
              e.preventDefault();
              setQuery("");
            }
          }}
          data-search-field
          // Short enough to show whole on a phone.
          placeholder="Titles, people, or “telugu comedy”"
          aria-label="Search titles, people, genres and languages"
          aria-keyshortcuts="/"
          enterKeyHint="search"
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent text-subhead text-fg outline-hidden placeholder:text-fg-faint"
        />
        {input && (
          <IconButton
            type="button"
            label="Clear search"
            size="sm"
            onClick={() => {
              setQuery("");
              inputRef.current?.focus();
            }}
          >
            <XIcon />
          </IconButton>
        )}
      </Glass>
      {underField && <div className="-mt-5">{underField}</div>}

      {needsKey ? (
        <NeedsTmdbKey className={UNDER_FIELD} />
      ) : browsing ? (
        <BrowseAll onEdit={editTags} />
      ) : tags ? (
        <TagResults
          tags={tags}
          typed={typedTags}
          onEdit={editTags}
          found={found}
          onType={(type) => setQuery(formatTags({ ...tags, type: type === "all" ? undefined : type }))}
        />
      ) : (
        <TitleResults query={query} found={found} filter={filter} onFilter={setFilter} onClear={() => setQuery("")} />
      )}
      {!needsKey && !browsing && found.data && !found.loading && !found.error && <SearchMore found={found} visible={tags ? undefined : visible} />}
    </main>
  );
}

/** What a tag query found: a heading that says what Krida understood, Movies or Shows, and the grid. */
function TagResults({
  tags,
  typed,
  onEdit,
  found,
  onType,
}: {
  tags: Tags;
  /** The tags as typed so far, which the chips follow before the search catches up. */
  typed: Tags | null;
  onEdit: (edit: (t: Tags) => Tags) => void;
  found: SearchState;
  onType: (type: Filter) => void;
}) {
  const items = found.data?.genre?.results;
  // A title that is also named like the tags ("Scary Movie") comes first, in a row of its own. Only
  // from Krida's server: the Cinemeta fallback matches loosely.
  const named = found.data?.tags ? found.data.results : [];
  const order = tags.sort === "best" ? "Highest rated first" : tags.sort === "new" ? "Out in the last 18 months" : "Most popular first";
  return (
    <>
      {named.length > 0 && <TitleRail title="Titles with this name" items={named} />}
      <section className="flex flex-col gap-6">
        <div className="flex flex-col gap-4">
          <div className="flex min-w-0 flex-col gap-1">
            <h2 className="text-title font-semibold text-balance md:text-display">{tagsTitle(tags)}</h2>
            <p role="status" className="h-5 text-body text-fg-muted">
              {found.error ? "" : found.loading ? "Finding them on TMDB…" : order}
            </p>
          </div>
          <TagBar
            tags={typed ?? tags}
            onEdit={onEdit}
            end={
              <Segmented
                label="Movies or shows"
                value={tags.type ?? "all"}
                onChange={onType}
                options={[
                  { value: "all", label: "All" },
                  { value: "movie", label: "Movies" },
                  { value: "series", label: "Shows" },
                ]}
              />
            }
          />
        </div>
        {found.error ? (
          <EmptyState
            title="Couldn’t load these"
            description="TMDB didn’t answer. Try again in a moment."
            action={<Button onClick={found.retry}>Try again</Button>}
          />
        ) : found.loading || !found.data ? (
          <ResultsSkeleton />
        ) : !items?.length && !found.hasMore ? (
          <EmptyState
            title={`Nothing for “${formatTags(tags)}”`}
            description={
              tags.type === "series" && tags.genres.some((g) => GENRES.find((x) => x.name === g)?.movieOnly)
                ? "TMDB doesn’t sort shows into that genre. Try movies."
                : "That mix is too narrow. Remove a tag and try again."
            }
            action={tags.type ? <Button onClick={() => onType("all")}>Show movies and shows</Button> : undefined}
          />
        ) : (
          <ResultsGrid items={items ?? []} />
        )}
      </section>
    </>
  );
}

/**
 * Title search results. When the search names one title it leads, with what else matches beside it;
 * a broad search is a plain grid, with the person you meant and anime seasons in rows above it.
 */
function TitleResults({
  query,
  found,
  filter,
  onFilter,
  onClear,
}: {
  query: string;
  found: SearchState;
  filter: Filter;
  onFilter: (filter: Filter) => void;
  onClear: () => void;
}) {
  // While a refined search loads, the last one stays, dimmed, instead of blanking the page.
  const stale = found.stale && !found.stale.data.tags ? found.stale : undefined;
  const shown = found.data ?? stale?.data;
  const results = shown?.results;
  // Counts only when they're final: every page loaded, and not the previous search's.
  const exact = !!found.data && !found.hasMore;
  const counts = useMemo(
    () => ({
      movie: (results ?? []).filter((m) => m.type === "movie").length,
      series: (results ?? []).filter((m) => m.type === "series").length,
    }),
    [results],
  );
  return (
    <section className="flex flex-col gap-8">
      {/* Held at the filter's height (its tabs are 44px), so results don't move when it arrives. */}
      <div className="flex h-11 items-center">
        {results?.length ? (
          <Segmented
            label="Filter results"
            value={filter}
            onChange={onFilter}
            options={[
              { value: "all", label: "All", count: exact ? results.length : undefined },
              { value: "movie", label: "Movies", count: exact ? counts.movie : undefined },
              { value: "series", label: "Shows", count: exact ? counts.series : undefined },
            ]}
          />
        ) : (
          found.loading && (
            <Delayed>
              <p role="status" className="text-body text-fg-muted">
                Searching TMDB and Cinemeta…
              </p>
            </Delayed>
          )
        )}
      </div>
      {found.error ? (
        <EmptyState
          className={UNDER_FIELD}
          title="Search isn’t answering"
          description="Neither TMDB nor Cinemeta responded. Check your connection and try again."
          action={<Button onClick={found.retry}>Try again</Button>}
        />
      ) : found.data ? (
        <TitleMatches query={query} data={found.data} filter={filter} hasMore={found.hasMore} onFilter={onFilter} onClear={onClear} />
      ) : stale ? (
        <div aria-busy="true" className="pointer-events-none flex flex-col gap-8 opacity-50">
          <TitleMatches query={stale.query} data={stale.data} filter={filter} hasMore onFilter={onFilter} onClear={onClear} />
        </div>
      ) : (
        <ResultsSkeleton />
      )}
    </section>
  );
}

function TitleMatches({
  query,
  data,
  filter,
  hasMore,
  onFilter,
  onClear,
}: {
  query: string;
  data: Found;
  filter: Filter;
  hasMore: boolean;
  onFilter: (filter: Filter) => void;
  onClear: () => void;
}) {
  const { person, anime, results } = data;
  const all = filter === "all";
  // Later batches only append, so the top result and its namesakes stay put while the grid grows.
  const best = useMemo(() => {
    const top = pickTopResult(query, results, person);
    return top ? { top, also: alsoMatching(query, results, top) } : null;
  }, [query, results, person]);
  const filtered = results.filter((m) => all || m.type === filter);

  if (filtered.length === 0 && !(all && (person || anime.length)) && !hasMore)
    return (
      <EmptyState
        className={UNDER_FIELD}
        title={`No results for “${query}”`}
        description={
          !all && results.length > 0
            ? `There ${results.length === 1 ? "is 1 result" : `are ${results.length} results`} in other types.`
            : "Check the spelling, try fewer words, or search a genre like “telugu comedy”."
        }
        action={!all ? <Button onClick={() => onFilter("all")}>Show all results</Button> : <Button onClick={onClear}>Clear search</Button>}
      />
    );

  if (all && best) {
    const shown = new Set([best.top, ...best.also]);
    const rest = results.filter((m) => !shown.has(m));
    return (
      <>
        <BestMatch top={best.top} also={best.also} person={person} />
        {person && <PersonRail person={person} />}
        {anime.length > 0 && <TitleRail title="Anime" items={anime} />}
        <AddonSearchRails query={query} filter={filter} />
        {rest.length > 0 && (
          <section className="flex flex-col gap-3">
            <h2 className="text-title font-semibold">More results</h2>
            <ResultsGrid items={rest} />
          </section>
        )}
      </>
    );
  }

  return (
    <>
      {person && all && <PersonRail person={person} />}
      {anime.length > 0 && all && <TitleRail title="Anime" items={anime} />}
      <AddonSearchRails query={query} filter={filter} />
      {filtered.length > 0 && (
        <section className="flex flex-col gap-3">
          {all && (person || anime.length > 0) && <h2 className="text-title font-semibold">Titles</h2>}
          <ResultsGrid items={filtered} />
        </section>
      )}
    </>
  );
}

/**
 * The end of the results: loads the next batch as it comes into view, and says what's happening. One
 * observer reports whether the end is near; loading continues only while batches add visible titles
 * (see `keepLoading`), then the button takes over.
 */
function SearchMore({ found, visible }: { found: SearchState; visible?: (r: Result) => boolean }) {
  const sentinel = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const { hasMore, loadingMore, moreError, loadMore, batches } = found;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => setNear(entries[entries.length - 1].isIntersecting), {
      rootMargin: "600px 0px",
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const auto = hasMore && keepLoading(batches, visible ?? (() => true));
  // Runs again after every batch (loadMore changes with the data): the next one loads only if the end is still near.
  useEffect(() => {
    if (near && auto && !loadingMore && !moreError) void loadMore();
  }, [near, auto, loadingMore, moreError, loadMore]);
  const count = found.data?.tags ? found.data.genre?.results.length ?? 0 : found.data?.results.length ?? 0;
  const shown = hasMore || count > 0;
  return (
    <div ref={sentinel} className={cx("flex flex-col items-center justify-center gap-3 text-center", shown && "min-h-20")}>
      {shown && (
        <>
          <p role="status" aria-live="polite" className="text-body text-fg-muted">
            {moreError
              ? "Couldn't load more titles. Your results are still here."
              : loadingMore
                ? "Finding more titles…"
                : !hasMore
                  ? "You've reached the end of these results."
                  : auto
                    ? "More titles load as you scroll."
                    : "Fewer matches from here on."}
          </p>
          {hasMore && (
            <Button className="min-h-11" onClick={() => void loadMore()} loading={loadingMore}>
              {moreError ? "Try again" : "Load more titles"}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
