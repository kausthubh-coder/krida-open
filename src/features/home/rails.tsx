// Home's rows and their cards: catalog rows, friends' rows, Plan to watch, top 10, Continue watching.
import { HoverFilm } from "../../ui/film";
import { useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { useMutation } from "convex/react";
import { toast } from "../../ui/toast";
import { CaretRightIcon, PlayIcon, XCircleIcon, XIcon } from "@phosphor-icons/react";
import { api } from "../../../convex/_generated/api";
import { useAuthed } from "../../data/session";
import { art, type MediaType } from "../../data/cinemeta";
import { episodeLabel, timeLeft } from "../../ui/format";
import { usePlayTitle, useTitleTarget, useWarmOnHover } from "../play";
import { seeAllPath, updatedLabel } from "./homeRows";
import { ExpandingPoster, useWarmRow } from "../trailers";
import { usePartyEntry } from "../party";
import { Art, ART_FALLBACK } from "../../ui/artwork";
import { itemMeta, scoreSource } from "../../ui/scores";
import { CardActions, CardMenu } from "../title";
import { POSTER_WIDTH, Rail } from "../../ui/rail";
import { useNear } from "../../ui/near";
import { released, useCatalogRow } from "../../data/addons";
import type { AddonRow } from "./useHome";
import { Avatar, cx, IconButton } from "../../ui/ui";
import { useNow } from "../../ui/clock";
import type { HomeRow, Person, ProgressRow, RowItem, Seed } from "./Home";
import type { NextEpisode } from "./nextUp";
import { resumeTarget, useResume } from "./slides";

/**
 * Holds the shape of the first rows while they load, so nothing below jumps: a title with its reason,
 * then posters with their two lines of text.
 */
export function RowsSkeleton() {
  return (
    <div className="flex flex-col gap-10" aria-hidden>
      {[0, 1].map((r) => (
        <RowSkeleton key={r} />
      ))}
    </div>
  );
}

/** One row's shape while its titles load; with its title when that's known already. */
function RowSkeleton({ title }: { title?: string }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex h-7 items-center gap-3 px-4 md:px-12">
        {title ? (
          <h2 className="text-[1.0625rem] leading-6 font-semibold tracking-[-0.01em] md:text-title">{title}</h2>
        ) : (
          <>
            <div className="skeleton h-5 w-48 rounded-full" />
            <div className="skeleton h-3.5 w-28 rounded-full" />
          </>
        )}
      </div>
      <div aria-hidden className="flex gap-3 overflow-hidden px-4 md:gap-4 md:px-12">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className={cx("flex shrink-0 flex-col gap-2", POSTER_WIDTH)}>
            <div className="skeleton aspect-2/3 w-full rounded-card" />
            {/* 36px: a body line and a caption line, like the card's own text. */}
            <div className="flex h-9 flex-col justify-between px-0.5 py-0.5">
              <div className="skeleton h-4 w-4/5 rounded-full" />
              <div className="skeleton h-3 w-1/2 rounded-full" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Rows

/** A row from the server, in the shape its kind calls for. */
export function HomeRail({ row }: { row: HomeRow }) {
  const subtitle = row.subtitle ?? (row.updatedAt !== undefined ? <UpdatedAgo at={row.updatedAt} /> : undefined);
  const warm = useWarmRow(row.items);
  if (row.style === "top10")
    return (
      <Rail title={row.title} subtitle={subtitle} itemWidth="w-max" gap="gap-2" onPointerEnter={warm}>
        {row.items.map((item, i) => (
          <Top10Card key={item.id} item={item} rank={i + 1} />
        ))}
      </Rail>
    );
  if (row.key.startsWith("together"))
    return (
      <Rail title={row.title} subtitle={subtitle} action={<PartyAction />} itemWidth="w-[80vw] sm:w-(--wide-w)">
        {row.items.map((item) => (
          <TogetherCard key={item.id} item={item} people={row.people} />
        ))}
      </Rail>
    );
  // "Because you loved X" opens with X itself, which carries the row's title.
  if (row.seed)
    return (
      <Rail title={row.title} hideTitle itemWidth="w-max" onPointerEnter={warm}>
        {[
          <div key="seed" className={POSTER_WIDTH}>
            <SeedTile seed={row.seed} />
          </div>,
          ...row.items.map((item) => <ItemPoster key={item.id} item={item} />),
        ]}
      </Rail>
    );
  return (
    // Posters size themselves, so one can widen into its trailer.
    <Rail title={row.title} subtitle={subtitle} itemWidth="w-max" onPointerEnter={warm}>
      {row.items.map((item) => (
        <ItemPoster key={item.id} item={item} />
      ))}
    </Rail>
  );
}

/**
 * One of the profile's addon catalogs. Its titles are asked for once the row comes near the screen, so a profile with
 * forty catalogs doesn't ask for them all at once. A catalog that comes back empty leaves no row; one whose addon
 * didn't answer says so.
 */
export function AddonRail({ row, title, hideUnreleased }: { row: AddonRow; title: string; hideUnreleased: boolean }) {
  const holder = useRef<HTMLDivElement>(null);
  const near = useNear(holder);
  if (!near)
    return (
      <div ref={holder}>
        <RowSkeleton title={title} />
      </div>
    );
  return <LoadedAddonRail row={row} title={title} hideUnreleased={hideUnreleased} />;
}

function LoadedAddonRail({ row, title, hideUnreleased }: { row: AddonRow; title: string; hideUnreleased: boolean }) {
  const loaded = useCatalogRow(row.base, row.catalog);
  const items = useMemo(() => (loaded ?? []).filter((i) => !hideUnreleased || released(i)).slice(0, 24), [loaded, hideUnreleased]);
  const warm = useWarmRow(items);
  if (loaded === undefined) return <RowSkeleton title={title} />;
  if (loaded === null)
    return (
      <section className="flex flex-col gap-1 px-4 md:px-12">
        <h2 className="text-[1.0625rem] leading-6 font-semibold tracking-[-0.01em] md:text-title">{title}</h2>
        <p className="text-body text-fg-faint">Couldn’t reach {row.addon} for this row. Krida asks again in a minute.</p>
      </section>
    );
  if (items.length === 0) return null;
  return (
    <Rail
      title={title}
      itemWidth="w-max"
      onPointerEnter={warm}
      action={
        <Link to={seeAllPath(row)} className="shrink-0 text-body font-medium text-fg-muted hover:text-fg">
          See all
        </Link>
      }
    >
      {items.map((item) => (
        <ItemPoster key={item.id} item={item} />
      ))}
    </Rail>
  );
}

/** "<friend> has been watching". */
export function FriendRail({ title, items }: { title: string; items: RowItem[] }) {
  const warm = useWarmRow(items);
  return (
    <Rail title={title} itemWidth="w-max" onPointerEnter={warm}>
      {items.map((item) => (
        <ItemPoster key={item.id} item={item} />
      ))}
    </Rail>
  );
}

export function MyListRail({ title, items }: { title: string; items: SavedItem[] }) {
  const titles = useMemo(() => items.map((item) => ({ ...item, id: item.imdbId })), [items]);
  const warm = useWarmRow(titles);
  return (
    <Rail
      title={title}
      // Posters size themselves, so one can widen into its trailer.
      itemWidth="w-max"
      action={
        <Link to="/library" className="text-body font-medium text-fg-muted hover:text-fg">
          See all
        </Link>
      }
      onPointerEnter={warm}
    >
      {items.map((item) => (
        <SavedPoster key={item._id} item={item} />
      ))}
    </Rail>
  );
}

function UpdatedAgo({ at }: { at: number }) {
  // Hours are the finest unit shown, so a slow clock is plenty.
  const now = useNow(5 * 60_000);
  return <>{updatedLabel(at, now)}</>;
}

/** Into the party from the "For you and…" row: the same entry point as the header button. */
function PartyAction() {
  const { entry, go, loading } = usePartyEntry();
  if (loading) return null;
  const label =
    entry.kind === "mine"
      ? "Back to your party"
      : entry.kind === "theirs"
        ? entry.room.kind === "party" ? "Join the party" : "Ask to join"
        : "Start a party";
  return (
    <button
      onClick={go}
      className="-my-2 inline-flex shrink-0 items-center gap-1 rounded-control py-2 text-body font-medium text-fg-muted hover:text-fg"
    >
      {label}
      <CaretRightIcon className="-mb-px" />
    </button>
  );
}

// ---------------------------------------------------------------------------------------------
// Cards

export function ItemPoster({ item }: { item: RowItem }) {
  const playTitle = usePlayTitle();
  const target = useTitleTarget();
  return (
    <CardMenu item={item} to={`/title/${item.type}/${item.id}`}>
      <ExpandingPoster
        item={item}
        subtitle={itemMeta(item)}
        score={scoreSource(item)}
        actions={<CardActions item={item} />}
        onPlay={() => playTitle(item.type, item.id)}
        playMedia={async () => (await target(item.type, item.id)).media}
      />
    </CardMenu>
  );
}

/** A title in Plan to watch; its status button can take it out again, with an undo. */
type SavedItem = { _id: string; imdbId: string; type: MediaType; name: string; poster?: string; year?: string };

function SavedPoster({ item }: { item: SavedItem }) {
  const playTitle = usePlayTitle();
  const target = useTitleTarget();
  const title = { id: item.imdbId, type: item.type, name: item.name, poster: item.poster, year: item.year };
  return (
    <CardMenu item={title} to={`/title/${item.type}/${item.imdbId}`}>
      <ExpandingPoster
        item={title}
        subtitle={item.year}
        actions={<CardActions undo item={title} />}
        onPlay={() => playTitle(item.type, item.imdbId)}
        playMedia={async () => (await target(item.type, item.imdbId)).media}
      />
    </CardMenu>
  );
}

/** Netflix's Top 10 tile: a big outlined rank tucked behind a standard-size poster, which widens into its trailer like any other. */
function Top10Card({ item, rank }: { item: RowItem; rank: number }) {
  const playTitle = usePlayTitle();
  const target = useTitleTarget();
  return (
    <div className="group flex items-end">
      {/* 1.2x the poster's width, so the digits stand a little over half its height at every size. */}
      <span
        aria-hidden
        className="-mr-[0.13em] shrink-0 font-display text-[length:calc(var(--poster-w)*1.2)] leading-[0.74] font-bold tracking-[-0.06em] text-page [-webkit-text-stroke:2px_oklch(0.6_0.012_60)] group-hover:[-webkit-text-stroke-color:var(--color-fg)]"
      >
        {rank}
      </span>
      {/* A soft shadow on the left edge lifts the poster off the numeral behind it. */}
      <div className="shrink-0 rounded-card shadow-[-10px_0_24px_-8px_oklch(0_0_0/0.7)]">
        <CardMenu item={item} to={`/title/${item.type}/${item.id}`}>
          <ExpandingPoster
            item={item}
            caption={false}
            subtitle={`Number ${rank} in the top 10`}
            score={scoreSource(item)}
            actions={<CardActions item={item} />}
            onPlay={() => playTitle(item.type, item.id)}
            playMedia={async () => (await target(item.type, item.id)).media}
          />
        </CardMenu>
      </div>
    </div>
  );
}

/** "For you and…": a wide backdrop with the title's logo and both of you on it. */
function TogetherCard({ item, people }: { item: RowItem; people?: Person[] }) {
  const meta = itemMeta(item);
  return (
    <CardMenu item={item} to={`/title/${item.type}/${item.id}`}>
    <div data-card className="group/card relative min-w-0 transition-transform duration-100 ease-out has-[>a:active]:scale-[0.985]">
      <Link to={`/title/${item.type}/${item.id}`} className="flex min-w-0 flex-col gap-2 rounded-card outline-offset-4">
        <div className="relative">
          {/* No fallback title: the logo slot sets the name when the art is missing. */}
          <Art
            src={item.background ?? art.background(item.id)}
            alt=""
            className={cx("aspect-video w-full rounded-card img-outline group-hover/card:brightness-110", ART_FALLBACK)}
          />
          <div aria-hidden className="absolute inset-0 rounded-card bg-linear-to-t from-black/80 to-transparent to-60%" />
          <CardLogo item={item} />
          {people && (
            <span className="absolute right-3 bottom-3 flex -space-x-1.5">
              {people.map((p) => (
                <Avatar key={p._id} name={p.name} hue={p.hue} size={26} ring />
              ))}
            </span>
          )}
        </div>
        <div className="min-w-0 px-0.5">
          <p className="truncate text-body font-medium text-fg" title={item.name}>
            {item.name}
          </p>
          {meta && <p className="truncate text-caption text-fg-faint">{meta}</p>}
        </div>
      </Link>
      {/* Like a poster's: shown while hovered, while a key has focus inside, and while a menu is open. Touch
          screens leave them to the title page, so they don't sit on every logo. */}
      <div
        data-hover-reveal
        className={cx(
          "pointer-events-none absolute top-2 right-2 flex gap-1.5 opacity-0 [@media(hover:none)]:hidden",
          "group-hover/card:pointer-events-auto group-hover/card:opacity-100",
          "group-has-focus-visible/card:pointer-events-auto group-has-focus-visible/card:opacity-100",
          "group-has-[[aria-expanded=true]]/card:pointer-events-auto group-has-[[aria-expanded=true]]/card:opacity-100",
        )}
      >
        <CardActions item={item} />
      </div>
    </div>
    </CardMenu>
  );
}

/** The title's logo on its backdrop, or its name in the display face when there's no logo. */
function CardLogo({ item }: { item: RowItem }) {
  const src = art.logo(item.id) ?? item.logo;
  const [failed, setFailed] = useState(false);
  if (!src || failed)
    return (
      <p className="absolute bottom-3 left-3.5 line-clamp-2 max-w-[60%] font-display text-title font-semibold text-balance text-fg">
        {item.name}
      </p>
    );
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={() => setFailed(true)}
      className="absolute bottom-3.5 left-3.5 max-h-[46px] w-auto max-w-[55%] object-contain object-left-bottom drop-shadow-[0_2px_12px_oklch(0_0_0/0.5)]"
    />
  );
}

/** The first tile of a "Because you…" row: the title it grows from, dimmed, with the reason set on it. */
function SeedTile({ seed }: { seed: Seed }) {
  const body = (
    <>
      <Art
        src={seed.poster ?? art.poster(seed.id)}
        alt=""
        className={cx("aspect-2/3 w-full rounded-card img-outline", ART_FALLBACK)}
        imgClassName="brightness-[.45] saturate-[.8] group-hover/seed:brightness-[.55]"
      />
      <div aria-hidden className="absolute inset-0 rounded-card bg-linear-to-t from-black/60 to-transparent to-50%" />
      <div className="absolute inset-x-3 bottom-3.5 flex flex-col gap-0.5">
        <span className="text-caption text-fg-muted">{seed.loved ? "Because you loved" : "Because you watched"}</span>
        <span className="line-clamp-3 font-display text-title font-semibold text-balance text-fg">{seed.name}</span>
      </div>
    </>
  );
  // Older rows may not know the seed's type; then the tile is a label, not a link.
  return seed.type ? (
    <Link to={`/title/${seed.type}/${seed.id}`} className="group/seed press-soft relative block rounded-card outline-offset-4">
      {body}
    </Link>
  ) : (
    <div className="relative">{body}</div>
  );
}

export function ContinueCard({ row }: { row: ProgressRow }) {
  const resume = useResume();
  const warmPlay = useWarmOnHover(async () => (await resumeTarget(row)).media);
  const { token } = useAuthed();
  const setHidden = useMutation(api.progress.setHidden);
  const [busy, setBusy] = useState(false);
  const m = row.media;
  const ratio = row.duration ? row.position / row.duration : 0;

  const remove = async () => {
    await setHidden({ token, imdbId: m.imdbId, hidden: true });
    toast(`Removed “${m.name}” from Continue watching`, {
      duration: 5000,
      action: { label: "Undo", onClick: () => void setHidden({ token, imdbId: m.imdbId, hidden: false }) },
    });
  };

  return (
    <CardMenu
      item={{ id: m.imdbId, type: m.type, name: m.name, poster: m.poster }}
      to={`/title/${m.type}/${m.imdbId}`}
      playLabel="Resume"
      onPlay={() => resume(row)}
      extra={{ label: "Remove from Continue watching", icon: <XCircleIcon />, onSelect: remove }}
    >
    <div data-card className="group relative">
      <button
        {...warmPlay}
        onClick={async () => {
          setBusy(true);
          await resume(row);
          setBusy(false);
        }}
        className="press-soft flex w-full flex-col gap-2 rounded-card text-left"
        aria-label={`Resume ${m.name}`}
      >
        <div className="relative w-full">
          <Art
            src={m.background ?? art.background(m.imdbId)}
            alt=""
            fallbackTitle={m.name}
            className="aspect-video w-full rounded-card img-outline group-hover:brightness-110"
          />
          <div aria-hidden className="absolute inset-0 rounded-card bg-linear-to-t from-black/70 via-transparent" />
          <span
            aria-hidden
            className={cx(
              "fill-scrim absolute top-1/2 left-1/2 grid size-14 -translate-1/2 place-items-center rounded-full bg-black/60 text-[24px] text-white",
              busy ? "opacity-100" : "opacity-0 group-hover:opacity-100",
            )}
          >
            <HoverFilm />
            <PlayIcon weight="fill" className="-translate-x-px" />
          </span>
          {!row.finished && (
            <div className="progress-groove absolute inset-x-3 bottom-3 h-1 overflow-hidden rounded-full bg-white/20">
              <div className="h-full rounded-full bg-accent" style={{ width: `${ratio * 100}%` }} />
            </div>
          )}
        </div>
        {/* A full width of its own: older Android WebViews (Chrome 124) size a block in a flex button to its text, so
            a long title ran into the next card instead of ending in an ellipsis. */}
        <div className="w-full min-w-0">
          <p className="truncate text-body font-medium" title={m.name}>
            {m.name}
          </p>
          <p className="truncate text-caption text-fg-faint">
            {m.type === "series" ? `${row.finished ? "Next after " : ""}${episodeLabel(m.season, m.episode)} · ` : ""}
            {row.finished ? "Finished" : timeLeft(row.position, row.duration)}
          </p>
        </div>
      </button>
      <IconButton
        label={`Remove ${m.name} from Continue watching`}
        size="sm"
        tone="scrim"
        shownOnTouch
        onClick={remove}
        // The only way out of the row, so touch screens keep it shown.
        className="absolute top-2 right-2 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-focus-within:opacity-100 [@media(hover:hover)]:group-hover:opacity-100"
      >
        <XIcon />
      </IconButton>
    </div>
    </CardMenu>
  );
}

/**
 * A show whose next episode isn't out yet, in Settings → Home's "Coming up" row: that episode, with the day it comes
 * out, opening the show's page. The show's own art: an episode not out yet seldom has a still.
 */
export function UpcomingCard({ row, next }: { row: ProgressRow; next: NextEpisode }) {
  const m = row.media;
  const { video } = next;
  const day = video.released ? new Date(video.released).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : undefined;
  return (
    <CardMenu item={{ id: m.imdbId, type: m.type, name: m.name, poster: m.poster }} to={`/title/${m.type}/${m.imdbId}`}>
      <Link
        to={`/title/${m.type}/${m.imdbId}`}
        className="press-soft flex w-full flex-col gap-2 rounded-card text-left"
        aria-label={`${m.name}, ${episodeLabel(video.season, video.episode)}${day ? `, out ${day}` : ""}`}
      >
        <div className="relative w-full overflow-hidden rounded-card">
          <Art
            src={m.background ?? art.background(m.imdbId)}
            alt=""
            fallbackTitle={m.name}
            className="aspect-video w-full rounded-card img-outline"
          />
        </div>
        <div className="w-full min-w-0">
          <p className="truncate text-body font-medium" title={m.name}>
            {m.name}
          </p>
          <p className="truncate text-caption text-fg-faint">
            {episodeLabel(video.season, video.episode)}
            {day ? ` · Out ${day}` : " · Coming soon"}
          </p>
        </div>
      </Link>
    </CardMenu>
  );
}
