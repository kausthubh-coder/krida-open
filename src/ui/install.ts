import { useSyncExternalStore } from "react";
import { android } from "./android";

/**
 * Krida on the home screen, as an app. Chrome and Edge (Android, desktop) offer it with `beforeinstallprompt`, which
 * fires once, early, so it's caught at startup and kept for the Install button. Safari has no such event: on an
 * iPhone or iPad it's Share, then Add to Home Screen, which Settings explains instead.
 */
type InstallPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };

let deferred: InstallPrompt | null = null;
let installed = false;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());

// The Android app (android/) is Krida installed too, though its WebView reports a browser tab.
const standalone = () =>
  !!android ||
  matchMedia("(display-mode: standalone)").matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;
// iPadOS asks for the desktop site, so it reads as a Mac that has a touch screen.
const appleTouch = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);

export function startInstallPrompt() {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as InstallPrompt;
    changed();
  });
  window.addEventListener("appinstalled", () => {
    installed = true;
    deferred = null;
    changed();
  });
}

export type InstallState = "installed" | "prompt" | "ios" | "unavailable";

function state(): InstallState {
  if (installed || standalone()) return "installed";
  if (deferred) return "prompt";
  if (appleTouch()) return "ios";
  return "unavailable";
}

export function useInstall() {
  const current = useSyncExternalStore((l) => {
    listeners.add(l);
    return () => listeners.delete(l);
  }, state);
  const install = async () => {
    const prompt = deferred;
    if (!prompt) return;
    await prompt.prompt();
    // The browser offers it once per event; whatever the answer, this one is spent.
    const { outcome } = await prompt.userChoice;
    deferred = null;
    if (outcome === "accepted") installed = true;
    changed();
  };
  return { state: current, install };
}
