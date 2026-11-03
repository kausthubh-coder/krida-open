// Black bars built into a film. A widescreen film is often stored in a 16:9 frame with black bands above and below
// it, so on a screen wider than 16:9 the picture sits boxed in, with black on all four sides. In the app, mpv says how
// lit each row and column of the frame playing is (mpv_frame_light in desktop/src-tauri/src/mpv.rs); this decides
// from those frames, over at least 20 seconds of film, where the film's picture really ends, and MpvVideo
// (desktop.ts) trims the rest. A wrong trim cuts picture for the whole film, so when in doubt it leaves the film whole.

/** How lit a frame is: for each row from the top, then each column from the left, the share brighter than LIT_LEVEL. */
export type FrameLight = { width: number; height: number; rows: number[]; cols: number[] };

/** Bars on each side, as shares of the frame: `v` above and below, `h` left and right. */
export type Bars = { v: number; h: number };

/**
 * What the frames looked at so far say. A dark frame (a night scene, a fade, a logo on black) is black at its edges
 * whether or not the film is, so a frame can show bars too thick but never too thin: the thinnest bars seen are the
 * film's, once they've held for longer than one shot with dark edges lasts, through bright frames.
 */
export type Finding = {
  looked: number;
  thinnest: Bars | null;
  /** The thinnest bars when they last got thinner, the looks after that one, and how many of them all were bright. */
  since: { bars: Bars; looks: number; bright: number } | null;
  /**
   * The bars to trim; none when the film has none; unsure when it gave up without knowing (bars in no film's shape, or
   * a film too dark to tell), so the Picture menu can point at Crop; undefined while still looking.
   */
  verdict?: Bars | "none" | "unsure";
};
export const NOTHING_SEEN: Finding = { looked: 0, thinnest: null, since: null };

/** Brighter than this, of 255, is picture. Bars are black, and the compression noise beside them stays under it. */
export const LIT_LEVEL = 24;
/** A row or column with at most this share lit is black. */
const BLACK = 0.005;
/** A frame is bright enough to go by when its picture covers at least half of it each way, a quarter of it lit. */
const MIN_PICTURE = 0.5;
const MIN_LIT = 0.25;
/** Bars this close, as a share of the frame, are the same bars: a row or two of mpv's picture. */
const SAME = 0.004;
/** Thinner bars aren't worth trimming. */
const MIN_BAR = 0.01;
/**
 * Shapes films are made in, width over height, and how near one the picture left must come. Real bars leave one to
 * within half a percent; a scene's dark edges leave any shape, so anything else is left whole.
 */
const FILM_SHAPES = [1.33, 1.37, 1.43, 1.66, 1.78, 1.85, 1.9, 2, 2.2, 2.35, 2.39, 2.4, 2.55, 2.76];
const SHAPE_TOLERANCE = 0.01;
/**
 * Looks after the bars were first seen, 2 seconds of film apart, that must show none thinner before they settle: 20
 * seconds, longer than a shot usually lasts, so a shot with dark edges can't settle them alone. 4 frames must be bright.
 */
const HOLD = 10;
const AGREE = 4;
/** A film this dark this long, or with bars in no film's shape, is left whole. */
const MAX_LOOKS = 120;

/** A frame's bars, and whether it's bright enough to say where its picture ends. */
export function readFrame({ rows, cols }: FrameLight): { bars: Bars; bright: boolean } {
  const [top, bottom] = [leading(rows), leading(rows.toReversed())];
  const [left, right] = [leading(cols), leading(cols.toReversed())];
  // A film's bars are the same on both sides; where one side looks thicker, the dark is the picture's own.
  const bars = {
    v: Math.min(top, bottom, rows.length / 2) / Math.max(rows.length, 1),
    h: Math.min(left, right, cols.length / 2) / Math.max(cols.length, 1),
  };
  const picture = rows.slice(top, rows.length - bottom);
  const tall = picture.length / Math.max(rows.length, 1);
  const wide = Math.max(cols.length - left - right, 0) / Math.max(cols.length, 1);
  // The bars are black, so the picture's own columns hold every lit pixel of its rows.
  const lit = picture.reduce((sum, share) => sum + share, 0) / Math.max(picture.length * wide, Number.EPSILON);
  return { bars, bright: tall >= MIN_PICTURE && wide >= MIN_PICTURE && lit >= MIN_LIT };
}

/** How many of `shares`, from the start, are black. */
function leading(shares: number[]) {
  let n = 0;
  while (n < shares.length && shares[n]! <= BLACK) n++;
  return n;
}

/** What one more frame, looked at a few seconds of film after the last, adds to `finding`. */
export function look(finding: Finding, frame: FrameLight): Finding {
  if (finding.verdict) return finding;
  const { bars, bright } = readFrame(frame);
  const was = finding.thinnest;
  const thinnest = was ? { v: Math.min(was.v, bars.v), h: Math.min(was.h, bars.h) } : bars;
  const counts = bright ? 1 : 0;
  const since =
    !finding.since || thinnest.v < finding.since.bars.v - SAME || thinnest.h < finding.since.bars.h - SAME
      ? { bars: thinnest, looks: 0, bright: counts }
      : { ...finding.since, looks: finding.since.looks + 1, bright: finding.since.bright + counts };
  const next = { looked: finding.looked + 1, thinnest, since };
  return { ...next, verdict: verdictOf(next, frame) };
}

function verdictOf({ looked, thinnest, since }: Finding, frame: FrameLight): Finding["verdict"] {
  if (!thinnest || !since) return undefined;
  // Only the thicker pair is trimmed. Dark on all four sides is a dark scene's (a lit doorway, a stage), and trimming
  // both pairs would zoom the whole film.
  const bars = thinnest.v >= thinnest.h ? { v: thinnest.v, h: 0 } : { v: 0, h: thinnest.h };
  // Bars only ever get thinner, so once they're too thin to trim, that's final.
  if (Math.max(bars.v, bars.h) < MIN_BAR) return "none";
  const shape = (frame.width * (1 - 2 * bars.h)) / (frame.height * (1 - 2 * bars.v));
  const filmShape = FILM_SHAPES.some((s) => Math.abs(shape / s - 1) < SHAPE_TOLERANCE);
  if (filmShape && since.looks >= HOLD && since.bright >= AGREE) return bars;
  return looked >= MAX_LOOKS ? "unsure" : undefined;
}

/** mpv's video-crop that trims `bars` off a `width`x`height` film: even pixels, and never into the picture. */
export function cropOf({ v, h }: Bars, width: number, height: number) {
  const x = 2 * Math.floor((h * width) / 2 + 1e-6);
  const y = 2 * Math.floor((v * height) / 2 + 1e-6);
  return `${width - 2 * x}x${height - 2 * y}+${x}+${y}`;
}
