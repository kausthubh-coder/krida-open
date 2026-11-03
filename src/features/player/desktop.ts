// In Krida for Windows, mpv plays the stream's own file under the page instead of a <video> playing TorBox's HLS:
// HEVC, HDR and Dolby Vision, every audio codec, at the file's full quality, decoded on the GPU.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useAction } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { desktopApp, desktopAtLeast, type DesktopApp } from "../../data/desktop";
import { cropOf, LIT_LEVEL, look, NOTHING_SEEN, type Finding, type FrameLight } from "./bars";
import type { Fit } from "./touch";

/** What the app reports from mpv (desktop/src-tauri/src/mpv.rs): a property that changed, or an event. */
export type MpvMessage = {
  name?: string;
  value?: unknown;
  event?: string;
  /** mpv's position when it sent this, in seconds. */
  time?: number | null;
  reason?: string | null;
};

const HAVE_METADATA = 1;
const HAVE_CURRENT_DATA = 2;
const HAVE_ENOUGH_DATA = 4;

/** While the film plays, the picture is looked at for black bars every this many seconds of it until they settle. */
const LOOK_EVERY = 2;
/** Looks in a row that can fail before the film is left whole, rather than asking every 2 seconds all film. */
const MAX_FAILURES = 5;
/** mpv's own margin under subtitles, in its 720-line units (its default). */
const SUB_MARGIN = 22;

/** Trimming black bars built into the film: switched off, still looking, none found, couldn't tell, or trimmed. */
export type BarsState = "off" | "looking" | "none" | "unsure" | "trimmed";

/**
 * mpv, dressed as the <video> element the player drives: the properties, methods and events it uses, so party sync,
 * skips, Up next and the controls work unchanged. Setting something asks mpv and takes effect here at once, as it does
 * on the element; mpv's reports then confirm it. mpv reports time four times a second; between reports it's counted on.
 */
export class MpvVideo extends EventTarget {
  paused = true;
  ended = false;
  seeking = false;
  duration = NaN;
  readyState = 0;
  /** Always 0: the picture isn't in the page, so the timeline's preview can't copy frames from it (framePreview.ts). */
  readonly videoWidth = 0;
  readonly videoHeight = 0;
  /** No picture-in-picture: the picture is mpv's window, not the page's. */
  readonly disablePictureInPicture = true;
  private position = 0;
  private positionAt = 0;
  private rate = 1;
  private level = 1;
  private mute = false;
  private stalled = false;
  private cachedTo = 0;
  private fit: Fit = "fit";
  private deband = true;
  /** How far, in CSS pixels, the file's own subtitles sit above where mpv puts them: clear of the controls. */
  private subLift = 0;
  /**
   * Black bars built into the film (bars.ts): whether to trim them, which film (stream) the finding is about, the
   * film's size in pixels, where in it the picture was last looked at, the looks that failed in a row, and the crop
   * mpv has for the file playing now.
   */
  private trim = false;
  private film: string | undefined;
  private finding: Finding = NOTHING_SEEN;
  private size = { width: 0, height: 0 };
  private lookedAt = -Infinity;
  private looking = false;
  private failures = 0;
  private loads = 0;
  private cropped = "";
  private app: DesktopApp;
  private now: () => number;

  constructor(app: DesktopApp, now: () => number = () => performance.now()) {
    super();
    this.app = app;
    this.now = now;
    this.positionAt = now();
  }

  /** Listens to mpv; returns how to stop. */
  attach() {
    let unlisten: (() => void) | null = null;
    let attached = true;
    void this.app.event.listen<MpvMessage>("mpv", (e) => this.receive(e.payload)).then((off) => {
      if (attached) unlisten = off;
      else off();
    });
    return () => {
      attached = false;
      unlisten?.();
    };
  }

  /** Plays `url`; `film` names what it is (the stream), so loading the same film again keeps the bars found in it. */
  load(url: string, { start, aid, title, film }: { start: number; aid: number; title: string; film?: string }) {
    Object.assign(this, { paused: true, ended: false, seeking: false, stalled: false, readyState: 0, duration: NaN, cachedTo: 0 });
    this.position = Math.max(0, start);
    this.positionAt = this.now();
    // mpv drops the file's crop when the file ends.
    Object.assign(this, { loads: this.loads + 1, cropped: "", lookedAt: -Infinity, failures: 0 });
    if (film === undefined || film !== this.film) {
      this.film = film;
      this.finding = NOTHING_SEEN;
      this.emit("barschange");
    }
    // An mpv started afresh (the first title, or after it closed) begins at fit.
    return this.app.core.invoke("mpv_load", { url, start: this.position, paused: true, aid, title }).then(() => {
      if (this.fit !== "fit") this.setFit(this.fit);
      if (!this.deband) this.setDeband(false);
      if (this.subLift) this.liftSubtitles(this.subLift);
    });
  }

  /** Starts mpv idle, if it isn't running, so it's ready when the file's link arrives. */
  warm() {
    void this.app.core.invoke("mpv_warm").catch(() => {});
  }

  stop() {
    void this.app.core.invoke("mpv_stop").catch(() => {});
  }

  /** Switches the audio track in place (mpv counts from 1), keeping the position and what's buffered. */
  setAudio(aid: number) {
    this.set("aid", aid);
  }

  /** Shows one of the file's own subtitle tracks (from 1), shifted by `delay` seconds, or none. */
  setSubtitles(sid: number | null, delay: number) {
    this.set("sid", sid ?? "no");
    this.set("sub-delay", delay);
  }

  /**
   * Sets the picture in the window the way the Picture menu asks, as Nuvio and Stremio Kai do with mpv: crop zooms
   * until no bars are left (panscan), stretch lets go of the film's shape, original shows one file pixel per screen
   * pixel. mpv keeps them from one file to the next.
   */
  setFit(fit: Fit) {
    this.fit = fit;
    this.set("panscan", fit === "crop" ? 1 : 0);
    this.set("keepaspect", fit !== "stretch");
    this.set("video-unscaled", fit === "original" ? "yes" : "no");
  }

  /** Evens out the stepped colour compression leaves in skies and dark scenes (mpv's deband, on as mpv starts). */
  /**
   * Lifts the file's own subtitles `px` CSS pixels, as the page lifts its own above the controls. mpv measures its
   * margin in a 720-line window whatever the window's size, from 22 at the bottom.
   */
  liftSubtitles(px: number) {
    this.subLift = px;
    this.set("sub-margin-y", Math.round(SUB_MARGIN + (px * 720) / Math.max(1, window.innerHeight)));
  }

  setDeband(on: boolean) {
    this.deband = on;
    this.set("deband", on);
  }

  /**
   * Trims black bars built into the film, or leaves the picture whole. They're found as the film plays (bars.ts), so a
   * dark opening or a fade can't trim the picture; once they settle they stay, and every way of fitting the picture
   * then fits the film without them.
   */
  setTrim(on: boolean) {
    if (on === this.trim) return;
    this.trim = on;
    this.showBars();
    this.emit("barschange");
  }

  get bars(): BarsState {
    const verdict = this.finding.verdict;
    if (!this.trim) return "off";
    if (!verdict) return "looking";
    return verdict === "none" || verdict === "unsure" ? verdict : "trimmed";
  }

  get currentTime() {
    if (!this.advancing()) return this.position;
    const t = this.position + ((this.now() - this.positionAt) / 1000) * this.rate;
    return Number.isFinite(this.duration) ? Math.min(t, this.duration) : t;
  }

  set currentTime(t: number) {
    this.position = Math.max(0, t);
    this.positionAt = this.now();
    this.ended = false;
    if (!this.seeking) {
      this.seeking = true;
      this.emit("seeking");
    }
    void this.app.core.invoke("mpv_seek", { time: this.position }).catch(() => {});
  }

  get playbackRate() {
    return this.rate;
  }

  set playbackRate(rate: number) {
    if (rate === this.rate) return;
    this.rebase();
    this.rate = rate;
    this.set("speed", rate);
  }

  get volume() {
    return this.level;
  }

  set volume(level: number) {
    if (level === this.level) return;
    this.level = level;
    this.set("volume", Math.round(level * 100));
    this.emit("volumechange");
  }

  get muted() {
    return this.mute;
  }

  set muted(mute: boolean) {
    if (mute === this.mute) return;
    this.mute = mute;
    this.set("mute", mute);
    this.emit("volumechange");
  }

  /** From here to the end of what mpv holds, as the one range the timeline draws. */
  get buffered() {
    return { length: 1, start: () => this.currentTime, end: () => Math.max(this.cachedTo, this.currentTime) };
  }

  play() {
    if (this.paused) {
      this.rebase();
      this.paused = false;
      this.emit("play");
      if (this.readyState >= HAVE_ENOUGH_DATA && !this.stalled) this.emit("playing");
      this.set("pause", false);
    }
    return Promise.resolve();
  }

  pause() {
    if (this.paused) return;
    this.rebase();
    this.paused = true;
    this.emit("pause");
    this.set("pause", true);
  }

  receive(m: MpvMessage) {
    // Until a seek lands, mpv's reports still carry where it was.
    if (typeof m.time === "number" && !this.seeking) {
      this.position = m.time;
      this.positionAt = this.now();
    }
    switch (m.event ?? m.name) {
      case "time-pos":
        this.emit("timeupdate");
        this.lookForBars();
        break;
      case "width":
      case "height":
        if (typeof m.value === "number") {
          this.size = { ...this.size, [m.name!]: m.value };
          this.showBars();
        }
        break;
      case "pause": {
        const paused = m.value === true;
        if (paused === this.paused) break;
        this.rebase();
        this.paused = paused;
        this.emit(paused ? "pause" : "play");
        if (!paused && this.readyState >= HAVE_ENOUGH_DATA && !this.stalled) this.emit("playing");
        break;
      }
      case "duration":
        if (typeof m.value === "number") {
          this.duration = m.value;
          this.emit("durationchange");
        }
        break;
      case "paused-for-cache": {
        const stalled = m.value === true;
        if (stalled === this.stalled) break;
        this.rebase();
        this.stalled = stalled;
        if (stalled) {
          this.readyState = HAVE_CURRENT_DATA;
          this.emit("waiting");
        } else {
          this.readyState = HAVE_ENOUGH_DATA;
          this.emit("canplay");
          if (!this.paused) this.emit("playing");
        }
        break;
      }
      case "eof-reached":
        if (m.value === true && !this.ended) {
          this.rebase();
          this.ended = true;
          this.paused = true;
          this.emit("pause");
          this.emit("ended");
        } else if (m.value === false) this.ended = false;
        break;
      case "volume":
        if (typeof m.value === "number" && m.value / 100 !== this.level) {
          this.level = m.value / 100;
          this.emit("volumechange");
        }
        break;
      case "mute":
        if (typeof m.value === "boolean" && m.value !== this.mute) {
          this.mute = m.value;
          this.emit("volumechange");
        }
        break;
      case "speed":
        if (typeof m.value === "number") {
          this.rebase();
          this.rate = m.value;
        }
        break;
      case "demuxer-cache-time":
        this.cachedTo = typeof m.value === "number" ? m.value : 0;
        break;
      case "file-loaded":
        this.readyState = HAVE_METADATA;
        this.emit("loadedmetadata");
        this.emit("durationchange");
        // The same film loaded again (a fresh link) is trimmed again from its first picture.
        this.showBars();
        break;
      case "seek":
        if (!this.seeking) {
          this.rebase();
          this.seeking = true;
          this.emit("seeking");
        }
        break;
      // The first picture after loading or a seek is up.
      case "playback-restart": {
        const wasSeeking = this.seeking;
        this.seeking = false;
        if (typeof m.time === "number") this.position = m.time;
        this.positionAt = this.now();
        this.readyState = this.stalled ? HAVE_CURRENT_DATA : HAVE_ENOUGH_DATA;
        if (wasSeeking) this.emit("seeked");
        if (!this.stalled) {
          this.emit("canplay");
          if (!this.paused) this.emit("playing");
        }
        this.emit("timeupdate");
        break;
      }
      case "end-file":
        if (m.reason === "error") this.emit("error");
        break;
      // mpv itself stopped: closed, or crashed.
      case "exit":
        this.emit("error");
        break;
    }
  }

  private advancing() {
    return !this.paused && !this.seeking && !this.stalled && !this.ended && this.readyState >= HAVE_ENOUGH_DATA;
  }

  /** Fixes the counted-on position before something changes how it advances. */
  private rebase() {
    this.position = this.currentTime;
    this.positionAt = this.now();
  }

  /** Every few seconds of film while it plays, until the bars settle, asks mpv how lit the frame showing is. */
  private lookForBars() {
    if (!this.trim || this.finding.verdict || this.looking || !this.advancing()) return;
    const at = this.currentTime;
    if (Math.abs(at - this.lookedAt) < LOOK_EVERY) return;
    this.lookedAt = at;
    this.looking = true;
    const load = this.loads;
    this.app.core
      .invoke<FrameLight>("mpv_frame_light", { level: LIT_LEVEL })
      .then((frame) => {
        // A frame from the file before a load says nothing about this one.
        if (load !== this.loads) return;
        this.failures = 0;
        this.finding = look(this.finding, frame);
        if (!this.finding.verdict) return;
        this.showBars();
        this.emit("barschange");
      })
      .catch(() => {
        if (load !== this.loads || ++this.failures < MAX_FAILURES) return;
        this.finding = { ...this.finding, verdict: "unsure" };
        this.emit("barschange");
      })
      .finally(() => (this.looking = false));
  }

  /** Gives mpv the crop for the file playing now: the bars found, if they're to be trimmed, or none. */
  private showBars() {
    const verdict = this.finding.verdict;
    const { width, height } = this.size;
    // Before mpv has loaded the file, a crop would go to the one before it.
    if (this.readyState === 0) return;
    const crop = this.trim && typeof verdict === "object" && width && height ? cropOf(verdict, width, height) : "";
    if (crop === this.cropped) return;
    this.cropped = crop;
    this.set("file-local-options/video-crop", crop);
  }

  private set(name: string, value: unknown) {
    void this.app.core.invoke("mpv_set", { name, value }).catch(() => {});
  }

  private emit(type: string) {
    this.dispatchEvent(new Event(type));
  }
}

/** The app lets the page set the picture's fit from 0.1.1; an older one would refuse it, so it gets no Picture menu. */
export const mpvFits = () => desktopAtLeast("0.1.1");
/** The app can look at the picture and crop it from 0.1.2, so trimming black bars starts there. */
export const mpvTrims = () => desktopAtLeast("0.1.2");
/** The app lifts the file's own subtitles above the controls from 0.1.6. */
export const mpvLiftsSubtitles = () => desktopAtLeast("0.1.6");
/** The app debands from 0.1.3; an older one would refuse the switch. */
export const mpvDebands = () => desktopAtLeast("0.1.3");
/** The app can start mpv before the file's link is known from 0.1.5. */
export const mpvWarms = () => desktopAtLeast("0.1.5");

/** A switch for the picture, on unless switched off, remembered on this computer. */
function useDeviceSwitch(key: string) {
  const [on, setOn] = useState(() => localStorage.getItem(key) !== "off");
  const set = useCallback(
    (to: boolean) => {
      localStorage.setItem(key, to ? "on" : "off");
      setOn(to);
    },
    [key],
  );
  return [on, set] as const;
}
/** Whether to trim black bars built into films. */
export const useTrimBars = () => useDeviceSwitch("krida.trimBars");
/** Whether mpv evens out colour banding. */
export const useDeband = () => useDeviceSwitch("krida.deband");

/** Where trimming black bars stands in this player's mpv. */
export function useBarsState(video: MpvVideo | null): BarsState {
  return useSyncExternalStore(
    useCallback(
      (changed: () => void) => {
        video?.addEventListener("barschange", changed);
        return () => video?.removeEventListener("barschange", changed);
      },
      [video],
    ),
    () => video?.bars ?? "off",
  );
}

/**
 * mpv for this player in the app, listening while the player is open; null in a browser, and in the app when the
 * stream isn't this account's file (a guest in another account's party plays the room's HLS in the page instead).
 */
export function useMpvVideo(wanted = true) {
  const [video] = useState(() => {
    const app = wanted ? desktopApp() : null;
    return app ? new MpvVideo(app) : null;
  });
  useEffect(() => video?.attach(), [video]);
  return video;
}

/** A link that fails again this soon after the last reload is given up on: the file itself won't play. */
const RELOAD_GAP_MS = 60_000;

/**
 * Plays the room's stream in mpv from where the room is, and stops it when the player closes. The page goes see-through
 * meanwhile, so the picture under it shows. TorBox's links run out after a few hours; one that stops working gets a
 * fresh link and picks up where it was.
 */
export function useDesktopStream({
  video,
  streamId,
  token,
  audio,
  title,
  startAt,
  setFatal,
}: {
  video: MpvVideo | null;
  streamId: Id<"streams">;
  token: string;
  audio: number;
  title: string;
  startAt: () => number;
  setFatal: (error: string | null) => void;
}) {
  const fileLink = useAction(api.desktop.fileLink);
  const audioRef = useRef(audio);
  audioRef.current = audio;
  const titleRef = useRef(title);
  titleRef.current = title;
  const startAtRef = useRef(startAt);
  startAtRef.current = startAt;

  useEffect(() => {
    if (!video) return;
    let alive = true;
    let lastLoad = 0;
    setFatal(null);
    document.documentElement.dataset.desktopVideo = "";
    const play = async (start: number) => {
      lastLoad = Date.now();
      const url = await fileLink({ token, streamId });
      if (!alive) return;
      if (!url) return setFatal("This stream isn’t available anymore.");
      await video.load(url, { start, aid: audioRef.current + 1, title: titleRef.current, film: streamId });
    };
    const fail = () => alive && setFatal("The stream stopped loading.");
    // mpv takes a moment to start; it starts while the link is fetched rather than after.
    if (mpvWarms()) video.warm();
    play(startAtRef.current()).catch(fail);
    const onError = () => {
      if (Date.now() - lastLoad < RELOAD_GAP_MS) return fail();
      const at = video.currentTime;
      const resume = !video.paused;
      play(at)
        .then(() => {
          if (resume) void video.play();
        })
        .catch(fail);
    };
    video.addEventListener("error", onError);
    return () => {
      alive = false;
      video.removeEventListener("error", onError);
      video.stop();
      delete document.documentElement.dataset.desktopVideo;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video, streamId, token]);

  useEffect(() => {
    if (video && video.readyState > 0) video.setAudio(audio + 1);
  }, [video, audio]);
}
