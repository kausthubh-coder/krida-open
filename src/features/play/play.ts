import { useCallback, useEffect, useRef } from "react";
import { useNavigate } from "react-router";
import { useMutation } from "convex/react";
import { toast } from "../../ui/toast";
import { ConvexError } from "convex/values";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { useAuthed } from "../../data/session";
import { PLAY_NEEDS_DEBRID, useNeedsDebrid } from "../../data/keys";
import { logProblem } from "../../data/log";
import { useParty } from "../party";
import type { Meta, Video } from "../../data/cinemeta";
import { episodeTitle, nextEpisode } from "../../data/cinemeta";
import { playAdd } from "../../ui/sound";
import { currentScreen } from "../../ui/screen";
import { startTimer } from "../../data/telemetry";
import { enterPlayerLandscape } from "../../ui/fullscreen";

export type Media = {
  type: "movie" | "series";
  imdbId: string;
  videoId: string;
  season?: number;
  episode?: number;
  name: string;
  episodeTitle?: string;
  poster?: string;
  background?: string;
  logo?: string;
  year?: string;
  ref?: { imdbId: string; season?: number; episode?: number };
};

export function mediaFor(meta: Meta, video?: Video): Media {
  return {
    type: meta.type,
    imdbId: meta.id,
    videoId: video ? video.id : meta.id,
    season: video?.season,
    episode: video?.episode,
    name: meta.name,
    episodeTitle: video ? episodeTitle(video) : undefined,
    ref: video?.imdb_id ? { imdbId: video.imdb_id, season: video.imdbSeason, episode: video.imdbEpisode } : undefined,
    poster: meta.poster,
    background: meta.background,
    logo: meta.logo,
    year: meta.releaseInfo ?? meta.year,
  };
}

export function errorMessage(error: unknown, fallback: string) {
  if (error instanceof ConvexError) return (error.data as { message?: string })?.message ?? fallback;
  return fallback;
}

/**
 * True when Play can't start here: alone, it streams from this account's debrid service, so it needs a debrid key its
 * service accepts; in a party it plays the host's stream. Play shows as unavailable then and says why when pressed.
 */
export function usePlayNeedsDebrid() {
  const party = useParty();
  return useNeedsDebrid() && !party;
}

/**
 * Start watching. Inside a party, Play switches what the party is watching, asking first if someone
 * is mid-watch; outside one, it opens a room just for you (which a friend can still join).
 */
export function usePlay() {
  const { token } = useAuthed();
  const party = useParty();
  const navigate = useNavigate();
  const create = useMutation(api.rooms.create);
  const requestSwitch = useMutation(api.rooms.requestSwitch);
  const playNow = useMutation(api.rooms.playNow);
  const needsDebrid = usePlayNeedsDebrid();

  return useCallback(
    async (media: Media, options: { startAt?: number; sourceIndex?: number; sourceKey?: string } = {}) => {
      if (needsDebrid) {
        toast(PLAY_NEEDS_DEBRID, {
          description: "Add your debrid key in Settings → Connections. TorBox plays everywhere; other services play MP4 files in the browser and the rest in the Mac and Windows apps.",
          action: { label: "Add a key", onClick: () => navigate("/settings/connections") },
        });
        return;
      }
      // While the press still counts: a phone goes full screen and sideways now, before the room exists.
      enterPlayerLandscape();
      // The room times Play from here (features/player/playTiming.ts).
      startTimer(`play:${media.videoId}`);
      const startAt = options.startAt && options.startAt > 5 ? options.startAt : 0;
      const { sourceIndex, sourceKey } = options;
      try {
        if (party) {
          // A specific source is a deliberate choice: just do it.
          if (sourceIndex !== undefined)
            await playNow({ token, roomId: party._id, media, startAt, sourceIndex, sourceKey });
          else await requestSwitch({ token, roomId: party._id, media, startAt });
          navigate(`/watch/${party._id}`);
        } else {
          const roomId = await create({ token, media, startAt, sourceIndex, sourceKey, screen: currentScreen() });
          navigate(`/watch/${roomId}`);
        }
      } catch (error) {
        logProblem("play", `Couldn't start ${media.videoId}: ${String(error)}`, { party: !!party, sourceIndex });
        toast.error(errorMessage(error, "Couldn't start playback. Try again."));
      }
    },
    [token, party, needsDebrid, create, requestSwitch, playNow, navigate],
  );
}

// Resting this long on Play means it; a tap or a quick click just plays.
const PLAY_INTENT_MS = 300;
// The server keeps a prepared stream for hours; asking again sooner only finds it.
const WARMED_FOR_MS = 30 * 60_000;
const warmedAt = new Map<string, number>();

/**
 * Prepares the stream while the pointer rests on a Play button: sources, TorBox and its stream link, so
 * pressing Play starts from a stream that's ready or on its way. `media` can be worked out on demand.
 */
export function useWarmOnHover(media: Media | (() => Promise<Media | undefined>) | undefined) {
  const { token } = useAuthed();
  const warm = useMutation(api.rooms.warm);
  const needsDebrid = useNeedsDebrid();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  if (!media || needsDebrid) return {};
  return {
    onPointerEnter: (e: React.PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      clearTimeout(timer.current);
      timer.current = setTimeout(async () => {
        const target = typeof media === "function" ? await media().catch(() => undefined) : media;
        if (!target || Date.now() - (warmedAt.get(target.videoId) ?? -Infinity) < WARMED_FOR_MS) return;
        warmedAt.set(target.videoId, Date.now());
        await warm({ token, media: target, screen: currentScreen() }).catch(() => warmedAt.delete(target.videoId));
      }, PLAY_INTENT_MS);
    },
    onPointerLeave: () => clearTimeout(timer.current),
  };
}

/** A title page opened: its sources are fetched now (not TorBox), so Play doesn't start by waiting for them. */
export function useWarmSources(media: Pick<Media, "type" | "videoId"> | undefined) {
  const { token } = useAuthed();
  const warm = useMutation(api.sources.warm);
  const type = media?.type;
  const videoId = media?.videoId;
  useEffect(() => {
    if (type && videoId) void warm({ token, type, videoId }).catch(() => {});
  }, [token, type, videoId, warm]);
}

/**
 * Start a watch party and invite people to it. With something picked it starts playing and opens
 * the player; an empty party is picked from wherever you are, so it stays put and returns the id.
 */
export function useStartParty() {
  const { token } = useAuthed();
  const navigate = useNavigate();
  const createParty = useMutation(api.rooms.createParty);
  return useCallback(
    async (inviteIds: Id<"profiles">[], media?: Media, startAt?: number) => {
      if (media) enterPlayerLandscape();
      try {
        const roomId = await createParty({
          token,
          inviteIds,
          media,
          startAt: startAt && startAt > 5 ? startAt : 0,
          screen: currentScreen(),
        });
        if (media) navigate(`/watch/${roomId}`);
        return roomId;
      } catch (error) {
        toast.error(errorMessage(error, "Couldn't start the party. Try again."));
        return null;
      }
    },
    [token, createParty, navigate],
  );
}

/** Put something on the party's table: it starts once everyone here is in. */
export function useSuggest() {
  const { token } = useAuthed();
  const party = useParty();
  const suggest = useMutation(api.rooms.suggest);
  return useCallback(
    async (media: Media) => {
      if (!party) return;
      playAdd();
      try {
        await suggest({ token, roomId: party._id, media });
      } catch (error) {
        toast.error(errorMessage(error, "Couldn't suggest that"));
      }
    },
    [token, party, suggest],
  );
}

/** "Watch after this" in the party you're in: the one thing lined up after the current title. */
export function useWatchAfter() {
  const { token } = useAuthed();
  const party = useParty();
  const setNext = useMutation(api.rooms.setNext);
  return useCallback(
    async (media: Media, roomId?: Id<"rooms">) => {
      const target = roomId ?? party?._id;
      if (!target) return;
      try {
        await setNext({ token, roomId: target, media });
      } catch (error) {
        toast.error(errorMessage(error, "Couldn't line that up"));
      }
    },
    [token, party, setNext],
  );
}

export type ProgressItem = {
  videoId: string;
  season?: number;
  episode?: number;
  position: number;
  duration: number;
  finished: boolean;
  updatedAt: number;
};

/**
 * What "Play" should do for a title right now: resume here, the next episode here, or (for a show
 * you were watching elsewhere) the episode Simkl says comes next.
 */
export function playTarget(meta: Meta, progress: ProgressItem[] | undefined, simklNext?: { season: number; episode: number } | null) {
  const target = kridaTarget(meta, progress);
  if (meta.type === "movie" || !simklNext || (target.row && !target.row.finished)) return target;
  // Watched further somewhere else (Simkl knows): carry on from there.
  const episodes = (meta.videos ?? []).filter((v) => v.season > 0);
  const next = episodes.find((v) => v.season === simklNext.season && v.episode === simklNext.episode);
  if (!next || (next.released && new Date(next.released).getTime() > Date.now())) return target;
  const at = (v?: Video) => (v ? episodes.indexOf(v) : -1);
  return at(next) > at(target.video) ? { video: next, row: undefined } : target;
}

function kridaTarget(meta: Meta, progress: ProgressItem[] | undefined) {
  if (meta.type === "movie") {
    const row = progress?.[0];
    if (row && !row.finished && row.position > 60) return { video: undefined, row };
    return { video: undefined, row: undefined };
  }
  const episodes = (meta.videos ?? []).filter((v) => v.season > 0);
  const latest = progress?.[0];
  if (latest) {
    const current = episodes.find((v) => v.id === latest.videoId);
    if (current && !latest.finished) return { video: current, row: latest };
    const next = nextEpisode(meta, latest.videoId);
    if (next) return { video: next, row: undefined };
  }
  return { video: episodes[0], row: undefined };
}
