import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { SpeedChoice } from "../src/features/player/SpeedChoice";
import { SubtitleMenu } from "../src/features/player/controls";

test("speed menu offers all seven speeds and selects the current speed", () => {
  const html = renderToStaticMarkup(createElement(SpeedChoice, { speed: { speed: 1.75, setSpeed: () => {} } }));
  expect(html.replace(/ class="bg-overlay text-fg"/g, "").match(/<option[^>]*>[^<]*<\/option>/g)).toEqual([
    '<option value="0.5">0.5×</option>', '<option value="0.75">0.75×</option>',
    '<option value="1">1× · Normal</option>', '<option value="1.25">1.25×</option>',
    '<option value="1.5">1.5×</option>', '<option value="1.75" selected="">1.75×</option>',
    '<option value="2">2×</option>',
  ]);
});

test("party menu explains its synced speed and offers no speed control", () => {
  expect(renderToStaticMarkup(createElement(SpeedChoice, { speed: null }))).toBe('<p class="px-3 py-2 text-body text-fg-muted">Parties play at 1× to stay in sync.</p>');
});

test("subtitle menu offers the accepted files, selected local track and empty-file feedback", () => {
  const html = renderToStaticMarkup(createElement(SubtitleMenu, {
    fileTracks: [], filePlayable: false, options: [], current: "local:one", error: false, offset: 0.1,
    onOffset: () => {}, onPick: () => {}, localSubs: [{ id: "local:one", name: "My captions.ass" }],
    onLoadFile: async () => {}, fileError: "This subtitle file has no cues.",
  }));
  expect(html.includes('accept=".srt,.vtt,.ass,.ssa"')).toBe(true);
  expect(html.includes("Load a subtitle file")).toBe(true);
  expect(html.match(/<button[^>]*aria-pressed="true"[^>]*>.*?<\/button>/g)?.length).toBe(1);
  expect(html.includes("My captions.ass")).toBe(true);
  expect(html.includes('role="alert"')).toBe(true);
  expect(html.includes("This subtitle file has no cues.")).toBe(true);
  expect(html.includes('aria-label="Show subtitles 0.1 seconds earlier (G)"')).toBe(true);
  expect(html.includes('aria-label="Show subtitles 0.1 seconds later (H)"')).toBe(true);
});
