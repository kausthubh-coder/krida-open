// Where the room's stream plays on this device: TorBox's HLS in the page, mpv in the app, another debrid service's file
// or an addon's plain web video straight in the page, or, when nothing here can play it, somewhere else (the desktop
// app, an external player).
import { fileKind, isBrowserContainer } from "../../../shared/formats";

export type PlayMode =
  /**
   * HLS in the page's <video>, through the room's playlist route: TorBox's (every browser, and a guest in the app from
   * another account), or an addon's own .m3u8, which the route sends the player to.
   */
  | "hls"
  /** The file itself in mpv: Krida for Windows and Mac, for the stream's own account. */
  | "mpv"
  /** A file played from its link in the page's <video> (another service's, or a plain web video): MP4 and WebM the browser has codecs for. */
  | "file"
  /** Nothing here plays it: the person is offered the desktop app and external players instead. */
  | "elsewhere";

/** Why a file plays elsewhere: its container, its sound or its picture, or that it's another account's file. */
export type ElsewhereWhy = "format" | "sound" | "picture" | "account";

/** What the room says about its stream (rooms.get). */
export type StreamFacts = {
  videoCodec?: string;
  /** A file played from its link (another debrid service's, or a plain web video): its container and sound formats, from its link and its listing. */
  direct?: { container?: string; audio: string[] };
  /** Whether this profile may have the file itself (desktop.fileLink). Unset from servers before it. */
  ownFile?: boolean;
};

/** Sound no browser plays. */
const NO_BROWSER_SOUND = /truehd|dts/i;
/** Dolby Digital and Dolby Digital Plus: Safari and Edge play them, Chrome and Firefox don't. */
const DOLBY_SOUND = /^(dd\+?|e?-?ac-?3|atmos)$/i;

/**
 * How this device plays the stream. `app` is Krida for Windows or Mac; `canPlay` asks the browser about a MIME type
 * with codecs (HTMLMediaElement.canPlayType), true for "probably" or "maybe".
 */
export function playsIn(stream: StreamFacts, { app, canPlay }: { app: boolean; canPlay: (type: string) => boolean }): { mode: PlayMode; why?: ElsewhereWhy } {
  if (!stream.direct) return { mode: app && stream.ownFile !== false ? "mpv" : "hls" };
  if (stream.ownFile === false) return { mode: "elsewhere", why: "account" };
  if (app) return { mode: "mpv" };
  const { container, audio } = stream.direct;
  if (!isBrowserContainer(container)) return { mode: "elsewhere", why: "format" };
  if (audio.some((a) => NO_BROWSER_SOUND.test(a))) return { mode: "elsewhere", why: "sound" };
  if (audio.some((a) => DOLBY_SOUND.test(a)) && !canPlay('audio/mp4; codecs="ec-3"') && !canPlay('audio/mp4; codecs="ac-3"'))
    return { mode: "elsewhere", why: "sound" };
  const codec = stream.videoCodec ?? "";
  if (/hevc|265/i.test(codec) && !canPlay('video/mp4; codecs="hvc1.1.6.L93.B0"')) return { mode: "elsewhere", why: "picture" };
  if (/av1/i.test(codec) && !canPlay('video/mp4; codecs="av01.0.08M.08"')) return { mode: "elsewhere", why: "picture" };
  return { mode: container === "hls" ? "hls" : "file" };
}

/** The browser's own answer, from a <video> made for asking. */
export function browserCanPlay(type: string) {
  const answer = document.createElement("video").canPlayType(type);
  return answer === "probably" || answer === "maybe";
}

/** Why this browser can't play the file, in a sentence. */
export function whyElsewhere(why: ElsewhereWhy, stream: { videoCodec?: string; direct?: { container?: string; audio: string[] } }) {
  const container = stream.direct?.container;
  switch (why) {
    case "format":
      return container ? `This copy is ${fileKind(container)}, which browsers can’t play.` : "Browsers can’t play this kind of file.";
    case "sound":
      return `Its sound (${(stream.direct?.audio ?? []).join(", ")}) is a kind this browser can’t play.`;
    case "picture":
      return `Its picture (${stream.videoCodec}) is a kind this browser can’t play.`;
    case "account":
      return "This file comes from the host’s own debrid service, so it plays only on their screens.";
  }
}
