import { useEffect, useSyncExternalStore } from "react";
import { toast } from "./toast";
import { useAppUpdate } from "./appUpdate";

// What an installed app tells you that a tab leaves to the browser: that the connection is gone, and that a newer
// Krida is out.

const subscribe = (l: () => void) => {
  window.addEventListener("online", l);
  window.addEventListener("offline", l);
  return () => {
    window.removeEventListener("online", l);
    window.removeEventListener("offline", l);
  };
};

export function useOnline() {
  return useSyncExternalStore(subscribe, () => navigator.onLine);
}

/** A toast that stays while the connection is gone, and goes on its own when it's back. */
export function useOfflineNotice() {
  const online = useOnline();
  useEffect(() => {
    if (online) return;
    toast("You’re offline", { id: "offline", description: "Krida picks up where it was once you’re back online.", duration: Infinity });
    return () => void toast.dismiss("offline");
  }, [online]);
}

// The commit this build came from (scripts/build-frontend.mjs), and the one the site serves now (/version.json).
const BUILT = import.meta.env.VITE_KRIDA_COMMIT as string | undefined;
const CHECK_EVERY_MS = 10 * 60_000;

/**
 * An installed Krida can stay open for days, on the build it opened with. Coming back to it, or every so often
 * while it's in front, it asks which build is live, and offers a reload when that's newer. Never in the player
 * (`paused`): the question waits until you're out of it.
 */
export function useNewBuildNotice(paused: boolean) {
  useEffect(() => {
    if (!BUILT || paused) return;
    let last = 0;
    const check = async () => {
      if (document.visibilityState !== "visible" || Date.now() - last < CHECK_EVERY_MS) return;
      last = Date.now();
      const live = await fetch("/version.json", { cache: "no-store" })
        .then((r) => (r.ok ? (r.json() as Promise<{ commit?: string }>) : null))
        .catch(() => null);
      if (!live?.commit || live.commit === BUILT) return;
      toast("Krida has been updated", {
        id: "new-build",
        duration: Infinity,
        action: { label: "Reload", onClick: () => location.reload() },
      });
    };
    void check();
    document.addEventListener("visibilitychange", check);
    const timer = setInterval(check, CHECK_EVERY_MS);
    return () => {
      document.removeEventListener("visibilitychange", check);
      clearInterval(timer);
    };
  }, [paused]);
}

const MANUAL_SEEN = "krida.appUpdateSeen";

/**
 * Krida's apps update themselves (appUpdate.ts): once a new version has downloaded, a toast offers to install it, a
 * restart in the desktop app and Android's own prompt on a phone. An app too old to update itself is told, once, where
 * the new one is. Never in the player (`paused`).
 */
export function useAppUpdateNotice(paused: boolean) {
  const update = useAppUpdate();
  const state = update?.status.state;
  const version = update?.status.version;
  const name = update?.name;
  const install = update?.install;
  const installShort = update?.installShort;
  const installHint = update?.installHint;
  const manualUrl = update?.manualUrl;
  useEffect(() => {
    if (paused || !name || !install) return;
    if (state === "ready") {
      toast(version ? `${name} ${version} is ready` : `A new ${name} is ready`, {
        id: "app-update",
        description: installHint,
        duration: Infinity,
        action: { label: installShort ?? "Install", onClick: install },
      });
    } else if (state === "manual" && manualUrl && !localStorage.getItem(MANUAL_SEEN)) {
      const seen = () => localStorage.setItem(MANUAL_SEEN, "1");
      toast(`A new ${name} is out`, {
        id: "app-update",
        description: "It keeps itself up to date from now on. Install it once.",
        duration: Infinity,
        onDismiss: seen,
        action: {
          label: "Download",
          onClick: () => {
            seen();
            window.open(manualUrl, "_blank");
          },
        },
      });
    } else return;
    return () => void toast.dismiss("app-update");
  }, [paused, state, version, name, install, installShort, installHint, manualUrl]);
}

const VERSION_SEEN = "krida.appVersionSeen";

/**
 * The first time an app opens on a new version, what's new in it (its release notes), once. Not on the first open
 * ever, and never over the player (`paused`): it waits for the player to close.
 */
export function useWhatsNew(paused: boolean) {
  const update = useAppUpdate();
  const name = update?.name;
  const version = update?.version;
  const notes = update?.notes;
  useEffect(() => {
    if (paused || !name || !version) return;
    const seen = localStorage.getItem(VERSION_SEEN);
    localStorage.setItem(VERSION_SEEN, version);
    if (seen && seen !== version && notes) toast(`What's new in ${name} ${version}`, { id: "whats-new", description: notes, duration: 12_000 });
  }, [paused, name, version, notes]);
}
