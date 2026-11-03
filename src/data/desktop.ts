import { useCallback, useEffect, useState } from "react";
import { toast } from "../ui/toast";

/**
 * Krida for Windows (desktop/ in this repo): this site in an app window, with mpv playing the picture under the page.
 * The app says it's there with `window.kridaDesktop` and lends Tauri's calls on `window.__TAURI__`; a browser has
 * neither.
 */
export type DesktopApp = {
  core: { invoke<T = void>(command: string, args?: Record<string, unknown>): Promise<T> };
  event: { listen<T>(event: string, handler: (event: { payload: T }) => void): Promise<() => void> };
};

declare global {
  interface Window {
    /**
     * platform from the Mac build on; an app without it is Krida for Windows. From 0.1.8 the window can be full screen
     * while the page isn't (it opened that way): isFullscreen says whether either is, setFullscreen sets both, and a
     * `kridafullscreenchange` event on window says when they change.
     */
    kridaDesktop?: {
      version: string;
      platform?: string;
      notes?: string;
      /** Google sign-in goes through the computer's browser (src/data/appSignIn.ts). */
      signIn?: boolean;
      isFullscreen?: () => boolean;
      setFullscreen?: (on: boolean) => void;
    };
    __TAURI__?: DesktopApp;
  }
}

/** The app's calls, or null in a browser. */
export const desktopApp = (): DesktopApp | null => (window.kridaDesktop && window.__TAURI__) || null;

/** The app's name: Krida for Windows, or Krida for Mac on a Mac (desktop/src-tauri/src/mpv_mac.rs). */
export const desktopName = () => (window.kridaDesktop?.platform === "macos" ? "Krida for Mac" : "Krida for Windows");

/**
 * Settings' Open in full screen: the app keeps it and opens its window that way (desktop/src-tauri/src/main.rs). Null
 * in a browser and in an app older than 0.1.8.
 */
export function useOpenFullscreen(): [boolean, (on: boolean) => void] | null {
  const app = window.kridaDesktop?.setFullscreen ? desktopApp() : null;
  const [on, setOn] = useState(false);
  useEffect(() => {
    let live = true;
    void app?.core.invoke<boolean>("open_fullscreen").then((v) => live && setOn(v), () => {});
    return () => {
      live = false;
    };
  }, [app]);
  const set = useCallback(
    (to: boolean) => {
      setOn(to);
      app?.core.invoke("set_open_fullscreen", { on: to }).catch(() => {
        setOn(!to);
        toast.error("Couldn't save that. Try again.");
      });
    },
    [app],
  );
  return app ? [on, set] : null;
}

/** Whether the app's version, as "major.minor.patch", is `version` or later. False in a browser. */
export function desktopAtLeast(version: string) {
  const have = window.kridaDesktop?.version.split(".").map(Number);
  if (!have) return false;
  const want = version.split(".").map(Number);
  for (let i = 0; i < want.length; i++) {
    const a = have[i] ?? 0;
    if (a !== want[i]) return a > want[i]!;
  }
  return true;
}

/**
 * Where the app's own updates stand (desktop/src-tauri/src/update.rs): from 0.1.3 it finds, downloads and installs
 * new versions itself; `ready` waits for a restart. An older app can't, so it's `manual`: a new installer from the
 * releases page, once.
 */
export type UpdateState = "off" | "idle" | "checking" | "current" | "downloading" | "ready" | "failed" | "manual";
export type UpdateStatus = { state: UpdateState; version?: string | null };
/** The public repo the app's installers are released to; the code's repo is private. */
export const RELEASES_PAGE = "https://github.com/kausthubh-coder/krida-open-releases/releases/latest";
const UPDATES_FROM = "0.1.3";
/** The first version that looks for an update when asked (`update_check`). */
const CHECKS_FROM = "0.1.7";

/** How long a browser has to hand a krida:// link to the app before the page offers the download. */
const APP_ANSWERS_MS = 1500;

/**
 * Opens a page of Krida (`/title/movie/tt…`) in Krida for Mac or Windows, through its own link, krida://<page>
 * (desktop/src-tauri/src/links.rs, from 0.1.11). A browser says nothing when no app takes the link; the page losing
 * focus (the app coming forward) says one did. `noAnswer` runs otherwise: the app is missing or older, or the browser
 * is still asking whether to open it.
 */
export function openInDesktopApp(path: string, noAnswer: () => void) {
  let answered = false;
  const away = () => {
    answered = true;
  };
  window.addEventListener("blur", away);
  document.addEventListener("visibilitychange", away);
  window.location.href = `krida:/${path}`;
  setTimeout(() => {
    window.removeEventListener("blur", away);
    document.removeEventListener("visibilitychange", away);
    if (!answered && document.hasFocus()) noAnswer();
  }, APP_ANSWERS_MS);
}

/** Looks for an update now; where it gets to arrives as `update` events. */
const checkNow = () => void desktopApp()?.core.invoke("update_check").catch(() => {});

/**
 * The app's updates as they change, the restart that installs one, and a look for one now (null in an app too old to
 * be asked); null in a browser.
 */
export function useDesktopUpdate(): { status: UpdateStatus; restart: () => Promise<void>; check: (() => void) | null } | null {
  const app = desktopApp();
  const updates = !!app && desktopAtLeast(UPDATES_FROM);
  const [status, setStatus] = useState<UpdateStatus>({ state: updates ? "idle" : "manual" });
  useEffect(() => {
    if (!app || !updates) return;
    let live = true;
    let unlisten: (() => void) | null = null;
    void app.event.listen<UpdateStatus>("update", (e) => live && setStatus(e.payload)).then((off) => {
      if (live) unlisten = off;
      else off();
    });
    void app.core.invoke<UpdateStatus>("update_status").then((s) => live && setStatus(s), () => {});
    return () => {
      live = false;
      unlisten?.();
    };
  }, [app, updates]);
  // A restart that worked closes the app; one that didn't keeps the update for closing Krida or the next try.
  const restart = useCallback(
    () => app?.core.invoke("update_restart").catch(() => void toast.error("Couldn't install the update. It installs when you close Krida.")) ?? Promise.resolve(),
    [app],
  );
  return app ? { status, restart, check: desktopAtLeast(CHECKS_FROM) ? checkNow : null } : null;
}
