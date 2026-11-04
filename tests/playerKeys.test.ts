import { describe, expect, test, vi } from "vitest";
import { handlePlayerKey, PLAYER_SHORTCUTS, type Keys } from "../src/features/player/keys";
import { nextSpeed } from "../src/features/player/playback";

function controls() {
  return {
    video: null, menu: null, setMenu: vi.fn(), wake: vi.fn(), togglePlay: vi.fn(), skipBy: vi.fn(),
    setVolume: vi.fn(), toggleFullscreen: vi.fn(), toggleSubtitles: vi.fn(), skip: vi.fn(),
    playNext: vi.fn(), episodes: vi.fn(), reactions: true, speed: vi.fn(), pictureInPicture: vi.fn(),
    cycleFit: vi.fn(), toggleBars: vi.fn(), subtitleDelay: vi.fn(), shortcuts: vi.fn(),
  } satisfies Keys;
}
function press(key: string, keys: Keys, editable = false, shiftKey = false) {
  const event = { key, shiftKey, target: { closest: (selector: string) => editable && selector.includes("input") ? {} : null }, preventDefault: vi.fn() };
  handlePlayerKey(event as unknown as KeyboardEvent, keys);
}

describe("player keyboard shortcuts", () => {
  test("G and H adjust subtitle delay and question mark opens shortcuts", () => {
    const keys = controls();
    press("g", keys); press("H", keys); press("?", keys);
    expect(keys.subtitleDelay.mock.calls).toEqual([[-1], [1]]);
    expect(keys.shortcuts.mock.calls).toEqual([[]]);
    expect(keys.setMenu.mock.calls).toEqual([[null]]);
    expect(keys.wake.mock.calls).toEqual([[], [], []]);
  });
  test("ignores typing in fields", () => {
    const keys = controls();
    for (const key of ["g", "h", "?", "k"]) press(key, keys, true);
    expect(keys.subtitleDelay.mock.calls).toEqual([]);
    expect(keys.shortcuts.mock.calls).toEqual([]);
    expect(keys.togglePlay.mock.calls).toEqual([]);
  });
  test("keeps transport, next episode and speed bindings", () => {
    const keys = controls();
    for (const key of [" ", "k", "j", "ArrowLeft", "l", "ArrowRight", ">", "<"]) press(key, keys);
    press("N", keys, false, true);
    press("n", keys);
    expect(keys.togglePlay.mock.calls).toEqual([[], []]);
    expect(keys.skipBy.mock.calls).toEqual([[-10], [-10], [10], [10]]);
    expect(keys.speed.mock.calls).toEqual([[1], [-1]]);
    expect(keys.playNext.mock.calls).toEqual([[]]);
  });
  test("party speed keys have no effect", () => {
    const keys = controls();
    press(">", { ...keys, speed: null });
    expect(keys.speed.mock.calls).toEqual([]);
  });
  test("the sheet table has no colliding bindings and describes every dispatch entry", () => {
    const bindings = PLAYER_SHORTCUTS.flatMap((s) => s.keys.map((k) => `${s.shift ? "shift:" : ""}${k}`));
    expect(new Set(bindings).size).toBe(bindings.length);
    expect(PLAYER_SHORTCUTS.filter((s) => !s.label || !s.description)).toEqual([]);
  });
});

test("speed steps include 1.75 and stop at the offered limits", () => {
  expect(nextSpeed(1.5, 1)).toBe(1.75);
  expect(nextSpeed(1.75, 1)).toBe(2);
  expect(nextSpeed(2, -1)).toBe(1.75);
  expect(nextSpeed(2, 1)).toBe(2);
  expect(nextSpeed(0.5, -1)).toBe(0.5);
});
