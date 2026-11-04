import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
import { useSubtitles } from "../src/features/player/useSubtitles";
import type { Me } from "../src/data/session";
import type { RoomData } from "../src/features/party";

// Supply the completed asynchronous discovery state; keep React's other state and memo behavior real.
const discovery = vi.hoisted(() => ({ next: true }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return { ...react, useState: (initial: unknown) => {
    if (discovery.next) {
      discovery.next = false;
      return react.useState({ tracks: [{ track: 7, language: "en", name: "Full", codec: "S_TEXT/UTF8" }], skipped: [], cues: [] });
    }
    return react.useState(initial);
  } };
});
vi.mock("../src/data/addons", () => ({ useAddons: () => [], addonJson: vi.fn() }));
vi.mock("../src/features/player/subtitles", async (original) => ({
  ...await original<typeof import("../src/features/player/subtitles")>(), useSubtitleOptions: () => [],
}));

test("useSubtitles exposes discovered tracks in the browser and auto-selects the profile's language", () => {
  const room = { media: { type: "movie", videoId: "tt1234567", imdbId: "tt1234567" }, stream: { size: 12345, subtitles: [] } } as unknown as RoomData;
  const me = { _id: "qa", prefs: { subLang: "eng" } } as unknown as Me;
  function Probe() {
    const result = useSubtitles(null, room, me, null);
    expect(result.fileSubs).toEqual([{ id: "file:7", lang: "eng", title: "Full · in the file" }]);
    expect([result.filePlayable, result.subId]).toEqual([true, "file:7"]);
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
});
