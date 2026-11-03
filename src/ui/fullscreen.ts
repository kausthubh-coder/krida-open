import { useEffect, useSyncExternalStore } from "react";
import { android } from "./android";

/**
 * Full screen is the whole app, not just the player: the page itself goes full screen, so it stays that way from
 * Home to a title to the player and back, and the Party panel and toasts still show over the picture. Browsers
 * only allow it from a click or a key, so it can't carry over to the next visit. iPhones can't do it at all. The
 * Android app has no browser bars to hide, and its player is always full screen (useAndroidWatching).
 */
export const canFullscreen = () => !android && document.fullscreenEnabled === true;

/**
 * Krida for Windows and Mac from 0.1.8, whose window can be full screen while the page isn't: it opens that way when
 * Settings says so. Undefined in a browser and an older app.
 */
const appWindow = () => (window.kridaDesktop?.setFullscreen ? window.kridaDesktop : undefined);

const subscribe = (l: () => void) => {
  document.addEventListener("fullscreenchange", l);
  window.addEventListener("kridafullscreenchange", l);
  return () => {
    document.removeEventListener("fullscreenchange", l);
    window.removeEventListener("kridafullscreenchange", l);
  };
};

const isFullscreen = () => appWindow()?.isFullscreen?.() ?? !!document.fullscreenElement;

export function useFullscreen() {
  return useSyncExternalStore(subscribe, isFullscreen);
}

/** A phone, held either way: what turns sideways for the picture. Tablets and laptops stay as they're held. */
export const isPhone = () => matchMedia("(pointer: coarse)").matches && Math.min(screen.width, screen.height) < 600;

// lock() is missing from TypeScript's DOM types: only Chromium on Android has it, and only in full screen.
type Lockable = ScreenOrientation & { lock?: (orientation: "landscape") => Promise<void> };

/**
 * Turns a phone sideways, as a streaming app does when you press full screen. Elsewhere, and on iPhones, nothing. A
 * WebView has no lock(), so the Android app holds the phone itself.
 */
export function lockLandscape() {
  if (!isPhone()) return;
  if (android) android.setOrientation("landscape");
  else void (screen.orientation as Lockable | undefined)?.lock?.("landscape").catch(() => {});
}

export function unlockOrientation() {
  android?.setOrientation("any");
  try {
    screen.orientation?.unlock();
  } catch {
    // Never locked, or a browser without the API.
  }
}

/** `landscape` turns a phone sideways once it's full screen; leaving full screen lets it turn freely again. */
export function toggleFullscreen({ landscape = false } = {}) {
  // Refused without a click or key (or by the browser's own settings): nothing to tell anyone, it just stays as it was.
  if (isFullscreen()) {
    unlockOrientation();
    const app = appWindow();
    if (app) app.setFullscreen?.(false);
    else void document.exitFullscreen().catch(() => {});
  } else {
    void document.documentElement
      .requestFullscreen({ navigationUI: "hide" })
      .then(() => landscape && lockLandscape())
      .catch(() => {});
  }
}

/** F from anywhere outside the player (which has its own) switches full screen, as it does there. */
export function useFullscreenShortcut() {
  useEffect(() => {
    if (!canFullscreen()) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || e.metaKey || e.ctrlKey || e.altKey || e.key.toLowerCase() !== "f") return;
      if (document.querySelector("dialog[open]")) return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      if (target?.closest("input, textarea, select, [contenteditable]")) return;
      e.preventDefault();
      toggleFullscreen();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/** Full screen came from pressing Play, so leaving the player leaves it too. */
let forPlayer = false;

/**
 * Pressing Play on a phone goes full screen and turns the phone sideways at once, as Netflix does, while the press
 * still counts as one (browsers only allow full screen from a press). Where that's refused (iPhones), the player
 * turns itself instead (sideways.ts).
 */
export function enterPlayerLandscape() {
  if (!isPhone() || !canFullscreen() || document.fullscreenElement) return;
  void document.documentElement
    .requestFullscreen({ navigationUI: "hide" })
    .then(() => {
      forPlayer = true;
      lockLandscape();
    })
    .catch(() => {});
}

/** Leaving the player: the phone turns freely again, and full screen that Play started ends. */
export function leavePlayerLandscape() {
  unlockOrientation();
  if (forPlayer && document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  forPlayer = false;
}
