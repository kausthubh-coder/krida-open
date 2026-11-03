/** The bits of YouTube's iframe API that Krida uses. */
export type YouTubePlayer = {
  mute(): void;
  unMute(): void;
  /** 0 to 100. */
  setVolume(volume: number): void;
  playVideo(): void;
  pauseVideo(): void;
  /** Stops and stops loading. */
  stopVideo(): void;
  /** Switches to another video and plays it. */
  loadVideoById(options: { videoId: string; startSeconds?: number }): void;
  destroy(): void;
};

type YouTubeApi = {
  Player: new (
    frame: HTMLIFrameElement,
    options: {
      events: {
        onReady?: (event: { target: YouTubePlayer }) => void;
        /** -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued. */
        onStateChange?: (event: { data: number; target: YouTubePlayer }) => void;
        onError?: (event: { data: number }) => void;
      };
    },
  ) => YouTubePlayer;
};

declare global {
  interface Window {
    YT?: YouTubeApi & { loaded?: number };
    onYouTubeIframeAPIReady?: () => void;
  }
}

let loading: Promise<YouTubeApi> | null = null;

/** Loads YouTube's iframe API once, on first use, so title pages that never open a trailer don't pay for it. */
export function loadYouTube() {
  if (window.YT?.loaded) return Promise.resolve(window.YT);
  loading ??= new Promise<YouTubeApi>((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      resolve(window.YT!);
    };
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.async = true;
    script.onerror = () => {
      // Let the next trailer try again (a blocker or a flaky connection).
      loading = null;
      script.remove();
      reject(new Error("YouTube's player didn't load"));
    };
    document.head.append(script);
  });
  return loading;
}

/** What to tell someone when YouTube refuses a video (its iframe API error codes). */
export function youtubeError(code: number) {
  if (code === 101 || code === 150) return "YouTube only lets it play on YouTube.";
  if (code === 100) return "It’s been taken down from YouTube.";
  return "YouTube couldn’t play it.";
}
