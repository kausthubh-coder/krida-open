import { useEffect, useState } from "react";
import { desktopName, RELEASES_PAGE, useDesktopUpdate, type UpdateStatus } from "../data/desktop";
import { android, onAndroid } from "./android";

/**
 * Each of Krida's apps updates itself: Krida for Windows and Mac (desktop/src-tauri/src/update.rs) install on a
 * restart, Krida for Android (android/.../Updates.kt) downloads the new APK and Android asks before installing it.
 * This is the same for all three, for the toast and Settings. Null in a browser, which the site itself keeps current.
 */
export type AppUpdate = {
  /** Krida for Windows, Krida for Mac or Krida for Android. */
  name: string;
  version: string;
  /** What's new in this version, from its release (scripts/release.ts); empty in versions from before. */
  notes: string;
  status: UpdateStatus;
  /** Looks for a new version now. Null where the app can't be asked: Android, and desktop apps before 0.1.7. */
  check: (() => void) | null;
  /** Installs the version that has downloaded. */
  install: () => void;
  /** Its button in Settings, and in a toast. */
  installLabel: string;
  installShort: string;
  /** When it installs otherwise, or how. */
  installHint: string;
  /** Where an app too old to update itself gets a new one, by hand, once. Null until there is one. */
  manualUrl: string | null;
};

/** The phone's update manifest (scripts/lib/release.ts), which an APK from before 1.2 is pointed at by hand. */
const ANDROID_MANIFEST = "https://raw.githubusercontent.com/kausthubh-coder/krida-open-releases/main/android.json";

const installAndroid = () => android?.installUpdate?.();

type AndroidBridgeUpdate = { state: UpdateStatus["state"]; version?: string | null };

function useAndroidUpdate(): AppUpdate | null {
  const updates = !!android?.updateStatus;
  const [status, setStatus] = useState<UpdateStatus>(() =>
    android?.updateStatus ? (JSON.parse(android.updateStatus()) as AndroidBridgeUpdate) : { state: "manual" },
  );
  const [manualUrl, setManualUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!android) return;
    if (updates) return onAndroid((e) => e.type === "update" && setStatus({ state: e.state, version: e.version }));
    // An APK from before updates is sent to the newest one, once there is one.
    let live = true;
    void fetch(ANDROID_MANIFEST, { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<{ url?: string }>) : null))
      .then((m) => live && m?.url && setManualUrl(m.url), () => {});
    return () => {
      live = false;
    };
  }, [updates]);
  if (!android) return null;
  return {
    name: "Krida for Android",
    version: android.version?.() ?? "",
    notes: android.notes?.() ?? "",
    status,
    check: null,
    install: installAndroid,
    installLabel: "Install update",
    installShort: "Install",
    installHint: "Android asks before it installs.",
    manualUrl,
  };
}

export function useAppUpdate(): AppUpdate | null {
  const desktop = useDesktopUpdate();
  const phone = useAndroidUpdate();
  if (!desktop) return phone;
  return {
    name: desktopName(),
    version: window.kridaDesktop?.version ?? "",
    notes: window.kridaDesktop?.notes ?? "",
    status: desktop.status,
    check: desktop.check,
    install: desktop.restart,
    installLabel: "Restart to update",
    installShort: "Restart",
    installHint: "It installs when you restart or close Krida.",
    manualUrl: RELEASES_PAGE,
  };
}
