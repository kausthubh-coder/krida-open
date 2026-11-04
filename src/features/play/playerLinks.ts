// Handing a file to another player: the apps a device can open a link in by its URL scheme, and a playlist file for
// any player (VLC and mpv on a computer open .m3u files, and Windows has no scheme they all answer to).

export type Platform = "ios" | "android" | "mac" | "windows" | "other";

/** The device this page runs on, from what the browser says it is. An iPad reports a Mac with a touch screen. */
export function platformOf(userAgent: string, touchPoints = 0): Platform {
  if (/iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && touchPoints > 1)) return "ios";
  if (/Android/.test(userAgent)) return "android";
  if (/Macintosh|Mac OS X/.test(userAgent)) return "mac";
  if (/Windows/.test(userAgent)) return "windows";
  return "other";
}

/** An app that opens a link handed to it, and the address that hands it over. */
export type PlayerApp = { name: string; href: string };

/** Android's way to hand a link to an app: an intent, to one package or to whichever the person picks. */
function intent(url: string, pkg?: string) {
  const separator = url.indexOf("://");
  const scheme = url.slice(0, separator);
  const rest = url.slice(separator + 3);
  return `intent://${rest}#Intent;scheme=${scheme};type=video/*;${pkg ? `package=${pkg};` : ""}end`;
}

/** The players this device can open `url` in directly, best known first. Windows and others have none: the playlist. */
export function playerApps(url: string, platform: Platform): PlayerApp[] {
  const enc = encodeURIComponent(url);
  switch (platform) {
    case "ios":
      return [
        { name: "VLC", href: `vlc-x-callback://x-callback-url/stream?url=${enc}` },
        { name: "Infuse", href: `infuse://x-callback-url/play?url=${enc}` },
        // Outplayer takes the link as it is after its scheme, so only what a link can't hold (a space) is escaped.
        { name: "Outplayer", href: `outplayer://${url.replace(/ /g, "%20")}` },
        { name: "SenPlayer", href: `senplayer://x-callback-url/play?url=${enc}` },
      ];
    case "android":
      return [
        { name: "VLC", href: intent(url, "org.videolan.vlc") },
        { name: "MX Player", href: intent(url, "com.mxtech.videoplayer.ad") },
        { name: "MX Player Pro", href: intent(url, "com.mxtech.videoplayer.pro") },
        { name: "Just Player", href: intent(url, "com.brouken.player") },
        { name: "Another app", href: intent(url) },
      ];
    case "mac":
      return [
        { name: "IINA", href: `iina://weblink?url=${enc}` },
        { name: "Infuse", href: `infuse://x-callback-url/play?url=${enc}` },
      ];
    default:
      return [];
  }
}

/** A one-film playlist: what a player opens when the file is double-clicked. */
export function m3u(url: string, title: string) {
  return `#EXTM3U\n#EXTINF:-1,${title.replace(/[\r\n]+/g, " ")}\n${url}\n`;
}

/** A file name for the playlist: the title, without what file systems refuse. */
export const playlistName = (title: string) => `${title.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim() || "Krida"}.m3u`;
