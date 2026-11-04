import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";
import { useNativeVideo } from "../src/features/player/androidPlayer";
import { SubtitleMenu } from "../src/features/player/controls";
import type { MpvVideo } from "../src/features/player/desktop";

vi.mock("../src/ui/android", () => ({
  android: { playerLoad: vi.fn(), playerSet: vi.fn() },
  androidAtLeast: () => true,
  onAndroid: () => () => {},
}));
afterEach(() => vi.unstubAllGlobals());

test("Android hides timing for native file subtitles and keeps it for page-rendered subtitles", () => {
  const menu = (current: string, native = true) => renderToStaticMarkup(createElement(SubtitleMenu, {
    native, fileTracks: [{ id: "file:1", lang: "eng" }], filePlayable: true, options: [{ id: "addon", lang: "eng" }],
    current, error: false, offset: 0, onOffset: () => {}, onPick: () => {},
    localSubs: [{ id: "local:1", name: "Local" }], onLoadFile: async () => {}, fileError: null,
  }));
  expect(menu("file:1").includes("Show subtitles 0.1 seconds earlier")).toBe(false);
  expect(menu("addon").includes("Show subtitles 0.1 seconds earlier")).toBe(true);
  expect(menu("local:1").includes("Show subtitles 0.1 seconds earlier")).toBe(true);
  // TorBox's HLS in the Android app: the page draws the file's tracks it read, so their timing still moves.
  expect(menu("file:1", false).includes("Show subtitles 0.1 seconds earlier")).toBe(true);
});

test("Android suppresses G/H only while native file subtitles are selected and removes its listener on detach", async () => {
  const events = new EventTarget();
  vi.stubGlobal("addEventListener", events.addEventListener.bind(events));
  vi.stubGlobal("removeEventListener", events.removeEventListener.bind(events));
  const videos: MpvVideo[] = [];
  function Probe() {
    const video = useNativeVideo(true);
    if (video) videos.push(video);
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  const video = videos[0]!;
  const detach = video.attach();
  await Promise.resolve();
  const key = (letter: string) => {
    const event = new Event("keydown", { cancelable: true });
    Object.defineProperties(event, {
      key: { value: letter }, target: { value: { closest: () => null } },
    });
    events.dispatchEvent(event);
    return event.defaultPrevented;
  };
  video.setSubtitles(1, 0);
  expect([key("g"), key("H"), key("c")]).toEqual([true, true, false]);
  video.setSubtitles(null, 0);
  expect([key("g"), key("h")]).toEqual([false, false]);
  video.setSubtitles(1, 0);
  detach();
  expect(key("g")).toBe(false);
});
