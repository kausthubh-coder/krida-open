import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { GATHER_MS, skipper } from "../src/features/player/skipping";

let seeks: number[];
let aims: (number | null)[];
const land = (t: number) => void seeks.push(t);
const make = () => skipper((t) => aims.push(t));

beforeEach(() => {
  vi.useFakeTimers();
  seeks = [];
  aims = [];
});
afterEach(() => vi.useRealTimers());

test("one press lands at once, and nothing follows", () => {
  const skips = make();
  skips.by(10, 60, 7200, land);
  expect(seeks).toEqual([70]);
  vi.advanceTimersByTime(GATHER_MS);
  expect(seeks).toEqual([70]);
  expect(aims.at(-1)).toBe(null);
});

test("quick presses: the first lands at once, the rest go once, after the last", () => {
  const skips = make();
  skips.by(-10, 600, 7200, land);
  vi.advanceTimersByTime(100);
  // The picture is at 590 and playing; the next presses count from the aim, not from the picture.
  skips.by(-10, 590.1, 7200, land);
  vi.advanceTimersByTime(250);
  skips.by(-10, 590.35, 7200, land);
  expect(seeks).toEqual([590]);
  expect(aims.at(-1)).toBe(570);
  vi.advanceTimersByTime(GATHER_MS - 1);
  expect(seeks).toEqual([590]);
  vi.advanceTimersByTime(1);
  expect(seeks).toEqual([590, 570]);
  expect(aims.at(-1)).toBe(null);
});

test("presses that come back to where the first landed don't seek again", () => {
  const skips = make();
  skips.by(10, 60, 7200, land);
  skips.by(-10, 70, 7200, land);
  skips.by(10, 70, 7200, land);
  vi.advanceTimersByTime(GATHER_MS);
  expect(seeks).toEqual([70]);
});

test("presses stop at the start and a second before the end", () => {
  const skips = make();
  skips.by(-10, 4, 7200, land);
  skips.by(-10, 0, 7200, land);
  vi.advanceTimersByTime(GATHER_MS);
  expect(seeks).toEqual([0]);
  skips.by(10, 7185, 7200, land);
  skips.by(10, 7195, 7200, land);
  vi.advanceTimersByTime(GATHER_MS);
  expect(seeks).toEqual([0, 7195, 7199]);
});

test("another seek in between drops where the presses aimed", () => {
  const skips = make();
  skips.by(10, 60, 7200, land);
  skips.by(10, 70, 7200, land);
  skips.cancel();
  vi.advanceTimersByTime(GATHER_MS);
  expect(seeks).toEqual([70]);
  expect(aims.at(-1)).toBe(null);
  // The next press starts afresh from the picture.
  skips.by(10, 300, 7200, land);
  expect(seeks).toEqual([70, 310]);
});

test("the player re-rendering between presses doesn't drop them: the gathered seek goes through the last press's land", () => {
  const skips = make();
  const later: number[] = [];
  skips.by(10, 60, 7200, land);
  skips.by(10, 70, 7200, (t) => void later.push(t));
  vi.advanceTimersByTime(GATHER_MS);
  expect(seeks).toEqual([70]);
  expect(later).toEqual([80]);
});
