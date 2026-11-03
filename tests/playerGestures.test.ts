import { describe, expect, test } from "vitest";
import { nextSpeed } from "../src/features/player/playback";
import { scrubSpan } from "../src/features/player/touch";

describe("speed", () => {
  test("steps through the list and stops at its ends", () => {
    expect(nextSpeed(1, 1)).toBe(1.25);
    expect(nextSpeed(1, -1)).toBe(0.75);
    expect(nextSpeed(2, 1)).toBe(2);
    expect(nextSpeed(0.5, -1)).toBe(0.5);
  });
  test("a speed off the list steps from normal", () => {
    expect(nextSpeed(1.1, 1)).toBe(1.25);
  });
});

describe("scrubbing across the picture", () => {
  test("covers a quarter of the film, between a minute and a half and ten minutes", () => {
    expect(scrubSpan(22 * 60)).toBe(330);
    expect(scrubSpan(3 * 3600)).toBe(600);
    expect(scrubSpan(5 * 60)).toBe(90);
  });
  test("never more than the whole of a short video", () => {
    expect(scrubSpan(60)).toBe(60);
  });
});
