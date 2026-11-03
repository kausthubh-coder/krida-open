import { useCallback, useEffect, useState } from "react";
import type { useRoomSync } from "./playbackSync";

/**
 * Skips pressed in quick succession gather into one seek, as in Stremio. The first press lands at once: a skip into
 * what's buffered takes a tenth of a second, and most single presses are that. The presses after it only move the
 * aim, and the player goes there once, 300 ms after the last. Past the buffer every seek is a fresh request for the
 * file (1.5 to 2.5 s for a 4K TorBox file in the app), so five quick presses wait once rather than five times, and a
 * party sees two moves rather than five.
 */
export const GATHER_MS = 300;

export const clampTime = (t: number, duration: number) => Math.max(0, Math.min(t, (duration || Infinity) - 1));

export type Skipper = {
  /**
   * Skips `seconds` from where the presses so far aim, or from `from` (the video's time) when this is the first.
   * `land` seeks; the gathered seek uses the one from the last press.
   */
  by: (seconds: number, from: number, duration: number, land: (t: number) => void) => void;
  /** Another kind of seek (the timeline, the room) ends the presses without going where they aimed. */
  cancel: () => void;
};

/** `aim` gets where the presses are headed while the picture hasn't gone there yet, then null. */
export function skipper(aim: (t: number | null) => void): Skipper {
  let presses: { to: number; landed: number; timer: ReturnType<typeof setTimeout> } | null = null;
  return {
    by(seconds, from, duration, land) {
      const to = clampTime((presses?.to ?? from) + seconds, duration);
      if (presses) clearTimeout(presses.timer);
      else land(to);
      const landed = presses?.landed ?? to;
      presses = {
        to,
        landed,
        timer: setTimeout(() => {
          presses = null;
          aim(null);
          if (to !== landed) land(to);
        }, GATHER_MS),
      };
      aim(to === landed ? null : to);
    },
    cancel() {
      if (!presses) return;
      clearTimeout(presses.timer);
      presses = null;
      aim(null);
    },
  };
}

/** Seeking for the player: `seekTo` goes somewhere and tells the room; `skipBy` is back and forward. */
export function useSeek({ video, duration, sync, setTime }: {
  video: HTMLVideoElement | null;
  duration: number;
  sync: ReturnType<typeof useRoomSync>;
  setTime: (t: number) => void;
}) {
  const { send } = sync;
  const land = useCallback(
    (t: number, action: "seek" | "skip" = "seek") => {
      if (!video) return;
      const target = clampTime(t, duration);
      video.currentTime = target;
      setTime(target);
      send(action, !video.paused, target);
    },
    [video, duration, send, setTime],
  );
  const [aim, setAim] = useState<number | null>(null);
  // One for the player's life: what `land` depends on changes between presses, and the presses carry on across it.
  const [skips] = useState(() => skipper(setAim));
  useEffect(() => () => skips.cancel(), [skips]);
  const seekTo = useCallback(
    (t: number, action: "seek" | "skip" = "seek") => {
      skips.cancel();
      land(t, action);
    },
    [skips, land],
  );
  const skipBy = useCallback(
    (seconds: number) => {
      if (video) skips.by(seconds, video.currentTime, duration, land);
    },
    [skips, video, duration, land],
  );
  return { seekTo, skipBy, aim };
}
