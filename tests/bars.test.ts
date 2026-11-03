import { describe, expect, test } from "vitest";
import { cropOf, look, NOTHING_SEEN, readFrame, type Finding, type FrameLight } from "../src/features/player/bars";

/**
 * mpv's picture of a frame as the app reads it, 960x540: black outside a picture that fills rows `top` to
 * 540 - `bottom` and columns `left` to 960 - `right`, with `lit` of its pixels lit. A 2.39:1 film in a 16:9 frame has
 * 69 black rows above and below.
 */
type Picture = { top?: number; bottom?: number; left?: number; right?: number; lit?: number };
function frame({ top = 0, bottom = top, left = 0, right = left, lit = 0.8 }: Picture = {}): FrameLight {
  const [width, height] = [960, 540];
  const [tall, wide] = [height - top - bottom, width - left - right];
  return {
    width,
    height,
    rows: Array.from({ length: height }, (_, i) => (i >= top && i < height - bottom ? (lit * wide) / width : 0)),
    cols: Array.from({ length: width }, (_, j) => (j >= left && j < width - right ? (lit * tall) / height : 0)),
  };
}
const FILM = { top: 69 };
const BARS = { v: 69 / 540, h: 0 };

/** The finding after looking at `frames` in turn, with what it said after each. */
function lookAt(frames: FrameLight[], from: Finding = NOTHING_SEEN) {
  const verdicts: (string | undefined)[] = [];
  let finding = from;
  for (const f of frames) {
    finding = look(finding, f);
    verdicts.push(typeof finding.verdict === "object" ? "bars" : finding.verdict);
  }
  return { finding, verdicts };
}

describe("one frame", () => {
  test("a bright widescreen film in a 16:9 frame shows its bars", () => {
    expect(readFrame(frame(FILM))).toEqual({ bars: BARS, bright: true });
  });

  test("a black frame is all bars and says nothing", () => {
    expect(readFrame(frame({ top: 270, bottom: 270 }))).toEqual({ bars: { v: 0.5, h: 0.5 }, bright: false });
  });

  test("a logo on black, a dark scene and a fade aren't bright enough to go by", () => {
    expect(readFrame(frame({ top: 250, left: 400 })).bright).toBe(false);
    expect(readFrame(frame({ ...FILM, lit: 0.1 })).bright).toBe(false);
    expect(readFrame(frame({ ...FILM, lit: 0.2 })).bright).toBe(false);
    expect(readFrame(frame({ ...FILM, lit: 0.3 })).bright).toBe(true);
  });

  test("where one side looks thicker, the dark is the picture's, so the thinner side counts", () => {
    expect(readFrame(frame({ top: 69, bottom: 120 })).bars).toEqual(BARS);
    expect(readFrame(frame({ left: 120, right: 90 })).bars).toEqual({ v: 0, h: 90 / 960 });
  });

  test("subtitles in the bottom bar keep it from being trimmed away", () => {
    const f = frame(FILM);
    for (let row = 500; row < 511; row++) f.rows[row] = 0.2;
    expect(readFrame(f).bars).toEqual({ v: 29 / 540, h: 0 });
  });
});

/** `n` of the same frame, as a film shows a picture look after look. */
const times = (n: number, f: FrameLight) => Array.from({ length: n }, () => f);

describe("settling on a film's bars", () => {
  test("a bright widescreen film settles on its bars once they've held for 20 seconds of film", () => {
    // The first look and 10 more, 2 seconds of film apart.
    const { finding, verdicts } = lookAt(times(11, frame(FILM)));
    expect(verdicts).toEqual([...Array(10).fill(undefined), "bars"]);
    expect(finding.verdict).toEqual(BARS);
  });

  test("a dark opening never settles; bright frames after it with the same bars do", () => {
    const dark = [frame({ top: 270 }), frame({ top: 250, left: 400 }), frame({ ...FILM, lit: 0.05 }), frame({ ...FILM, lit: 0.1 })];
    // Half a minute of dark opening: the dim frames show the film's bars, but none is bright enough to go by.
    const { finding, verdicts } = lookAt([...dark, ...dark, ...dark, ...dark, ...times(4, frame(FILM))]);
    expect(verdicts).toEqual([...Array(19).fill(undefined), "bars"]);
    expect(finding.verdict).toEqual(BARS);
  });

  test("a fade in, with the picture's edges lighting last, waits until the bars stop getting thinner", () => {
    const fade = [frame({ top: 140, lit: 0.3 }), frame({ top: 110, lit: 0.4 }), frame({ top: 90, lit: 0.6 }), frame({ ...FILM, lit: 0.7 })];
    const { finding, verdicts } = lookAt([...fade, ...times(10, frame(FILM))]);
    expect(verdicts).toEqual([...Array(13).fill(undefined), "bars"]);
    expect(finding.verdict).toEqual(BARS);
  });

  test("a bright shot with dark edges in a film's shape doesn't settle them, and the whole frame after it shows none", () => {
    // A 16:9 film opening on 16 seconds of a lit street between dark sky and ground: bands of 2:1, 2.39:1 and 2.76:1.
    for (const top of [30, 69, 95]) {
      const { finding, verdicts } = lookAt([...times(8, frame({ top })), frame(), frame()]);
      expect([top, verdicts]).toEqual([top, [...Array(8).fill(undefined), "none", "none"]]);
      expect(finding.verdict).toBe("none");
    }
  });

  test("dark on all four sides, a lit doorway, isn't trimmed: only one pair of bars ever is, and one alone isn't a film's shape", () => {
    const { verdicts } = lookAt([...times(30, frame({ top: 108, left: 192 })), frame()]);
    expect(verdicts).toEqual([...Array(30).fill(undefined), "none"]);
  });

  test("a widescreen film darker at its sides is trimmed above and below only", () => {
    const { finding } = lookAt(times(11, frame({ ...FILM, left: 12 })));
    expect(finding.verdict).toEqual(BARS);
  });

  test("a long scene with dark sky and ground isn't trimmed: its shape isn't a film's; the film after it is", () => {
    // A bright band 280 rows tall, a 3.4:1 shape: twelve frames of it, then the whole picture.
    const { finding, verdicts } = lookAt([...times(12, frame({ top: 130 })), ...times(11, frame(FILM))]);
    expect(verdicts).toEqual([...Array(22).fill(undefined), "bars"]);
    expect(finding.verdict).toEqual(BARS);
  });

  test("bars that leave a shape no film is made in are never trimmed, and after 120 looks the film is left whole, unsure", () => {
    // 3.4:1, and 2.31:1, 2% short of 2.35:1: real bars come within half a percent of a film's shape.
    for (const top of [130, 62]) {
      const { verdicts } = lookAt(times(120, frame({ top })));
      expect([top, verdicts]).toEqual([top, [...Array(119).fill(undefined), "unsure"]]);
    }
  });

  test("a frame lit to its edges settles on none at once", () => {
    expect(lookAt([frame()]).verdicts).toEqual(["none"]);
  });

  test("bars thinner than a hundredth aren't trimmed", () => {
    expect(lookAt([frame({ top: 4 })]).verdicts).toEqual(["none"]);
  });

  test("a frame showing picture where the bars were makes them thinner, before they settle", () => {
    // IMAX: the film opens up to the whole 16:9 frame for a scene.
    const { finding, verdicts } = lookAt([...times(5, frame(FILM)), frame()]);
    expect(verdicts).toEqual([...Array(5).fill(undefined), "none"]);
    expect(finding.thinnest).toEqual({ v: 0, h: 0 });
  });

  test("once settled, nothing changes it", () => {
    const settled = lookAt(times(11, frame(FILM))).finding;
    expect(look(settled, frame())).toBe(settled);
  });

  test("a film too dark to tell is left whole after 120 frames, unsure", () => {
    const { verdicts } = lookAt(times(120, frame({ ...FILM, lit: 0.1 })));
    expect(verdicts.at(-2)).toBe(undefined);
    expect(verdicts.at(-1)).toBe("unsure");
  });

  test("pillarboxed films settle on their side bars", () => {
    // A 4:3 show in a 16:9 frame.
    expect(lookAt(times(11, frame({ left: 120 }))).finding.verdict).toEqual({ v: 0, h: 120 / 960 });
  });
});

describe("mpv's crop", () => {
  test("trims the bars off the film in its own pixels", () => {
    expect(cropOf(BARS, 3840, 2160)).toBe("3840x1608+0+276");
    expect(cropOf(BARS, 1920, 1080)).toBe("1920x804+0+138");
    expect(cropOf({ v: 0, h: 120 / 960 }, 1920, 1080)).toBe("1440x1080+240+0");
  });

  test("keeps every pixel of picture, trimming to an even row short of an odd edge", () => {
    expect(cropOf({ v: 0.1, h: 0 }, 1280, 723)).toBe("1280x579+0+72");
  });
});
