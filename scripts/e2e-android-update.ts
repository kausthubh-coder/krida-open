// Krida for Android updating itself, on an emulator against the QA app: an older copy (9.0) finds a newer one (9.1)
// in an android.json served here, downloads it and checks its checksum; the page offers it in a toast and in
// Settings; Install sends the phone to "allow installs from Krida" once (granted here with appops), then Android's
// installer asks and the update is accepted; the phone then runs 9.1, which shows what's new in it once. Both copies
// are debug builds, signed with the same debug key, as a release is with the release key. It reinstalls the app.
// Usage: npm run qa -- up; node scripts/e2e-android-update.ts <serial> [outDir]   (android/README.md)
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { _android, type AndroidDevice, type Page } from "playwright-core";
import { checks, qaSession, signIn } from "./lib/qa.ts";

const repo = resolve(import.meta.dirname, "..");
const serial = process.argv[2] ?? process.env.ANDROID_SERIAL;
if (!serial) throw new Error("Name the emulator: node scripts/e2e-android-update.ts emulator-5554 (adb devices lists them)");
const out = resolve(process.argv[3] ?? `${repo}/.artifacts/android-update`);
mkdirSync(out, { recursive: true });
const sdk = process.env.ANDROID_HOME ?? `${homedir()}/Library/Android/sdk`;
const adb = (...args: string[]) => execFileSync(`${sdk}/platform-tools/adb`, ["-s", serial, ...args], { encoding: "utf8", maxBuffer: 64 << 20 });
const shot = (name: string) => writeFileSync(resolve(out, name), execFileSync(`${sdk}/platform-tools/adb`, ["-s", serial, "exec-out", "screencap", "-p"], { maxBuffer: 64 << 20 }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => Promise<boolean> | boolean, ms: number) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(500)) if (await ok()) return true;
  return false;
};

const s = qaSession();
const url = s.url.replace("127.0.0.1", "localhost");
const PORT = 9452;
const OLD = { code: 900, name: "9.0", notes: "The copy that updates" };
const NEW = { code: 901, name: "9.1", notes: "Updated while you watched" };

// ----- the two copies, and a stand-in for the releases repo
const build = (v: typeof OLD, file: string) => {
  execFileSync("bash", ["gradlew", "--quiet", "assembleDebug", `-PkridaUrl=${url}`, `-PkridaUpdateUrl=http://localhost:${PORT}/android.json`, `-PkridaVersionCode=${v.code}`, `-PkridaVersionName=${v.name}`, `-PkridaNotes=${v.notes}`], {
    cwd: resolve(repo, "android"),
    stdio: "inherit",
    env: { ...process.env, JAVA_HOME: process.env.JAVA_HOME ?? "/opt/homebrew/opt/openjdk@17" },
  });
  copyFileSync(resolve(repo, "android/app/build/outputs/apk/debug/app-debug.apk"), resolve(out, file));
};
build(NEW, "new.apk");
build(OLD, "old.apk");
const apk = readFileSync(resolve(out, "new.apk"));
const manifest = { versionCode: NEW.code, versionName: NEW.name, notes: NEW.notes, url: `http://localhost:${PORT}/Krida-${NEW.name}.apk`, sha256: createHash("sha256").update(apk).digest("hex") };
const asked: string[] = [];
const server = createServer((req, res) => {
  asked.push(req.url ?? "");
  if (req.url === "/android.json") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(manifest));
  if (req.url === `/Krida-${NEW.name}.apk`) return res.writeHead(200, { "content-type": "application/vnd.android.package-archive" }).end(apk);
  res.writeHead(404).end();
});
await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r));

// ----- the older copy, signed in
const providers = /providers http:\/\/127\.0\.0\.1:(\d+)/.exec(readFileSync(resolve(repo, ".qa/providers.log"), "utf8"))![1]!;
for (const port of [new URL(s.url).port, new URL(s.convexUrl).port, new URL(s.siteUrl).port, providers, String(PORT)]) adb("reverse", `tcp:${port}`, `tcp:${port}`);
try {
  adb("uninstall", "app.krida");
} catch {
  // Not installed.
}
adb("install", resolve(out, "old.apk"));
// An installer left open by an earlier run would come forward instead of asking.
adb("shell", "am", "force-stop", "com.google.android.packageinstaller");
adb("shell", "appops", "set", "app.krida", "REQUEST_INSTALL_PACKAGES", "default");
const versionCode = () => /versionCode=(\d+)/.exec(adb("shell", "dumpsys", "package", "app.krida"))?.[1];
/** Opens the app and its page: the WebView of the process running now, not one an update has ended. */
const open = async (device: AndroidDevice) => {
  adb("shell", "am", "start", "-W", "-n", "app.krida/.MainActivity");
  const pid = Number(adb("shell", "pidof", "app.krida").trim());
  for (let i = 0; i < 60; i++, await sleep(500)) {
    const view = device.webViews().find((w) => w.pkg() === "app.krida" && w.pid() === pid);
    if (view) return view.page();
  }
  throw new Error(`No WebView in app.krida (pid ${pid})`);
};
const device = (await _android.devices()).find((d) => d.serial() === serial);
if (!device) throw new Error(`${serial} isn't attached (adb devices)`);
let page: Page = await open(device);
const { check, finish } = checks(page);
check("the older copy is installed", versionCode() === String(OLD.code), versionCode());
await signIn(page, url, s.profiles[0]!);

const status = () => page.evaluate(() => JSON.parse((window as unknown as { KridaAndroid: { updateStatus(): string } }).KridaAndroid.updateStatus()) as { state: string; version: string | null });
check("it finds the newer copy and downloads it", await until(async () => (await status()).state === "ready", 60_000), JSON.stringify(await status()));
check("it read the manifest, then the APK", asked.join(",") === `/android.json,/Krida-${NEW.name}.apk`, asked.join(","));
check("a toast offers the update", await until(() => page.getByText(`Krida for Android ${NEW.name} is ready`).isVisible(), 10_000));
shot("ready-toast.png");

await page.goto(`${url}/settings/app`, { waitUntil: "domcontentloaded" });
const install = page.getByRole("button", { name: "Install update" });
check("Settings shows the version and the update waiting", await until(async () => (await page.getByText(`Version ${OLD.name}`).isVisible()) && (await install.isVisible()), 10_000));
await page.getByRole("heading", { name: "Krida for Android" }).scrollIntoViewIfNeeded();
shot("settings-ready.png");

// ----- Install: first the setting, then Android's own confirm
const focused = () => /mCurrentFocus=Window\{[^ ]+ [^ ]+ ([^}]+)\}/.exec(adb("shell", "dumpsys", "window"))?.[1] ?? "";
await install.click();
check("Install first asks to allow installs from Krida", await until(() => focused().includes("settings"), 10_000), focused());
shot("allow-installs.png");
adb("shell", "appops", "set", "app.krida", "REQUEST_INSTALL_PACKAGES", "allow");
adb("shell", "input", "keyevent", "KEYCODE_BACK");
const button = (label: RegExp) => {
  adb("shell", "uiautomator", "dump", "/sdcard/krida-ui.xml");
  const xml = adb("shell", "cat", "/sdcard/krida-ui.xml");
  for (const node of xml.match(/<node [^>]+>/g) ?? []) {
    const text = /text="([^"]*)"/.exec(node)?.[1] ?? "";
    const bounds = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(node);
    if (label.test(text) && bounds) return [(+bounds[1]! + +bounds[3]!) / 2, (+bounds[2]! + +bounds[4]!) / 2] as const;
  }
  return null;
};
let update: readonly [number, number] | null = null;
check("then Android's installer asks to update Krida", await until(() => !!(update = button(/^update$/i)), 20_000), focused());
shot("installer.png");
if (update) adb("shell", "input", "tap", String(update[0]), String(update[1]));
check("the phone now runs the newer copy", await until(() => versionCode() === String(NEW.code), 60_000), versionCode());

// ----- the newer copy, opened from the installer's last screen: what's new, once
let opened: readonly [number, number] | null = null;
check("the installer offers to open it", await until(() => !!(opened = button(/^open$/i)), 20_000), focused());
if (opened) adb("shell", "input", "tap", String(opened[0]), String(opened[1]));
page = await open(device);
check("the newer copy shows what's new in it", await until(() => page.getByText(`What's new in Krida for Android ${NEW.name}`).isVisible(), 20_000));
check("with its notes", await page.getByText(NEW.notes).isVisible());
shot("whats-new.png");
const version = await page.evaluate(() => (window as unknown as { KridaAndroid: { version(): string } }).KridaAndroid.version());
check("the page hears the new version", version === NEW.name, version);

server.close();
finish();
// Closing the device connection waits on adb indefinitely; the run is over.
process.exit(process.exitCode ?? 0);
