import { describe, expect, test } from "vitest";
import { landing, skippedAt, type Part } from "../src/features/player/skips";

// IntroDB's times for Attack on Titan season 1 (tt2560140).
const aot = (recap: [number, number], intro: [number, number]): Part<"recap" | "intro">[] => [
  { part: "intro", start: intro[0], end: intro[1] },
  { part: "recap", start: recap[0], end: recap[1] },
];
const e9 = aot([17.043, 52.79], [38.271, 128.271]); // the recap ends 14.5 s into the intro
const e7 = aot([17.278, 129.11], [122.482, 212.482]); // 6.6 s in
const e18 = aot([8.756, 135.298], [135.364, 225.364]); // back to back
const e22 = aot([1, 99], [100.458, 190.458]); // 1.5 s apart
const e12 = aot([16.583, 132.5], [145, 235]); // a 12.5 s scene between

describe("landing", () => {
  test("skipping a recap that ends inside the intro skips the intro too", () => {
    expect(landing(e9, 52.79)).toBe(128.271);
    expect(landing(e7, 129.11)).toBe(212.482);
  });

  test("parts that touch or nearly touch go in one seek", () => {
    expect(landing(e18, 135.298)).toBe(225.364);
    expect(landing(e22, 99)).toBe(190.458);
  });

  test("a scene between them still plays", () => {
    expect(landing(e12, 132.5)).toBe(132.5);
  });

  test("a part that doesn't skip itself is left alone", () => {
    const recapOnly = e9.filter((p) => p.part === "recap");
    expect(landing(recapOnly, 52.79)).toBe(52.79);
  });
});

describe("skippedAt", () => {
  test("names everything one seek passed, in order", () => {
    expect(skippedAt(e9, 128.271)).toEqual(["recap", "intro"]);
    expect(skippedAt(e18, 225.364)).toEqual(["recap", "intro"]);
  });

  test("a skip with a scene before it names only its own part", () => {
    expect(skippedAt(e12, 132.5)).toEqual(["recap"]);
    expect(skippedAt(e12, 235)).toEqual(["intro"]);
  });

  test("a seek that isn't the end of a part names nothing", () => {
    expect(skippedAt(e12, 600)).toEqual([]);
  });
});
