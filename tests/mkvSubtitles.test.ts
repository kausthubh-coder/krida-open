import { describe, expect, test } from "vitest";
import { readSubtitles } from "../server/mkv";
import { embeddedCues, embeddedOptions, bestSubtitles } from "../src/features/player/subtitles";
import { subtitleFile } from "./mkvFile";

describe("a file's text subtitles", () => {
  test("lists languages, names and codecs, excluding PGS and VobSub", async () => {
    const file = subtitleFile();
    const result = await readSubtitles(async (a, b) => file.slice(a, b), file.length);
    expect(result.tracks).toEqual([
      { track: 2, language: "eng", name: "Full subtitles", codec: "S_TEXT/UTF8" },
      { track: 3, language: "jpn", name: "Dialogue", codec: "S_TEXT/ASS" },
      { track: 5, language: "fra", name: "VTT", codec: "S_TEXT/WEBVTT" },
      { track: 6, language: "spa", name: "SSA", codec: "S_TEXT/SSA" },
    ]);
    expect(result.skipped).toEqual([{ codec: "S_HDMV/PGS", name: "PGS" }, { codec: "S_VOBSUB", name: "DVD" }]);
    const options = embeddedOptions(result.tracks);
    expect(options).toEqual([
      { id: "file:2", lang: "eng", title: "Full subtitles · in the file" },
      { id: "file:3", lang: "jpn", title: "Dialogue · in the file" },
      { id: "file:5", lang: "fra", title: "VTT · in the file" },
      { id: "file:6", lang: "spa", title: "SSA · in the file" },
    ]);
    expect(bestSubtitles("eng", options, [{ id: "addon", lang: "eng", url: "https://subs.test" }])).toBe("file:2");
  });

  test("extracts every SRT and ASS cue with block timestamps and duration, skipping video bytes", async () => {
    const file = subtitleFile();
    let spent = 0;
    const read = async (a: number, b: number) => { spent += b - a; return file.slice(a, b); };
    const srt = await readSubtitles(read, file.length, 2);
    expect(embeddedCues("S_TEXT/UTF8", srt.cues)).toEqual([
      { start: 0.125, end: 1.625, html: "Hello <i>world</i>" },
      { start: 4.75, end: 6.25, html: "Second<br>line" },
    ]);
    const ass = await readSubtitles(read, file.length, 3);
    expect(embeddedCues("S_TEXT/ASS", ass.cues)).toEqual([
      { start: 0.25, end: 2.25, html: "Hello<br>world" },
      { start: 5.25, end: 7.25, html: "Goodbye, friend" },
    ]);
    expect(spent).toBeLessThan(16_000);
  });

  test("extracts WebVTT and SSA packets", async () => {
    const file = subtitleFile();
    const read = async (a: number, b: number) => file.slice(a, b);
    expect(embeddedCues("S_TEXT/WEBVTT", (await readSubtitles(read, file.length, 5)).cues)).toEqual([
      { start: 0, end: 0.5, html: "VTT cue" }, { start: 5, end: 5.5, html: "VTT cue" },
    ]);
    expect(embeddedCues("S_TEXT/SSA", (await readSubtitles(read, file.length, 6)).cues)).toEqual([
      { start: 0, end: 0.5, html: "SSA cue" }, { start: 5, end: 5.5, html: "SSA cue" },
    ]);
  });

  test("reads indexed subtitle blocks from Cues and falls back for a track the Cues do not index", async () => {
    const file = subtitleFile(true);
    const read = async (a: number, b: number) => file.slice(a, b);
    expect((await readSubtitles(read, file.length, 2)).cues).toEqual([
      { start: 0.125, end: 1.625, text: "Hello <i>world</i>" },
      { start: 4.75, end: 6.25, text: "Second\nline" },
    ]);
    expect(embeddedCues("S_TEXT/ASS", (await readSubtitles(read, file.length, 3)).cues)).toEqual([
      { start: 0.25, end: 2.25, html: "Hello<br>world" },
      { start: 5.25, end: 7.25, html: "Goodbye, friend" },
    ]);
  });

  test("walks a short file whose Cues omit subtitles, and gives up on a long one within 200 Range reads", async () => {
    const reader = (file: Uint8Array) => {
      const counted = { requests: 0 };
      return { counted, read: async (a: number, b: number) => { counted.requests++; return file.slice(a, b); } };
    };
    const short = subtitleFile(true, 50, 1);
    const s = reader(short);
    expect((await readSubtitles(s.read, short.length, 2)).cues).toEqual([
      { start: 0.125, end: 1.625, text: "Hello <i>world</i>" },
      { start: 4.75, end: 6.25, text: "Second\nline" },
    ]);
    const long = subtitleFile(true, 40_000, 1);
    const l = reader(long);
    await expect(readSubtitles(l.read, long.length, 2)).rejects.toThrow("Subtitle track isn't indexed; too far to scan");
    expect(l.counted.requests).toBeLessThan(220);
  });

  test("refuses extraction before exceeding the byte budget, without returning partial cues", async () => {
    const file = subtitleFile();
    let spent = 0;
    await expect(readSubtitles(async (a, b) => { spent += b - a; return file.slice(a, b); }, file.length, 2, 100)).rejects.toThrow("Subtitle read limit exceeded or truncated file");
    expect(spent).toBeLessThanOrEqual(100);
  });
});
