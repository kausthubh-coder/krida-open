import { useEffect, useRef, useState } from "react";

type Events = { addEventListener(type: string, listener: (event: { sessionState?: string }) => void): void; removeEventListener(type: string, listener: (event: { sessionState?: string }) => void): void };
type Remote = {
  currentTime: number; duration: number; isPaused: boolean; isMuted: boolean; volumeLevel: number;
  isMediaLoaded: boolean; playerState: string; savedPlayerState?: { currentTime: number; isPaused: boolean };
};
type Controller = Events & { playOrPause(): void; seek(): void; setVolumeLevel(): void; muteOrUnmute(): void };
type Session = { loadMedia(request: Load): Promise<unknown> };
type Load = { currentTime: number; autoplay: boolean };
export type CastSdk = {
  framework: {
    CastContext: { getInstance(): Events & {
      setOptions(options: object): void; getCastState(): string; getCurrentSession(): Session | null;
      requestSession(): Promise<unknown>; endCurrentSession(stop: boolean): void;
    } };
    RemotePlayer: new () => Remote;
    RemotePlayerController: new (player: Remote) => Controller;
    CastContextEventType: { CAST_STATE_CHANGED: string; SESSION_STATE_CHANGED: string };
    RemotePlayerEventType: { ANY_CHANGE: string };
    SessionState: { SESSION_STARTED: string; SESSION_RESUMED: string; SESSION_ENDED: string };
    CastState: { NO_DEVICES_AVAILABLE: string };
  };
  media: {
    MediaInfo: new (url: string, type: string) => { metadata?: { title: string; images: { url: string }[] } };
    GenericMediaMetadata: new () => { title: string; images: { url: string }[] };
    LoadRequest: new (info: object) => Load;
    DEFAULT_MEDIA_RECEIVER_APP_ID: string;
  };
  autoJoinPolicy: string;
};

type CastWindow = Window & {
  cast?: { framework: CastSdk["framework"] };
  chrome?: { cast?: { media: CastSdk["media"]; AutoJoinPolicy: { ORIGIN_SCOPED: string } } };
  __onGCastApiAvailable?: (available: boolean) => void;
  KridaAndroid?: unknown; __TAURI_INTERNALS__?: unknown;
  kridaDesktop?: unknown;
};

export function castBrowser(userAgent: string, native: boolean) {
  return !native && /Chrome\//.test(userAgent) && !/Edg\/|OPR\/|; wv\)/.test(userAgent);
}

/** Called only by the mounted web player. SDK failure leaves normal playback alone. */
export function loadCastSdk(): Promise<CastSdk | null> {
  const host = window as CastWindow;
  if (!castBrowser(navigator.userAgent, !!host.KridaAndroid || !!host.__TAURI_INTERNALS__ || !!host.kridaDesktop)) return Promise.resolve(null);
  const read = (): CastSdk | null => host.cast?.framework && host.chrome?.cast
    ? { framework: host.cast.framework, media: host.chrome.cast.media, autoJoinPolicy: host.chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED }
    : null;
  if (read()) return Promise.resolve(read());
  return new Promise((resolve) => {
    const previous = host.__onGCastApiAvailable;
    host.__onGCastApiAvailable = (available) => { previous?.(available); resolve(available ? read() : null); };
    let script = document.querySelector<HTMLScriptElement>("script[data-krida-cast]");
    if (!script) {
      script = document.createElement("script");
      script.dataset.kridaCast = "true";
      script.src = "https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1";
      script.async = true;
      script.onerror = () => resolve(null);
      document.head.append(script);
    }
  });
}

export type CastMedia = { url: string; contentType: string; title: string; poster?: string };
export function castContentType(url: string) {
  const path = url.split(/[?#]/)[0].toLowerCase();
  return path.endsWith(".m3u8") ? "application/x-mpegURL" : path.endsWith(".webm") ? "video/webm" : path.endsWith(".mkv") ? "video/x-matroska" : "video/mp4";
}

/** The same small video interface the timeline, progress and transport already use. */
export class CastVideo extends EventTarget {
  readonly remote: Remote;
  private controller: Controller;
  playbackRate = 1;
  seeking = false;
  buffered = { length: 0, start: () => 0, end: () => 0 };
  constructor(remote: Remote, controller: Controller) { super(); this.remote = remote; this.controller = controller; }
  get currentTime() { return this.remote.currentTime; }
  set currentTime(time: number) {
    this.remote.currentTime = Math.max(0, time);
    this.dispatchEvent(new Event("seeking"));
    this.controller.seek();
  }
  get duration() { return this.remote.duration; }
  get paused() { return this.remote.isPaused; }
  get ended() { return this.remote.playerState === "IDLE" && this.currentTime >= this.duration && this.duration > 0; }
  get readyState() { return this.remote.isMediaLoaded ? 4 : 0; }
  get volume() { return this.remote.volumeLevel; }
  set volume(value: number) { this.remote.volumeLevel = Math.max(0, Math.min(1, value)); this.controller.setVolumeLevel(); }
  get muted() { return this.remote.isMuted; }
  set muted(value: boolean) { if (value !== this.muted) this.controller.muteOrUnmute(); }
  async play() { if (this.paused) this.controller.playOrPause(); }
  pause() { if (!this.paused) this.controller.playOrPause(); }
  update() {
    const ready = this.remote.isMediaLoaded && this.remote.playerState !== "BUFFERING";
    const events = ["timeupdate", "durationchange", "volumechange", this.paused ? "pause" : "play"];
    if (ready) events.push("loadedmetadata", "canplay", "seeked", ...(this.paused ? [] : ["playing"]));
    else events.push("waiting");
    for (const type of events) {
      this.dispatchEvent(new Event(type));
    }
    if (this.ended) this.dispatchEvent(new Event("ended"));
  }
}

export type CastState = { available: boolean; active: boolean; connecting: boolean; error: string | null; video: CastVideo | null };
const initial: CastState = { available: false, active: false, connecting: false, error: null, video: null };

export function connectCast(sdk: CastSdk, local: HTMLVideoElement, media: () => CastMedia | null, changed: (state: CastState) => void, resume: (time: number, playing: boolean) => void) {
  const { framework: f } = sdk;
  const context = f.CastContext.getInstance();
  context.setOptions({ receiverApplicationId: sdk.media.DEFAULT_MEDIA_RECEIVER_APP_ID, autoJoinPolicy: sdk.autoJoinPolicy });
  const remote = new f.RemotePlayer();
  const controller = new f.RemotePlayerController(remote);
  const video = new CastVideo(remote, controller);
  let state = { ...initial };
  let disposed = false;
  let generation = 0;
  let lastTime = local.currentTime;
  const publish = (patch: Partial<CastState>) => { state = { ...state, ...patch }; if (!disposed) changed(state); };
  const availability = () => publish({ available: context.getCastState() !== f.CastState.NO_DEVICES_AVAILABLE });
  const pauseLocal = () => { if (state.active) local.pause(); };
  const update = () => {
    if (!state.active) return;
    if (remote.isMediaLoaded) lastTime = remote.currentTime;
    video.update();
    publish({});
  };
  const finish = (restore: boolean) => {
    generation++;
    if (!state.active) { publish({ connecting: false }); return; }
    const time = remote.savedPlayerState?.currentTime ?? (remote.isMediaLoaded ? remote.currentTime : lastTime);
    const playing = !(remote.savedPlayerState?.isPaused ?? remote.isPaused);
    if (restore) {
      local.currentTime = time;
      resume(time, playing);
    }
    publish({ active: false, connecting: false, video: null });
    if (restore && playing) void local.play().catch(() => publish({ error: "Press Play to continue here." }));
  };
  const load = async () => {
    const session = context.getCurrentSession();
    const item = media();
    if (!session || !item) { publish({ connecting: false, error: "Wait for the stream to load before casting." }); return; }
    const current = ++generation;
    publish({ connecting: true, error: null });
    const info = new sdk.media.MediaInfo(item.url, item.contentType);
    const metadata = new sdk.media.GenericMediaMetadata();
    metadata.title = item.title;
    metadata.images = item.poster ? [{ url: item.poster }] : [];
    info.metadata = metadata;
    const request = new sdk.media.LoadRequest(info);
    request.currentTime = local.currentTime;
    request.autoplay = !local.paused;
    lastTime = local.currentTime;
    try {
      await session.loadMedia(request);
      if (disposed || current !== generation) return;
      local.pause();
      publish({ active: true, connecting: false, video });
      setTimeout(update, 0);
    } catch {
      if (current === generation) publish({ connecting: false, error: "Couldn’t play on the Cast device. Try another source." });
    }
  };
  const onSession = (event: { sessionState?: string }) => {
    if (event.sessionState === f.SessionState.SESSION_STARTED || event.sessionState === f.SessionState.SESSION_RESUMED) void load();
    if (event.sessionState === f.SessionState.SESSION_ENDED) finish(!disposed);
  };
  context.addEventListener(f.CastContextEventType.CAST_STATE_CHANGED, availability);
  context.addEventListener(f.CastContextEventType.SESSION_STATE_CHANGED, onSession);
  controller.addEventListener(f.RemotePlayerEventType.ANY_CHANGE, update);
  local.addEventListener("play", pauseLocal);
  availability();
  return {
    async toggle() {
      if (state.active) { context.endCurrentSession(true); return; }
      if (state.connecting) return;
      if (context.getCurrentSession()) { await load(); return; }
      publish({ connecting: true, error: null });
      try { await context.requestSession(); } catch { publish({ connecting: false }); }
    },
    dispose() {
      disposed = true;
      if (state.active || state.connecting) context.endCurrentSession(true);
      generation++;
      context.removeEventListener(f.CastContextEventType.CAST_STATE_CHANGED, availability);
      context.removeEventListener(f.CastContextEventType.SESSION_STATE_CHANGED, onSession);
      controller.removeEventListener(f.RemotePlayerEventType.ANY_CHANGE, update);
      local.removeEventListener("play", pauseLocal);
    },
  };
}

export function useCast(local: HTMLVideoElement | null, enabled: boolean, media: () => CastMedia | null, resume: (time: number, playing: boolean) => void) {
  const [state, setState] = useState(initial);
  const latest = useRef({ media, resume });
  useEffect(() => { latest.current = { media, resume }; }, [media, resume]);
  const connection = useRef<ReturnType<typeof connectCast> | null>(null);
  useEffect(() => {
    if (!local || !enabled) return;
    let alive = true;
    void loadCastSdk().then((sdk) => {
      if (alive && sdk) connection.current = connectCast(sdk, local, () => latest.current.media(), setState, (time, playing) => latest.current.resume(time, playing));
    });
    return () => { alive = false; connection.current?.dispose(); connection.current = null; setState(initial); };
  }, [local, enabled]);
  return { ...state, toggle: () => void connection.current?.toggle() };
}
