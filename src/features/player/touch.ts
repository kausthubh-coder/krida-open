// The player on a phone: taps, double taps, holds, swipes, drags and pinches on the picture, turning sideways, and
// the lock screen.
import { useCallback, useEffect, useRef, useState } from "react";
import { android } from "../../ui/android";
import { canFullscreen, isPhone, leavePlayerLandscape, unlockOrientation } from "../../ui/fullscreen";
import { episodeLabel } from "../../ui/format";
import { detent, tick } from "../../ui/haptics";
import { pointIn } from "../../ui/sideways";
import type { Media } from "../play";
import type { FramePreview } from "./framePreview";

/** How far one tap on a side of the picture seeks, the same as the buttons and the arrow keys. */
const STEP = 10;
/** A second tap within this long is a double tap. */
const DOUBLE_TAP_MS = 300;
/** Once seeking, each further tap on the same side within this long adds another step, as YouTube does. */
const KEEP_SEEKING_MS = 700;
/** A drag this far up or down a side adjusts brightness or volume; any less is still a tap. */
const DRAG_PX = 12;
/** Dragging this share of the picture's height goes from none to all. */
const FULL_DRAG = 0.6;
/** How long the level stays on screen after the finger lifts. */
const LEVEL_LINGER_MS = 600;
/** Held this long without moving, a finger plays the picture at double speed until it lifts, as YouTube does. */
const HOLD_MS = 500;
/** How far two fingers open (or close) before the picture fills the screen (or fits it again). */
const PINCH_OPEN = 1.15;
const PINCH_CLOSE = 0.87;
/** How long "Zoomed to fill" or a new speed stays on screen. */
const FLASH_MS = 900;

export type TouchSeek = { side: "back" | "forward"; seconds: number };
export type TouchLevel = { kind: "brightness" | "volume"; value: number };
/** A finger sliding sideways along the picture: where it would land, and how far that is from where it started. */
export type TouchScrub = { to: number; by: number };
/** A change that says itself for a moment at the top of the picture: the zoom, or the speed from the keyboard. */
export type Flash = { kind: "zoom" | "speed"; text: string };

/**
 * Brightness as a drag sets it, 0 to 1. The middle is the picture as it comes; below dims it, above lifts dark
 * scenes. A page can't reach the screen's own backlight, so this is a filter on the picture. It lasts from one
 * episode to the next, until the page reloads.
 */
let brightness = 0.5;
/** The filter for a brightness level: 0 is a fifth of the light, the middle as it comes, the top half again. */
export const brightnessFilter = (level: number) =>
  android || level === 0.5 ? undefined : `brightness(${level < 0.5 ? 0.2 + 1.6 * level : 1 + (level - 0.5)})`;

/**
 * In the Android app the drag sets the screen's own brightness instead, and the phone's media volume, as MX Player
 * does. The screen's level lasts like the filter's, and the phone goes back to its own as the player closes (see
 * useAndroidPlayer); null until a drag sets it.
 */
let screenBrightness: number | null = null;
export const chosenScreenBrightness = () => screenBrightness;

/**
 * How the picture sits in the frame, as in Stremio and Nuvio: whole with bars (fit), filling it with the edges
 * trimmed (crop), filling it out of shape (stretch), or at the file's own size, one pixel to a pixel (original).
 * Remembered on this device, so a wide screen that's always cropped stays cropped.
 */
export type Fit = "fit" | "crop" | "stretch" | "original";
export const FITS: { fit: Fit; label: string; hint: string; flash: string }[] = [
  { fit: "fit", label: "Fit", hint: "Whole picture", flash: "Fit to screen" },
  { fit: "crop", label: "Crop", hint: "Trims the edges", flash: "Zoomed to fill" },
  { fit: "stretch", label: "Stretch", hint: "Out of shape", flash: "Stretched to fill" },
  { fit: "original", label: "Original", hint: "1:1 pixels", flash: "Original size" },
];
const FIT_KEY = "krida.fit";
// globalThis: the tests' runtime has no localStorage.
let chosenFit: Fit = FITS.find((x) => x.fit === globalThis.localStorage?.getItem(FIT_KEY))?.fit ?? "fit";
function saveFit(to: Fit) {
  chosenFit = to;
  localStorage.setItem(FIT_KEY, to);
}

/** The fit films open in, for Settings: the one last chosen, which the player then starts with. */
export function useChosenFit() {
  const [fit, setFitState] = useState(chosenFit);
  const set = useCallback((to: Fit) => {
    saveFit(to);
    setFitState(to);
  }, []);
  return [fit, set] as const;
}

/** iPhones fix a page's volume at full and leave it to the phone's buttons. */
let settableVolume: boolean | undefined;
function canSetVolume() {
  if (android) return true;
  if (settableVolume === undefined) {
    const probe = document.createElement("audio");
    probe.volume = 0.5;
    settableVolume = probe.volume === 0.5;
  }
  return settableVolume;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * How much of the film one slide across the whole picture covers: a quarter of it, at least a minute and a half
 * and at most ten, so an episode and a three-hour film both scrub finely enough to land on a scene.
 */
export const scrubSpan = (duration: number) => Math.min(duration, Math.max(90, Math.min(600, duration / 4)));

/**
 * Touch on the picture, as streaming apps on phones do it. A tap shows or hides the controls (play and pause have
 * their button). A double tap on the left or right third seeks back or forward 10 seconds, and each tap after it
 * adds 10 more. Holding and dragging up or down the left third sets brightness, the right third volume, as MX Player
 * and VLC do. Sliding sideways scrubs, with the picture at that time, and lands where the finger lifts. Holding
 * still plays at double speed while held (`onHold`; only where speed is yours to change). Pinching out fills the
 * screen and pinching in fits it again. Swiping up the middle goes full screen, swiping down leaves. A mouse keeps
 * the desktop's click and double click, so `touching()` tells the element's click handlers to stand aside.
 */
export function useTouchGestures({
  video,
  visible,
  duration,
  preview,
  onTap,
  onHold,
  seekTo,
  skipBy,
  volume,
  setVolume,
  fullscreen,
  toggleFullscreen,
}: {
  video: HTMLVideoElement | null;
  visible: boolean;
  duration: number;
  /** Frames of the film, for the picture while scrubbing. */
  preview: FramePreview | null;
  /** A single tap; `wasVisible` is whether the controls were up before the finger came down. */
  onTap: (wasVisible: boolean) => void;
  /** Double speed while a finger holds still, or null where speed can't change (a party). */
  onHold: ((held: boolean) => void) | null;
  seekTo: (t: number) => void;
  skipBy: (seconds: number) => void;
  volume: number;
  setVolume: (v: number) => void;
  fullscreen: boolean;
  toggleFullscreen: () => void;
}) {
  const [seek, setSeek] = useState<TouchSeek | null>(null);
  const [level, setLevel] = useState<TouchLevel | null>(null);
  const [light, setLight] = useState(brightness);
  const [scrub, setScrub] = useState<TouchScrub | null>(null);
  const [fit, setFitState] = useState(chosenFit);
  const [flash, setFlash] = useState<Flash | null>(null);
  const down = useRef<{
    x: number;
    y: number;
    wasVisible: boolean;
    /** Which third of the picture the finger came down on, and the picture's size. */
    zone: "back" | "middle" | "forward";
    width: number;
    height: number;
    /** Set once the finger has moved far enough up or down a side: what it adjusts, from where. */
    drag?: { kind: TouchLevel["kind"]; from: number; y: number };
    /** Set once it has moved far enough sideways: the time it started from, from where, and where it would land. */
    scrub?: { from: number; x: number; to: number };
    /** Set once it has held still long enough to play at double speed. */
    held?: boolean;
  } | null>(null);
  /** Where each finger on the picture is, so a second one makes a pinch. */
  const fingers = useRef(new Map<number, { x: number; y: number }>());
  /** A pinch: how far apart the fingers started, and how the picture sat then. */
  const pinch = useRef<{ from: number; fit: Fit } | null>(null);
  const lastTap = useRef<{ at: number; zone: string } | null>(null);
  const seeking = useRef<TouchSeek & { at: number } | null>(null);
  const tapTimer = useRef<number | undefined>(undefined);
  const seekTimer = useRef<number | undefined>(undefined);
  const levelTimer = useRef<number | undefined>(undefined);
  const holdTimer = useRef<number | undefined>(undefined);
  const flashTimer = useRef<number | undefined>(undefined);
  const touch = useRef(false);
  /** The level on screen right now, so a drag past one of its marks can click. */
  const shown = useRef<TouchLevel | null>(null);

  useEffect(
    () => () => {
      for (const t of [tapTimer, seekTimer, levelTimer, holdTimer, flashTimer]) window.clearTimeout(t.current);
    },
    [],
  );

  const hideLevel = useCallback(() => {
    shown.current = null;
    setLevel(null);
  }, []);
  /** Shows a level, fading after a moment if `linger`; a step to a new tenth (or the phone's next volume step) clicks. */
  const showLevel = useCallback((next: TouchLevel, linger = false) => {
    const last = shown.current;
    if (last?.kind === next.kind && mark(last) !== mark(next)) detent();
    shown.current = next;
    window.clearTimeout(levelTimer.current);
    setLevel(next);
    if (linger) levelTimer.current = window.setTimeout(hideLevel, LEVEL_LINGER_MS);
  }, [hideLevel]);

  const adjust = (kind: TouchLevel["kind"], value: number, element: HTMLVideoElement) => {
    let landed = value;
    if (kind === "brightness") {
      if (android) {
        screenBrightness = value;
        android.setBrightness(value);
      } else {
        brightness = value;
        setLight(value);
      }
    } else if (android) {
      landed = android.setVolume(value);
    } else {
      if (value > 0) element.muted = false;
      setVolume(value);
    }
    showLevel({ kind, value: landed });
  };

  const seekBy = (side: TouchSeek["side"], now: number) => {
    skipBy(side === "back" ? -STEP : STEP);
    tick();
    const prev = seeking.current;
    const seconds = prev && prev.side === side && now - prev.at < KEEP_SEEKING_MS ? prev.seconds + STEP : STEP;
    seeking.current = { side, seconds, at: now };
    setSeek({ side, seconds });
    window.clearTimeout(seekTimer.current);
    seekTimer.current = window.setTimeout(() => setSeek(null), KEEP_SEEKING_MS);
  };

  const setFit = useCallback((to: Fit) => {
    saveFit(to);
    setFitState(to);
  }, []);

  const showFlash = useCallback((kind: Flash["kind"], text: string) => {
    setFlash({ kind, text });
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(null), FLASH_MS);
  }, []);

  /** Lets go of whatever one finger was doing, without finishing it: a second finger came, or the browser took over. */
  const drop = () => {
    window.clearTimeout(holdTimer.current);
    const d = down.current;
    down.current = null;
    if (!d) return;
    if (d.held) onHold?.(false);
    if (d.scrub) {
      setScrub(null);
      preview?.hide();
    }
    if (d.drag) levelTimer.current = window.setTimeout(hideLevel, LEVEL_LINGER_MS);
  };

  const spread = () => {
    const [a, b] = [...fingers.current.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };

  const handlers = {
    // The picture's touches are all handled here, so the click a tap leaves behind is never wanted. Left alone, it
    // lands on whatever is under the finger by then: a tap in the middle brings up pause right there, and pressed it.
    onTouchEnd: (e: React.TouchEvent<HTMLElement>) => {
      if (e.cancelable) e.preventDefault();
    },
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      touch.current = e.pointerType !== "mouse";
      if (!touch.current) return;
      // In the picture's own frame, which on an upright phone is turned a quarter (sideways.ts).
      const p = pointIn(e.currentTarget, e.clientX, e.clientY);
      fingers.current.set(e.pointerId, { x: p.x, y: p.y });
      if (fingers.current.size === 2) {
        // A second finger makes it a pinch, whatever the first was doing.
        drop();
        window.clearTimeout(tapTimer.current);
        pinch.current = { from: spread(), fit: chosenFit };
        return;
      }
      if (fingers.current.size > 2 || pinch.current) return;
      const at = p.x / p.width;
      const zone = at < 1 / 3 ? "back" : at > 2 / 3 ? "forward" : "middle";
      down.current = { x: p.x, y: p.y, wasVisible: visible, zone, width: p.width, height: p.height };
      window.clearTimeout(holdTimer.current);
      if (onHold)
        holdTimer.current = window.setTimeout(() => {
          const d = down.current;
          if (!d || d.drag || d.scrub || !video || video.paused) return;
          d.held = true;
          window.clearTimeout(tapTimer.current);
          tick(8, "press");
          onHold(true);
        }, HOLD_MS);
    },
    onPointerMove: (e: React.PointerEvent<HTMLVideoElement>) => {
      if (e.pointerType === "mouse") return;
      const p = pointIn(e.currentTarget, e.clientX, e.clientY);
      if (fingers.current.has(e.pointerId)) fingers.current.set(e.pointerId, { x: p.x, y: p.y });
      const two = pinch.current;
      if (two) {
        if (fingers.current.size < 2 || !two.from) return;
        const ratio = spread() / two.from;
        // Out crops, in fits; a picture stretched or at its own size stays so until the fingers move far enough.
        const want = ratio > PINCH_OPEN ? "crop" : ratio < PINCH_CLOSE ? "fit" : two.fit;
        if (want !== chosenFit) {
          setFit(want);
          tick();
          showFlash("zoom", FITS.find((x) => x.fit === want)!.flash);
        }
        return;
      }
      const d = down.current;
      if (!d || d.held) return;
      if (d.scrub && video) {
        const s = d.scrub;
        s.to = Math.min(Math.max(0, duration - 1), Math.max(0, s.from + ((p.x - s.x) / d.width) * scrubSpan(duration)));
        setScrub({ to: s.to, by: s.to - s.from });
        preview?.show(s.to);
        return;
      }
      if (d.drag) {
        adjust(d.drag.kind, clamp01(d.drag.from + (d.drag.y - p.y) / (d.height * FULL_DRAG)), e.currentTarget);
        return;
      }
      const dx = p.x - d.x;
      const dy = p.y - d.y;
      if (Math.hypot(dx, dy) < DRAG_PX) return;
      // Moving, it's no longer a hold.
      window.clearTimeout(holdTimer.current);
      if (Math.abs(dx) > Math.abs(dy) * 1.5) {
        if (!video || !duration) return;
        // Measured from where the finger came down, so the whole slide counts, as it does on the timeline.
        const from = video.currentTime;
        const to = Math.min(Math.max(0, duration - 1), Math.max(0, from + (dx / d.width) * scrubSpan(duration)));
        d.scrub = { from, x: d.x, to };
        window.clearTimeout(tapTimer.current);
        setScrub({ to, by: to - from });
        preview?.show(to);
        return;
      }
      // Up or down the middle is a swipe for full screen, decided when the finger lifts.
      if (d.zone === "middle" || Math.abs(dy) < Math.abs(dx) * 1.5) return;
      const kind = d.zone === "back" ? "brightness" : "volume";
      if (kind === "volume" && !canSetVolume()) return;
      const from =
        kind === "brightness"
          ? android ? (screenBrightness ?? android.getBrightness()) : brightness
          : android ? android.getVolume() : e.currentTarget.muted ? 0 : volume;
      d.drag = { kind, from, y: p.y };
      shown.current = { kind, value: from };
      window.clearTimeout(tapTimer.current);
    },
    onPointerUp: (e: React.PointerEvent<HTMLElement>) => {
      if (e.pointerType === "mouse") return;
      fingers.current.delete(e.pointerId);
      if (pinch.current) {
        // The pinch ends with the last finger; the one left behind isn't a tap.
        if (fingers.current.size === 0) pinch.current = null;
        return;
      }
      window.clearTimeout(holdTimer.current);
      const d = down.current;
      down.current = null;
      if (!d) return;
      if (d.held) {
        onHold?.(false);
        return;
      }
      if (d.scrub) {
        if (Math.abs(d.scrub.to - d.scrub.from) >= 1) seekTo(d.scrub.to);
        setScrub(null);
        preview?.hide();
        return;
      }
      if (d.drag) {
        levelTimer.current = window.setTimeout(hideLevel, LEVEL_LINGER_MS);
        return;
      }
      const end = pointIn(e.currentTarget, e.clientX, e.clientY);
      const dx = end.x - d.x;
      const dy = end.y - d.y;
      // A swipe that's mostly up or down: up goes full screen, down comes out of it.
      if (Math.abs(dy) > 60 && Math.abs(dy) > Math.abs(dx) * 2) {
        if (dy < 0 !== fullscreen) toggleFullscreen();
        return;
      }
      if (Math.hypot(dx, dy) > DRAG_PX) return;
      const zone = d.zone;
      const now = performance.now();
      const last = lastTap.current;
      lastTap.current = { at: now, zone };
      if (zone !== "middle") {
        const again = last?.zone === zone && now - last.at < DOUBLE_TAP_MS;
        const more = seeking.current?.side === zone && now - seeking.current.at < KEEP_SEEKING_MS;
        if (again || more) {
          window.clearTimeout(tapTimer.current);
          seekBy(zone, now);
          return;
        }
      }
      window.clearTimeout(tapTimer.current);
      // A tap on a side waits a moment in case it's the first of two; the middle answers at once.
      if (zone === "middle") onTap(d.wasVisible);
      else tapTimer.current = window.setTimeout(() => onTap(d.wasVisible), DOUBLE_TAP_MS);
    },
    onPointerCancel: (e: React.PointerEvent<HTMLElement>) => {
      fingers.current.delete(e.pointerId);
      if (fingers.current.size === 0) pinch.current = null;
      drop();
    },
  };

  return {
    handlers,
    seek,
    level,
    showLevel,
    scrub,
    fit,
    setFit,
    flash,
    showFlash,
    brightness: light,
    touching: useCallback(() => touch.current, []),
  };
}

/**
 * Where a level sits among the marks a drag clicks past: tenths, or in the Android app the phone's own volume
 * steps, which `setVolume` lands on exactly.
 */
const mark = (level: TouchLevel) => (android && level.kind === "volume" ? level.value : Math.round(level.value * 10));

/**
 * The `scale` that sets the picture the way `fit` asks, from how its shape compares with the frame's; none for fit,
 * or where a mode changes nothing. Scaling, rather than switching object-fit, lets it move on a spring. Follows the
 * window and the film.
 */
export function useFitScale(video: HTMLVideoElement | null, fit: Fit) {
  const [shape, setShape] = useState<{ r: number; native: number } | null>(null);
  useEffect(() => {
    if (!video) return;
    const measure = () => {
      const { videoWidth, videoHeight, clientWidth, clientHeight } = video;
      if (!videoWidth || !videoHeight || !clientWidth || !clientHeight) return;
      // Above 1 the frame is wider than the film, so the film fits with bars at the sides; below, above and below.
      const r = clientWidth / clientHeight / (videoWidth / videoHeight);
      const fitted = r > 1 ? clientHeight * (videoWidth / videoHeight) : clientWidth;
      // Read off window: a WebKit view on /watch threw "devicePixelRatio is not defined" for the bare global (prod
      // logs, 2026-10-26), which left the picture's fit unset.
      setShape({ r, native: videoWidth / (window.devicePixelRatio || 1) / fitted });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(video);
    video.addEventListener("loadedmetadata", measure);
    video.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      video.removeEventListener("loadedmetadata", measure);
      video.removeEventListener("resize", measure);
    };
  }, [video]);
  if (!shape || fit === "fit") return undefined;
  const { r, native } = shape;
  const cover = Math.max(r, 1 / r);
  if (fit === "original") return Math.abs(native - 1) > 0.01 ? `${native}` : undefined;
  if (cover < 1.01) return undefined;
  if (fit === "crop") return `${cover}`;
  return r > 1 ? `${r} 1` : `1 ${1 / r}`;
}

/**
 * Full screen came from turning the phone, so turning it back leaves. It outlives one episode's player, as full
 * screen does.
 */
let turned = false;

/**
 * A phone turned sideways while something plays goes full screen, and turned back it comes out, as YouTube does.
 * Full screen from the button turns the phone sideways and holds it there (toggleFullscreen's `landscape`), so
 * turning it back doesn't throw you out. Browsers that only allow full screen from a tap refuse the turn quietly;
 * the button still works there.
 */
export function useAutoRotate(playing: boolean) {
  useEffect(() => {
    if (!canFullscreen() || !isPhone() || !screen.orientation) return;
    const onTurn = () => {
      const sideways = screen.orientation.type.startsWith("landscape");
      if (sideways && playing && !document.fullscreenElement) {
        void document.documentElement
          .requestFullscreen({ navigationUI: "hide" })
          .then(() => (turned = true))
          .catch(() => {});
      } else if (!sideways && turned && document.fullscreenElement) {
        turned = false;
        void document.exitFullscreen().catch(() => {});
      }
    };
    screen.orientation.addEventListener("change", onTurn);
    return () => screen.orientation.removeEventListener("change", onTurn);
  }, [playing]);
}

/** Rooms on screen: one, or briefly two while React remounts one in development. */
let rooms = 0;

/**
 * Leaving full screen or the room lets the phone turn freely again, and leaving the room ends the full screen that
 * Play started. It belongs to the room, not the player: the player is rebuilt for every episode, and the next one
 * has to start as sideways as the last one ended.
 */
export function useReleaseOrientation() {
  useEffect(() => {
    rooms++;
    const onChange = () => {
      if (document.fullscreenElement) return;
      turned = false;
      unlockOrientation();
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => {
      rooms--;
      document.removeEventListener("fullscreenchange", onChange);
      turned = false;
      // A room that comes straight back (React's development remount) keeps its full screen.
      setTimeout(() => rooms === 0 && leavePlayerLandscape(), 0);
    };
  }, []);
}

/**
 * What's playing on the lock screen, in the notification and on headphones, with their buttons. They go through
 * the player's own play, pause and seek, so in a party they move everyone, as the buttons on screen do.
 */
export function useMediaSession({
  media,
  video,
  togglePlay,
  seekTo,
  skipBy,
  playNext,
}: {
  media: Media;
  video: HTMLVideoElement | null;
  togglePlay: () => void;
  seekTo: (t: number) => void;
  skipBy: (seconds: number) => void;
  playNext: (() => void) | null;
}) {
  const { name, type, season, episode, episodeTitle, year, poster } = media;
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    const episodeLine = type === "series" && episode ? [episodeLabel(season, episode), episodeTitle].filter(Boolean).join(" · ") : undefined;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: episodeLine ?? name,
      artist: episodeLine ? name : (year ?? ""),
      album: "Krida",
      artwork: poster ? [{ src: poster }] : [],
    });
    return () => {
      navigator.mediaSession.metadata = null;
    };
  }, [name, type, season, episode, episodeTitle, year, poster]);

  useEffect(() => {
    if (!("mediaSession" in navigator) || !video) return;
    const handlers: [MediaSessionAction, MediaSessionActionHandler | null][] = [
      ["play", () => video.paused && togglePlay()],
      ["pause", () => !video.paused && togglePlay()],
      ["seekbackward", (d) => skipBy(-(d.seekOffset ?? STEP))],
      ["seekforward", (d) => skipBy(d.seekOffset ?? STEP)],
      ["seekto", (d) => d.seekTime !== undefined && seekTo(d.seekTime)],
      ["nexttrack", playNext && (() => playNext())],
    ];
    const set = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch {
        // An action this browser doesn't know.
      }
    };
    for (const [action, handler] of handlers) set(action, handler);
    return () => {
      for (const [action] of handlers) set(action, null);
    };
  }, [video, togglePlay, seekTo, skipBy, playNext]);
}
