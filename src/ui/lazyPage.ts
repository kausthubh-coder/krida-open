import { lazy, type ComponentType } from "react";

/**
 * A page whose code isn't part of the first load, so Home draws sooner. It downloads once the browser is idle
 * after start-up, so opening it later is still instant; a link followed before that waits for it.
 */
export function lazyPage(load: () => Promise<ComponentType>) {
  let loading: Promise<ComponentType> | undefined;
  const fetch = () =>
    (loading ??= load().catch((error: unknown) => {
      loading = undefined;
      throw error;
    }));
  afterStartup(() => void fetch().catch(() => {}));
  return lazy(() => fetch().then((page) => ({ default: page }), reloadOntoNewBuild));
}

function afterStartup(run: () => void) {
  // Older Safari has no requestIdleCallback.
  const idle = () => ("requestIdleCallback" in window ? requestIdleCallback(run, { timeout: 3000 }) : setTimeout(run, 500));
  if (document.readyState === "complete") idle();
  else addEventListener("load", idle, { once: true });
}

/**
 * A tab opened before a deploy still asks for the old build's chunks, which are gone, so the import
 * fails and the page goes blank. Reload onto the new build instead, at most once a minute so a real
 * outage can't loop.
 */
export function reloadOntoNewBuild(error: unknown): Promise<never> {
  const key = "krida:reloaded-for-build";
  if (Date.now() - Number(sessionStorage.getItem(key) ?? 0) < 60_000) throw error;
  sessionStorage.setItem(key, String(Date.now()));
  location.reload();
  // Keep showing the loading screen until the reload takes over.
  return new Promise(() => {});
}
