// The player inside Krida's Android app: what the phone does for it (src/ui/android.ts). Nothing here runs in a
// browser.
import { useEffect, useState } from "react";
import type { DesktopApp } from "../../data/desktop";
import { android, androidAtLeast, onAndroid } from "../../ui/android";
import { isShown } from "../../ui/dpad";
import { MpvVideo } from "./desktop";
import { chosenScreenBrightness, type TouchLevel } from "./touch";

/** The app plays a file itself, under the page, from 1.4 (NativePlayer.kt); an older one sends it elsewhere, as a browser does. */
export const nativePlayer = () => !!android?.playerLoad && androidAtLeast("1.4");

/**
 * The app's player as the desktop app's calls: it takes mpv's commands and properties and reports as mpv does, so
 * `MpvVideo` drives it unchanged, and with it party sync, skips, Up next and the controls. What only mpv can (looking
 * at the frame for black bars, debanding) it refuses or ignores, and the player offers neither.
 */
function nativeCalls(bridge: NonNullable<typeof android>): DesktopApp {
  let fileSubtitles = false;
  const run = (command: string, a: Record<string, unknown>) => {
    switch (command) {
      case "mpv_load":
        return bridge.playerLoad!(String(a.url), Number(a.start), a.paused === true, Number(a.aid), String(a.title));
      case "mpv_seek":
        return bridge.playerSeek!(Number(a.time));
      case "mpv_set":
        if (a.name === "sid") fileSubtitles = typeof a.value === "number" && a.value > 0;
        return bridge.playerSet!(String(a.name), JSON.stringify(a.value));
      case "mpv_stop":
        return bridge.playerStop!();
      // ExoPlayer starts in a moment; there's nothing to warm.
      case "mpv_warm":
        return;
      default:
        throw new Error(`The Android app can't ${command}`);
    }
  };
  return {
    core: {
      invoke<T>(command: string, args: Record<string, unknown> = {}) {
        try {
          run(command, args);
          return Promise.resolve(undefined as T);
        } catch (error) {
          return Promise.reject(error as Error);
        }
      },
    },
    event: {
      listen<T>(_event: string, handler: (event: { payload: T }) => void) {
        // Media3 1.9 cannot offset embedded tracks. Its text output arrives at presentation time, too late to
        // advance cues. Suppress G/H for those tracks, matching the hidden Timing row; page-rendered tracks work.
        const timingKey = (e: KeyboardEvent) => {
          if (fileSubtitles && !e.altKey && !e.ctrlKey && !e.metaKey &&
              !(e.target as HTMLElement)?.closest("input, textarea, select, [contenteditable], dialog") && ["g", "h"].includes(e.key.toLowerCase())) {
            e.preventDefault();
            e.stopImmediatePropagation();
          }
        };
        addEventListener("keydown", timingKey, { capture: true });
        const off = onAndroid((e) => e.type === "player" && handler({ payload: e as T }));
        return Promise.resolve(() => { off(); removeEventListener("keydown", timingKey, { capture: true }); });
      },
    },
  };
}

/**
 * In the Android app, from 1.4, ExoPlayer plays the file under the page and stands in for the <video> element, as mpv
 * does in the desktop app (`useDesktopStream` plays it); null anywhere else, or when `wanted` is false.
 */
export function useNativeVideo(wanted: boolean) {
  const [video] = useState(() => (wanted && android && nativePlayer() ? new MpvVideo(nativeCalls(android)) : null));
  useEffect(() => video?.attach(), [video]);
  return video;
}

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

/** The player's play button: the capsule's, or in the one-capsule layout the one in the middle of the picture. */
const PLAY_BUTTONS = 'button:is([aria-label="Play"], [aria-label="Pause"], [aria-label^="Play ("], [aria-label^="Pause ("]):not([tabindex="-1"])';

/**
 * A TV remote in the player. Its middle button plays and pauses; up or down bring the controls up with focus on play,
 * and from there the arrows move between them (ui/dpad.ts) and the middle button presses. With nothing focused, left
 * and right still seek (keys.ts). Every key keeps the controls up while you move through them.
 */
export function useRemoteKeys({ togglePlay, wake }: { togglePlay: () => void; wake: () => void }) {
  useEffect(() => {
    if (!android) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const active = document.activeElement;
      // Focus left on a control that has since faded out counts as none.
      const free = !(active instanceof HTMLElement) || active === document.body || active instanceof HTMLVideoElement || !isShown(active);
      if (!free || !["Enter", "ArrowUp", "ArrowDown"].includes(e.key)) {
        if (!active?.closest("dialog")) wake();
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      wake();
      if (e.key === "Enter") return togglePlay();
      // Once the controls are back: still fading in, so not yet opaque.
      requestAnimationFrame(() =>
        requestAnimationFrame(() =>
          [...document.querySelectorAll<HTMLElement>(PLAY_BUTTONS)].find((el) => el.checkVisibility({ visibilityProperty: true }) && el.getClientRects().length > 0)?.focus(),
        ),
      );
    };
    addEventListener("keydown", onKey, true);
    return () => removeEventListener("keydown", onKey, true);
  }, [togglePlay, wake]);
}
