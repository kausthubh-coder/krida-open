// The player inside Krida's Android app: what the phone does for it (src/ui/android.ts). Nothing here runs in a
// browser.
import { useEffect, useState } from "react";
import { android, onAndroid } from "../../ui/android";
import { chosenScreenBrightness, type TouchLevel } from "./touch";

/**
 * Watching, from pressing Play until you leave: the app turns the phone sideways and fills the screen, bars hidden,
 * as Netflix does, through the wait for the stream and every episode after it. Leaving gives the phone back its own
 * brightness and lets it turn freely.
 */
export function useAndroidWatching() {
  useEffect(() => {
    if (!android) return;
    android.setPlayer(true);
    return () => android?.setPlayer(false);
  }, []);
}

/**
 * Tells the app whether the picture plays: the screen stays on while it does, and leaving the app shrinks it into
 * the small picture-in-picture window. The small window's play button and closing it reach the player as
 * `togglePlay`, so in a party they move everyone, as the buttons on screen do. Returns the small window (null outside
 * the app), shown with only the picture in it.
 */
export function useAndroidPlayer({ video, paused, togglePlay }: { video: HTMLVideoElement | null; paused: boolean; togglePlay: () => void }) {
  const [pip, setPip] = useState(false);

  // A brightness you chose carries on to the next episode, whose player is a new one.
  useEffect(() => {
    const chosen = chosenScreenBrightness();
    if (android && chosen !== null) android.setBrightness(chosen);
  }, []);

  useEffect(() => {
    android?.setPlaying(!paused);
    return () => android?.setPlaying(false);
  }, [paused]);

  useEffect(() => {
    if (!android || !video) return;
    const size = () => {
      if (video.videoWidth) android?.setVideoSize(video.videoWidth, video.videoHeight);
    };
    size();
    video.addEventListener("loadedmetadata", size);
    video.addEventListener("resize", size);
    return () => {
      video.removeEventListener("loadedmetadata", size);
      video.removeEventListener("resize", size);
    };
  }, [video]);

  useEffect(() => {
    if (!android) return;
    return onAndroid((e) => {
      if (e.type === "pip") setPip(e.on);
      else if (e.type === "media" && (e.action === "toggle" || (video && !video.paused))) togglePlay();
    });
  }, [video, togglePlay]);

  // The small window shows the picture alone (styles.css hides the rest under html[data-pip]).
  useEffect(() => {
    if (!pip) return;
    document.documentElement.dataset.pip = "";
    return () => {
      delete document.documentElement.dataset.pip;
    };
  }, [pip]);

  return android?.canPictureInPicture() ? { on: pip, toggle: () => android?.enterPictureInPicture() } : null;
}

/** The phone's volume keys, in the player: the phone's volume moves, and Krida's own meter shows where it is. */
export function useAndroidVolumeKeys(showLevel: (level: TouchLevel, linger: boolean) => void) {
  useEffect(() => {
    if (!android) return;
    return onAndroid((e) => {
      if (e.type === "volume") showLevel({ kind: "volume", value: e.value }, true);
    });
  }, [showLevel]);
}
