export type SourceInfo = {
  addon: string;
  cached: boolean;
  resolution?: string;
  quality?: string;
  codec?: string;
  tenBit: boolean;
  hdr: string[];
  audio: string[];
  /** Channel layouts across the file's audio tracks, e.g. ["2.0", "5.1"]. */
  channels: string[];
  seeders?: number;
  indexer?: string;
  group?: string;
  service?: string;
  languages: string[];
  subtitles: string[];
  /** Size of this episode's file. Unknown when only the size of a season pack is listed. */
  size?: number;
  /** Size of the season pack the file comes from. */
  packSize?: number;
  /** Megabits per second of the file itself; never derived from a pack. */
  bitrate?: number;
  filename?: string;
  /** Folder path inside a pack, when the file comes from one. */
  path?: string;
  upscale: boolean;
};

const first = (text: string, pairs: [RegExp, string][]) => pairs.find(([re]) => re.test(text))?.[1];
const UNITS = { TB: 1e12, GB: 1e9, MB: 1e6 } as const;
const MARKS = "🎥🎞🏷📡📺🎧🔊📦👥🔍🌎📝📁";

/** The value after one of AIOStreams' field emoji, up to the next field or the end of the line. */
function field(description: string, mark: string) {
  const start = description.indexOf(mark);
  if (start === -1) return undefined;
  let value = "";
  for (const ch of description.slice(start + mark.length).replace(/^️/u, "")) {
    if (ch === "\n" || MARKS.includes(ch)) break;
    value += ch;
  }
  return value.trim() || undefined;
}
const list = (value: string | undefined) =>
  value
    ? value
        .split("|")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

/**
 * Reads one AIOStreams result. The description carries labelled fields (🎥 quality, 🌎 languages, 📝 subtitles,
 * 📦 sizes…); the name and filename fill in whatever a formatter left out.
 */
/** Flags Torrentio and Comet put on a release for its languages, by their two-letter country. */
const FLAG_LANGUAGES: Record<string, string> = {
  GB: "English", US: "English", ES: "Spanish", MX: "Spanish", FR: "French", DE: "German", IT: "Italian", PT: "Portuguese",
  BR: "Portuguese", IN: "Hindi", JP: "Japanese", KR: "Korean", CN: "Chinese", TW: "Chinese", SA: "Arabic", RU: "Russian",
  TR: "Turkish", PL: "Polish", NL: "Dutch", UA: "Ukrainian", CZ: "Czech", HU: "Hungarian", GR: "Greek", RO: "Romanian",
  SE: "Swedish", DK: "Danish", NO: "Norwegian", FI: "Finnish", IL: "Hebrew", TH: "Thai", VN: "Vietnamese", ID: "Indonesian",
};

/**
 * A release's languages: AIOStreams' 🌎 field, else the flags other addons draw (🇬🇧 / 🇮🇹), with their "Multi Audio" and
 * "Dual Audio" as the groups the source sheet knows.
 */
function languagesOf(description: string): string[] {
  const named = list(field(description, "🌎"));
  if (named.length) return named;
  const out = new Set<string>();
  for (const [flag] of description.matchAll(/[\u{1F1E6}-\u{1F1FF}]{2}/gu)) {
    const country = [...flag].map((c) => String.fromCharCode(c.codePointAt(0)! - 0x1f1e6 + 65)).join("");
    const language = FLAG_LANGUAGES[country];
    if (language) out.add(language);
  }
  if (/\bmulti[ .-]?audio\b/i.test(description)) out.add("Multi");
  if (/\bdual[ .-]?audio\b/i.test(description)) out.add("Dual Audio");
  return [...out];
}

export function parseSource(
  name: string,
  description: string,
  filename: string | undefined,
  size: number | undefined,
): SourceInfo {
  const path = field(description, "📁");
  const base = (filename ?? path?.split("/").pop() ?? "").trim();
  const text = `${name}\n${description}\n${base}`;
  const inPack = !!path?.includes("/");

  const resolution = first(name, [
    [/\b(2160p|4k|uhd)\b/i, "2160p"],
    [/\b1440p\b/i, "1440p"],
    [/\b1080p\b/i, "1080p"],
    [/\b720p\b/i, "720p"],
    [/\b(576p|480p|sd)\b/i, "SD"],
  ]) ??
    first(base, [
      [/\b(2160p|4k|uhd|3840x2160)\b/i, "2160p"],
      [/\b(1080p|1920x1080)\b/i, "1080p"],
      [/\b(720p|1280x720)\b/i, "720p"],
      [/\b(576p|480p)\b/i, "SD"],
    ]);

  const qualityText = `${field(description, "🎥") ?? ""} ${base}`;
  const quality = first(qualityText, [
    [/remux/i, "Remux"],
    [/blu-?ray|bdrip|brrip|\bbd\b/i, "BluRay"],
    [/web-?dl/i, "WEB-DL"],
    [/web-?rip/i, "WEBRip"],
    [/\bweb\b/i, "WEB"],
    [/hdrip/i, "HDRip"],
    [/hdtv/i, "HDTV"],
    [/dvd/i, "DVD"],
    [/\b(cam|hdcam|telesync|hdts)\b/i, "CAM"],
  ]);
  const codec = first(`${field(description, "🎞") ?? ""} ${base}`, [
    [/\b(hevc|x265|h\.?265)\b/i, "HEVC"],
    [/\bav1\b/i, "AV1"],
    [/\bvp9\b/i, "VP9"],
    [/\b(avc|x264|h\.?264)\b/i, "H.264"],
  ]);

  const visual = list(field(description, "📺"));
  const tenBit = visual.includes("10bit") || /\b(hi10p?|ma10p?|10.?bits?)\b/i.test(base);
  const hdr: string[] = [];
  if (visual.includes("DV") || /\b(dv|dovi|dolby.?vision)\b/i.test(base)) hdr.push("DV");
  if (visual.includes("HDR10+") || /hdr10\+|hdr10plus/i.test(base)) hdr.push("HDR10+");
  else if (visual.some((v) => /^HDR/.test(v)) || /\bhdr(10)?\b/i.test(base)) hdr.push("HDR");
  // HLG, broadcasters' HDR, is HDR to the browser too.
  if (hdr.length === 0 && (visual.includes("HLG") || /\bhlg\b/i.test(base))) hdr.push("HLG");

  const audio = list(field(description, "🎧")).map((a) => (a === "OPUS" ? "Opus" : a));
  if (audio.length === 0) {
    if (/truehd/i.test(text)) audio.push("TrueHD");
    if (/dts-?hd|dts-?x/i.test(text)) audio.push("DTS-HD");
    else if (/\bdts\b/i.test(text)) audio.push("DTS");
    if (/dd\+|ddp|e-?ac-?3/i.test(text)) audio.push("DD+");
    else if (/\b(dd|ac-?3)\b/i.test(text)) audio.push("DD");
    if (/\bflac\b/i.test(text)) audio.push("FLAC");
    if (/\bopus\b/i.test(text)) audio.push("Opus");
    if (audio.length === 0 && /\baac\b/i.test(text)) audio.push("AAC");
  }
  const channels = list(field(description, "🔊"));
  if (channels.length === 0) {
    const m = /\b([257])[ .]([01])\b/.exec(base);
    if (m) channels.push(`${m[1]}.${m[2]}`);
  }

  // "7.56 GB / 193 GB (41.6 Mbps)": this file, then its pack. A lone size inside a pack is the pack's.
  let fileSize: number | undefined;
  let packSize: number | undefined;
  let bitrate: number | undefined;
  const sizes = /([\d.]+)\s*(TB|GB|MB)(?:\s*\/\s*([\d.]+)\s*(TB|GB|MB))?(?:\s*\(([\d.]+)\s*([GM])bps\))?/i.exec(
    field(description, "📦") ?? "",
  );
  if (sizes) {
    const a = Number(sizes[1]) * UNITS[sizes[2].toUpperCase() as keyof typeof UNITS];
    const packOnly = !sizes[3] && inPack;
    if (sizes[3]) {
      fileSize = a;
      packSize = Number(sizes[3]) * UNITS[sizes[4].toUpperCase() as keyof typeof UNITS];
    } else if (packOnly) packSize = a;
    else fileSize = a;
    if (sizes[5] && !packOnly) bitrate = Number(sizes[5]) * (sizes[6].toUpperCase() === "G" ? 1000 : 1);
  }
  // The addon's own size wins for the file, unless it is just the pack again.
  if (size && !(packSize && Math.abs(size - packSize) / packSize < 0.02)) fileSize = size;

  const firstLine = name.split("\n")[0] ?? name;
  const addon =
    firstLine
      .replace(/\[[^\]]*\]/g, "")
      .replace(/[🔑⚡]/gu, "")
      .replace(/\((best|top)\)/gi, "")
      .replace(/\b(2160p|4k|1440p|1080p|720p|576p|480p|sd|uhd)\b/gi, "")
      .replace(/\s+/g, " ")
      .trim() || "Source";

  return {
    addon,
    cached: /⚡/u.test(name),
    resolution,
    quality,
    codec,
    tenBit,
    hdr,
    audio,
    channels,
    seeders: Number(field(description, "👥")) || undefined,
    // "Comet|StremThru" is Comet reading StremThru's index; the index is the useful part.
    indexer: field(description, "🔍")?.split("|").pop()?.trim() || undefined,
    group: field(description, "🏷"),
    service: field(description, "📡"),
    languages: languagesOf(description),
    subtitles: list(field(description, "📝")),
    size: fileSize,
    packSize,
    bitrate,
    filename: base || undefined,
    path: inPack ? path : undefined,
    upscale: /upscale/i.test(text),
  };
}

export function parseDuration(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return undefined;
  const parts = value.split(":").map(Number);
  if (parts.some((n) => Number.isNaN(n))) return undefined;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}
