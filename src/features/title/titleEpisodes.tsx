// The title page's episode list: seasons, marking episodes watched, and each episode's row.
import { useEffect, useMemo, useState } from "react";
import { useMutation } from "convex/react";
import { toast } from "../../ui/toast";
import { useQuery } from "convex-helpers/react/cache/hooks";
import {
  CheckCircleIcon,
  CheckIcon,
  PlayIcon,
  StarIcon,
} from "@phosphor-icons/react";
import { api } from "../../../convex/_generated/api";
import { useAuthed } from "../../data/session";
import { art, episodeTitle, type Meta, type Video } from "../../data/cinemeta";
import { episodeLabel, timeLeft } from "../../ui/format";
import { errorMessage, mediaFor, useWarmOnHover, type Media, type ProgressItem } from "../play";
import { AfterThisButton, SuggestIcon } from "../party";
import { Art } from "../../ui/artwork";
import type { ArtLookup } from "../../ui/artFallback";
import { Button, cx, EmptyState, IconButton, Segmented } from "../../ui/ui";
import { lookupOf } from "./lookup";

export function Episodes({
  meta,
  progress,
  initialSeason,
  onPlay,
  onQueue,
  onSuggest,
  partyMode,
  nextId,
  suggestedIds,
  watchedElsewhere,
  rewatchingSince,
}: {
  meta: Meta;
  progress: ProgressItem[] | undefined;
  initialSeason?: number;
  onPlay: (video: Video, row?: ProgressItem) => void;
  onQueue: (video: Video) => void;
  onSuggest: (video: Video) => void;
  partyMode?: "picking" | "watching";
  nextId?: string;
  suggestedIds: Set<string>;
  watchedElsewhere: Set<string>;
  // While rewatching, only plays and marks since it began count.
  rewatchingSince?: number;
}) {
  const { token, me } = useAuthed();
  const mark = useMarkEpisodes(meta, rewatchingSince);
  const blurUnwatched = !!me.prefs.blurUnwatched;
  // The same subscription as the Rate button, so episode scores appear the moment they're saved.
  const ratings = useQuery(api.ratings.details, { token, id: meta.id });
  const episodeScores = useMemo(
    () => new Map((ratings?.parts ?? []).filter((p) => p.episode !== undefined && p.rating !== null).map((p) => [`${p.season}:${p.episode}`, p.rating!])),
    [ratings?.parts],
  );
  const seasons = useMemo(() => {
    const set = new Set((meta.videos ?? []).map((v) => v.season));
    const list = [...set].sort((a, b) => a - b);
    // Specials last: most people want season 1 first.
    return [...list.filter((s) => s > 0), ...list.filter((s) => s === 0)];
  }, [meta.videos]);
  const [season, setSeason] = useState(initialSeason ?? seasons[0] ?? 1);
  useEffect(() => {
    if (initialSeason !== undefined) setSeason(initialSeason);
  }, [initialSeason]);

  const byVideo = useMemo(() => new Map((progress ?? []).map((p) => [p.videoId, p])), [progress]);
  const inSeason = (meta.videos ?? []).filter((v) => v.season === season);
  // Long-running anime can have a thousand episodes in one season: show them fifty at a time.
  const PAGE = 50;
  const ranges = Math.ceil(inSeason.length / PAGE);
  const latest = progress?.find((p) => inSeason.some((v) => v.id === p.videoId));
  const [range, setRange] = useState(() =>
    latest ? Math.floor(Math.max(0, inSeason.findIndex((v) => v.id === latest.videoId)) / PAGE) : 0,
  );
  useEffect(() => {
    if (range >= ranges) setRange(0);
  }, [season, range, ranges]);
  const episodes = ranges > 1 ? inSeason.slice(range * PAGE, range * PAGE + PAGE) : inSeason;
  const seenOn = (v: Video): "here" | "simkl" | undefined => {
    const row = byVideo.get(v.id);
    if (rewatchingSince !== undefined) return row?.finished && row.updatedAt >= rewatchingSince ? "here" : undefined;
    return row?.finished ? "here" : !row && watchedElsewhere.has(`${v.season}:${v.episode}`) ? "simkl" : undefined;
  };
  const watched = (v: Video) => seenOn(v) !== undefined;
  const watchedCount = inSeason.filter(watched).length;
  const unseen = inSeason.filter((v) => !watched(v) && !isUpcoming(v));
  const toggle = (v: Video) => {
    const seen = !watched(v);
    void mark([v], seen);
    // Ticking an episode partway through a season usually means everything before it too.
    const before = seen && v.season > 0 ? unseen.filter((e) => e.episode < v.episode) : [];
    if (before.length)
      toast(`${episodeLabel(v.season, v.episode)} marked watched`, {
        action: {
          label: before.length === 1 ? `Mark E${before[0].episode} too` : `Mark E${before[0].episode}–E${before.at(-1)!.episode} too`,
          onClick: () => void mark(before, true),
        },
      });
  };

  if (seasons.length === 0)
    return <EmptyState title="No episodes listed yet" description="The catalog has no episode list for this show." />;

  return (
    <section aria-labelledby="episodes-heading" className="flex flex-col gap-4 px-4 md:px-12">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
        <div className="flex shrink-0 items-baseline gap-3">
          <h2 id="episodes-heading" className="text-title font-semibold">Episodes</h2>
          {watchedCount > 0 && (
            <p className="text-caption text-fg-muted tabular-nums">
              {watchedCount === inSeason.length ? "All watched" : `${watchedCount} of ${inSeason.length} watched`}
              {rewatchingSince !== undefined && " this time"}
            </p>
          )}
        </div>
        {seasons.length > 1 && (
          <div className="-mx-4 min-w-0 px-4 sm:mx-0 sm:px-0">
            <Segmented
              label="Seasons"
              value={String(season)}
              onChange={(s) => setSeason(Number(s))}
              options={seasons.map((s) => ({ value: String(s), label: s === 0 ? "Specials" : `Season ${s}` }))}
            />
          </div>
        )}
        {unseen.length > 1 && (
          <Button variant="ghost" className="-ml-3.5 self-start sm:ml-auto sm:self-center" icon={<CheckIcon weight="bold" />}
            onClick={() => void mark(unseen, true)}>
            Mark {season === 0 ? "specials" : "season"} watched
          </Button>
        )}
      </div>
      {ranges > 1 && (
        <Segmented
          label="Episode ranges"
          value={String(range)}
          onChange={(r) => setRange(Number(r))}
          options={Array.from({ length: ranges }, (_, i) => ({
            value: String(i),
            label: `${inSeason[i * PAGE]?.episode}–${inSeason[Math.min(inSeason.length, (i + 1) * PAGE) - 1]?.episode}`,
          }))}
        />
      )}
      {/* Rows are padded for their hover; the list steps out by as much, so thumbnails line up with the page.
          More columns on wide screens, so a synopsis stays a readable length. */}
      <ol className="-mx-2 grid gap-x-6 gap-y-2 lg:grid-cols-2 min-[120rem]:grid-cols-3 min-[180rem]:grid-cols-4">
        {episodes.map((v) => (
          <EpisodeRow
            key={v.id}
            video={v}
            row={byVideo.get(v.id)}
            media={mediaFor(meta, v)}
            fallbackArt={art.background(meta.id) ?? meta.background}
            lookup={lookupOf(meta)}
            onPlay={() => onPlay(v, byVideo.get(v.id))}
            onQueue={() => onQueue(v)}
            onSuggest={() => onSuggest(v)}
            partyMode={partyMode}
            lined={nextId === v.id}
            suggested={suggestedIds.has(v.id)}
            seen={seenOn(v)}
            onToggleSeen={() => toggle(v)}
            score={episodeScores.get(`${v.season}:${v.episode}`)}
            // An episode started but not finished has been seen in part, so it stays as it is.
            hideSpoilers={blurUnwatched && !watched(v) && !byVideo.get(v.id)}
          />
        ))}
      </ol>
    </section>
  );
}

/** Marks episodes watched or not. Shown at once; the server orders the plays and tells Simkl. */
function useMarkEpisodes(meta: Meta, rewatchingSince?: number) {
  const { token } = useAuthed();
  const markEpisodes = useMutation(api.progress.mark).withOptimisticUpdate((store, { episodes, watched }) => {
    const ids = new Set(episodes.map((m) => m.videoId));
    const rows = store.getQuery(api.progress.forTitle, { token, imdbId: meta.id });
    if (rows !== undefined) {
      const kept = rows.filter((r) => !ids.has(r.videoId));
      // Added last, so Play doesn't jump to an old episode before the server places it.
      const added = watched ? episodes.map((m) => {
        const row = rows.find((r) => r.videoId === m.videoId);
        return { videoId: m.videoId, season: m.season, episode: m.episode, position: row?.position ?? 0,
          duration: row?.duration ?? 0, finished: true, updatedAt: Math.max(Date.now(), rewatchingSince ?? 0) };
      }) : [];
      store.setQuery(api.progress.forTitle, { token, imdbId: meta.id }, [...kept, ...added]);
    }
    const simkl = store.getQuery(api.simkl.forTitle, { token, id: meta.id });
    if (simkl && !watched && rewatchingSince === undefined) {
      const keys = new Set(episodes.map((m) => `${m.season}:${m.episode}`));
      store.setQuery(api.simkl.forTitle, { token, id: meta.id }, { ...simkl, watched: simkl.watched.filter((k) => !keys.has(k)) });
    }
  });
  return async (videos: Video[], watched: boolean) => {
    try {
      await markEpisodes({ token, episodes: videos.map((v) => mediaFor(meta, v)), watched });
    } catch (error) {
      toast.error(errorMessage(error, "Couldn’t save that. Try again."));
    }
  };
}

const isUpcoming = (v: Video) => !!v.released && new Date(v.released).getTime() > Date.now();

function EpisodeRow({
  video,
  row,
  media,
  fallbackArt,
  lookup,
  onPlay,
  onQueue,
  onSuggest,
  partyMode,
  lined,
  suggested,
  seen,
  onToggleSeen,
  score,
  hideSpoilers,
}: {
  video: Video;
  row?: ProgressItem;
  media: Media;
  fallbackArt?: string;
  lookup: ArtLookup;
  onPlay: () => void;
  onQueue: () => void;
  onSuggest: () => void;
  partyMode?: "picking" | "watching";
  lined: boolean;
  suggested: boolean;
  seen?: "here" | "simkl";
  onToggleSeen: () => void;
  score?: number;
  /** Blur its still and description: the profile hides episodes it hasn't watched (Settings → Home). */
  hideSpoilers?: boolean;
}) {
  const upcoming = isUpcoming(video);
  const released = video.released
    ? new Date(video.released).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : undefined;
  const overview = video.overview ?? video.description;
  const warmPlay = useWarmOnHover(upcoming ? undefined : media);
  return (
    <li className="group flex items-start gap-4 rounded-card p-2 hover:bg-white/4">
      <button
        {...warmPlay}
        onClick={onPlay}
        disabled={upcoming}
        className={cx("press-soft relative w-32 shrink-0 rounded-[8px] sm:w-48", hideSpoilers && "spoiler overflow-hidden")}
        aria-label={`Play ${episodeLabel(video.season, video.episode)}, ${episodeTitle(video)}`}
      >
        <Art
          // An episode yet to air keeps its label rather than repeating the show's backdrop down the list.
          src={video.thumbnail ?? (upcoming ? undefined : fallbackArt)}
          alt=""
          fallbackTitle={episodeLabel(video.season, video.episode)}
          lookup={lookup}
          className="aspect-video w-full rounded-[8px] img-outline"
        />
        {!upcoming && (
          <span className="absolute inset-0 grid place-items-center rounded-[8px] bg-black/30 opacity-0 group-hover:opacity-100">
            <span className="grid size-10 place-items-center rounded-full bg-black/60 text-white shadow-[inset_0_0_0_1px_oklch(1_0_0/0.12)]">
              <PlayIcon weight="fill" />
            </span>
          </span>
        )}
        {row && !row.finished && (
          <span className="absolute inset-x-2 bottom-2 h-1 overflow-hidden rounded-full bg-black/50">
            <span
              className="block h-full rounded-full bg-accent"
              style={{ width: `${(row.position / row.duration) * 100}%` }}
            />
          </span>
        )}
      </button>
      <div className="flex min-w-0 flex-1 flex-col gap-1 py-1">
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1 text-body font-medium text-fg">
            <span className="text-fg-faint tabular-nums">{video.episode}.</span> {episodeTitle(video)}
          </p>
          {score !== undefined && (
            <span className="inline-flex shrink-0 items-center gap-1 text-caption font-medium text-fg tabular-nums" title="Your rating">
              <StarIcon weight="fill" aria-hidden className="text-accent" />
              {score}
              <span className="sr-only"> out of 10, your rating</span>
            </span>
          )}
          {(seen || !upcoming) && (
            <IconButton
              size="sm"
              label={seen
                ? `Mark ${episodeLabel(video.season, video.episode)} unwatched${seen === "simkl" ? " (watched on Simkl)" : ""}`
                : `Mark ${episodeLabel(video.season, video.episode)} watched`}
              aria-pressed={!!seen}
              onClick={onToggleSeen}
              className={cx(
                "relative -my-1.5 -mr-1.5 after:absolute after:-inset-1.5",
                seen ? "text-fg-muted hover:text-fg" : "text-fg-faint hover:text-fg md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100",
              )}
            >
              <CheckCircleIcon weight={seen ? "fill" : "regular"} />
            </IconButton>
          )}
        </div>
        {/* Tall enough for the party buttons only when they're there; otherwise the date sits right under the name. */}
        <div className={cx("flex items-center gap-2", partyMode && !upcoming && "min-h-8")}>
          <p className="min-w-0 flex-1 truncate text-caption text-fg-faint">
            {upcoming ? `Airs ${released}` : released}
            {row && !row.finished && ` · ${timeLeft(row.position, row.duration)}`}
          </p>
          {/* Sources and starting a party live on the page's main buttons; a row only suggests or lines up. */}
          {partyMode && !upcoming && (
            <div
              className={cx(
                "-my-1 -mr-1 flex shrink-0",
                !(partyMode === "picking" ? suggested : lined) &&
                  "md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100",
              )}
            >
              {partyMode === "picking" ? (
                <IconButton
                  size="sm"
                  label={suggested ? "On the table" : `Suggest ${episodeLabel(video.season, video.episode)}`}
                  aria-pressed={suggested}
                  onClick={suggested ? undefined : onSuggest}
                  className={cx("relative after:absolute after:-inset-1.5", suggested && "text-accent")}
                >
                  <SuggestIcon done={suggested} />
                </IconButton>
              ) : (
                <AfterThisButton lined={lined} onLineUp={onQueue} className="relative after:absolute after:-inset-1.5" />
              )}
            </div>
          )}
        </div>
        {overview &&
          (hideSpoilers ? (
            <p className="mt-1 text-body text-fg-muted">
              <span aria-hidden className="spoiler-text line-clamp-2">{overview}</span>
              <span className="sr-only">Description hidden until you watch it</span>
            </p>
          ) : (
            <p className="mt-1 line-clamp-2 text-body text-fg-muted">{overview}</p>
          ))}
      </div>
    </li>
  );
}
