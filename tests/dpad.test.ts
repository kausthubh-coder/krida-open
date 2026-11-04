// A TV remote's arrows on Krida's pages (src/ui/dpad.ts): which card or button is next in each direction.
import { describe, expect, test } from "vitest";
import { nearest } from "../src/ui/dpad";

const box = (left: number, top: number, width = 100, height = 150) => ({ left, top, right: left + width, bottom: top + height });
// Two rows of cards, 100 wide with 12 between, and a link on the right between them.
const row = (top: number, name: string) => [0, 1, 2, 3].map((i) => ({ item: `${name}${i}`, box: box(i * 112, top) }));
const page = [...row(0, "a"), { item: "see all", box: box(400, 170, 60, 20) }, ...row(200, "b")];

describe("the next thing in a direction", () => {
  test("right and left move along the row", () => {
    expect(nearest(box(112, 0), page, "right")).toBe("a2");
    expect(nearest(box(112, 0), page, "left")).toBe("a0");
  });

  test("down lands on the card under this one in the next row, not on what's nearer but off to the side", () => {
    expect(nearest(box(112, 0), page, "down")).toBe("b1");
    expect(nearest(box(224, 0), page, "down")).toBe("b2");
    // Straight under the last card, the link is nearest.
    expect(nearest(box(336, 0), page, "down")).toBe("see all");
  });

  test("up goes back to the row above", () => {
    expect(nearest(box(224, 200), page, "up")).toBe("a2");
  });

  test("nothing past the end", () => {
    expect(nearest(box(336, 0), page, "right")).toBe(undefined);
    expect(nearest(box(0, 0), page, "up")).toBe(undefined);
  });
});
