// The player's keyboard, and the controls hiding when nobody's moving.
import { useCallback, useEffect, useRef, useState } from "react";

/** Controls show while the pointer moves, and hide 2.8 seconds after it stops. */
export function useAutoHide() {
  const [active, setActive] = useState(true);
  const hideTimer = useRef<number | undefined>(undefined);
  const wake = useCallback(() => {
    setActive(true);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setActive(false), 2800);
  }, []);
  /** Hides them now: a tap on the picture on a phone. */
  const rest = useCallback(() => {
    window.clearTimeout(hideTimer.current);
    setActive(false);
  }, []);
  useEffect(() => {
    wake();
    return () => window.clearTimeout(hideTimer.current);
  }, [wake]);
  return { active, wake, rest };
}

export type PlayerMenu = "audio" | "subs" | "auto" | "picture" | "react" | null;

type Keys = {
  video: HTMLVideoElement | null;
  menu: PlayerMenu;
  setMenu: (menu: PlayerMenu | ((menu: PlayerMenu) => PlayerMenu)) => void;
  wake: () => void;
  togglePlay: () => void;
  skipBy: (seconds: number) => void;
  setVolume: (volume: (v: number) => number) => void;
  toggleFullscreen: () => void;
  /** C: subtitles off, or on in the profile's language. */
  toggleSubtitles: () => void;
  /** S: the Skip button, when there is one. */
  skip: (() => void) | null;
  /** Shift+N: moves on, asking the others first, as the button does. */
  playNext: (() => void) | null;
  /** E: the show's episodes. */
  episodes: (() => void) | null;
  /** R: reactions, which only exist in a party. */
  reactions: boolean;
  /** Shift+. and Shift+, (> and <): a step faster or slower, as on YouTube. Null in a party, which plays at 1×. */
  speed: ((by: 1 | -1) => void) | null;
  /** P: picture in picture, where the browser has it. */
  pictureInPicture: (() => void) | null;
  /** V: the next way to fit the picture, as in Stremio. Null where the page can't scale the picture. */
  cycleFit: (() => void) | null;
  /** B: trimming black bars built into the film on or off. Only in the app, where mpv can. */
  toggleBars: (() => void) | null;
};

export function usePlayerKeys(keys: Keys) {
  const { video, menu, setMenu, wake, togglePlay, skipBy, setVolume, toggleFullscreen, toggleSubtitles, skip, playNext, episodes, reactions, speed, pictureInPicture, cycleFit, toggleBars } = keys;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest("dialog")) return;
      // Hidden controls can't take focus, so Tab brings them back before it moves.
      if (e.key === "Tab") {
        wake();
        return;
      }
      // Escape closes a menu even from a switch inside it, and hands focus back to the button that opened it.
      if (e.key === "Escape" && menu) {
        target.closest('[role="dialog"]')?.parentElement?.querySelector<HTMLElement>('[aria-expanded="true"]')?.focus();
        setMenu(null);
        wake();
        return;
      }
      if (target.closest("input, textarea, select, [contenteditable]")) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if ((key === ">" || key === "<") && speed) {
        speed(key === ">" ? 1 : -1);
        return;
      }
      // Shift+N moves on, like YouTube; it asks the others first, as the button does.
      if (key === "n" && e.shiftKey) {
        if (!playNext) return;
        playNext();
        wake();
        return;
      }
      // Space presses a focused button ("Switch now", "Keep watching"); it only plays or pauses from elsewhere.
      if (key === " " && target.closest('button, a[href], [role="button"], [role="switch"]')) return;
      if (key === " " || key === "k") {
        e.preventDefault();
        togglePlay();
      } else if (key === "arrowleft" || key === "j") {
        e.preventDefault();
        skipBy(-10);
      } else if (key === "arrowright" || key === "l") {
        e.preventDefault();
        skipBy(10);
      } else if (key === "arrowup") {
        e.preventDefault();
        setVolume((v) => Math.min(1, +(v + 0.1).toFixed(2)));
      } else if (key === "arrowdown") {
        e.preventDefault();
        setVolume((v) => Math.max(0, +(v - 0.1).toFixed(2)));
      } else if (key === "f") toggleFullscreen();
      else if (key === "m" && video) video.muted = !video.muted;
      else if (key === "c") toggleSubtitles();
      else if (key === "p" && pictureInPicture) pictureInPicture();
      else if (key === "v" && cycleFit) cycleFit();
      else if (key === "b" && toggleBars) toggleBars();
      else if (key === "s" && skip) skip();
      else if (key === "a") setMenu(menu === "auto" ? null : "auto");
      else if (key === "e" && episodes) {
        setMenu(null);
        episodes();
      }
      // Reactions only exist in a party; elsewhere the menu would open nothing and hold the controls up.
      else if (key === "r" && reactions) setMenu((x) => (x === "react" ? null : "react"));
      else return;
      wake();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [video, menu, setMenu, wake, togglePlay, skipBy, setVolume, toggleFullscreen, toggleSubtitles, skip, playNext, episodes, reactions, speed, pictureInPicture, cycleFit, toggleBars]);
}
