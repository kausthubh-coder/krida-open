import { parseSource, type SourceInfo } from "./parse";

/**
 * How TorBox's conversion copes with a file. Every file is re-encoded to 8-bit H.264 with stereo AAC; measured on
 * TorBox (October 2026): 1080p at 36 Mbps converts 10–25× faster than playback, 4K at 23 Mbps 1.6×, and 4K at
 * 99 Mbps only 0.7×, which buffers.
 */
export type Speed = "smooth" | "slow" | "buffer" | "unknown";

export type RankContext = {
  type: "movie" | "series";
  name?: string;
  season?: number;
  episode?: number;
  /** Profile preferences as ISO 639-2 codes ("eng", "jpn"). */
  audioLang?: string;
  subLang?: string;
  /** Whether the screen it plays on is showing HDR right now, or that Krida for Windows plays the file itself;
   * unknown for older clients. */
  screen?: Screen;
  /** The profile's "Hide sources containing" setting: listings that contain one of its words are left out. */
  exclude?: string;
};

/**
 * The words of a "Hide sources containing" setting ("CAM|TS|HDCAM", commas work too) as one test: a listing is hidden
 * when its name, description or file has one of them as a whole word, in any case. Plain words, not a regular
 * expression, so nothing anyone types can make the check run away. Null when there are no words.
 */
export function excluder(setting: string | undefined): ((item: Listing) => boolean) | null {
  const words = (setting ?? "").split(/[|,]/).map((w) => w.trim()).filter(Boolean).slice(0, 30);
  if (words.length === 0) return null;
  const escaped = words.map((w) => w.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${escaped.join("|")})(?![\\p{L}\\p{N}])`, "iu");
  return (item) => re.test(`${item.name}\n${item.description}\n${item.filename ?? ""}`);
}

/**
 * Where the picture goes. "sdr" and "hdr" are a browser playing TorBox's conversion on that kind of screen. "app" is
 * Krida for Windows, where mpv plays the original file (HEVC 10-bit, HDR and Dolby Vision, lossless audio) and
 * tone-maps it for any screen, so nothing is lost to the conversion and only the connection limits a file.
 */
export type Screen = "sdr" | "hdr" | "app";

export type SourceOption = Omit<SourceInfo, "path"> & {
  /** Position in the stored list of the copy to play (a cached one when there is one). It shifts when the list is
   * fetched again, so a pick is sent with `key` too. */
  index: number;
  /** Every position holding the same file (several addons and indexers often list one file), `index` first. */
  indices: number[];
  /** `sourceKey` of the copy at `index`: names the file across refetches. */
  key: string;
  /** `sourceKey` of each position in `indices`. */
  keys: string[];
  /** Addon and indexer pairs the file was found on. */
  foundOn: string[];
  speed: Speed;
  /** Why this is probably not the requested episode, e.g. "Episode 6" or "OAD". */
  mismatch?: string;
  /** Dolby Vision without an HDR10 base: colors can come out wrong after conversion. */
  dvOnly: boolean;
  score: number;
  unavailable?: boolean;
};

const LANGUAGE_NAMES: Record<string, string> = {
  eng: "English", spa: "Spanish", fre: "French", ger: "German", ita: "Italian", por: "Portuguese", hin: "Hindi",
  tam: "Tamil", tel: "Telugu", jpn: "Japanese", kor: "Korean", chi: "Chinese", ara: "Arabic", rus: "Russian",
  tur: "Turkish",
};
export const languageFor = (code?: string) => (code ? LANGUAGE_NAMES[code] : undefined);

type Listing = { name: string; description: string; filename?: string; size?: number; unavailable?: boolean };

/** A short id for one listing that survives the addon reordering its list: the file and its size, or the addon's
 * text when no file is named. Built from display fields only; the playback URL carries account credentials. */
export function sourceKey(item: Listing) {
  const basis = item.filename ? `${item.filename.toLowerCase()}|${item.size ?? ""}` : `${item.name}|${item.description}`;
  // cyrb53: two 32-bit lanes, plenty to tell a few dozen files apart.
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < basis.length; i++) {
    const c = basis.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** Labels AIOStreams uses for a mix of languages rather than one. */
export const LANGUAGE_GROUPS = ["Multi", "Dual Audio", "Dubbed"];

/** The original file streams at its own bitrate: above this, many home connections can't keep up. */
const APP_MAX_MBPS = 60;
/** Without a bitrate, a file this big is about 60 Mbps over a long film. */
const APP_MAX_BYTES = 60e9;

export function speedOf(info: Pick<SourceInfo, "resolution" | "bitrate" | "size" | "packSize">, screen?: Screen): Speed {
  if (screen === "app") {
    if (info.bitrate) return info.bitrate > APP_MAX_MBPS ? "buffer" : "smooth";
    if (!info.size) return "unknown";
    return info.size > APP_MAX_BYTES ? "buffer" : "smooth";
  }
  const fourK = info.resolution === "2160p";
  if (info.bitrate) {
    if (fourK) return info.bitrate > 45 ? "buffer" : info.bitrate > 30 ? "slow" : "smooth";
    return info.bitrate > 90 ? "buffer" : "smooth";
  }
  if (!info.size) return "unknown";
  return fourK && info.size > 40e9 ? "buffer" : "smooth";
}

const SPIN_OFFS: [RegExp, string][] = [
  [/\b(OAD|OVA|ONA)\b/i, "OAD"],
  [/\b(NCOP|NCED|creditless)\b/i, "Opening or ending"],
  [/\b(junior high|chuugakkou|lost girls|short anime|chibi)\b/i, "Spin-off"],
  [/\b(SP\d+|specials?|recap)\b/i, "Special"],
];

/** Says why a file is probably not the requested episode, or nothing when it looks right. */
export function mismatchOf(filename: string | undefined, ctx: RankContext): string | undefined {
  if (ctx.type !== "series" || !filename) return undefined;
  const base = filename.replace(/\.[a-z0-9]{2,4}$/i, "");
  const title = (ctx.name ?? "").toLowerCase();
  // Season 0 is where OADs, OVAs and specials live, so there those words describe the right file.
  const specials = ctx.season === 0;
  for (const [re, label] of SPIN_OFFS) {
    if (specials && (label === "OAD" || label === "Special")) continue;
    const m = re.exec(base);
    if (m && !title.includes(m[0].toLowerCase())) return label;
  }
  if (/final season/i.test(base) && ctx.season === 1) return "Final Season";

  const { season, episode } = ctx;
  if (episode === undefined) return undefined;
  const named = numbering(base);
  if (named?.season !== undefined) {
    if (season !== undefined && named.season !== season) return `Season ${named.season}`;
    if (named.episode !== episode) return `Episode ${named.episode}`;
    return undefined;
  }
  // Anime numbering: "Title - 07", "Title E07". Later seasons may count on from the first, so there only a lower
  // number is clearly wrong; without a season (Kitsu entries number their own episodes) any other number is.
  if (named) {
    const n = named.episode;
    if (n !== episode && (season === undefined || season === 1 || n < episode)) return `Episode ${n}`;
  }
  return undefined;
}

/** The season and episode a file's name gives ("S01E07", "1x07"), or just the episode ("Title - 07"). */
function numbering(base: string): { season?: number; episode: number } | undefined {
  const se =
    /\bS(\d{1,2})\s?E(\d{1,4})\b/i.exec(base) ??
    /\bS(\d{1,2})\s+-\s+(\d{1,4})\b/i.exec(base) ??
    /\b(\d{1,2})x(\d{2,3})\b/.exec(base);
  if (se) return { season: Number(se[1]), episode: Number(se[2]) };
  const abs = /(?:\s-\s|\bE)(\d{1,4})(?:v\d)?(?=[\s\].([]|$)/i.exec(base);
  return abs ? { episode: Number(abs[1]) } : undefined;
}

/** Whether a file's name says it is exactly the requested episode, for picking it out of a season pack. */
export function namesEpisode(filename: string, ctx: RankContext): boolean {
  const named = numbering(filename.replace(/\.[a-z0-9]{2,4}$/i, ""));
  return named?.episode === ctx.episode && !mismatchOf(filename, ctx);
}

function hasLanguage(languages: string[], name: string) {
  if (languages.includes(name)) return true;
  return languages.includes("Dual Audio") && (name === "English" || name === "Japanese");
}

const RES_POINTS: Record<string, number> = { "2160p": 30, "1440p": 27, "1080p": 24, "720p": 14, SD: 4 };
const QUALITY_POINTS: Record<string, number> = {
  Remux: 8, BluRay: 6, "WEB-DL": 5, WEB: 4, WEBRip: 3, HDRip: 2, HDTV: 1, DVD: 0, CAM: -30,
};
const HDR_ON_SDR = 14;
const BITRATE_CAP: Record<string, number> = { "2160p": 30, "1440p": 35, "1080p": 40, "720p": 15, SD: 6 };
/** In the app a 4K file keeps every bit, so a remux counts for more than a lighter encode. */
const APP_BITRATE_CAP: Record<string, number> = { ...BITRATE_CAP, "2160p": APP_MAX_MBPS };
/** Audio the browser turns into stereo AAC and the app passes on as it is. */
const LOSSLESS_AUDIO = /truehd|atmos|dts-?hd|dts:?x|flac/i;

function scoreOf(o: Omit<SourceOption, "score">, position: number, total: number, ctx: RankContext) {
  const app = ctx.screen === "app";
  let score = RES_POINTS[o.resolution ?? ""] ?? 12;
  score += QUALITY_POINTS[o.quality ?? ""] ?? 2;
  const cap = (app ? APP_BITRATE_CAP : BITRATE_CAP)[o.resolution ?? ""] ?? 30;
  if (o.bitrate) score += (Math.min(o.bitrate, cap) / cap) * 6;
  // Your AIOStreams sort order still counts, a little.
  score += 4 * (1 - position / Math.max(total, 1));
  if (!o.cached) score -= 20;
  if (o.speed === "buffer") score -= 25;
  else if (o.speed === "slow") score -= 6;
  else if (o.speed === "unknown") score -= 8;
  if (o.upscale) score -= 10;
  if (app) {
    // mpv reads Dolby Vision's own color data and maps HDR to whatever screen it's on, so more of it is better.
    if (o.hdr.length > 0) score += 4;
    if (o.hdr.includes("DV")) score += 2;
    if (o.audio.some((a) => LOSSLESS_AUDIO.test(a))) score += 3;
  } else {
    if (o.dvOnly) score -= 6;
    // TorBox keeps HDR as HDR (in 8 bits). A screen showing HDR gets its light; on any other the browser squeezes
    // it into SDR, darker and duller than an SDR copy, so one a step lower in resolution is still the better picture.
    if (o.hdr.length > 0 && ctx.screen === "sdr") score -= HDR_ON_SDR;
    else if (o.hdr.length > 0 && ctx.screen === "hdr" && !o.dvOnly) score += 3;
  }
  if (o.mismatch) score -= 40;
  const audio = languageFor(ctx.audioLang);
  if (audio && o.languages.length) {
    if (hasLanguage(o.languages, audio)) score += 3;
    // Outweighs every picture and sound bonus: a 4K remux is no use in a language you didn't ask for.
    else if (!o.languages.some((l) => LANGUAGE_GROUPS.includes(l))) score -= 20;
  }
  const subs = languageFor(ctx.subLang);
  if (subs && o.subtitles.includes(subs)) score += 2;
  return Math.round(score * 10) / 10;
}

/**
 * Parses, folds duplicates (one file listed by several addons or indexers) and scores the addon's list.
 * Options keep the addon's order; `pick` is what Krida would play on its own.
 */
export function rankSources(items: Listing[], ctx: RankContext) {
  const options: Omit<SourceOption, "score">[] = [];
  const byFile = new Map<string, Omit<SourceOption, "score">[]>();
  const excluded = excluder(ctx.exclude);

  items.forEach((item, index) => {
    // Left out of the list and of Krida's pick; positions stay those of the stored list.
    if (excluded?.(item)) return;
    const { path: _path, ...info } = parseSource(item.name, item.description, item.filename, item.size);
    // Providers omit extensions and change separators or accents in the same file's name.
    const key = info.filename ? info.filename.normalize("NFKD").replace(/\p{M}/gu, "")
      .replace(/\.(mkv|mp4|avi|m4v)$/i, "").toLowerCase().replace(/[^a-z0-9]+/g, "") : `#${index}`;
    const listing = sourceKey(item);
    const found = info.indexer && info.indexer !== info.addon ? `${info.addon} (${info.indexer})` : info.addon;
    const same = byFile
      .get(key)
      ?.find((o) =>
        o.size && info.size
          ? Math.abs(o.size - info.size) / o.size < 0.01
          : !!(o.packSize && info.packSize && Math.abs(o.packSize - info.packSize) / o.packSize < 0.02),
      );
    if (same) {
      // Play a cached copy when there is one; the other copies are fallbacks.
      if (!item.unavailable && (same.unavailable || (info.cached && !same.cached))) {
        same.indices.unshift(index);
        same.keys.unshift(listing);
        same.index = index;
        same.key = listing;
        same.cached = info.cached;
        same.unavailable = undefined;
      } else {
        same.indices.push(index);
        same.keys.push(listing);
      }
      if (!same.foundOn.includes(found)) same.foundOn.push(found);
      same.seeders = Math.max(same.seeders ?? 0, info.seeders ?? 0) || undefined;
      same.size ??= info.size;
      same.bitrate ??= info.bitrate;
      same.indexer ??= info.indexer;
      if (info.languages.length > same.languages.length) same.languages = info.languages;
      if (info.subtitles.length > same.subtitles.length) same.subtitles = info.subtitles;
      same.speed = speedOf(same, ctx.screen);
      return;
    }
    const option = {
      ...info,
      index,
      indices: [index],
      key: listing,
      keys: [listing],
      foundOn: [found],
      speed: speedOf(info, ctx.screen),
      mismatch: mismatchOf(info.filename, ctx),
      dvOnly: info.hdr.includes("DV") && info.hdr.length === 1,
      ...(item.unavailable ? { unavailable: true } : {}),
    };
    options.push(option);
    byFile.set(key, [...(byFile.get(key) ?? []), option]);
  });

  const ranked: SourceOption[] = options.map((o, position) => ({
    ...o,
    score: scoreOf(o, position, options.length, ctx),
  }));
  const best = ranked.filter(o => !o.unavailable).sort((a, b) => b.score - a.score);
  const pick =
    best.find((o) => o.speed === "smooth" && !o.mismatch && !o.upscale && o.cached) ?? best.find((o) => !o.mismatch);
  return { options: ranked, best, pick };
}

/**
 * The kind of file to look for again on a show's next episode: the addon's binge group, or else the release group and
 * resolution as "release:<group>|<resolution>" (lastSources). Undefined when the file says neither.
 */
export function kindOf(source: { bingeGroup?: string; filename?: string; resolution?: string }) {
  if (source.bingeGroup) return source.bingeGroup;
  const group = source.filename ? releaseGroupOf(source.filename) : undefined;
  return group ? `release:${group.toLowerCase()}|${source.resolution ?? ""}` : undefined;
}

/** Words at the end of a name that are part of the format, not a release group ("WEB-DL"). */
const NOT_A_GROUP = /^(dl|rip|web|hd|sd|uhd|x26[45]|h26[45]|\d{3,4}p)$/i;

/** The release group a file's name ends in ("…H.264-NTb.mkv"), or starts with for anime ("[SubsPlease] …"). */
export function releaseGroupOf(filename: string) {
  const base = filename.replace(/\.[a-z0-9]{2,4}$/i, "");
  const tail = /-([A-Za-z0-9]{2,20})$/.exec(base)?.[1];
  if (tail && !NOT_A_GROUP.test(tail)) return tail;
  return /^\[([^\]]{2,30})\]/.exec(base)?.[1];
}

/** Whether a listed file is of the kind `binge` names (`kindOf`). */
export function sameKind(item: Listing & { bingeGroup?: string }, binge: string) {
  if (!binge.startsWith("release:")) return item.bingeGroup === binge;
  const info = parseSource(item.name, item.description, item.filename, item.size);
  return kindOf({ filename: info.filename, resolution: info.resolution }) === binge;
}

const numberAt = (parts: string[], i: number) => {
  const n = parts[i] ? Number(parts[i]) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

/** Context for a Stremio video id: "tt123:1:7" is season 1, episode 7, "tt123:0:2" the second special;
 * "kitsu:12:7" is episode 7 of an entry without seasons. */
export function contextFor(type: "movie" | "series", videoId: string): RankContext {
  if (type === "movie") return { type };
  const parts = videoId.split(":");
  if (parts[0] === "kitsu") return { type, episode: numberAt(parts, 2) };
  return { type, season: numberAt(parts, 1), episode: numberAt(parts, 2) };
}
