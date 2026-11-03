import { loadYouTube, type YouTubePlayer } from "./youtube";

/**
 * What plays Home's muted trailers. A title's IMDb trailer file plays in a plain <video>: nothing is drawn
 * over it, and it starts in about 0.3 s. Titles without one fall back to YouTube, cropped like Hayase does.
 *
 * Starting a YouTube player costs about a second (a page, its scripts, a handshake), switching what one plays
 * about 0.4 s, so each kind of trailer ("banner", "poster") keeps one player and moves it into whichever slot
 * plays next. `moveBefore` moves a frame without reloading it; browsers without it get a player per trailer.
 */

/** Where a trailer plays from, best first: IMDb's file, then YouTube ids. */
export type TrailerSource = { kind: "file"; url: string } | { kind: "youtube"; id: string };

/** The same few controls over a <video> and a YouTube player. Volume is 0 to 100. */
export type TrailerControls = { play(): void; pause(): void; mute(): void; unMute(): void; setVolume(volume: number): void };

export type TrailerEvents = {
  /** Its controls, once it's loading this trailer. */
  onReady: (controls: TrailerControls) => void;
  /** -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering. Only ever about this trailer. */
  onState: (state: number) => void;
  onError: () => void;
  /** Another trailer took the shared player. */
  onLost: () => void;
};

// Most trailers open on studio logos and a rating card.
const START_SECONDS = 2;
// A shared player nobody has used for this long is let go (it holds a process and tens of MB).
const IDLE_MS = 60_000;
// Taller than the picture by 100 px each way, so YouTube's title bar and logo strip (drawn at the frame's top and
// bottom edges, not the picture's) fall outside the slot, a size container. Only its pause button in the middle,
// for the first 3 s of playback, can't be cropped away.
const FRAME_CLASS =
  "absolute top-1/2 left-1/2 h-[calc(max(100cqh,56.25cqw)+200px)] w-[max(100cqw,177.78cqh)] -translate-1/2 border-0";
const FILE_CLASS = "absolute inset-0 size-full object-cover";

const canMove = typeof Element !== "undefined" && "moveBefore" in Element.prototype;

/** Plays `source` muted inside `slot` until the returned release is called (in a layout effect's cleanup). */
export function playTrailer(kind: string, slot: HTMLElement, source: TrailerSource, events: TrailerEvents) {
  if (source.kind === "file") return playFile(slot, source.url, events);
  return canMove ? playShared(kind, slot, source.id, events) : playOwn(slot, source.id, events);
}

// ---------------------------------------------------------------------------------------------
// IMDb's files

function playFile(slot: HTMLElement, url: string, events: TrailerEvents) {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  // Nothing of the browser's own over it either.
  video.disablePictureInPicture = true;
  video.disableRemotePlayback = true;
  video.className = FILE_CLASS;
  video.src = `${url}#t=${START_SECONDS}`;
  // Released, it goes quiet: pausing it on the way out isn't news for whatever plays next.
  const gone = new AbortController();
  const listen = (type: string, state: number) => video.addEventListener(type, () => events.onState(state), { signal: gone.signal });
  listen("playing", 1);
  listen("pause", 2);
  listen("ended", 0);
  video.addEventListener("error", () => events.onError(), { signal: gone.signal });
  slot.append(video);
  events.onReady({
    // Muted playback is always allowed; a refusal can only be the trailer going away.
    play: () => void video.play().catch(() => {}),
    pause: () => video.pause(),
    mute: () => (video.muted = true),
    unMute: () => (video.muted = false),
    setVolume: (volume) => (video.volume = volume / 100),
  });
  return () => {
    gone.abort();
    video.pause();
    // Stops the download too.
    video.removeAttribute("src");
    video.load();
    video.remove();
  };
}

// ---------------------------------------------------------------------------------------------
// YouTube

type Owner = { events: TrailerEvents; started: boolean };
type Shared = { frame: HTMLIFrameElement; player: YouTubePlayer | null; ready: Promise<YouTubePlayer>; owner: Owner | null; idle?: ReturnType<typeof setTimeout> };

const shared = new Map<string, Shared>();
let parking: HTMLElement | null = null;

const controlsOf = (p: YouTubePlayer): TrailerControls => ({
  play: () => p.playVideo(),
  pause: () => p.pauseVideo(),
  mute: () => p.mute(),
  unMute: () => p.unMute(),
  setVolume: (volume) => p.setVolume(volume),
});

function embed(id = "") {
  const frame = document.createElement("iframe");
  frame.title = "";
  frame.tabIndex = -1;
  frame.allow = "autoplay; encrypted-media";
  // The site sends no referrer at all, and YouTube refuses to play embeds that don't say where they are.
  frame.referrerPolicy = "strict-origin-when-cross-origin";
  frame.className = FRAME_CLASS;
  frame.src =
    `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&mute=1&controls=0&disablekb=1&fs=0&iv_load_policy=3` +
    `&rel=0&playsinline=1&start=${START_SECONDS}&enablejsapi=1&origin=${encodeURIComponent(location.origin)}`;
  return frame;
}

/** Connects YouTube's API to `frame`, passing its events to whoever `owner` says is playing. */
function connect(frame: HTMLIFrameElement, owner: () => Owner | null) {
  return loadYouTube().then(
    (YT) =>
      new Promise<YouTubePlayer>((resolve) => {
        new YT.Player(frame, {
          events: {
            onReady: ({ target }) => resolve(target),
            onStateChange: ({ data }) => {
              const o = owner();
              if (!o) return;
              // A switch reports the old video pausing first; this trailer's own events start at "unstarted".
              if (data === -1) o.started = true;
              if (o.started) o.events.onState(data);
            },
            onError: () => owner()?.events.onError(),
          },
        });
      }),
  );
}

/** Where idle players wait: on the page (a frame can only move within it) but out of sight. */
function park() {
  if (!parking) {
    parking = document.createElement("div");
    parking.setAttribute("aria-hidden", "true");
    parking.style.cssText = "position:fixed;top:0;left:-10000px;width:480px;height:270px;container-type:size;pointer-events:none";
    document.body.append(parking);
  }
  return parking;
}

function sharedPlayer(kind: string) {
  let s = shared.get(kind);
  if (!s) {
    const frame = embed();
    park().append(frame);
    const entry: Shared = { frame, player: null, owner: null, ready: connect(frame, () => entry.owner) };
    entry.ready.then(
      (p) => (entry.player = p),
      () => drop(kind, entry),
    );
    shared.set(kind, (s = entry));
  }
  return s;
}

function drop(kind: string, s: Shared) {
  clearTimeout(s.idle);
  if (shared.get(kind) === s) shared.delete(kind);
  s.player?.destroy();
  s.frame.remove();
}

function idleLater(kind: string, s: Shared) {
  clearTimeout(s.idle);
  s.idle = setTimeout(() => !s.owner && drop(kind, s), IDLE_MS);
}

/** Gets a YouTube player of this kind ready before a trailer needs it, so the first one starts sooner. */
export function warmYouTube(kind: string) {
  if (!canMove) {
    loadYouTube().catch(() => {});
    return;
  }
  const s = sharedPlayer(kind);
  if (!s.owner) idleLater(kind, s);
}

function playShared(kind: string, slot: HTMLElement, id: string, events: TrailerEvents) {
  const s = sharedPlayer(kind);
  clearTimeout(s.idle);
  const previous = s.owner;
  const owner: Owner = { events, started: false };
  s.owner = owner;
  previous?.events.onLost();
  slot.moveBefore(s.frame, null);
  const start = (p: YouTubePlayer) => {
    if (s.owner !== owner) return;
    // The last trailer may have left it unmuted.
    p.mute();
    p.loadVideoById({ videoId: id, startSeconds: START_SECONDS });
    events.onReady(controlsOf(p));
  };
  if (s.player) start(s.player);
  else s.ready.then(start, () => {});
  return () => {
    if (s.owner !== owner) return;
    s.owner = null;
    // Taken off the page with its slot, it has reloaded: start afresh next time.
    if (!s.frame.isConnected) return drop(kind, s);
    // Stopped, it stops loading too.
    s.player?.stopVideo();
    park().moveBefore(s.frame, null);
    idleLater(kind, s);
  };
}

/** A player for one trailer, created in place and destroyed with it. */
function playOwn(slot: HTMLElement, id: string, events: TrailerEvents) {
  const frame = embed(id);
  slot.append(frame);
  let alive = true;
  let player: YouTubePlayer | null = null;
  connect(frame, () => (alive ? { events, started: true } : null)).then(
    (p) => {
      if (!alive) return p.destroy();
      player = p;
      events.onReady(controlsOf(p));
    },
    // Without the API there's no way to know it's playing, so the artwork stays.
    () => {},
  );
  return () => {
    alive = false;
    player?.destroy();
    frame.remove();
  };
}
