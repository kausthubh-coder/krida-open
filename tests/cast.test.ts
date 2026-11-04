import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { castBrowser, castContentType, connectCast, loadCastSdk, type CastSdk, type CastState } from "../src/features/player/cast";
import { CastButton } from "../src/features/player/PlayerControls";

vi.mock("bubli", () => ({ Glass: () => null }));
vi.mock("../src/ui/ui", () => ({ cx: () => "", IconButton: ({ label, children, ...props }: { label: string; children: never }) => createElement("button", { ...props, "aria-label": label }, children), Kbd: () => null, Toggle: () => null }));
vi.mock("../src/ui/artwork", () => ({ TitleArt: () => null }));
vi.mock("../src/features/party", () => ({ mediaLabel: () => "", ReactionPicker: () => null }));
vi.mock("../src/features/player/automatic", () => ({ AUTO_ROWS: [] }));
vi.mock("../src/features/player/chrome", () => ({ CAP: "", CAPSULE: "", capOpen: () => "", capsuleBubble: () => ({}), fade: () => "" }));
vi.mock("../src/features/player/controls", () => ({ MenuLabel: () => null, MenuRow: () => null, Popover: () => null, SubtitleMenu: () => null, Timeline: () => null, Volume: () => null }));
vi.mock("../src/features/player/SpeedChoice", () => ({ SpeedChoice: () => null }));
vi.mock("../src/features/player/touch", () => ({ FITS: [] }));

class Emitter {
  listeners = new Map<string, Set<(event: { sessionState?: string }) => void>>();
  addEventListener(type: string, fn: (event: { sessionState?: string }) => void) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type)!.add(fn); }
  removeEventListener(type: string, fn: (event: { sessionState?: string }) => void) { this.listeners.get(type)?.delete(fn); }
  emit(type: string, event = {}) { this.listeners.get(type)?.forEach((fn) => fn(event)); }
}

function sender(url = "https://stream.example/hls/playlist.m3u8?s=stream&a=1&t=session") {
  const context = Object.assign(new Emitter(), {
    setOptions: vi.fn(), getCastState: () => "AVAILABLE", getCurrentSession: () => session,
    requestSession: vi.fn(async () => {}), endCurrentSession: vi.fn(() => context.emit("session", { sessionState: "ended" })),
  });
  const remote = { currentTime: 42, duration: 300, isPaused: false, isMuted: false, volumeLevel: 0.5, isMediaLoaded: true, playerState: "PLAYING", savedPlayerState: undefined as { currentTime: number; isPaused: boolean } | undefined };
  const controller = Object.assign(new Emitter(), { playOrPause: vi.fn(() => { remote.isPaused = !remote.isPaused; }), seek: vi.fn(), setVolumeLevel: vi.fn(), muteOrUnmute: vi.fn(() => { remote.isMuted = !remote.isMuted; }) });
  const session = { loadMedia: vi.fn(async (_request: object) => {}) };
  const sdk = {
    framework: {
      CastContext: { getInstance: () => context }, RemotePlayer: function () { return remote; }, RemotePlayerController: function () { return controller; },
      CastContextEventType: { CAST_STATE_CHANGED: "availability", SESSION_STATE_CHANGED: "session" }, RemotePlayerEventType: { ANY_CHANGE: "remote" },
      SessionState: { SESSION_STARTED: "started", SESSION_RESUMED: "resumed", SESSION_ENDED: "ended" }, CastState: { NO_DEVICES_AVAILABLE: "NONE" },
    },
    media: {
      MediaInfo: class { contentId: string; contentType: string; constructor(id: string, type: string) { this.contentId = id; this.contentType = type; } },
      GenericMediaMetadata: class {}, LoadRequest: class { media: object; constructor(media: object) { this.media = media; } }, DEFAULT_MEDIA_RECEIVER_APP_ID: "default",
    }, autoJoinPolicy: "origin",
  } as unknown as CastSdk;
  const local = Object.assign(new EventTarget(), { currentTime: 42, paused: false, pause: vi.fn(), play: vi.fn(async () => {}) });
  let state: CastState | null = null;
  const resume = vi.fn();
  const connection = connectCast(sdk, local as unknown as HTMLVideoElement, () => ({ url, contentType: castContentType(url), title: "Dune", poster: "https://art.example/poster.jpg" }), (next) => { state = next; }, resume);
  return { connection, context, controller, remote, session, local, resume, state: () => state! };
}

describe("Cast sender", () => {
  it("does not load Google's SDK outside Chrome or inside a native app", async () => {
    try {
      vi.stubGlobal("window", {});
      vi.stubGlobal("navigator", { userAgent: "Firefox/140" });
      expect(await loadCastSdk()).toBe(null);
      vi.stubGlobal("navigator", { userAgent: "Chrome/143.0" });
      vi.stubGlobal("window", { KridaAndroid: {} });
      expect(await loadCastSdk()).toBe(null);
      vi.stubGlobal("window", { kridaDesktop: {} });
      expect(await loadCastSdk()).toBe(null);
    } finally { vi.unstubAllGlobals(); }
  });

  it("loads Google's sender lazily and stays unavailable if the SDK cannot start", async () => {
    const host: { __onGCastApiAvailable?: (available: boolean) => void } = {};
    const script = { dataset: {}, src: "", async: false };
    const append = vi.fn();
    try {
      vi.stubGlobal("window", host);
      vi.stubGlobal("navigator", { userAgent: "Chrome/143.0" });
      vi.stubGlobal("document", { querySelector: () => null, createElement: () => script, head: { append } });
      const loading = loadCastSdk();
      expect(script.src).toBe("https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1");
      expect(append).toHaveBeenCalledWith(script);
      host.__onGCastApiAvailable!(false);
      expect(await loading).toBe(null);
    } finally { vi.unstubAllGlobals(); }
  });

  it("hides the button until the SDK reports a receiver", () => {
    expect(renderToStaticMarkup(createElement(CastButton, { party: false }))).toBe("");
    const s = sender();
    const props = { ...s.state(), toggle: vi.fn() };
    expect(renderToStaticMarkup(createElement(CastButton, { cast: { ...props, available: false }, party: false }))).toBe("");
    expect(renderToStaticMarkup(createElement(CastButton, { cast: props, party: false }))).toContain('aria-label="Cast to a device"');
    expect(renderToStaticMarkup(createElement(CastButton, { cast: props, party: true }))).toContain('aria-label="Casting is unavailable in a party"');
    s.connection.dispose();
  });

  it.each([
    ["https://stream.example/hls/playlist.m3u8?s=stream&a=1&t=session", "application/x-mpegURL"],
    ["https://file.example/movie.mp4?key=owner", "video/mp4"],
    ["https://file.example/movie.webm", "video/webm"],
  ])("loads the exact media URL, metadata and current position: %s", async (url, contentType) => {
    const s = sender(url);
    await s.connection.toggle();
    expect(s.session.loadMedia).toHaveBeenCalledWith({ media: { contentId: url, contentType, metadata: { title: "Dune", images: [{ url: "https://art.example/poster.jpg" }] } }, currentTime: 42, autoplay: true });
    expect(s.state().active).toBe(true);
    expect(s.local.pause).toHaveBeenCalledTimes(1);
    s.connection.dispose();
  });

  it("shows the receiver's state and sends transport commands to it", async () => {
    const s = sender();
    await s.connection.toggle();
    const video = s.state().video!;
    const times: number[] = [];
    video.addEventListener("timeupdate", () => times.push(video.currentTime));
    s.remote.currentTime = 88;
    s.remote.isPaused = true;
    s.controller.emit("remote");
    expect(times).toEqual([88]);
    expect(video.paused).toBe(true);
    expect(video.duration).toBe(300);
    await video.play();
    expect(s.remote.isPaused).toBe(false);
    video.pause();
    expect(s.remote.isPaused).toBe(true);
    video.currentTime = 95;
    expect(s.remote.currentTime).toBe(95);
    expect(s.controller.seek).toHaveBeenCalledTimes(1);
    video.volume = 0.3;
    expect(s.remote.volumeLevel).toBe(0.3);
    expect(s.controller.setVolumeLevel).toHaveBeenCalledTimes(1);
    video.muted = true;
    expect(s.remote.isMuted).toBe(true);
    s.connection.dispose();
  });

  it("stopping resumes locally at the receiver's final position", async () => {
    const s = sender();
    await s.connection.toggle();
    s.remote.currentTime = 123;
    s.controller.emit("remote");
    await s.connection.toggle();
    expect(s.local.currentTime).toBe(123);
    expect(s.local.play).toHaveBeenCalledTimes(1);
    expect(s.resume).toHaveBeenCalledWith(123, true);
    expect(s.state().active).toBe(false);
    s.connection.dispose();
  });

  it("preserves a paused receiver's saved position on disconnection", async () => {
    const s = sender();
    await s.connection.toggle();
    s.remote.savedPlayerState = { currentTime: 149, isPaused: true };
    s.context.emit("session", { sessionState: "ended" });
    expect(s.local.currentTime).toBe(149);
    expect(s.local.play).toHaveBeenCalledTimes(0);
    expect(s.resume).toHaveBeenCalledWith(149, false);
    s.connection.dispose();
  });

  it("leaves local playback alone when the receiver refuses the stream", async () => {
    const s = sender();
    s.session.loadMedia.mockRejectedValueOnce(new Error("load failed"));
    await s.connection.toggle();
    expect(s.state().active).toBe(false);
    expect(s.state().error).toBe("Couldn’t play on the Cast device. Try another source.");
    expect(s.local.pause).toHaveBeenCalledTimes(0);
    s.connection.dispose();
  });

  it("only offers the sender to Chrome outside native apps", () => {
    expect(castBrowser("Chrome/143.0 Safari/537.36", false)).toBe(true);
    expect(castBrowser("Chrome/143.0 Safari/537.36", true)).toBe(false);
    expect(castBrowser("Android; wv) Chrome/143.0", false)).toBe(false);
    expect(castBrowser("Firefox/140", false)).toBe(false);
    expect(castBrowser("Chrome/143.0 Edg/143.0", false)).toBe(false);
  });
});
