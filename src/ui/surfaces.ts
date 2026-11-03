import { useSyncExternalStore } from "react";

/**
 * Settings → Bubble glass, a beta you turn on, kept per device because it's about the screen and the machine, not the
 * profile. Off, Krida's controls are bubli's plain, solid look and nothing draws on the GPU.
 */
const KEY = "krida.bubbles";
const listeners = new Set<() => void>();

const read = () => {
  try {
    return localStorage.getItem(KEY) === "on";
  } catch {
    return false;
  }
};
const apply = (on: boolean) => (document.documentElement.dataset.surfaces = on ? "glass" : "solid");

/** Applies the saved choice to the page. Call once at startup. */
export function applySurfaces() {
  apply(read());
}

export function useBubbleGlass() {
  const value = useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, read);
  const set = (next: boolean) => {
    try {
      localStorage.setItem(KEY, next ? "on" : "off");
    } catch {
      // Private mode: the choice lasts for this visit.
    }
    apply(next);
    listeners.forEach((listener) => listener());
  };
  return [value, set] as const;
}
