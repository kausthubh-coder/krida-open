import { describe, expect, test } from "vitest";
import { parseSubtitles, readSubtitleFile, shiftSubtitleDelay } from "../src/features/player/subtitles";

describe("ASS and SSA subtitles", () => {
  test("reads Dialogue in Events, strips overrides, preserves commas and line breaks, skips comments", () => {
    expect(parseSubtitles(`[Script Info]
Title: Test
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Comment: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Hidden
Dialogue: 0,0:00:02.50,0:00:04.75,Default,,0,0,0,,{\\i1}Hello, world{\\i0}\\NNext\\nline
[Fonts]
Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,Not an event`)).toEqual([
      { start: 2.5, end: 4.75, html: "Hello, world<br>Next<br>line" },
    ]);
  });
  test("honours reordered Format fields and SSA marked events, sorts cues and escapes HTML", () => {
    expect(parseSubtitles(`[Events]
Format: End, Text, Start, Marked
Dialogue: 0:01:03.00,Later,0:01:02.00,Marked=0
Dialogue: 0:00:02.25,<b>Hello</b>, friend,0:00:01.50,Marked=0
Dialogue: broken,Ignore,0:00:01.00,Marked=0
Dialogue: 0:00:01.00,Backwards,0:00:02.00,Marked=0`)).toEqual([
      { start: 1.5, end: 2.25, html: "&lt;b&gt;Hello&lt;/b&gt;, friend" },
      { start: 62, end: 63, html: "Later" },
    ]);
  });
  test("keeps SRT and VTT working", () => {
    for (const text of ["1\n00:00:01,500 --> 00:00:02,250\nHello", "WEBVTT\n\n00:01.500 --> 00:02.250\nHello"])
      expect(parseSubtitles(text)).toEqual([{ start: 1.5, end: 2.25, html: "Hello" }]);
  });
});

describe("loading a viewer's subtitle file", () => {
  test("reads File.text and returns a selectable track with the filename and parsed cues", async () => {
    const file = new File(["1\n00:00:01,000 --> 00:00:02,000\nHello"], "my subtitles.srt");
    const track = await readSubtitleFile(file);
    expect(track.id.startsWith("local:")).toBe(true);
    expect(track.name).toBe("my subtitles.srt");
    expect(track.cues).toEqual([{ start: 1, end: 2, html: "Hello" }]);
  });
  test("reports files without cues plainly", async () => {
    await expect(readSubtitleFile(new File(["[Events]\nComment: no dialogue"], "empty.ass"))).rejects.toThrow("This subtitle file has no cues. Try an SRT, VTT, ASS or SSA file.");
  });
  test("delay steps by tenths without accumulating rounding errors", () => {
    expect(shiftSubtitleDelay(0, -1)).toBe(-0.1);
    expect(shiftSubtitleDelay(0, 1)).toBe(0.1);
    expect(shiftSubtitleDelay(0.2, 1)).toBe(0.3);
    expect(shiftSubtitleDelay(-0.1, 1)).toBe(0);
  });
});
