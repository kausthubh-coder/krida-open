import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { Link } from "react-router";
import { useConvex } from "convex/react";
import { useQuery } from "convex-helpers/react/cache/hooks";
import { toast } from "../../../ui/toast";
import { CaretDownIcon, CheckIcon, PlayIcon, SpeakerHighIcon, SpeakerSlashIcon, UsersThreeIcon } from "@phosphor-icons/react";
import { api } from "../../../../convex/_generated/api";
import type { SearchOut } from "../../../data/api";
import { useAuthed } from "../../../data/session";
import { useParty, useOpenStartParty } from "../../party";
import { art, getMeta, useAsync } from "../../../data/cinemeta";
import { plural } from "../../../ui/format";
import { mediaFor, usePlay } from "../../play";
import { useWatchStatus } from "../../../data/mine";
import { useMovieProgress } from "../../../data/rows";
import { useAmbientTrailers, usePreviewOpen, useTrailerSound, useTitleTrailer, useWarmRow, AmbientTrailer, ExpandingPoster } from "../../trailers";
import { usePrefetchTitle } from "../../../data/prefetch";
import { Art, ART_FALLBACK, TitleArt } from "../../../ui/artwork";
import { CardActions, CardMenu, ListButton } from "../../title";
import { POSTER_WIDTH, Rail } from "../../../ui/rail";
import { Button, cx, IconButton } from "../../../ui/ui";
import { statusLabel, type WatchStatus } from "../../../data/watchStatus";
import { playPlan } from "./playPlan";

export type Found = SearchOut;
export type Result = Found["results"][number];
type Person = NonNullable<Found["person"]>;

// Art's own fallback surface, for boxes that already carry the title in text.
export { ART_FALLBACK };

const PERSON_ROW = "search-person";
const kindLabel = (type: Result["type"]) => (type === "movie" ? "Movie" : "Show");
const resultSubtitle = (m: { year?: string; type: Result["type"] }) => [m.year, kindLabel(m.type)].filter(Boolean).join(" · ");

/** Shown only if the wait is long enough to notice. */
export function Delayed({ children }: { children: ReactNode }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 300);
    return () => clearTimeout(t);
  }, []);
  return <div className={cx("contents", !visible && "[&>*]:invisible")}>{children}</div>;
}

/** Rails bring their own page padding. */
export const FullBleed = ({ children }: { children: ReactNode }) => <div className="-mx-4 md:-mx-12">{children}</div>;

// The skeleton's columns; the grid itself works its columns out from its width.
const grid = "grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-posters";
// Home's gap between posters.
const GAP = 16;

/** A result's poster; in the grid it takes the column's width (`--card`). */
export function ResultCard({ item: m, width = "w-(--card)" }: { item: Result; width?: string }) {
  const status = useWatchStatus(m.id);
  const progress = useMovieProgress(m.id, m.type);
  const startTitle = useStartTitle();
  const target = useTitleTarget();
  return (
    <CardMenu item={m} to={`/title/${m.type}/${m.id}`} onPlay={() => startTitle(m)}>
      <ExpandingPoster
        item={m}
        subtitle={resultSubtitle(m)}
        score={{ rating: m.rating, ratingSource: "tmdb" }}
        badge={status ? <WatchBadge status={status} /> : undefined}
        progress={progress}
        actions={<CardActions item={m} />}
        onPlay={() => startTitle(m)}
        playMedia={async () => (await target(m)).media}
        width={width}
      />
    </CardMenu>
  );
}

/**
 * Results as rows of posters that open into their trailers like Home's: each row is its own strip, so a
 * poster widening pushes only its row's neighbours aside (past the page's edge) and the rows below stay put.
 */
export function ResultsGrid({ items }: { items: Result[] }) {
  const box = useRef<HTMLDivElement>(null);
  const probe = useRef<HTMLDivElement>(null);
  const width = useWidth(box);
  // Home's poster width (`--poster-w`), which grows with the screen's height.
  const card = useWidth(probe) || 184;
  const columns = Math.max(2, Math.round((width + GAP) / (card + GAP)));
  const rows: Result[][] = [];
  if (width) for (let i = 0; i < items.length; i += columns) rows.push(items.slice(i, i + columns));
  return (
    <div
      ref={box}
      role="list"
      className="relative flex flex-col gap-y-6"
      style={{ ["--card" as string]: `${(width - GAP * (columns - 1)) / columns}px` }}
    >
      <div ref={probe} aria-hidden className="absolute w-(--poster-w)" />
      {rows.map((row, r) => (
        <ResultRow key={r} items={row} first={r * columns} />
      ))}
    </div>
  );
}

function ResultRow({ items, first }: { items: Result[]; first: number }) {
  const warm = useWarmRow(items);
  return (
    // Full bleed, so a poster opening pushes its neighbours off the screen's edge, not the content's.
    <div
      data-rail
      role="none"
      onPointerEnter={warm}
      className="scroll-fade-x -mx-4 -my-2 flex gap-4 overflow-x-hidden px-4 py-2 md:-mx-12 md:px-12"
    >
      {items.map((m, i) => (
        <div key={`${m.type}:${m.id}`} role="listitem" className="shrink-0">
          {/* The entrance on its own layer: the row moves the item itself when a poster opens. */}
          <div className="rise-in" style={{ ["--i" as string]: Math.min(first + i, 10) }}>
            <ResultCard item={m} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** An element's content width, measured before the first paint and again whenever it changes. */
function useWidth(ref: RefObject<HTMLElement | null>) {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

export function ResultsSkeleton() {
  return (
    <Delayed>
      <ul className={grid} aria-hidden>
        {Array.from({ length: 14 }).map((_, i) => (
          <li key={i} className="flex flex-col gap-2">
            <div className="skeleton aspect-2/3 rounded-card" />
            <div className="skeleton h-4 w-3/4 rounded-full" />
          </li>
        ))}
      </ul>
    </Delayed>
  );
}

export function PersonRail({ person }: { person: Person }) {
  const warm = useWarmRow(person.titles);
  return (
    // The person card above jumps here; focus lands on the row so the keyboard follows.
    <div id={PERSON_ROW} tabIndex={-1} className="outline-hidden">
      <FullBleed>
        <Rail
          itemWidth="w-max"
          onPointerEnter={warm}
          action={
            <Link to={`/person/${person.id}`} className="text-body font-medium text-fg-muted hover:text-fg">
              See all
            </Link>
          }
          title={
            <span className="flex items-center gap-3">
              <Art src={person.photo} alt="" className={cx("size-10 shrink-0 rounded-full img-outline", ART_FALLBACK)} imgClassName="object-[center_20%]" />
              <span className="min-w-0">
                <span className="block truncate">{person.name}</span>
                <span className="block text-body font-normal text-fg-muted">{person.role}</span>
              </span>
            </span>
          }
        >
          {person.titles.map((m) => (
            <ResultCard key={m.id} item={m} width={POSTER_WIDTH} />
          ))}
        </Rail>
      </FullBleed>
    </div>
  );
}

export function TitleRail({ title, subtitle, items }: { title: string; subtitle?: string; items: Result[] }) {
  const warm = useWarmRow(items);
  return (
    <FullBleed>
      <Rail title={title} subtitle={subtitle} itemWidth="w-max" onPointerEnter={warm}>
        {items.map((m) => (
          <ResultCard key={m.id} item={m} width={POSTER_WIDTH} />
        ))}
      </Rail>
    </FullBleed>
  );
}

/** The search named one title: it leads, with Play right there, and the near namesakes and person beside it. */
export function BestMatch({ top, also, person }: { top: Result; also: Result[]; person: Person | null }) {
  const aside = also.length > 0 || !!person;
  return (
    <section
      aria-label="Top result"
      className={cx("grid gap-6 lg:gap-8", aside ? "xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]" : "max-w-4xl")}
    >
      <TopResult key={top.id} item={top} />
      {aside && (
        <div className="flex min-w-0 flex-col gap-4">
          {also.length > 0 && <AlsoMatching items={also} />}
          {person && <PersonCard person={person} />}
        </div>
      )}
    </section>
  );
}

function WatchBadge({ status }: { status: WatchStatus }) {
  return <span className="inline-flex items-center gap-1 rounded-full bg-black/70 px-2 py-0.5 text-caption font-medium text-fg">
    {status === "completed" && <CheckIcon weight="bold" className="-ml-0.5 text-accent" />}
    {statusLabel(status)}
  </span>;
}

function LiveStatus({ id }: { id: string }) {
  const status = useWatchStatus(id);
  return status ? <span className="text-fg-muted"> · {statusLabel(status)}</span> : null;
}

/** What Play means for a title: where you left off, the next episode, or the start. */
function useTitleTarget() {
  const { token } = useAuthed();
  const convex = useConvex();
  return async (item: { id: string; type: Result["type"] }) => {
    const [loaded, currentProgress, currentSimkl] = await Promise.all([
      getMeta(item.type, item.id),
      convex.query(api.progress.forTitle, { token, imdbId: item.id }),
      convex.query(api.simkl.forTitle, { token, id: item.id }),
    ]);
    const { video, startAt } = playPlan(loaded, currentProgress, currentSimkl?.next);
    return { media: mediaFor(loaded, video), startAt };
  };
}

/** Plays a title from where you left off, or starts a party with it, loading what it needs first. */
export function useStartTitle() {
  const target = useTitleTarget();
  const play = usePlay();
  const openStartParty = useOpenStartParty();
  return async (item: { id: string; type: Result["type"] }, kind: "play" | "party" = "play") => {
    try {
      const { media, startAt } = await target(item);
      if (kind === "play") await play(media, { startAt });
      else openStartParty(media, startAt);
    } catch {
      toast.error("Couldn't load that title. Try again.");
    }
  };
}

// The top result rests this long on its backdrop before its trailer loads, so typing past it costs nothing.
const TOP_TRAILER_DELAY_MS = 1500;
// The file's height for the top result: about 900 px wide, twice that on a sharp screen.
const TOP_FILE_HEIGHT = 1080;

function TopResult({ item }: { item: Result }) {
  const { token, me } = useAuthed();
  const root = useRef<HTMLElement>(null);
  // Its trailer plays muted behind it, like Home's banner, and pauses while a poster below plays its own.
  const trailersOn = useAmbientTrailers("(min-width: 768px)");
  const { sources } = useTitleTrailer(item, TOP_FILE_HEIGHT, trailersOn);
  const watching = useWatching(root);
  const previewOpen = usePreviewOpen();
  const [trailer, setTrailer] = useState(false);
  const [sound, setSound] = useTrailerSound();
  const meta = useAsync(`meta:${item.type}:${item.id}`, () => getMeta(item.type, item.id));
  const progress = useQuery(api.progress.forTitle, { token, imdbId: item.id });
  const simkl = useQuery(api.simkl.forTitle, { token, id: item.id });
  const profiles = useQuery(api.profiles.list, { token });
  const party = useParty();
  const startTitle = useStartTitle();
  const [busy, setBusy] = useState<"play" | "party" | null>(null);
  const others = (profiles ?? []).filter((p) => p._id !== me._id);
  // From 768px the buttons sit on the artwork, so they're glass; on a phone they're under it, on the flat page.
  const onArt = useOnArt();
  const m = meta.data;
  const plan = m ? playPlan(m, progress, simkl?.next) : undefined;
  const label = plan?.label ?? "Play";
  // IMDb's when the title's details have it (same as the title page), else the search's own (TMDB) score.
  const imdb = Number.parseFloat(m?.imdbRating ?? "") || undefined;
  const rating = imdb ?? item.rating;
  const facts = [item.year, kindLabel(item.type), m?.runtime, (m?.genres ?? m?.genre)?.[0]].filter(Boolean);
  const href = `/title/${item.type}/${item.id}`;

  const start = async (kind: "play" | "party") => {
    setBusy(kind);
    await startTitle(item, kind);
    setBusy(null);
  };

  return (
    <article ref={root} className="relative flex min-w-0 flex-col gap-4 md:block md:aspect-video">
      <Link
        to={href}
        aria-label={`Open ${item.name}`}
        className="group/hero relative block aspect-video overflow-hidden rounded-card md:absolute md:inset-0 md:aspect-auto md:rounded-sheet"
      >
        <Art
          src={art.backgroundLarge(item.id) ?? m?.background}
          alt=""
          eager
          lookup={{ name: item.name, year: item.year, type: item.type }}
          className={cx("absolute inset-0", ART_FALLBACK)}
          imgClassName="group-hover/hero:brightness-110"
        />
        {!!sources?.length && (
          <AmbientTrailer
            kind="banner"
            sources={sources}
            active={watching && !previewOpen}
            muted={!sound}
            delay={TOP_TRAILER_DELAY_MS}
            onShown={setTrailer}
          />
        )}
        <span aria-hidden className="absolute inset-0 hidden bg-linear-to-t from-page/95 via-page/20 via-65% to-transparent md:block" />
        <span aria-hidden className="absolute inset-0 rounded-[inherit] img-outline" />
      </Link>
      {/* Over the art on wider screens; the art stays clickable through everything but the buttons. */}
      <div className="pointer-events-none relative flex min-w-0 flex-col gap-2.5 md:absolute md:inset-x-6 md:bottom-6">
        <p className="text-caption font-semibold tracking-[0.08em] text-accent uppercase">Top result</p>
        <TitleArt imdbId={item.id} name={item.name} logo={m?.logo} size="card" as="h2" />
        <p className="flex min-w-0 items-center gap-x-2 text-body text-fg-muted">
          {rating && (
            <span className="shrink-0">
              <span className="font-medium text-fg tabular-nums">{rating.toFixed(1)}</span> {imdb ? "IMDb" : "TMDB"}
            </span>
          )}
          <span className="truncate">{facts.join(" · ")}</span>
        </p>
        <div className="pointer-events-auto mt-1 flex flex-wrap gap-2.5">
          <Button
            variant="primary"
            size="lg"
            loading={busy === "play"}
            icon={<PlayIcon weight="fill" />}
            onClick={() => void start("play")}
          >
            {party ? `${label} in party` : label}
          </Button>
          {/* Both keyed by where they sit, so glass mounts fresh instead of gaining the class later. */}
          <ListButton key={onArt ? "list-glass" : "list-flat"} item={item} variant={onArt ? "glass" : "secondary"} />
          {/* In a party, Play already puts it on for everyone. */}
          {!party && others.length > 0 && (
            <Button
              key={onArt ? "party-glass" : "party-flat"}
              variant={onArt ? "glass" : "secondary"}
              size="lg"
              loading={busy === "party"}
              icon={<UsersThreeIcon />}
              onClick={() => void start("party")}
            >
              {others.length === 1 ? `Watch with ${others[0].name}` : "Watch together"}
            </Button>
          )}
          {trailer && (
            <IconButton
              label={sound ? "Turn sound off" : "Turn sound on"}
              tone="glass"
              className="ml-auto self-center"
              onClick={() => setSound(!sound)}
            >
              {sound ? <SpeakerHighIcon /> : <SpeakerSlashIcon />}
            </IconButton>
          )}
        </div>
      </div>
    </article>
  );
}

const artQuery = "(min-width: 768px)";
function useOnArt() {
  return useSyncExternalStore(
    (changed) => {
      const list = matchMedia(artQuery);
      list.addEventListener("change", changed);
      return () => list.removeEventListener("change", changed);
    },
    () => matchMedia(artQuery).matches,
  );
}

/** Whether most of an element is on screen while the tab is showing. */
function useWatching(ref: RefObject<HTMLElement | null>) {
  const [inView, setInView] = useState(true);
  const [hidden, setHidden] = useState(document.hidden);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), { threshold: 0.4 });
    observer.observe(el);
    const onVisibility = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [ref]);
  return inView && !hidden;
}

/**
 * Namesakes beside the top result. Several can share a name ("Leila" ×4), so each shows what tells them
 * apart: a poster big enough to recognise, the score, and the start of its story.
 */
function AlsoMatching({ items }: { items: Result[] }) {
  return (
    <section aria-labelledby="also-matching" className="flex flex-col gap-2">
      <h2 id="also-matching" className="text-title font-semibold">
        Also matching
      </h2>
      <ul className="flex flex-col">
        {items.map((m) => (
          <li key={`${m.type}:${m.id}`} className="border-b border-line last:border-0">
            <AlsoRow item={m} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function AlsoRow({ item: m }: { item: Result }) {
  const to = `/title/${m.type}/${m.id}`;
  const prefetch = usePrefetchTitle(to);
  return (
    <Link to={to} className="group/also -mx-2 flex items-center gap-4 rounded-control px-2 py-2.5 hover:bg-white/6" {...prefetch}>
      <Art
        src={m.poster}
        titleId={m.id}
        alt=""
        fallbackTitle={m.name}
        className={cx("aspect-2/3 w-16 shrink-0 rounded-[8px] img-outline group-hover/also:brightness-110 2xl:w-20", ART_FALLBACK)}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-subhead font-semibold text-fg" title={m.name}>
          {m.name}
        </span>
        <span className="truncate text-body text-fg-muted">
          {m.rating && (
            <>
              <span className="font-medium text-fg tabular-nums">{m.rating.toFixed(1)}</span> TMDB ·{" "}
            </>
          )}
          {resultSubtitle(m)}
          <LiveStatus id={m.id} />
        </span>
        {m.overview && <span className="mt-0.5 line-clamp-2 text-body text-fg-faint">{m.overview}</span>}
      </span>
    </Link>
  );
}

function PersonCard({ person }: { person: Person }) {
  const jump = () => {
    const row = document.getElementById(PERSON_ROW);
    if (!row) return;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    row.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    row.focus({ preventScroll: true });
  };
  return (
    <button
      onClick={jump}
      className="press-soft flex min-h-11 w-full items-center gap-3 rounded-card bg-surface p-3 text-left shadow-raised hover:bg-raised"
    >
      <Art src={person.photo} alt="" className={cx("size-12 shrink-0 rounded-full img-outline", ART_FALLBACK)} imgClassName="object-[center_20%]" />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-fg">{person.name}</span>
        <span className="block truncate text-caption text-fg-faint">
          {[person.role, plural(person.titles.length, "title", "titles")].filter(Boolean).join(" · ")}
        </span>
      </span>
      <CaretDownIcon aria-hidden className="shrink-0 text-subhead text-fg-faint" />
    </button>
  );
}
