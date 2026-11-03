/**
 * Krida's Android app (android/) opens this site in a WebView and hands the page what a browser can't reach: the
 * screen's own brightness, the phone's volume, its haptic motor, holding the phone sideways, keeping the screen on,
 * and the small picture-in-picture window. `android` is null everywhere else. Levels are 0 to 1 both ways.
 */
export type Haptic = "tick" | "detent" | "press" | "confirm" | "reject";

type Insets = { top: number; right: number; bottom: number; left: number };

type Bridge = {
  /** The app's version name, such as 1.2. */
  version?(): string;
  /** What's new in this version. Missing before 1.2, as are updates. */
  notes?(): string;
  /** JSON `{state, version, notes}`: where the app's own updates stand (appUpdate.ts). */
  updateStatus?(): string;
  /** Android's install screen for the version that has downloaded. */
  installUpdate?(): void;
  /** The app's own link a sign-in in the browser comes back to (src/data/appSignIn.ts). Missing before open Krida's app. */
  signInRedirect?(): string;
  /** Opens a sign-in page (Google's) in a Custom Tab; it comes back as a `signin` event. */
  openSignIn?(url: string): void;
  /** A sign-in that came back while the page wasn't loaded, once; empty otherwise. */
  signInCallback?(): string;
  /** JSON Insets, in CSS pixels. Missing in app 1.0, which kept the page clear of the bars with margins instead. */
  insets?(): string;
  haptic(kind: Haptic): void;
  getBrightness(): number;
  setBrightness(level: number): void;
  resetBrightness(): void;
  getVolume(): number;
  /** Answers the level it landed on: the phone's volume has steps. */
  setVolume(level: number): number;
  setPlayer(on: boolean): void;
  setPlaying(playing: boolean): void;
  setVideoSize(width: number, height: number): void;
  setOrientation(kind: "landscape" | "any"): void;
  canPictureInPicture(): boolean;
  enterPictureInPicture(): void;
};

export const android: Bridge | null = (window as { KridaAndroid?: Bridge }).KridaAndroid ?? null;

/** What the phone tells the page: a volume key's new level, the small window opening or closing, its play button. */
export type AndroidEvent =
  | ({ type: "insets" } & Insets)
  | { type: "volume"; value: number }
  | { type: "pip"; on: boolean }
  | { type: "media"; action: "toggle" | "pause" }
  | { type: "signin"; url: string }
  | { type: "update"; state: "idle" | "checking" | "current" | "downloading" | "ready" | "failed"; version: string | null };

export function onAndroid(listener: (event: AndroidEvent) => void) {
  const handle = (e: Event) => listener((e as CustomEvent<AndroidEvent>).detail);
  window.addEventListener("krida-android", handle);
  return () => window.removeEventListener("krida-android", handle);
}

/**
 * In the app, before the first render: the page learns the phone's bars and cutout (styles.css turns them into
 * --inset-*), now and whenever they change, and the back button asks the page first.
 */
export function startAndroid() {
  if (!android) return;
  if (android.insets) setInsets(JSON.parse(android.insets()) as Insets);
  onAndroid((e) => e.type === "insets" && setInsets(e));
  (window as { kridaBack?: () => boolean }).kridaBack = back;
}

function setInsets(insets: Insets) {
  const style = document.documentElement.style;
  for (const side of ["top", "right", "bottom", "left"] as const) style.setProperty(`--android-inset-${side}`, `${insets[side]}px`);
}

/**
 * The phone's back button or gesture asks the page first (`window.kridaBack`): it closes the sheet on top, or leaves
 * full screen, as Escape does. False lets the app go back a page. Chrome does this itself; a WebView leaves it to
 * the app.
 */
function back() {
  const sheet = [...document.querySelectorAll("dialog[open]")].pop();
  if (sheet instanceof HTMLDialogElement) {
    // As Escape would: the sheet's own cancel handler animates it shut; one without a handler just closes.
    if (sheet.dispatchEvent(new Event("cancel", { cancelable: true }))) sheet.close();
    return true;
  }
  if (document.fullscreenElement) {
    void document.exitFullscreen().catch(() => {});
    return true;
  }
  return false;
}
