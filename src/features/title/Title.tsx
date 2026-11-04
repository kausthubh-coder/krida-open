import { useMemo, useState } from "react";
import { barBubble } from "../../ui/barBubble";
import { Glass } from "bubli";
import { useParams } from "react-router";
import { useQuery } from "convex-helpers/react/cache/hooks";
import {
  FilmStripIcon,
  MonitorPlayIcon,
  PlayIcon,
  UsersThreeIcon,
} from "@phosphor-icons/react";
import { api } from "../../../convex/_generated/api";
import { useAuthed } from "../../data/session";
import { PlayNeedsDebrid } from "../../ui/needsKey";
import { useNeedsTmdbKey } from "../../data/keys";
import { useReadyTiming } from "../../data/telemetry";
import { art, getMeta, useAsync, type Meta } from "../../data/cinemeta";
import { useAnimeFill } from "./animeFill";
import { episodeLabel, timeLeft } from "../../ui/format";
import { mediaFor, playTarget, usePlay, usePlayNeedsDebrid, useSuggest, useWarmOnHover, useWarmSources, useWatchAfter, type Media, SourcesSheet } from "../play";
import { useParty, useOpenStartParty, AfterThisButton, SuggestIcon, usePartyRoom, ONLINE_MS, useServerNow, names } from "../party";
import { parseRating, publicScores } from "../../ui/scoreValues";
import { playAdd } from "../../ui/sound";
import { Art, TitleArt } from "../../ui/artwork";
import { Avatar, Button, ButtonLink, cx, EmptyState, IconButton } from "../../ui/ui";
import { RateButton } from "./taste";
import { ListButton, toolbarItem } from "./watchStatus";
import { RatingsStrip } from "../../ui/ratings";
import { TrailerDialog, trailerIds } from "../trailers";
import { Credits, Description, Facts } from "./details";
import { useTitleInfo } from "./titleInfo";
import { Episodes } from "./titleEpisodes";
import { MoreLikeThis } from "./moreLikeThis";
import { lookupOf } from "./lookup";
import { useArtTint } from "../../ui/artTint";
import { isTitleId } from "../../../shared/ids";

export function TitlePage() {
  const { type, id } = useParams<{ type: "movie" | "series"; id: string }>();
  const valid = (type === "movie" || type === "series") && !!id;
  const meta = useAsync(valid ? `meta:${type}:${id}` : null, () => getMeta(type!, id!));
  const filled = useAnimeFill(meta.data);
  useReadyTiming("title", !!meta.data, `${type}:${id}`);

  if (!valid) return <EmptyState className="pt-32" title="That link doesn’t point to a title" />;
  if (meta.error)
    return meta.error.message === "Not found" ? (
      <EmptyState
        className="min-h-[70dvh] pt-24"
        title="We couldn’t find this title"
        description="No catalog or addon has this title. Search for it by name instead."
        action={<ButtonLink to="/search">Search</ButtonLink>}
      />
    ) : (
      <EmptyState
        className="min-h-[70dvh] pt-24"
        title="Couldn’t load this title"
        description="The catalog didn’t answer. Check your connection and try again."
        action={<Button onClick={() => location.reload()}>Try again</Button>}
      />
    );
  if (!meta.data || !filled.meta) return <TitleSkeleton />;
  return <TitleView key={meta.data.id} meta={filled.meta} filling={filled.pending} />;
}

/** The hero's shape while Cinemeta answers, so the page doesn't jump when it does. */
function TitleSkeleton() {
  return (
    <main className="pb-16" aria-busy>
      <section className="-mt-(--inset-top) flex min-h-[78dvh] items-end max-md:min-h-[90dvh]">
        <div className="flex w-full max-w-3xl flex-col gap-4 px-4 pt-32 pb-8 md:px-12 short:gap-3 short:pt-20">
          <div className="skeleton h-24 w-80 max-w-[80%] rounded-card md:h-32 short:h-18" />
          <div className="flex flex-col gap-3">
            <div className="skeleton h-5 w-72 max-w-full rounded-full" />
            <div className="skeleton h-5 w-56 max-w-full rounded-full" />
          </div>
          <div className="flex max-w-[55ch] flex-col gap-2">
            <div className="skeleton h-4 rounded-full" />
            <div className="skeleton h-4 rounded-full" />
            <div className="skeleton h-4 w-2/3 rounded-full" />
          </div>
          <div className="mt-2 flex flex-col gap-3 md:flex-row">
            <div className="skeleton h-12 rounded-full md:w-32" />
            <div className="skeleton h-12 rounded-full md:w-[440px]" />
          </div>
          <span role="status" className="sr-only">Loading title…</span>
        </div>
      </section>
    </main>
  );
}

function Backdrop({ meta, filling }: { meta: Meta; filling: boolean }) {
  const src = meta.background ?? art.backgroundLarge(meta.id);
  useArtTint(src ?? meta.poster);
  // Only IMDb titles have Metahub's backdrops: the rest without one of their own (Kitsu, an addon's) blur the poster.
  if (!src && !filling && !meta.id.startsWith("tt") && meta.poster)
    return (
      <Art
        src={meta.poster}
        alt=""
        eager
        className="absolute inset-0 -z-10 bg-page"
        imgClassName="scale-125 blur-3xl brightness-75 saturate-150"
      />
    );
  return (
    <Art
      src={src}
      alt=""
      eager
      lookup={lookupOf(meta)}
      className="absolute inset-0 -z-10 bg-page"
      imgClassName="object-[center_20%]"
    />
  );
}

function TitleView({ meta, filling }: { meta: Meta; filling: boolean }) {
  const { token } = useAuthed();
  const play = usePlay();
  const party = useParty();
  const noDebrid = usePlayNeedsDebrid();
  const progress = useQuery(api.progress.forTitle, { token, imdbId: meta.id });
  const [sourcesFor, setSourcesFor] = useState<Media | null>(null);
  const [starting, setStarting] = useState(false);
  const openStartParty = useOpenStartParty();
  const watchAfter = useWatchAfter();
  // What the party has lined up after the current title (shown right away, before the server echoes it).
  const [optimisticNext, setOptimisticNext] = useState<string | null>(null);
  const nextId = optimisticNext ?? party?.next?.media.videoId;
  const lineUp = async (media: Media) => {
    setOptimisticNext(media.videoId);
    playAdd();
    await watchAfter(media);
    setOptimisticNext(null);
  };
  // While the party is picking, this page puts things on its table.
  const room = usePartyRoom();
  const suggest = useSuggest();
  const picking = party?.status === "idle";
  // Only who's still here while picking needs the time; outside that, ticking would redraw the page every 5 s.
  // It's the server's time, as lastSeenAt is: a device clock 20 s off would leave nobody to pick with.
  const now = useServerNow(picking ? 5000 : null);
  const suggestedIds = new Set(room?.suggestions.map((s) => s.media.videoId));

  const simkl = useQuery(api.simkl.forTitle, { token, id: meta.id });
  // MDBList's ratings come through /api/title, which asks with the account's TMDB key; without one, Cinemeta's IMDb score shows.
  const needsKey = useNeedsTmdbKey();
  const infoId = needsKey ? undefined : meta.id.startsWith("tt") ? meta.id : meta.imdb_id?.startsWith("tt") ? meta.imdb_id : undefined;
  const info = useTitleInfo(meta.type, infoId);
  const trailers = useMemo(() => trailerIds(meta, info?.trailer), [meta, info?.trailer]);
  const [trailerOpen, setTrailerOpen] = useState(false);
  const target = useMemo(() => playTarget(meta, progress, simkl?.next), [meta, progress, simkl?.next]);
  const watchedElsewhere = useMemo(() => new Set(simkl?.watched ?? []), [simkl?.watched]);
  const targetMedia = mediaFor(meta, target.video);
  const startAt = target.row && !target.row.finished ? target.row.position : 0;
  // Once Play knows which episode it means.
  useWarmSources(progress !== undefined && simkl !== undefined ? targetMedia : undefined);
  const warmPlay = useWarmOnHover(targetMedia);

  const year = meta.releaseInfo ?? meta.year;
  const item = { id: meta.id, type: meta.type, name: meta.name, poster: meta.poster, year };
  // Kitsu's addon fills imdbRating with Kitsu's own score; only Cinemeta's is IMDb's.
  const kitsu = meta.id.startsWith("kitsu:");
  const scores = publicScores(info?.ratings, {
    imdb: kitsu ? undefined : parseRating(meta.imdbRating),
    kitsu: kitsu ? parseRating(meta.imdbRating) : undefined,
    anime: kitsu || !!info?.ratings.mal,
  });

  const baseLabel =
    meta.type === "movie"
      ? target.row
        ? "Resume"
        : "Play"
      : target.row
        ? `Resume ${episodeLabel(target.video?.season, target.video?.episode)}`
        : target.video
          ? `Play ${episodeLabel(target.video.season, target.video.episode)}`
          : "Play S1 E1";
  const playLabel = party ? `${baseLabel} in party` : baseLabel;
  const partyNames = party?.members.filter((m) => !m.isMe).map((m) => m.name) ?? [];
  // With someone here to agree with, suggesting is the main thing; alone, playing is.
  const pickingWith = picking
    ? (room?.members ?? party.members).filter((m) => !m.isMe && now - m.lastSeenAt < ONLINE_MS).map((m) => m.name)
    : [];
  const which = meta.type === "series" && target.video ? ` ${episodeLabel(target.video.season, target.video.episode)}` : "";
  const suggested = suggestedIds.has(targetMedia.videoId);
  const partyLine = !party
    ? null
    : !picking
      ? partyNames.length
        ? `You’re in a party with ${names(partyNames)}. Play puts this on for everyone.`
        : "You’re in a party. Play puts this on there."
      : pickingWith.length
        ? `Picking with ${names(pickingWith)}. Suggest puts it on the table, and it starts when you’re ${pickingWith.length > 1 ? "all" : "both"} in.`
        : "You’re in a party. Suggest this for when they get here, or play it now.";
  const playButton = (primary = true, label = playLabel, before?: () => void) => (
    <Button
      variant={primary && !noDebrid ? "primary" : "glass"}
      size="lg"
      loading={starting}
      icon={<PlayIcon weight="fill" />}
      aria-disabled={noDebrid || undefined}
      aria-describedby={noDebrid ? "play-needs-debrid" : undefined}
      {...warmPlay}
      onClick={async () => {
        before?.();
        setStarting(true);
        await play(targetMedia, { startAt });
        setStarting(false);
      }}
      className={cx("min-w-0", noDebrid && "opacity-60")}
    >
      <span className="truncate">{label}</span>
    </Button>
  );
  const suggestButton = (primary: boolean) => (
    <Button
      variant={primary ? "primary" : "glass"}
      size="lg"
      icon={<SuggestIcon done={suggested} />}
      aria-disabled={suggested || undefined}
      onClick={suggested ? undefined : () => void suggest(targetMedia)}
      className="min-w-0"
    >
      <span className="truncate">{suggested ? `Suggested${which}` : `Suggest${which}`}</span>
    </Button>
  );

  return (
    <main className="pb-16">
      {/* The artwork runs on under a sideways phone's rail, so its glass has a picture behind it. */}
      <section className="relative isolate -mt-(--inset-top) -mr-(--inset-right) -ml-(--rail-pad,0px) flex min-h-[78dvh] items-end overflow-hidden pr-(--inset-right) pl-(--rail-pad,0px) max-md:min-h-[90dvh]">
        {/* What the glass actions bend in Safari and Firefox: a copy of the artwork, not of the whole page. */}
        <div className="absolute inset-0 -z-10">
          <Backdrop meta={meta} filling={filling} />
          {/* Clear at the top, so the picture leads; it melts into the page, which has taken its colour, where the words start. */}
          <div aria-hidden className="absolute inset-0 -z-10 bg-linear-to-t from-page from-30% via-page/80 via-48% to-page/0 to-72% md:from-page md:from-3% md:via-page/50 md:via-35% md:to-page/5 md:to-100%" />
          <div aria-hidden className="absolute inset-0 -z-10 bg-linear-to-r from-page/90 via-page/30 to-transparent max-md:hidden" />
          <div aria-hidden className="absolute inset-x-0 top-0 -z-10 h-28 bg-linear-to-b from-page/50 to-transparent md:hidden" />
        </div>

        <div className="flex w-full max-w-3xl flex-col gap-4 px-5 pt-32 pb-8 max-md:items-center max-md:text-center md:px-12 short:gap-3 short:pt-20 max-md:[&_img]:object-center">
          <TitleArt imdbId={meta.id} name={meta.name} logo={meta.logo} size="page" />
          <div className="flex flex-col gap-2 max-md:items-center max-md:*:justify-center md:gap-3">
            <Facts meta={meta} certification={info?.certification ?? undefined} />
            <RatingsStrip scores={scores} loading={!!infoId && info === undefined} />
          </div>
          {/* A phone reads after the buttons, so Play is on the first screen. */}
          {meta.description && <Description text={meta.description} className="max-md:order-1 max-md:mt-2 max-md:self-stretch max-md:text-left short:order-1" />}
          {party && (
            <p className="mt-2 flex items-center gap-2 text-body text-fg-muted">
              <span className="flex -space-x-1.5">
                {party.members.slice(0, 3).map((m) => (
                  <Avatar key={m._id} name={m.name} hue={m.hue} size={20} ring />
                ))}
              </span>
              {partyLine}
            </p>
          )}
          {/*
            One solid action leads (Play, or Suggest while picking with someone). Everything else is one capsule of
            glass beside it: the trailer, where you stand with the title, your rating, watching together, and
            sources. Phones give Play its own row and keep only the status's words in the capsule.
          */}
          {target.row && (
            // As wide as Play under it on a phone, so it reads as how far along Play carries on from.
            <div className="mt-1 flex items-center gap-3 self-stretch md:max-w-sm">
              <div className="progress-groove h-1 flex-1 overflow-hidden rounded-full bg-white/15">
                <div
                  className="h-full rounded-full bg-accent"
                  style={{ width: `${(target.row.position / target.row.duration) * 100}%` }}
                />
              </div>
              <span className="shrink-0 text-caption text-fg-muted tabular-nums">
                {timeLeft(target.row.position, target.row.duration)}
              </span>
            </div>
          )}
          <div className="flex flex-col gap-3 self-stretch md:mt-1 md:flex-row md:flex-wrap md:items-center md:self-auto">
            <div className="flex gap-3 *:flex-1 md:*:flex-none">
              {picking && pickingWith.length ? (
                <>
                  {suggestButton(true)}
                  {playButton(false, target.row ? "Resume now" : "Play now")}
                </>
              ) : picking ? (
                <>
                  {playButton()}
                  {suggestButton(false)}
                </>
              ) : (
                playButton()
              )}
            </div>
            <Glass {...barBubble("toolbar")} role="group" aria-label={`${meta.name} actions`} className="bubble-bar flex h-13 items-center gap-1 self-stretch rounded-full p-1 max-md:justify-between md:self-auto">
              {trailers.length > 0 && (
                <button type="button" onClick={() => setTrailerOpen(true)} className={cx(toolbarItem, "pl-3.5 max-sm:w-10 max-sm:px-0")}>
                  <MonitorPlayIcon aria-hidden className="shrink-0 text-[20px]" />
                  <span className="max-sm:sr-only">Trailer</span>
                </button>
              )}
              {/* Kept by IMDb or Kitsu id, as Simkl knows titles; an addon's own id has neither. */}
              {isTitleId(meta.id) && <>
                <ListButton item={item} variant="toolbar" className="max-md:flex-1" />
                <RateButton item={item} variant="toolbar" />
              </>}
              {picking ? null : party ? (
                <AfterThisButton
                  size="md"
                  lined={nextId === targetMedia.videoId}
                  onLineUp={() => void lineUp(targetMedia)}
                  className={toolbarIcon}
                />
              ) : (
                <IconButton label="Watch together" className={toolbarIcon} onClick={() => openStartParty(targetMedia, startAt)}>
                  <UsersThreeIcon />
                </IconButton>
              )}
              <IconButton
                label={target.video ? `Choose a source for ${episodeLabel(target.video.season, target.video.episode)}` : "Choose a source"}
                className={toolbarIcon}
                onClick={() => setSourcesFor(targetMedia)}
              >
                <FilmStripIcon />
              </IconButton>
            </Glass>
          </div>
          {noDebrid && <PlayNeedsDebrid id="play-needs-debrid" className="max-md:justify-center max-md:self-stretch" />}
          <Credits meta={meta} className="max-md:order-1 max-md:mt-0 max-md:self-stretch max-md:text-left short:order-1" />
        </div>
      </section>

      {meta.type === "series" && (
        <Episodes
          meta={meta}
          progress={progress}
          initialSeason={target.video?.season}
          onPlay={(video, row) => play(mediaFor(meta, video), { startAt: row && !row.finished ? row.position : 0 })}
          partyMode={!party ? undefined : picking ? "picking" : "watching"}
          nextId={nextId ?? undefined}
          suggestedIds={suggestedIds}
          watchedElsewhere={watchedElsewhere}
          rewatchingSince={simkl?.rewatchingSince ?? undefined}
          onQueue={(video) => void lineUp(mediaFor(meta, video))}
          onSuggest={(video) => void suggest(mediaFor(meta, video))}
        />
      )}

      <MoreLikeThis meta={meta} />

      <SourcesSheet
        media={sourcesFor}
        onClose={() => setSourcesFor(null)}
        onPick={(index, key) => {
          const media = sourcesFor!;
          setSourcesFor(null);
          const row = progress?.find((p) => p.videoId === media.videoId);
          void play(media, { sourceIndex: index, sourceKey: key, startAt: row && !row.finished ? row.position : 0 });
        }}
      />

      <TrailerDialog
        open={trailerOpen}
        onClose={() => setTrailerOpen(false)}
        name={meta.name}
        ids={trailers}
        backdrop={meta.background ?? art.background(meta.id)}
        action={
          <>
            {playButton(true, playLabel, () => setTrailerOpen(false))}
            {partyNames.length > 0 && (
              <p className="text-center text-body text-fg-faint md:text-left">
                Just for you. {partyNames.join(" and ")} won’t see it.
              </p>
            )}
          </>
        }
      />
    </main>
  );
}

/** An icon button in the title's toolbar: its hit area reaches the capsule's top and bottom. */
const toolbarIcon = "relative after:absolute after:inset-x-0 after:-inset-y-1";
