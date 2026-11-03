// Releases open Krida's apps from the Mac mini: Krida for Windows and Mac when desktop/ changed since their last release,
// Krida for Android when android/ did. It bumps their versions, builds each signed, publishes them to the public
// krida-open-releases repo where installed apps look for updates, then commits the versions, tags them and pushes main.
// The web needs none of this: pushing main deploys it, and every app shows the live site.
// Usage: node scripts/release.ts "What's new, one line" [--dry-run] [--only desktop|android] [--no-windows]
//        node scripts/release.ts --add-windows        (on Windows, after a --no-windows release: see docs/desktop.md)
// Release from main as it is on GitHub, after the change itself has shipped (ship-krida). It needs gh signed in, the
// keys in ~/.krida-open (krida-open-updater.key; krida-open-release.jks and android-signing.properties for Android),
// and for the Windows cross-build: brew install rustup llvm nsis p7zip mpv dylibbundler openjdk@17, then
// rustup toolchain install stable --target x86_64-pc-windows-msvc and cargo install cargo-xwin. --no-windows releases
// the Mac app alone; --add-windows then builds Krida for Windows on a Windows machine and adds it to that release.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  type App,
  APPS,
  androidManifest,
  desktopManifest,
  needsRelease,
  nextAndroidVersion,
  nextDesktopVersion,
  readAndroidVersion,
  RELEASES_REPO,
  RELEASES_RAW,
  tagOf,
  writeAndroidVersion,
  writeDesktopVersion,
} from "./lib/release.ts";

const repo = resolve(import.meta.dirname, "..");
const desktop = join(repo, "desktop");
const tauri = join(desktop, "src-tauri");
const gradleFile = join(repo, "android/app/build.gradle.kts");
// Open Krida's own keys, never private Krida's (~/.krida): its apps install beside these and must not take their updates.
const keys = join(homedir(), ".krida-open");
const UPDATER_KEY = "krida-open-updater.key";
const out = join(repo, ".artifacts/release");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const withWindows = !args.includes("--no-windows");
const only = args.includes("--only") ? (args[args.indexOf("--only") + 1] as App) : null;
const notes = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--only");

// Windows needs .cmd for npx, and a shell to run it.
const onWindows = process.platform === "win32";
const npx = onWindows ? "npx.cmd" : "npx";
const text = (cmd: string, cmdArgs: string[], cwd = repo, env: Record<string, string> = {}) =>
  execFileSync(cmd, cmdArgs, { cwd, encoding: "utf8", env: { ...process.env, ...env }, shell: onWindows }).trim();
const run = (cmd: string, cmdArgs: string[], o: { cwd?: string; env?: Record<string, string> } = {}) =>
  execFileSync(cmd, cmdArgs, { cwd: o.cwd ?? repo, stdio: "inherit", env: { ...process.env, ...o.env }, shell: onWindows });

if (args.includes("--add-windows")) {
  await addWindows();
  process.exit(0);
}
if (!notes) throw new Error('Say what changed, in a line people will see: node scripts/release.ts "Smoother colour in dark scenes"');
if (only && !APPS.includes(only)) throw new Error(`--only takes ${APPS.join(" or ")}`);
if (process.platform !== "darwin") throw new Error("Release from the Mac mini: it builds the Mac app and cross-builds Windows. On Windows, --add-windows adds Windows to a release.");

// ----- what goes out

run("git", ["fetch", "--quiet", "--tags", "origin", "main"]);

const lastTag = (app: App) => {
  try {
    return text("git", ["describe", "--tags", "--abbrev=0", "--match", `${app}-v*`]);
  } catch {
    return null;
  }
};
const desktopVersion = JSON.parse(readFileSync(join(tauri, "tauri.conf.json"), "utf8")).version as string;
const androidVersion = readAndroidVersion(readFileSync(gradleFile, "utf8"));
const plan = APPS.filter((app) => !only || app === only).flatMap((app) => {
  const tag = lastTag(app);
  const changed = tag ? text("git", ["diff", "--name-only", `${tag}..HEAD`]).split("\n") : null;
  if (!only && changed && !needsRelease(app, changed)) {
    console.log(`${app}: nothing changed in ${app}/ since ${tag}`);
    return [];
  }
  const to = app === "desktop" ? nextDesktopVersion(desktopVersion) : nextAndroidVersion(androidVersion).name;
  console.log(`${app}: ${tag ?? "never released"} -> ${tagOf(app, to)}`);
  return [app];
});
if (!plan.length) {
  console.log("Nothing to release. The site goes out with every push to main.");
  process.exit(0);
}
// A dry run says what this checkout would release, before or after it lands.
if (dryRun) process.exit(0);
if (text("git", ["status", "--porcelain"])) throw new Error("Commit or put away your changes first: a release is built from main as it is.");
if (text("git", ["rev-parse", "HEAD"]) !== text("git", ["rev-parse", "origin/main"])) throw new Error("Release from main as it is on GitHub: ship the change first, then release.");
for (const key of [UPDATER_KEY, ...(plan.includes("android") ? ["krida-open-release.jks", "android-signing.properties"] : [])]) {
  if (!existsSync(join(keys, key))) throw new Error(`${join(keys, key)} is missing. Without it installed apps can't take the update.`);
}

// ----- versions, builds and the release

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const tags: string[] = [];
const titles: string[] = [];
const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

if (plan.includes("desktop")) {
  const to = nextDesktopVersion(desktopVersion);
  const files = {
    "package.json": join(desktop, "package.json"),
    "package-lock.json": join(desktop, "package-lock.json"),
    "Cargo.toml": join(tauri, "Cargo.toml"),
    "Cargo.lock": join(tauri, "Cargo.lock"),
    "tauri.conf.json": join(tauri, "tauri.conf.json"),
  } as const;
  for (const [name, path] of Object.entries(files)) writeFileSync(path, writeDesktopVersion(name as keyof typeof files, readFileSync(path, "utf8"), desktopVersion, to));

  const key = readFileSync(join(keys, UPDATER_KEY), "utf8");
  // CI: tauri takes an empty key password instead of waiting for one to be typed. makensis dies under the C locale.
  const env = {
    TAURI_SIGNING_PRIVATE_KEY: key,
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "",
    CI: "true",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    KRIDA_RELEASE_NOTES: notes,
    // rustup's cargo (Homebrew's rust has no Windows target), llvm's clang-cl and lld, and cargo-xwin.
    PATH: ["/opt/homebrew/opt/rustup/bin", "/opt/homebrew/opt/llvm/bin", join(homedir(), ".cargo/bin"), process.env.PATH].join(":"),
    RUSTUP_TOOLCHAIN: "stable",
  };

  // Windows: the installer and its signature. Without them (--no-windows), --add-windows adds them later.
  const exe = `Krida_${to}_x64-setup.exe`;
  if (withWindows) {
    run("node", ["scripts/fetch-mpv.mjs", "--windows"], { cwd: desktop });
    run("npx", ["tauri", "build", "--runner", "cargo-xwin", "--target", "x86_64-pc-windows-msvc"], { cwd: desktop, env });
    const nsis = join(tauri, "target/x86_64-pc-windows-msvc/release/bundle/nsis");
    copyFileSync(join(nsis, exe), join(out, exe));
    copyFileSync(join(nsis, `${exe}.sig`), join(out, `${exe}.sig`));
  }

  // Mac: the app with mpv inside it, packed for the updater and signed, and a disk image to install it from.
  run("npx", ["tauri", "build", "--bundles", "app"], { cwd: desktop, env });
  const built = join(tauri, "target/release/bundle/macos/Krida.app");
  run("node", ["scripts/bundle-mac.mjs", built], { cwd: desktop });
  const tarball = `Krida_${to}_aarch64.app.tar.gz`;
  // Without macOS's ._ metadata files, which the updater refuses to unpack.
  run("tar", ["--no-mac-metadata", "-czf", join(out, tarball), "-C", join(built, ".."), "Krida.app"], { env: { COPYFILE_DISABLE: "1" } });
  // The key comes from its file here; the build's key variable alongside would clash with it.
  run("npx", ["tauri", "signer", "sign", "-f", join(keys, UPDATER_KEY), "-p", "", join(out, tarball)], { cwd: desktop, env: { CI: "true" } });
  const stage = join(out, "dmg");
  mkdirSync(stage);
  run("cp", ["-R", built, stage]);
  symlinkSync("/Applications", join(stage, "Applications"));
  const dmg = `Krida_${to}_aarch64.dmg`;
  run("hdiutil", ["create", "-quiet", "-volname", "Krida", "-srcfolder", stage, "-format", "UDZO", join(out, dmg)]);

  const manifest = desktopManifest({
    version: to,
    notes,
    date: new Date(),
    windows: withWindows ? { signature: readFileSync(join(out, `${exe}.sig`), "utf8"), file: exe } : undefined,
    mac: { signature: readFileSync(join(out, `${tarball}.sig`), "utf8"), file: tarball },
  });
  writeFileSync(join(out, "latest.json"), JSON.stringify(manifest, null, 2));
  // The newest desktop release is the repo's latest: installed apps read releases/latest/download/latest.json.
  const assets = [...(withWindows ? [exe, `${exe}.sig`] : []), tarball, `${tarball}.sig`, dmg, "latest.json"];
  const title = `${withWindows ? "Krida for Windows and Mac" : "Krida for Mac"} ${to}`;
  run("gh", ["release", "create", tagOf("desktop", to), ...assets.map((f) => join(out, f)), "--repo", RELEASES_REPO, "--title", title, "--notes", notes, "--latest"]);
  tags.push(tagOf("desktop", to));
  titles.push(title);
}

if (plan.includes("android")) {
  const next = nextAndroidVersion(androidVersion);
  writeFileSync(gradleFile, writeAndroidVersion(readFileSync(gradleFile, "utf8"), next));
  // Gradle and apksigner both run on Java, which macOS doesn't have unless it's named.
  const sdk = process.env.ANDROID_HOME ?? join(homedir(), "Library/Android/sdk");
  const java = { JAVA_HOME: "/opt/homebrew/opt/openjdk@17", ANDROID_HOME: sdk, PATH: `/opt/homebrew/opt/openjdk@17/bin:${process.env.PATH}` };
  run("bash", ["gradlew", "--quiet", "assembleRelease", `-PkridaNotes=${notes}`], { cwd: join(repo, "android"), env: java });
  const apk = `Krida-${next.name}.apk`;
  copyFileSync(join(repo, "android/app/build/outputs/apk/release/app-release.apk"), join(out, apk));
  // Only a release signed with the key installed apps carry can update them.
  const signer = text(join(sdk, "build-tools/36.0.0/apksigner"), ["verify", "--print-certs", join(out, apk)], repo, java);
  if (!signer.includes("Signer #1 certificate SHA-256 digest")) throw new Error(`The APK isn't signed:\n${signer}`);
  // Not the repo's latest: that stays the desktop release installed desktop apps read.
  run("gh", ["release", "create", tagOf("android", next.name), join(out, apk), "--repo", RELEASES_REPO, "--title", `Krida for Android ${next.name}`, "--notes", notes, "--latest=false"]);
  // Installed phones read android.json from the repo's main branch.
  const manifest = androidManifest({ code: next.code, name: next.name, notes, file: apk, sha256: sha256(join(out, apk)) });
  let current: string | null = null;
  try {
    current = text("gh", ["api", `repos/${RELEASES_REPO}/contents/android.json`, "-q", ".sha"]);
  } catch {
    // The first Android release writes it.
  }
  run("gh", [
    "api", "--silent", "-X", "PUT", `repos/${RELEASES_REPO}/contents/android.json`,
    "-f", `message=Krida for Android ${next.name}`,
    "-f", `content=${Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`).toString("base64")}`,
    ...(current ? ["-f", `sha=${current}`] : []),
  ]);
  tags.push(tagOf("android", next.name));
  titles.push(`Krida for Android ${next.name}`);
}

// ----- the versions, back in main

run("git", ["commit", "--quiet", "-am", `Release ${titles.join(", ")}\n\n${notes}`]);
for (const tag of tags) run("git", ["tag", tag]);
run("git", ["push", "--quiet", "origin", "HEAD:main", ...tags]);

// What installed apps read now.
const live = async (url: string) => (await fetch(url, { cache: "no-store" })).json() as Promise<{ version?: string; versionName?: string }>;
if (plan.includes("desktop")) console.log(`latest.json says ${(await live(`https://github.com/${RELEASES_REPO}/releases/latest/download/latest.json`)).version}`);
if (plan.includes("android")) console.log(`android.json says ${(await live(`${RELEASES_RAW}/android.json`)).versionName} (GitHub's raw copy can lag a few minutes)`);
console.log(`Released ${titles.join(", ")}.`);

/**
 * Krida for Windows, built on Windows and added to the desktop release this checkout's version names (one made with
 * --no-windows on the Mac mini): the installer, its signature, and its line in that release's latest.json, so
 * installed Windows apps update from it too. Run it from main after that release, with the updater key in
 * ~/.krida-open on this machine as well. Needs Rust (MSVC), Node and gh.
 */
async function addWindows() {
  if (!onWindows) throw new Error("--add-windows builds the Windows installer natively: run it on Windows.");
  const version = JSON.parse(readFileSync(join(tauri, "tauri.conf.json"), "utf8")).version as string;
  const tag = tagOf("desktop", version);
  const body = text("gh", ["release", "view", tag, "--repo", RELEASES_REPO, "--json", "body", "-q", ".body"]);
  if (!existsSync(join(keys, UPDATER_KEY))) throw new Error(`${join(keys, UPDATER_KEY)} is missing: copy it from the Mac mini.`);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const env = { TAURI_SIGNING_PRIVATE_KEY: readFileSync(join(keys, UPDATER_KEY), "utf8"), TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "", CI: "true", KRIDA_RELEASE_NOTES: body };
  run("node", ["scripts/fetch-mpv.mjs"], { cwd: desktop });
  run(npx, ["tauri", "build"], { cwd: desktop, env });
  const exe = `Krida_${version}_x64-setup.exe`;
  const nsis = join(tauri, "target/release/bundle/nsis");
  copyFileSync(join(nsis, exe), join(out, exe));
  copyFileSync(join(nsis, `${exe}.sig`), join(out, `${exe}.sig`));
  run("gh", ["release", "download", tag, "--repo", RELEASES_REPO, "-p", "latest.json", "-D", out]);
  const latest = JSON.parse(readFileSync(join(out, "latest.json"), "utf8")) as { version: string; platforms: Record<string, unknown> };
  if (latest.version !== version) throw new Error(`${tag}'s latest.json is for ${latest.version}, this checkout for ${version}`);
  latest.platforms["windows-x86_64"] = {
    signature: readFileSync(join(out, `${exe}.sig`), "utf8"),
    url: `https://github.com/${RELEASES_REPO}/releases/download/${tag}/${exe}`,
  };
  writeFileSync(join(out, "latest.json"), JSON.stringify(latest, null, 2));
  run("gh", ["release", "upload", tag, join(out, exe), join(out, `${exe}.sig`), join(out, "latest.json"), "--repo", RELEASES_REPO, "--clobber"]);
  run("gh", ["release", "edit", tag, "--repo", RELEASES_REPO, "--title", `Krida for Windows and Mac ${version}`]);
  console.log(`Added Krida for Windows ${version} to ${tag}.`);
}
