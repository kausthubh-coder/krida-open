// The subtitles you last picked for a title, kept on this device so the next episode starts with them. Like Stremio,
// it remembers a language rather than a file: each episode has its own files and track numbers.
import { bestSubtitles, type FileSubtitle, type SubtitleOption } from "./subtitles";

const KEY = "krida.subtitles";
/** Titles remembered per device, the oldest forgotten first. */
const KEEP = 100;

/** A language, off, or one of the file's own tracks when it names no language (matched by its number). */
export type SubtitleChoice = { lang: string } | { off: true } | { track: string };
type Stored = Record<string, SubtitleChoice & { at: number }>;

const keyFor = (profileId: string, titleId: string) => `${profileId}:${titleId}`;

function read(): Stored {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return stored && typeof stored === "object" && !Array.isArray(stored) ? (stored as Stored) : {};
  } catch {
    return {};
  }
}

export function recallSubtitles(profileId: string, titleId: string): SubtitleChoice | undefined {
  const hit = read()[keyFor(profileId, titleId)];
  if (!hit) return undefined;
  if ("off" in hit) return { off: true };
  if ("lang" in hit && typeof hit.lang === "string") return { lang: hit.lang };
  if ("track" in hit && typeof hit.track === "string") return { track: hit.track };
  return undefined;
}

export function rememberSubtitles(profileId: string, titleId: string, choice: SubtitleChoice) {
  const stored = read();
  stored[keyFor(profileId, titleId)] = { ...choice, at: Date.now() };
  const kept = Object.entries(stored)
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, KEEP);
  try {
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // Storage full or blocked: the choice still holds for this episode.
  }
}

/** What a pick from the menu means for the next episode: its language, or the track itself when it names none. */
export function choiceFor(id: string | null, fileTracks: FileSubtitle[], options: SubtitleOption[] | undefined): SubtitleChoice | undefined {
  if (id === null) return { off: true };
  const file = fileTracks.find((t) => t.id === id);
  if (file) return file.lang ? { lang: file.lang } : { track: id };
  const online = options?.find((s) => s.id === id);
  return online ? { lang: online.lang } : undefined;
}

/**
 * The subtitles to start an episode with: the title's remembered choice, else the profile's language, else its second
 * language, else none. Remembered off stays off. A remembered language or track this episode lacks falls back to the
 * profile's languages, as Stremio and Nuvio do.
 */
export function startingSubtitles(
  remembered: SubtitleChoice | undefined,
  profileLang: string | undefined,
  fileTracks: FileSubtitle[],
  options: SubtitleOption[] | undefined,
  profileLang2?: string,
): string | null {
  if (remembered && "off" in remembered) return null;
  const same =
    remembered && "track" in remembered
      ? fileTracks.find((t) => t.id === remembered.track)?.id
      : remembered && bestSubtitles(remembered.lang, fileTracks, options);
  // OpenSubtitles may still have it: wait rather than show another language and switch.
  if (!same && remembered && "lang" in remembered && options === undefined) return null;
  if (same) return same;
  const first = profileLang ? bestSubtitles(profileLang, fileTracks, options) : null;
  // The second language only once the first is known to be missing, so it never shows and then switches.
  if (first || !profileLang2 || (profileLang && options === undefined)) return first;
  return bestSubtitles(profileLang2, fileTracks, options);
}
