import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  androidManifest,
  desktopManifest,
  needsRelease,
  nextAndroidVersion,
  nextDesktopVersion,
  readAndroidVersion,
  tagOf,
  writeAndroidVersion,
  writeDesktopVersion,
} from "../scripts/lib/release";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("what needs a release", () => {
  test("a change under an app's folder releases that app only", () => {
    const changed = ["desktop/src-tauri/src/update.rs", "src/features/player/Player.tsx"];
    expect([needsRelease("desktop", changed), needsRelease("android", changed)]).toEqual([true, false]);
  });

  test("the site, the backend and notes beside the code release nothing", () => {
    const changed = ["src/main.tsx", "convex/rooms.ts", "android/README.md", "docs/desktop.md", "desktop-notes.txt"];
    expect([needsRelease("desktop", changed), needsRelease("android", changed)]).toEqual([false, false]);
  });
});

describe("next versions", () => {
  test("the desktop app counts patches, past 9", () => {
    expect([nextDesktopVersion("0.1.3"), nextDesktopVersion("0.1.9"), nextDesktopVersion("1.0.0")]).toEqual(["0.1.4", "0.1.10", "1.0.1"]);
  });

  test("a desktop version that isn't major.minor.patch is refused", () => {
    expect(() => nextDesktopVersion("0.1")).toThrow("0.1 isn't major.minor.patch");
  });

  test("Android counts its name in minors and its code by one", () => {
    expect([nextAndroidVersion({ code: 2, name: "1.1" }), nextAndroidVersion({ code: 9, name: "1.9" })]).toEqual([
      { code: 3, name: "1.2" },
      { code: 10, name: "1.10" },
    ]);
  });
});

describe("the version in each file", () => {
  test("Android's build file is read and rewritten in place", () => {
    const gradle = read("android/app/build.gradle.kts");
    const now = readAndroidVersion(gradle);
    const next = writeAndroidVersion(gradle, { code: now.code + 1, name: "9.9" });
    expect(readAndroidVersion(next)).toEqual({ code: now.code + 1, name: "9.9" });
    expect(next.split("\n").length).toBe(gradle.split("\n").length);
  });

  test("each desktop file changes its own version and nothing else", () => {
    const files = {
      "package.json": "desktop/package.json",
      "package-lock.json": "desktop/package-lock.json",
      "Cargo.toml": "desktop/src-tauri/Cargo.toml",
      "Cargo.lock": "desktop/src-tauri/Cargo.lock",
      "tauri.conf.json": "desktop/src-tauri/tauri.conf.json",
    } as const;
    const from = JSON.parse(read(files["tauri.conf.json"])).version as string;
    const changes = Object.entries(files).map(([name, path]) => {
      const before = read(path);
      const after = writeDesktopVersion(name as keyof typeof files, before, from, "9.9.9");
      const lines = [before.split("\n"), after.split("\n")] as const;
      return [name, lines[0].filter((line, i) => line !== lines[1][i]).length, after.split("9.9.9").length - 1];
    });
    // Lines changed, and where 9.9.9 now appears: the lock carries it twice (its own and its root package's).
    expect(changes).toEqual([
      ["package.json", 1, 1],
      ["package-lock.json", 2, 2],
      ["Cargo.toml", 1, 1],
      ["Cargo.lock", 1, 1],
      ["tauri.conf.json", 1, 1],
    ]);
  });

  test("a file that doesn't carry the version expected is refused, not left unchanged", () => {
    expect(() => writeDesktopVersion("Cargo.toml", 'version = "0.1.2"\n', "0.1.3", "0.1.4")).toThrow("Cargo.toml doesn't say version 0.1.3 where expected");
  });
});

describe("tags", () => {
  test("desktop tags carry the version; Android's carry its name with .0, as its earlier tags did", () => {
    expect([tagOf("desktop", "0.1.4"), tagOf("android", "1.2"), tagOf("android", "1.10")]).toEqual(["desktop-v0.1.4", "android-v1.2.0", "android-v1.10.0"]);
  });
});

describe("manifests", () => {
  test("the desktop one lists each platform built, linked to its release", () => {
    const manifest = desktopManifest({
      version: "0.1.4",
      notes: "Faster",
      date: new Date("2026-10-24T12:00:00Z"),
      windows: { signature: "w-sig", file: "Krida_0.1.4_x64-setup.exe" },
      mac: { signature: "m-sig", file: "Krida.app.tar.gz" },
    });
    expect(manifest).toEqual({
      version: "0.1.4",
      notes: "Faster",
      pub_date: "2026-10-24T12:00:00.000Z",
      platforms: {
        "windows-x86_64": { signature: "w-sig", url: "https://github.com/kausthubh-coder/krida-open-releases/releases/download/desktop-v0.1.4/Krida_0.1.4_x64-setup.exe" },
        "darwin-aarch64": { signature: "m-sig", url: "https://github.com/kausthubh-coder/krida-open-releases/releases/download/desktop-v0.1.4/Krida.app.tar.gz" },
      },
    });
  });

  test("the Android one names the APK's code, link and checksum", () => {
    expect(androidManifest({ code: 3, name: "1.2", notes: "Updates itself", file: "Krida-1.2.apk", sha256: "abc" })).toEqual({
      versionCode: 3,
      versionName: "1.2",
      notes: "Updates itself",
      url: "https://github.com/kausthubh-coder/krida-open-releases/releases/download/android-v1.2.0/Krida-1.2.apk",
      sha256: "abc",
    });
  });
});
