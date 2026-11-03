// How a source is described and ordered in the sources sheet: quality, audio, subtitles, speed, size, and why it's the pick.
import type { SourceOption } from "./sources";

// ---------- labels

export const RES_ORDER = ["2160p", "1440p", "1080p", "720p", "SD"];

export const resKey = (o: SourceOption) => o.resolution ?? "other";

export const resLabel = (r?: string) => (r === "2160p" ? "4K" : (r ?? "Unknown"));

/** Sharpest first; files without a listed resolution last. */
const resRank = (o: SourceOption) => {
  const i = RES_ORDER.indexOf(o.resolution ?? "");
  return i < 0 ? RES_ORDER.length : i;
};

export const hdrName = (o: SourceOption) => (o.hdr.includes("DV") ? "Dolby Vision" : o.hdr[0]);

export const hdrTag = (o: SourceOption) => (o.hdr.includes("DV") ? "DV" : o.hdr.length ? "HDR" : undefined);

const GROUPS = ["Multi", "Dual Audio", "Dubbed"];

export const realLanguages = (o: SourceOption) => o.languages.filter((l) => !GROUPS.includes(l));

export function audioLabel(o: SourceOption) {
  const real = realLanguages(o);
  if (real.length === 0) {
    if (o.languages.includes("Dual Audio")) return "Dual audio";
    if (o.languages.includes("Multi")) return "Several languages";
    return undefined;
  }
  return real.length <= 2 ? real.join(", ") : `${real.slice(0, 2).join(", ")} +${real.length - 2}`;
}

export function subsLabel(o: SourceOption) {
  if (o.subtitles.length === 0) return undefined;
  if (o.subtitles.length === 1) return o.subtitles[0];
  return `${o.subtitles[0]} +${o.subtitles.length - 1}`;
}

/** The fullest sound a file has, e.g. "5.1" when it also has a stereo track. */
export const widestChannels = (o: SourceOption) =>
  o.channels.reduce<string | undefined>((a, b) => (a === undefined || parseFloat(b) > parseFloat(a) ? b : a), undefined);

/** Subtitle languages listed in a file's details before "and N more". */
export const SUBS_SHOWN = 6;

export const mbps = (n: number) => `${n >= 10 ? Math.round(n) : n.toFixed(1)} Mbps`;

export function mismatchLabel(m: string) {
  if (m === "OAD") return "Looks like an OAD";
  if (m === "Special") return "Looks like a special";
  if (m === "Spin-off") return "Looks like a spin-off";
  if (m === "Opening or ending") return "Looks like an opening or ending";
  return `Looks like ${m.startsWith("Final") ? "the " : ""}${m}`;
}

/** How a file copes with TorBox's conversion: a word for the pick, a sentence for the details, bars in the list. */
export const SPEED: Record<SourceOption["speed"], { bars: number; word: string; note: string; text: string }> = {
  smooth: { bars: 3, word: "Smooth", note: "Plays smoothly", text: "Converts faster than playback." },
  slow: {
    bars: 2,
    word: "Slow start",
    note: "Slow to start",
    text: "Converts just ahead of playback, so the first seconds can stall.",
  },
  buffer: { bars: 1, word: "May buffer", note: "May buffer", text: "Converts slower than playback, so expect pauses." },
  unknown: { bars: 0, word: "Unknown", note: "Speed unknown", text: "Unknown: only the season pack’s size is listed." },
};

/** The same, in Krida for Windows: nothing converts there, so a file is only as fast as the connection. */
export const SPEED_IN_APP: Record<SourceOption["speed"], string> = {
  smooth: "Light enough for most connections.",
  slow: "Light enough for most connections.",
  buffer: "Over 60 Mbps, more than many connections carry, so expect pauses.",
  unknown: SPEED.unknown.text,
};

/** One line on why the pick is the pick, from the same facts the list shows. */
export function pickReason(pick: SourceOption, options: SourceOption[], inApp = false) {
  if (pick.speed === "slow") return "The best file found, though the first seconds can stall.";
  if (pick.speed === "buffer") return `The best file found, though it may pause while it ${inApp ? "loads" : "converts"}.`;
  if (pick.speed === "unknown") return "The best file found.";
  const sharper = options.filter((o) => !o.mismatch && resRank(o) < resRank(pick));
  if (sharper.length === 0) return "The sharpest file that plays without stalling.";
  if (sharper.some((o) => o.speed === "smooth")) return "The best file that plays without stalling.";
  const top = RES_ORDER[Math.min(...sharper.map(resRank))];
  return `The best file that plays without stalling. The ${resLabel(top)} ones can stall.`;
}

// ---------- list

export type SortKey = "best" | "quality" | "speed" | "size";

/** 1 puts the best, smoothest or largest first; -1 turns the column around. */
export type Sort = { key: SortKey; dir: 1 | -1 };

export const BEST: Sort = { key: "best", dir: 1 };

/** A header sorts by its column, a second click turns it around, a third goes back to best first. */
export const nextSort = (sort: Sort, key: SortKey): Sort =>
  sort.key !== key ? { key, dir: 1 } : sort.dir === 1 ? { key, dir: -1 } : BEST;

export const ORDER_TEXT: Record<Exclude<SortKey, "best">, [string, string]> = {
  quality: ["sharpest first", "lowest first"],
  speed: ["smoothest first", "slowest first"],
  size: ["largest first", "smallest first"],
};

export function compare({ key, dir }: Sort) {
  return (a: SourceOption, b: SourceOption) => {
    const by =
      key === "quality" ? (resRank(a) - resRank(b)) * dir
      : key === "speed" ? (SPEED[b.speed].bars - SPEED[a.speed].bars) * dir
      : key === "size" ?
        // Files without a size stay last either way.
        a.size === undefined || b.size === undefined ? Number(a.size === undefined) - Number(b.size === undefined)
        : (b.size - a.size) * dir
      : 0;
    return by || b.score - a.score;
  };
}

/** The four columns every row lines up on, so a file is found by scanning one: quality, audio, speed, size. */
export const COLS =
  "grid grid-cols-[76px_minmax(0,1fr)_40px_64px] items-center gap-x-3 narrow:grid-cols-[60px_minmax(0,1fr)_32px_56px] narrow:gap-x-2";

export const ANY = "any";
