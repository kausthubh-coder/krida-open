// Subtitles: the options for this file, the one picked (or the title's last choice, or the profile's language), its
// cues, and the line on screen.
// The file's text tracks and subtitle addons are drawn here; mpv draws the original file tracks in the desktop app.
import { useEffect, useMemo, useState } from "react";
import type { Me } from "../../data/session";
import { useAddons } from "../../data/addons";
import type { RoomData } from "../party";
import type { MpvVideo } from "./desktop";
import { choiceFor, recallSubtitles, rememberSubtitles, startingSubtitles } from "./subtitleMemory";
import { bestSubtitles, cuesAt, embeddedCues, embeddedOptions, embeddedSubtitles, loadCues, nextCueChange, readSubtitleFile, useSubtitleOptions, type Cue, type FileSubtitle, type LocalSubtitle } from "./subtitles";

export function useSubtitles(video: HTMLVideoElement | null, room: RoomData, me: Me, mpv: MpvVideo | null) {
  const m = room.media!;
  const stream = room.stream!;
  // Subtitles are indexed by IMDb; anime episodes look them up through their IMDb mapping.
  const subtitleId = m.ref
    ? m.ref.season !== undefined && m.ref.episode !== undefined
      ? `${m.ref.imdbId}:${m.ref.season}:${m.ref.episode}`
      : m.ref.imdbId
    : m.videoId;
  // The viewer's own subtitle addons too (in a party, each person's): by IMDb first, then by the title's own id.
  const addons = useAddons();
  const subtitleAddons = useMemo(() => (addons ?? []).map((a) => ({ base: a.url, manifest: a.manifest, enabled: a.enabled })), [addons]);
  const subs = useSubtitleOptions(m.type, [...new Set([subtitleId, m.videoId])], stream.osHash, stream.size, subtitleAddons);
  const [embedded, setEmbedded] = useState<Awaited<ReturnType<typeof embeddedSubtitles>>>(null);
  useEffect(() => {
    let alive = true;
    if (!mpv && stream.size) void embeddedSubtitles(stream.size).then(
      (result) => { if (alive) setEmbedded(result); },
      () => { /* Addon subtitles remain available when the original file cannot be read. */ },
    );
    return () => { alive = false; };
  }, [mpv, stream.size]);
  // The tracks read from the file play here; until they're read, or when they can't be, the ones TorBox reports are
  // still named, with the note that they show in the app.
  const read = useMemo(() => embeddedOptions(embedded?.tracks ?? []), [embedded]);
  const fileSubs: FileSubtitle[] = useMemo(
    () => mpv || read.length === 0 ? stream.subtitles.map((t, i) => ({ id: `file:${i + 1}`, lang: t.language, title: t.title })) : read,
    [mpv, stream.subtitles, read],
  );
  const filePlayable = mpv !== null || read.length > 0;
  const [subPick, setSubPick] = useState<string | null | undefined>(undefined); // undefined = automatic
  const [subOffset, setSubOffset] = useState(0);
  const [localSubs, setLocalSubs] = useState<LocalSubtitle[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const loadFile = async (file: File) => {
    setFileError(null);
    try {
      const local = await readSubtitleFile(file);
      setLocalSubs((old) => [...old, local]);
      setSubPick(local.id);
    } catch (error) {
      setFileError(error instanceof Error ? error.message : "Could not read this subtitle file. Try another.");
    }
  };
  const bestIn = (lang: string) => bestSubtitles(lang, filePlayable ? fileSubs : [], subs);
  // Read once per episode (the player remounts for each stream), so a pick here doesn't change what it starts with.
  const [remembered] = useState(() => recallSubtitles(me._id, m.imdbId));
  const autoSub = startingSubtitles(remembered, me.prefs.subLang, filePlayable ? fileSubs : [], subs, me.prefs.subLang2);
  const subId = subPick === undefined ? autoSub : subPick;
  /** A pick from the menu or the keyboard, kept for this title's next episode. */
  const pick = (id: string | null) => {
    setSubPick(id);
    const choice = choiceFor(id, fileSubs, subs);
    if (choice) rememberSubtitles(me._id, m.imdbId, choice);
  };
  const subOption = subs?.find((s) => s.id === subId);
  const fileTrack = filePlayable && subId?.startsWith("file:") ? Number(subId.slice(5)) : null;
  // mpv keeps its subtitle track from one file to the next, so each file loaded gets this player's choice again.
  useEffect(() => {
    if (!mpv) return;
    const apply = () => mpv.setSubtitles(fileTrack, fileTrack ? subOffset : 0);
    if (mpv.readyState > 0) apply();
    mpv.addEventListener("loadedmetadata", apply);
    return () => mpv.removeEventListener("loadedmetadata", apply);
  }, [mpv, fileTrack, subOffset]);
  const [cues, setCues] = useState<Cue[]>([]);
  const [subError, setSubError] = useState(false);
  const local = localSubs.find((s) => s.id === subId);
  useEffect(() => {
    setCues([]);
    setSubError(false);
    if (local) {
      setCues(local.cues);
      return;
    }
    const track = !mpv && fileTrack ? embedded?.tracks.find((t) => t.track === fileTrack) : undefined;
    if (!subOption && !track) return;
    let alive = true;
    const load = track && stream.size
      ? embeddedSubtitles(stream.size, track.track).then((result) => {
        if (!result) throw new Error("File unavailable");
        return embeddedCues(track.codec, result.cues);
      })
      : loadCues(subOption!.url);
    load.then(
      (c) => alive && setCues(c),
      () => alive && setSubError(true),
    );
    return () => {
      alive = false;
    };
  }, [subOption, local, mpv, fileTrack, embedded, stream.size]);
  const [cueHtml, setCueHtml] = useState("");
  useEffect(() => {
    if (!video || cues.length === 0) {
      setCueHtml("");
      return;
    }
    // The line changes only where a cue starts or ends, so it's set then, not checked every frame: a loop on every
    // frame kept the page drawing 60 times a second under a film. The video's own events catch seeks, pauses and
    // speed changes, and a timer the next change.
    let timer = 0;
    let last = "";
    const update = () => {
      clearTimeout(timer);
      const t = video.currentTime - subOffset;
      const html = cuesAt(cues, t)
        .map((c) => c.html)
        .join("<br>");
      if (html !== last) {
        last = html;
        setCueHtml(html);
      }
      const next = video.paused ? null : nextCueChange(cues, t);
      // Just past the change, since a cue shows until its end and from its start. A timer that fires a little early
      // finds nothing changed and waits out the rest.
      if (next !== null) timer = window.setTimeout(update, ((next - t) / (video.playbackRate || 1)) * 1000 + 5);
    };
    update();
    const events = ["timeupdate", "seeked", "play", "pause", "ratechange"];
    for (const e of events) video.addEventListener(e, update);
    return () => {
      clearTimeout(timer);
      for (const e of events) video.removeEventListener(e, update);
    };
  }, [video, cues, subOffset]);
  /** C on the keyboard: off, or back on in this title's language, else yours (English when none is set). */
  const onLang = (remembered && "lang" in remembered ? remembered.lang : undefined) ?? me.prefs.subLang ?? "eng";
  const toggle = () => pick(subId ? null : bestIn(onLang));
  const skippedNotice = embedded?.skipped.length ? "Some subtitle tracks use images or unsupported encoding and cannot be shown in the web player. Try addon subtitles." : null;
  return { subs, fileSubs, filePlayable, subId, setSubPick: pick, toggle, subOffset, setSubOffset, subError, cueHtml, localSubs, loadFile, fileError: fileError ?? skippedNotice };
}
