import { useEffect } from "react";
import { timerSince, track } from "../../data/telemetry";
import type { RoomData } from "../party";

/*
 * How long Play takes, step by step, and how the picture holds up once it plays: PostHog's `play_timing` and
 * `playback_health` (src/data/telemetry.ts), the numbers to make Play faster and stalls rarer by.
 */

type Attempt = {
  videoId: string;
  started: number;
  /** When each step the room showed ("Finding sources", "Adding to TorBox", "Starting stream") began, in ms. */
  steps: Record<string, number>;
  readyMs?: number;
  sent: boolean;
  context: Record<string, unknown>;
};
let attempt: Attempt | null = null;

const since = (a: Attempt) => Math.round(performance.now() - a.started);

function finish(outcome: "played" | "error" | "left", extra?: Record<string, unknown>) {
  if (!attempt || attempt.sent) return;
  attempt.sent = true;
  track("play_timing", { outcome, videoId: attempt.videoId, ...attempt.context, steps: attempt.steps, readyMs: attempt.readyMs, totalMs: since(attempt), ...extra });
}

/** In the room: from Play (or opening the room) through each preparing step to the stream being ready. */
export function usePlayTiming(room: RoomData) {
  const media = room.media;
  const videoId = media?.videoId;
  useEffect(() => {
    if (!videoId) return;
    // From the press when Play was pressed here; a party joined from a link starts when the room opens.
    const pressed = timerSince(`play:${videoId}`);
    attempt = {
      videoId,
      started: performance.now() - (pressed ?? 0),
      steps: {},
      sent: false,
      context: { type: media.type, name: media.name, members: room.members.length, fromPress: pressed !== undefined },
    };
    return () => finish("left");
  }, [videoId]); // eslint-disable-line react-hooks/exhaustive-deps -- once per title; the rest is read as it was then
  useEffect(() => {
    const step = room.step?.replace("…", "");
    if (attempt && step && attempt.steps[step] === undefined) attempt.steps[step] = since(attempt);
  }, [room.step]);
  useEffect(() => {
    if (!attempt) return;
    if (room.status === "ready") attempt.readyMs ??= since(attempt);
    if (room.status === "error") finish("error", { error: room.error });
  }, [room.status, room.error]);
}

/** Five minutes of watching per `playback_health`, plus one when the player closes. */
const REPORT_EVERY_MS = 5 * 60_000;

/**
 * In the player: the first frame (which ends `play_timing`), then stalls, waits after seeking and dropped frames,
 * sent every few minutes. `video` is the element, or mpv standing in for it in Krida's apps.
 */
export function usePlaybackHealth(video: HTMLVideoElement | null, stream: { _id: string; size?: number; height?: number; videoCodec?: string }, mpv: boolean) {
  useEffect(() => {
    if (!video) return;
    let played = false;
    // Sent "closed" already (the page went away, then React unmounted): once is enough.
    let windowClosed = false;
    let window = performance.now();
    let stalls = 0;
    let stalledMs = 0;
    let seekWaits = 0;
    let seekWaitMs = 0;
    let waiting: { at: number; seeking: boolean } | null = null;
    const quality = () => (video instanceof HTMLVideoElement ? video.getVideoPlaybackQuality() : undefined);
    let dropped = quality()?.droppedVideoFrames ?? 0;

    const onWaiting = () => {
      if (played && !waiting) waiting = { at: performance.now(), seeking: video.seeking };
    };
    const onPlaying = () => {
      if (!played) {
        played = true;
        finish("played", { firstFrameMs: attempt ? since(attempt) : undefined, mpv });
      }
      if (!waiting) return;
      const ms = performance.now() - waiting.at;
      if (waiting.seeking) {
        seekWaits++;
        seekWaitMs += ms;
      } else {
        stalls++;
        stalledMs += ms;
      }
      waiting = null;
    };
    const report = (reason: "interval" | "closed") => {
      if (!played || windowClosed) return;
      const q = quality();
      track("playback_health", {
        reason,
        stream: stream._id,
        size: stream.size,
        fileHeight: stream.height,
        codec: stream.videoCodec,
        mpv,
        windowMs: Math.round(performance.now() - window),
        stalls,
        stalledMs: Math.round(stalledMs),
        seekWaits,
        seekWaitMs: Math.round(seekWaitMs),
        droppedFrames: q ? q.droppedVideoFrames - dropped : undefined,
        width: video.videoWidth,
        height: video.videoHeight,
        paused: video.paused,
      });
      window = performance.now();
      windowClosed = reason === "closed";
      stalls = stalledMs = seekWaits = seekWaitMs = 0;
      dropped = q?.droppedVideoFrames ?? dropped;
    };
    // Closing the tab or the app ends the page without unmounting the player: report what's left as it goes.
    const onHide = () => report("closed");
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("playing", onPlaying);
    addEventListener("pagehide", onHide);
    const id = setInterval(() => report("interval"), REPORT_EVERY_MS);
    return () => {
      clearInterval(id);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("playing", onPlaying);
      removeEventListener("pagehide", onHide);
      report("closed");
    };
  }, [video, stream._id, stream.size, stream.height, stream.videoCodec, mpv]);
}
