import { useEffect, useState } from "react";

/*
 * Which apps have a download yet: each app's newest file among the releases of krida-open-releases, read when the
 * landing page opens. The desktop apps and Android are released apart (scripts/release.ts), and only the desktop's
 * is the repo's latest, so every recent release is looked through. A platform shows Download, straight to its file,
 * once a release carries one, and "Coming soon" until then (or when GitHub can't be reached), so publishing a release
 * is all it takes.
 */

const LIST_API = "https://api.github.com/repos/kausthubh-coder/krida-open-releases/releases?per_page=30";

export type App = "android" | "mac" | "windows";
/** Each app's file to download, by its link. */
export type Downloads = Partial<Record<App, string>>;
const FILES: Record<App, RegExp> = { android: /\.apk$/i, mac: /\.dmg$/i, windows: /\.(msi|exe)$/i };
const CACHE = "krida.downloads";

type Release = { draft?: unknown; prerelease?: unknown; assets?: { name?: unknown; browser_download_url?: unknown }[] };

/** Each app's newest file, from GitHub's list of releases (newest first); drafts and pre-releases don't count. */
export function downloadsIn(releases: unknown): Downloads {
  const found: Downloads = {};
  if (!Array.isArray(releases)) return found;
  for (const release of releases as Release[]) {
    if (release?.draft || release?.prerelease || !Array.isArray(release.assets)) continue;
    for (const app of Object.keys(FILES) as App[]) {
      if (found[app]) continue;
      const file = release.assets.find((a) => typeof a?.name === "string" && FILES[app].test(a.name));
      if (typeof file?.browser_download_url === "string") found[app] = file.browser_download_url;
    }
  }
  return found;
}

async function released(): Promise<Downloads> {
  try {
    const kept = sessionStorage.getItem(CACHE);
    if (kept) return JSON.parse(kept) as Downloads;
  } catch {
    // No storage: ask GitHub.
  }
  const res = await fetch(LIST_API, { headers: { accept: "application/vnd.github+json" } });
  const downloads = res.ok ? downloadsIn(await res.json()) : {};
  try {
    sessionStorage.setItem(CACHE, JSON.stringify(downloads));
  } catch {
    // Asked again next time.
  }
  return downloads;
}

/** Each app's download, once GitHub has answered (empty when it can't). */
export function useReleased() {
  const [downloads, setDownloads] = useState<Downloads | undefined>();
  useEffect(() => {
    let live = true;
    released().then(
      (d) => live && setDownloads(d),
      () => live && setDownloads({}),
    );
    return () => {
      live = false;
    };
  }, []);
  return downloads;
}
