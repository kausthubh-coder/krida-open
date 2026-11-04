import { useEffect, useState } from "react";
import { resourceUrl, serves, type AddonManifest } from "../../../shared/stremio";
import { addonJson } from "../../data/addons";

const ADDON = "https://opensubtitles-v3.strem.io";

export type SubtitleOption = { id: string; url: string; lang: string };
/** One of the file's own tracks. `id` is "file:<n>", n being mpv's track number (from 1). */
export type FileSubtitle = { id: string; lang?: string; title?: string };

/** Signs and forced tracks only cover on-screen text and foreign lines, so they aren't picked for a language. */
const PARTIAL = /\b(forced|signs?|songs?)\b/i;

/** The best subtitles in a language: the file's own full track (timed to this very file), else OpenSubtitles. */
export function bestSubtitles(lang: string, fileTracks: FileSubtitle[], options: SubtitleOption[] | undefined) {
  return (
    fileTracks.find((t) => t.lang === lang && !PARTIAL.test(t.title ?? ""))?.id ??
    options?.find((s) => s.lang === lang)?.id ??
    null
  );
}
export type Cue = { start: number; end: number; html: string };

/** A profile's subtitle addon, and the ids it may be asked by (an anime's Kitsu id, its IMDb episode). */
type SubtitleAddon = { base: string; manifest: Pick<AddonManifest, "resources">; enabled: boolean };

/**
 * Subtitles from OpenSubtitles and the profile's own subtitle addons, OpenSubtitles first. The file hash TorBox
 * reports picks ones synced to this exact release. Each addon is asked by the first of `ids` it lists; one that fails
 * costs only its own.
 */
export function useSubtitleOptions(
  type: "movie" | "series",
  ids: string[],
  osHash?: string,
  size?: number,
  addons: SubtitleAddon[] = [],
) {
  const [options, setOptions] = useState<SubtitleOption[] | undefined>();
  const key = ids.join("|");
  const sources = addons
    .filter((a) => a.enabled && a.base !== ADDON)
    .flatMap((a) => {
      const id = ids.find((i) => serves(a.manifest, "subtitles", type, i));
      return id ? [{ base: a.base, id }] : [];
    });
  const sourcesKey = sources.map((s) => `${s.base}#${s.id}`).join("|");
  useEffect(() => {
    let alive = true;
    setOptions(undefined);
    const extra = osHash && size ? { videoHash: osHash, videoSize: size } : {};
    const ask = (base: string, id: string, n: number) =>
      addonJson<{ subtitles?: { id: string; url: string; lang: string }[] }>(resourceUrl(base, "subtitles", type, id, extra))
        .then((body) => (body.subtitles ?? []).filter((x) => typeof x.url === "string").map((x) => ({ id: n ? `${n}:${x.id}` : String(x.id), url: x.url, lang: x.lang })))
        .catch(() => [] as SubtitleOption[]);
    void Promise.all([ask(ADDON, ids[0], 0), ...sources.map((s, i) => ask(s.base, s.id, i + 1))]).then((lists) => alive && setOptions(lists.flat()));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, key, osHash, size, sourcesKey]);
  return options;
}

const cueCache = new Map<string, Promise<Cue[]>>();

export function loadCues(url: string) {
  let hit = cueCache.get(url);
  if (!hit) {
    hit = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`Subtitles answered ${r.status}`);
        return r.text();
      })
      .then(parseSubtitles);
    cueCache.set(url, hit);
    hit.catch(() => cueCache.delete(url));
  }
  return hit;
}

function toSeconds(stamp: string) {
  const m = /(?:(\d+):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})/.exec(stamp);
  if (!m) return NaN;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, "0")) / 1000;
}

function escapeHtml(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Keep italics and line breaks; drop every other tag and any ASS override codes. */
function cueHtml(raw: string) {
  const italic = raw.replace(/<\s*i\s*>/gi, "\u0001").replace(/<\s*\/\s*i\s*>/gi, "\u0002");
  const plain = italic.replace(/<[^>]*>/g, "").replace(/\{\\[^}]*\}/g, "");
  return escapeHtml(plain)
    .replace(/\u0001/g, "<i>")
    .replace(/\u0002/g, "</i>")
    .trim()
    .replace(/\n/g, "<br>");
}

export function parseSubtitles(text: string): Cue[] {
  if (/^\s*\[Events\]\s*$/im.test(text)) return parseAss(text);
  const blocks = text.replace(/\r/g, "").replace(/^﻿/, "").split(/\n{2,}/);
  const cues: Cue[] = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    const timeIndex = lines.findIndex((l) => l.includes("-->"));
    if (timeIndex === -1) continue;
    const [a, b] = lines[timeIndex].split("-->");
    const start = toSeconds(a);
    const end = toSeconds(b);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const html = cueHtml(lines.slice(timeIndex + 1).join("\n"));
    if (html) cues.push({ start, end, html });
  }
  return cues.sort((x, y) => x.start - y.start);
}

function parseAss(text: string): Cue[] {
  let events = false;
  let format = "Marked,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text".toLowerCase().split(",");
  const cues: Cue[] = [];
  for (const line of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) {
      events = line.trim().toLowerCase() === "[events]";
      continue;
    }
    if (!events) continue;
    const match = /^\s*(Format|Dialogue):\s*(.*)$/i.exec(line);
    if (!match) continue;
    if (match[1].toLowerCase() === "format") {
      format = match[2].split(",").map((s) => s.trim().toLowerCase());
      continue;
    }
    // Text may contain commas, including when a custom Format puts fields after it.
    const values = match[2].split(",");
    const ti = format.indexOf("text");
    if (ti < 0 || values.length < format.length) continue;
    values.splice(ti, values.length - format.length + 1, values.slice(ti, ti + values.length - format.length + 1).join(","));
    const start = toSeconds(values[format.indexOf("start")] ?? "");
    const end = toSeconds(values[format.indexOf("end")] ?? "");
    const plain = values[ti].replace(/\{\\[^}]*\}/g, "").replace(/\\[Nn]/g, "\n").replace(/\\h/g, " ").trim();
    if (Number.isFinite(start) && Number.isFinite(end) && end > start && plain)
      cues.push({ start, end, html: escapeHtml(plain).replace(/\n/g, "<br>") });
  }
  return cues.sort((a, b) => a.start - b.start);
}

export type LocalSubtitle = { id: string; name: string; cues: Cue[] };

/** Read in the browser without uploading the viewer's file. */
export async function readSubtitleFile(file: Pick<File, "name" | "text">): Promise<LocalSubtitle> {
  const cues = parseSubtitles(await file.text());
  if (!cues.length) throw new Error("This subtitle file has no cues. Try an SRT, VTT, ASS or SSA file.");
  return { id: `local:${crypto.randomUUID()}`, name: file.name, cues };
}

export function shiftSubtitleDelay(offset: number, by: -1 | 1) {
  return Math.round((offset * 10 + by)) / 10;
}

/** Every cue showing at time t (binary search to the first cue that could still be on screen). */
export function cuesAt(cues: Cue[], t: number) {
  let lo = 0;
  let hi = cues.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].end < t) lo = mid + 1;
    else hi = mid;
  }
  const out: Cue[] = [];
  for (let i = Math.max(0, lo - 3); i < cues.length && cues[i].start <= t; i++) {
    if (cues[i].end >= t && cues[i].start <= t) out.push(cues[i]);
  }
  return out;
}

/** When after t the cues showing next change: the next one starts, or one showing ends. Null when none will. */
export function nextCueChange(cues: Cue[], t: number) {
  let next = Infinity;
  for (const c of cuesAt(cues, t)) next = Math.min(next, c.end);
  let lo = 0;
  let hi = cues.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].start <= t) lo = mid + 1;
    else hi = mid;
  }
  if (lo < cues.length) next = Math.min(next, cues[lo].start);
  return Number.isFinite(next) ? next : null;
}
