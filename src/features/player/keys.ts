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

export type Keys = {
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
  subtitleDelay: (by: -1 | 1) => void;
  shortcuts: () => void;
};

/** The bindings drive both dispatch and the shortcuts sheet. */
export const PLAYER_SHORTCUTS = [
  { action: "wake", keys: ["tab"], label: "Tab", description: "Show controls" },
  { action: "close", keys: ["escape"], label: "Esc", description: "Close menu or sheet" },
  { action: "play", keys: [" ", "k"], label: "Space / K", description: "Play or pause" },
  { action: "back", keys: ["arrowleft", "j"], label: "← / J", description: "Back 10 seconds (5 on timeline)" },
  { action: "forward", keys: ["arrowright", "l"], label: "→ / L", description: "Forward 10 seconds (5 on timeline)" },
  { action: "louder", keys: ["arrowup"], label: "↑", description: "Volume up" },
  { action: "quieter", keys: ["arrowdown"], label: "↓", description: "Volume down" },
  { action: "fullscreen", keys: ["f"], label: "F", description: "Toggle full screen" },
  { action: "mute", keys: ["m"], label: "M", description: "Mute or unmute" },
  { action: "subtitles", keys: ["c"], label: "C", description: "Toggle subtitles" },
  { action: "earlier", keys: ["g"], label: "G", description: "Subtitles 0.1 s earlier" },
  { action: "later", keys: ["h"], label: "H", description: "Subtitles 0.1 s later" },
  { action: "pip", keys: ["p"], label: "P", description: "Picture in picture (where available)" },
  { action: "fit", keys: ["v"], label: "V", description: "Next picture fit (browser)" },
  { action: "bars", keys: ["b"], label: "B", description: "Trim black bars (desktop app)" },
  { action: "skip", keys: ["s"], label: "S", description: "Skip intro, recap or credits when offered" },
  { action: "auto", keys: ["a"], label: "A", description: "Automatic playback menu" },
  { action: "episodes", keys: ["e"], label: "E", description: "Show episodes" },
  { action: "reactions", keys: ["r"], label: "R", description: "Reactions (party)" },
  { action: "next", keys: ["n"], shift: true, label: "Shift+N", description: "Play next when offered" },
  { action: "faster", keys: [">"], label: "Shift+.", description: "Speed up (solo)" },
  { action: "slower", keys: ["<"], label: "Shift+,", description: "Slow down (solo)" },
  { action: "shortcuts", keys: ["?"], label: "?", description: "Show keyboard shortcuts" },
];

export function handlePlayerKey(e: KeyboardEvent, keys: Keys) {
  const { video, menu, setMenu, wake, togglePlay, skipBy, setVolume, toggleFullscreen, toggleSubtitles, skip, playNext, episodes, reactions, speed, pictureInPicture, cycleFit, toggleBars, subtitleDelay, shortcuts } = keys;
  const key = e.key.toLowerCase();
  const action = PLAYER_SHORTCUTS.find((s) => s.keys.includes(key) && (!s.shift || e.shiftKey))?.action;
  const target = e.target as HTMLElement;
  if (target.closest("dialog")) return;
  // Hidden controls can't take focus, so Tab brings them back before it moves.
  if (action === "wake") {
    wake();
    return;
  }
  // Escape closes a menu even from a switch inside it, and hands focus back to the button that opened it.
  if (action === "close" && menu) {
    target.closest('[role="dialog"]')?.parentElement?.querySelector<HTMLElement>('[aria-expanded="true"]')?.focus();
    setMenu(null);
    wake();
    return;
  }
  if (target.closest("input, textarea, select, [contenteditable]")) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if ((action === "faster" || action === "slower") && speed) {
    speed(action === "faster" ? 1 : -1);
    return;
  }
  // Shift+N moves on, like YouTube; it asks the others first, as the button does.
  if (action === "next") {
    if (!playNext) return;
    playNext();
    wake();
    return;
  }
  // Space presses a focused button ("Switch now", "Keep watching"); it only plays or pauses from elsewhere.
  if (key === " " && target.closest('button, a[href], [role="button"], [role="switch"]')) return;
  if (action === "play") {
    e.preventDefault();
    togglePlay();
  } else if (action === "back") {
    e.preventDefault();
    skipBy(-10);
  } else if (action === "forward") {
    e.preventDefault();
    skipBy(10);
  } else if (action === "louder") {
    e.preventDefault();
    setVolume((v) => Math.min(1, +(v + 0.1).toFixed(2)));
  } else if (action === "quieter") {
    e.preventDefault();
    setVolume((v) => Math.max(0, +(v - 0.1).toFixed(2)));
  } else if (action === "fullscreen") toggleFullscreen();
  else if (action === "mute" && video) video.muted = !video.muted;
  else if (action === "subtitles") toggleSubtitles();
  else if (action === "earlier" || action === "later") subtitleDelay(action === "earlier" ? -1 : 1);
  else if (action === "shortcuts") { setMenu(null); shortcuts(); }
  else if (action === "pip" && pictureInPicture) pictureInPicture();
  else if (action === "fit" && cycleFit) cycleFit();
  else if (action === "bars" && toggleBars) toggleBars();
  else if (action === "skip" && skip) skip();
  else if (action === "auto") setMenu(menu === "auto" ? null : "auto");
  else if (action === "episodes" && episodes) {
    setMenu(null);
    episodes();
  }
  // Reactions only exist in a party; elsewhere the menu would open nothing and hold the controls up.
  else if (action === "reactions" && reactions) setMenu((x) => (x === "react" ? null : "react"));
  else return;
  wake();
}

export function usePlayerKeys(keys: Keys) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => handlePlayerKey(e, keys);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [keys]);
}
