// What a release of Krida's apps needs, worked out from git: which apps changed since their last release, their next
// versions, and the manifests installed apps read to update themselves. scripts/release.ts does the building and
// publishing. The web needs no release: every push to main deploys it, and every app shows the live site.

export type App = "desktop" | "android";
export const APPS: App[] = ["desktop", "android"];

/** The folder each app's own code lives in; a change anywhere else reaches every app through the site. */
const FOLDERS: Record<App, string> = { desktop: "desktop/", android: "android/" };

/** The public repo installers are released to, and the raw link to its main branch. */
export const RELEASES_REPO = "kausthubh-coder/krida-open-releases";
export const RELEASES_RAW = `https://raw.githubusercontent.com/${RELEASES_REPO}/main`;

/** An app's release tag, in both repos: desktop-v0.1.4, and android-v1.2.0 for Android's 1.2, as its tags have been. */
export const tagOf = (app: App, version: string) => `${app}-v${app === "android" && version.split(".").length === 2 ? `${version}.0` : version}`;

/**
 * Whether files changed since an app's last release need a new one. Notes beside the code (README.md) don't, nor do
 * the files only a test build reads.
 */
export function needsRelease(app: App, changed: string[]) {
  return changed.some((path) => path.startsWith(FOLDERS[app]) && !path.endsWith(".md"));
}

/** Krida for Windows and Mac count patches: 0.1.3 to 0.1.4. */
export function nextDesktopVersion(version: string) {
  const parts = version.split(".").map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n) || n < 0)) throw new Error(`${version} isn't major.minor.patch`);
  return `${parts[0]}.${parts[1]}.${parts[2]! + 1}`;
}

/** Krida for Android counts its name in minors (1.1 to 1.2), and Android compares the code, which only goes up. */
export function nextAndroidVersion(current: { code: number; name: string }) {
  const [major, minor] = current.name.split(".").map(Number);
  if (!Number.isInteger(major) || !Number.isInteger(minor)) throw new Error(`${current.name} isn't major.minor`);
  return { code: current.code + 1, name: `${major}.${minor! + 1}` };
}

/**
 * What tauri's updater reads (desktop/src-tauri/src/update.rs): the version, its notes, and per platform the
 * installer's link and signature. Only the platforms built go in.
 */
export function desktopManifest(o: {
  version: string;
  notes: string;
  date: Date;
  windows?: { signature: string; file: string };
  mac?: { signature: string; file: string };
}) {
  const url = (file: string) => `https://github.com/${RELEASES_REPO}/releases/download/${tagOf("desktop", o.version)}/${file}`;
  const platforms: Record<string, { signature: string; url: string }> = {};
  if (o.windows) platforms["windows-x86_64"] = { signature: o.windows.signature, url: url(o.windows.file) };
  if (o.mac) platforms["darwin-aarch64"] = { signature: o.mac.signature, url: url(o.mac.file) };
  return { version: o.version, notes: o.notes, pub_date: o.date.toISOString(), platforms };
}

/** What Krida for Android reads to update itself (android/.../Updates.kt): the newest APK, its code and checksum. */
export function androidManifest(o: { code: number; name: string; notes: string; file: string; sha256: string }) {
  return {
    versionCode: o.code,
    versionName: o.name,
    notes: o.notes,
    url: `https://github.com/${RELEASES_REPO}/releases/download/${tagOf("android", o.name)}/${o.file}`,
    sha256: o.sha256,
  };
}

/** The version lines of the Android app's build file, read and rewritten. */
const ANDROID_CODE = /versionCode = (\d+)/;
const ANDROID_NAME = /versionName = "([^"]+)"/;

export function readAndroidVersion(gradle: string) {
  const code = ANDROID_CODE.exec(gradle)?.[1];
  const name = ANDROID_NAME.exec(gradle)?.[1];
  if (!code || !name) throw new Error("android/app/build.gradle.kts has no versionCode or versionName");
  return { code: Number(code), name };
}

export function writeAndroidVersion(gradle: string, next: { code: number; name: string }) {
  return gradle.replace(ANDROID_CODE, `versionCode = ${next.code}`).replace(ANDROID_NAME, `versionName = "${next.name}"`);
}

/**
 * The desktop app's version in each file that carries it: its package.json and lock, the crate and its lock entry,
 * and tauri.conf.json. Only the app's own entries change, never a dependency's that happens to share the number.
 */
export function writeDesktopVersion(file: "package.json" | "package-lock.json" | "Cargo.toml" | "Cargo.lock" | "tauri.conf.json", text: string, from: string, to: string) {
  const v = from.replaceAll(".", "\\.");
  const swap = (source: string, pattern: RegExp) => {
    if (!pattern.test(source)) throw new Error(`${file} doesn't say version ${from} where expected`);
    return source.replace(pattern, (match) => match.replace(from, to));
  };
  switch (file) {
    case "package.json":
    case "tauri.conf.json":
      return swap(text, new RegExp(`^  "version": "${v}",$`, "m"));
    case "package-lock.json":
      // The lock's own version, and its root package's.
      return swap(swap(text, new RegExp(`^  "version": "${v}",$`, "m")), new RegExp(`\\n    "": \\{\\n      "name": "krida-desktop",\\n      "version": "${v}"`));
    case "Cargo.toml":
      return swap(text, new RegExp(`^version = "${v}"$`, "m"));
    case "Cargo.lock":
      return swap(text, new RegExp(`^name = "krida"\\nversion = "${v}"$`, "m"));
  }
}
