// The <video> element: the HLS stream attached to it, its state mirrored into React, and starting it when ready.
import { useCallback, useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import { useAction } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { Me } from "../../data/session";
import { logProblem } from "../../data/log";
import { android } from "../../ui/android";
import type { Member, RoomData } from "../party";
import type { useRoomSync } from "./playbackSync";
import { stageOf } from "./together";

type Sync = ReturnType<typeof useRoomSync>;

/** Attaches the stream (hls.js, or Safari's own HLS), starting where the room is. */
export function useHlsStream(video: HTMLVideoElement | null, src: string, sync: Sync, setFatal: (error: string | null) => void) {
  useEffect(() => {
    if (!video) return;
    setFatal(null);
    const startAt = sync.expected();
    if (Hls.isSupported()) {
      let networkRetries = 0;
      const hls = new Hls({
        startPosition: startAt > 1 ? startAt : -1,
        maxBufferLength: 30,
        maxMaxBufferLength: 90,
        backBufferLength: 30,
        fragLoadPolicy: {
          default: {
            maxTimeToFirstByteMs: 20_000,
            maxLoadTimeMs: 60_000,
            timeoutRetry: { maxNumRetry: 4, retryDelayMs: 500, maxRetryDelayMs: 4000 },
            errorRetry: { maxNumRetry: 6, retryDelayMs: 1000, maxRetryDelayMs: 8000 },
          },
        },
      });
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && networkRetries < 3) {
          networkRetries++;
          setTimeout(() => hls.startLoad(), 1000 * networkRetries);
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          hls.recoverMediaError();
        } else {
          // Not the URL: the stream's carries the session token.
          logProblem("hls", `${data.type} ${data.details}`, { status: data.response?.code, retries: networkRetries });
          setFatal("The stream stopped loading.");
        }
      });
      hls.on(Hls.Events.FRAG_LOADED, () => (networkRetries = 0));
      hls.loadSource(src);
      hls.attachMedia(video);
      return () => hls.destroy();
    }
    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      // Safari plays HLS natively.
      video.src = src;
      const seek = () => {
        if (startAt > 1) video.currentTime = startAt;
      };
      video.addEventListener("loadedmetadata", seek, { once: true });
      return () => {
        video.removeEventListener("loadedmetadata", seek);
        video.removeAttribute("src");
        video.load();
      };
    }
    setFatal("This browser can’t play HLS video.");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video, src]);
}

/**
 * Plays another debrid service's file straight from its link (an MP4 or WebM the browser has codecs for), starting
 * where the room is. The link comes from following the addon's afresh (desktop.fileLink), since a debrid service's
 * links run out; one that stops loading is fetched once more before the player gives up.
 */
export function useFileStream(video: HTMLVideoElement | null, streamId: Id<"streams">, token: string, sync: Sync, setFatal: (error: string | null) => void) {
  const fileLink = useAction(api.desktop.fileLink);
  useEffect(() => {
    if (!video) return;
    let alive = true;
    let retried = false;
    setFatal(null);
    const load = async (start: number) => {
      const url = await fileLink({ token, streamId });
      if (!alive) return;
      if (!url) return setFatal("This file isn’t available anymore. Choose another source.");
      video.src = url;
      const seek = () => {
        if (start > 1) video.currentTime = start;
      };
      video.addEventListener("loadedmetadata", seek, { once: true });
    };
    const onError = () => {
      if (!alive || !video.error) return;
      logProblem("file", `media error ${video.error.code}`, { stream: streamId, retried });
      if (retried) return setFatal("The file stopped loading.");
      retried = true;
      void load(video.currentTime).catch(() => alive && setFatal("The file stopped loading."));
    };
    video.addEventListener("error", onError);
    load(sync.expected()).catch(() => alive && setFatal("The file stopped loading."));
    return () => {
      alive = false;
      video.removeEventListener("error", onError);
      video.removeAttribute("src");
      video.load();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video, streamId, token]);
}

/** The element's state, mirrored from its events. */
/**
 * The video's state for the player. `time` changes only when playback crosses one of the marks `marksAt` gives for the
 * duration (stageOf): what reads it compares it with those, so a playing film doesn't redraw the player. The timeline
 * and subtitles keep their own time.
 */
export function useVideoState(
  video: HTMLVideoElement | null,
  initialDuration: number,
  setBlocked: (blocked: boolean) => void,
  marksAt: (duration: number) => number[],
) {
  const [paused, setPaused] = useState(true);
  const [time, setTimeState] = useState(0);
  // The time last given to React, so a tick between two marks schedules nothing: an update that turns out the same
  // still renders the player whenever React can't tell at once.
  const timeRef = useRef(0);
  const setTime = useCallback((t: number) => {
    timeRef.current = t;
    setTimeState(t);
  }, []);
  /** Takes the video's time only where it crosses a mark. */
  const follow = useCallback((now: number) => {
    if (stageOf(marksRef.current, timeRef.current) !== stageOf(marksRef.current, now)) setTime(now);
  }, [setTime]);
  const [duration, setDuration] = useState(initialDuration);
  const [waiting, setWaiting] = useState(true);
  /** The first frames are in: until then a paused video has nothing to play yet. */
  const [canPlay, setCanPlay] = useState(false);
  // In the Android app the phone's own volume is the one that moves (touch.ts), so the film plays at full.
  const [volume, setVolume] = useState(() => (android ? 1 : Number(localStorage.getItem("krida.volume") ?? 1)));
  const [muted, setMuted] = useState(false);
  const [ended, setEnded] = useState(false);
  const marks = marksAt(duration);
  const marksRef = useRef(marks);
  marksRef.current = marks;

  useEffect(() => {
    if (!video) return;
    video.volume = volume;
    const on = (type: string, fn: () => void) => {
      video.addEventListener(type, fn);
      return () => video.removeEventListener(type, fn);
    };
    const offs = [
      on("play", () => {
        setPaused(false);
        setBlocked(false);
        setEnded(false);
      }),
      on("pause", () => setPaused(true)),
      on("timeupdate", () => follow(video.currentTime)),
      on("durationchange", () => Number.isFinite(video.duration) && setDuration(video.duration)),
      on("waiting", () => setWaiting(true)),
      on("playing", () => setWaiting(false)),
      on("canplay", () => {
        setWaiting(false);
        setCanPlay(true);
      }),
      on("seeking", () => setWaiting(true)),
      on("seeked", () => {
        setWaiting(false);
        // Scrubbing back from the end, paused: Up next's countdown is over, and nothing advances the room.
        setEnded(video.ended);
      }),
      on("ended", () => setEnded(true)),
      on("volumechange", () => setMuted(video.muted)),
    ];
    return () => offs.forEach((off) => off());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video]);

  // New marks (the duration known, a skip found) may put the time in another stage.
  const marksKey = marks.join(",");
  useEffect(() => {
    if (video) follow(video.currentTime);
  }, [video, marksKey, follow]);

  useEffect(() => {
    if (video) video.volume = volume;
    localStorage.setItem("krida.volume", String(volume));
  }, [video, volume]);

  return { paused, time, setTime, duration, waiting, canPlay, volume, setVolume, muted, ended };
}

/** Once the stream is ready, whoever started it presses play for everyone. */
export function useAutoStart(video: HTMLVideoElement | null, room: RoomData, online: Member[], me: Me, sync: Sync, setBlocked: (blocked: boolean) => void) {
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!video || autoStarted.current) return;
    const p = room.playback;
    // Whoever picked this presses play for everyone. If they aren't in the player, the first person
    // who is does it instead, so nobody sits waiting.
    const watchers = online.filter((x) => x.watching).sort((a, b) => a._id.localeCompare(b._id));
    const pickerWatching = !!p.by && watchers.some((x) => x._id === p.by);
    const iAmStarter = pickerWatching ? p.by === me._id : (watchers[0]?._id ?? me._id) === me._id;
    if (p.action !== "ready" || p.playing || !iAmStarter) return;
    const start = () => {
      if (autoStarted.current) return;
      autoStarted.current = true;
      video.play().then(
        () => sync.send("play", true, video.currentTime),
        () => setBlocked(true),
      );
    };
    if (video.readyState >= 3) start();
    else {
      video.addEventListener("canplay", start, { once: true });
      return () => video.removeEventListener("canplay", start);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video, room.playback.seq]);
}

/**
 * True once `on` has lasted `ms`. A skip inside what's buffered lands in a tenth of a second or two; a spinner that
 * shows for that long only flickers over it, so the wait has to last before it says anything.
 */
export function useLasting(on: boolean, ms: number) {
  const [lasting, setLasting] = useState(false);
  useEffect(() => {
    if (!on) return;
    const id = setTimeout(() => setLasting(true), ms);
    // The wait is over: the next one starts from nothing again.
    return () => {
      clearTimeout(id);
      setLasting(false);
    };
  }, [on, ms]);
  return on && lasting;
}
