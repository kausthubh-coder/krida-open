/*
 * Which video files a browser plays straight from a link. TorBox streams don't care (TorBox converts every file to HLS);
 * another debrid service's files and an addon's plain web links are played as they are, and a browser plays only MP4,
 * WebM and HLS (an .m3u8 playlist, through hls.js), with the picture and sound formats it has. MKV, AVI and TS play in
 * Krida for Mac and Windows (mpv) or an external player.
 */

const TYPES: Record<string, string> = { mp4: "mp4", webm: "webm", "x-matroska": "mkv", quicktime: "mp4", "x-msvideo": "avi", mp2t: "ts" };

/** A file's container from the type its server gave, or the end of its link or name: the first hint that says. */
export function containerOf(...hints: (string | null | undefined)[]): string | undefined {
  for (const hint of hints) {
    if (!hint) continue;
    if (/^(application|audio)\/(vnd\.apple\.mpegurl|x-mpegurl|mpegurl)\b/i.test(hint)) return "hls";
    const type = /^video\/(mp4|webm|x-matroska|quicktime|x-msvideo|mp2t)\b/i.exec(hint)?.[1]?.toLowerCase();
    if (type) return TYPES[type];
    const ext = /\.(mp4|m4v|mov|webm|mkv|avi|ts|m2ts|wmv|m3u8)$/i.exec(decodeURIComponentSafe(hint.split(/[?#]/)[0]))?.[1]?.toLowerCase();
    if (ext) return ext === "m4v" || ext === "mov" ? "mp4" : ext === "m2ts" ? "ts" : ext === "m3u8" ? "hls" : ext;
  }
  return undefined;
}

function decodeURIComponentSafe(s: string) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Whether browsers play this container at all (HLS through hls.js). Codecs inside it still have to be ones the browser has. */
export const isBrowserContainer = (container: string | undefined) => container === "mp4" || container === "webm" || container === "hls";

/** "an MKV file", "a TS file": letters said with a vowel sound first take "an". */
export const fileKind = (container: string | undefined) =>
  container ? `${/^[aefhilmnorsx]/i.test(container) ? "an" : "a"} ${container.toUpperCase()} file` : "a file";
