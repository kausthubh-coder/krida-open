// Playback speed and picture in picture.
import { useCallback, useEffect, useState } from "react";

/** The speeds on offer, as YouTube and Netflix have them. */
export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;
export const speedLabel = (s: number) => (s === 1 ? "Normal" : `${s}×`);

/** One step faster or slower from `speed`, stopping at the ends; a speed off the list steps from normal. */
export function nextSpeed(speed: number, by: 1 | -1) {
  const i = SPEEDS.indexOf(speed as (typeof SPEEDS)[number]);
  return SPEEDS[Math.min(SPEEDS.length - 1, Math.max(0, (i === -1 ? SPEEDS.indexOf(1) : i) + by))]!;
}

/**
 * The speed you chose, kept from one episode to the next until the page reloads. A party always plays at 1×:
 * everyone shares one clock, so one person's speed would pull them apart.
 */
let chosen = 1;

/** Your speed, and one step faster or slower (Shift+. and Shift+, as on YouTube). Null in a party. */
export function useSpeed(party: boolean) {
  const [speed, setState] = useState(chosen);
  const setSpeed = useCallback((s: number) => {
    chosen = s;
    setState(s);
  }, []);
  const step = useCallback(
    (by: 1 | -1) => {
      const next = nextSpeed(speed, by);
      setSpeed(next);
      return next;
    },
    [speed, setSpeed],
  );
  return party ? null : { speed, setSpeed, step };
}

type WebkitVideo = HTMLVideoElement & {
  webkitSupportsPresentationMode?: (mode: string) => boolean;
  webkitPresentationMode?: string;
  webkitSetPresentationMode?: (mode: string) => void;
};

/**
 * The picture in its own small window over other apps and tabs, for Chrome, Edge, Safari and Android; null where
 * the browser has none (Firefox keeps its own button on the video).
 */
export function usePictureInPicture(video: HTMLVideoElement | null) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!video) return;
    const update = () =>
      setOn(document.pictureInPictureElement === video || (video as WebkitVideo).webkitPresentationMode === "picture-in-picture");
    const events = ["enterpictureinpicture", "leavepictureinpicture", "webkitpresentationmodechanged"];
    for (const e of events) video.addEventListener(e, update);
    return () => {
      for (const e of events) video.removeEventListener(e, update);
      // Leaving the player takes the small window with it.
      if (document.pictureInPictureElement === video) void document.exitPictureInPicture().catch(() => {});
    };
  }, [video]);
  const v = video as WebkitVideo | null;
  const standard = !!v && document.pictureInPictureEnabled && !v.disablePictureInPicture;
  const webkit = !!v?.webkitSupportsPresentationMode?.("picture-in-picture");
  if (!v || (!standard && !webkit)) return null;
  const toggle = () => {
    if (standard) {
      if (document.pictureInPictureElement) void document.exitPictureInPicture().catch(() => {});
      else void v.requestPictureInPicture().catch(() => {});
    } else v.webkitSetPresentationMode?.(on ? "inline" : "picture-in-picture");
  };
  return { on, toggle };
}
