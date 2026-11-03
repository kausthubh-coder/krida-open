// The picture above the timeline while you point at it or drag it. Pictures are keyframes, decoded in the browser
// (keyframes.ts), from one of two places:
// - The film's own file, when it's an MKV with an index of its keyframes: a keyframe's few hundred KB read out of the
//   file in about half a second, several at once. TorBox's links carry the account key, so a server reads them: the
//   frames Worker on Cloudflare (workers/frames) when there's a ticket for it, else Krida's server (api/frame.ts).
// - Otherwise TorBox's HLS: the first frame of a segment. TorBox makes a segment the first time anyone asks for it
//   (1.5 to 2.5 s) and only one at a time, so this is the slow way.
// From Play, a storyboard of pictures spread over the title fills in: one every 10 s through the Worker, which costs
// nothing per byte, and one every 90 s through Vercel, whose free plan pauses the site past 10 GB a month. While you
// point at the bar it fills in nearest the pointer first. Frames the main video shows are kept too. Pictures from the
// file are kept on this device (previewCache.ts), so a title watched before has them at once. Pointing at the bar
// shows the nearest picture at once, then the exact one.
import { useEffect, useMemo } from "react";
import { FileError, frameTicket, keyframe, keyframeIndex, SlowDown } from "../../data/api";
import { codecFromRecord, DecodeError, decodeKeyframe, fetchKeyframe } from "./keyframes";
import { keepPicture, keptPictures, toJpeg } from "./previewCache";

/** Stored width: the card is 176px, so this stays sharp up to a 1.8x screen. */
const WIDTH = 320;
/** Seconds between storyboard pictures, and at most how many: 1,200 at 10 s is 3 h 20 min, about 12 MB of JPEGs. */
const DENSE = { spacing: 10, most: 1200 };
const SPARSE = { spacing: 90, most: 120 };
/** Frames from the main video as it plays, the least recently seen let go first: about 18 MB. */
const KEEP = 80;
/** Storyboard pictures are kept as JPEGs; this many stay decoded for drawing. */
const DECODED = 24;
/** A pointer passing over the bar on its way to a button asks for nothing. */
const REST_MS = 100;
/** How far either side of the pointer to look for a kept picture, in keyframes. */
const REACH = 400;
/** At least this long without asking, after TorBox says to slow down. */
const SLOW_DOWN_MS = 10_000;

export type PreviewState = { shown: boolean; stale: boolean };
/** A picture: a JPEG (storyboard and pointer) or a decoded frame (from the main video). */
type Frame = { t: number; blob?: Blob; bitmap?: ImageBitmap };

/** Where pictures come from: their places in time, and how to get one. */
type Source = {
  /** Each picture's time in seconds, ascending. */
  starts: number[];
  /** Pictures asked for at once: TorBox's HLS makes one segment at a time; a file's own bytes come several at once. */
  lanes: number;
  /** The storyboard's density. It can thin out, when the Worker stops answering. */
  density: { spacing: number; most: number };
  /** The file's size, when its pictures are kept on this device under it. */
  file?: number;
  picture: (index: number, signal: AbortSignal) => Promise<ImageBitmap | null>;
};

export class FramePreview {
  private src: string;
  private size: number | undefined;
  /** Bumped by `destroy`, so work started before it lets its result go. */
  private generation = 0;
  private source: Source | null = null;
  private loadingSource: Promise<void> | null = null;
  private board = new Map<number, Frame>();
  private recent = new Map<number, Frame>();
  private decoded = new Map<Frame, ImageBitmap>();
  /** Storyboard places still to fetch, ranked so any first part covers the bar evenly; null until it starts. */
  private boardQueue: { index: number; rank: number }[] | null = null;
  private boardLoads = new Set<AbortController>();
  /** Storyboard places that failed once and went back in the queue. */
  private retried = new Set<number>();
  /** Storyboard requests running now. */
  private lanes = 0;
  /** Places being fetched right now, by the storyboard or the pointer, so neither asks for one twice. */
  private loading = new Set<number>();
  /** Pictures that failed to decode in a row. After a few, this browser can't: only the main video's frames show. */
  private failures = 0;
  /** TorBox said to slow down: nothing is asked for until then. */
  private quietUntil = 0;
  private main: HTMLVideoElement | null = null;
  /** The time under the pointer, or null when nobody is looking, and when the pointer came onto the bar. */
  private target: number | null = null;
  private hoverSince = 0;
  /** The keyframe under the pointer and when it got there. */
  private pointedAt = { index: -1, since: 0 };
  private pointed: AbortController | null = null;
  /** Pointer pictures that failed while the pointer is on the bar: not asked for again until it comes back. */
  private pointerFailed = new Set<number>();
  /** Pointer pictures asked for at the sparse density, which Vercel or TorBox's HLS pays for. */
  private sparsePointers = 0;
  private restTimer = 0;
  private canvas: HTMLCanvasElement | null = null;
  private drawn: Frame | null = null;
  /** The picture waiting to be decoded for the card. */
  private wanted: Frame | null = null;
  private state: PreviewState = { shown: false, stale: false };
  private listener: ((state: PreviewState) => void) | null = null;

  constructor(src: string, size: number | undefined) {
    this.src = src;
    this.size = size;
  }

  /** Where the pictures go, and who hears whether one is showing. */
  attach(canvas: HTMLCanvasElement | null, listener: ((state: PreviewState) => void) | null) {
    this.canvas = canvas;
    this.listener = listener;
    // A new canvas starts blank, whatever the last one showed.
    this.drawn = null;
    this.state = { shown: false, stale: false };
    listener?.(this.state);
    if (canvas && this.target !== null) this.show(this.target);
  }

  /** Show the picture at `t`: the nearest one kept at once, the exact one as soon as it comes. */
  show(t: number) {
    if (this.target === null) {
      this.hoverSince = performance.now();
      this.pointerFailed.clear();
    }
    this.target = t;
    if (!this.source) {
      void this.start();
      return;
    }
    const index = this.index(t);
    if (index !== this.pointedAt.index) this.pointedAt = { index, since: performance.now() };
    const near = this.nearest(index);
    if (near) this.draw(near);
    this.refresh();
    this.fillLanes();
    this.pump();
  }

  /** Nobody is looking. What's on its way still comes and is kept; the storyboard slows to one at a time. */
  hide() {
    this.target = null;
    this.pointedAt = { index: -1, since: 0 };
    this.pointerFailed.clear();
    window.clearTimeout(this.restTimer);
    this.restTimer = 0;
  }

  /** Finds the pictures as the player opens, starts the storyboard at Play, and keeps the main video's frames. */
  watch(main: HTMLVideoElement) {
    this.main = main;
    void this.loadSource();
    const playing = () => void this.start();
    const paused = () => this.fillLanes();
    const keep = () => {
      if (!this.source || main.paused || main.seeking || main.readyState < 2 || !main.videoWidth) return;
      const index = this.index(main.currentTime);
      if (this.has(index)) return;
      const t = main.currentTime;
      const generation = this.generation;
      void createImageBitmap(main, { resizeWidth: WIDTH, resizeHeight: Math.round((WIDTH * main.videoHeight) / main.videoWidth) })
        .then((bitmap) => (generation === this.generation ? this.keep(this.recent, index, { bitmap, t }) : bitmap.close()))
        .catch(() => {});
    };
    main.addEventListener("playing", playing, { once: true });
    main.addEventListener("pause", paused);
    main.addEventListener("timeupdate", keep);
    return () => {
      main.removeEventListener("playing", playing);
      main.removeEventListener("pause", paused);
      main.removeEventListener("timeupdate", keep);
      this.main = null;
    };
  }

  /** Lets go of everything. Asked again, it starts over. */
  destroy() {
    this.generation++;
    this.hide();
    this.pointed?.abort();
    this.pointed = null;
    for (const load of this.boardLoads) load.abort();
    this.boardLoads.clear();
    this.boardQueue = null;
    this.retried.clear();
    this.lanes = 0;
    this.loading.clear();
    this.sparsePointers = 0;
    this.source = null;
    this.loadingSource = null;
    for (const frame of [...this.board.values(), ...this.recent.values()]) frame.bitmap?.close();
    for (const bitmap of this.decoded.values()) bitmap.close();
    this.board.clear();
    this.recent.clear();
    this.decoded.clear();
    this.drawn = null;
    this.wanted = null;
  }

  private async start() {
    await this.loadSource();
    if (this.source && !this.boardQueue) {
      const { starts } = this.source;
      this.boardQueue = storyboardOrder(starts.length, boardSize(starts.at(-1) ?? 0, this.source.density)).map((index, rank) => ({ index, rank }));
      this.fillLanes();
    }
    if (this.target !== null) this.show(this.target);
  }

  /** The file's own keyframes when a server can read them, else TorBox's HLS; with what this device kept. */
  private loadSource() {
    const generation = this.generation;
    this.loadingSource ??= (async () => {
      // No HLS and no size (another debrid service's file): there's nothing to take pictures from.
      const source = (this.size ? await fileSource(this.size).catch(() => null) : null) ?? (this.src ? await hlsSource(this.src) : null);
      if (generation !== this.generation || !source) return;
      this.source = source;
      if (!source.file) return;
      for (const [index, blob] of await keptPictures(source.file).catch(() => new Map<number, Blob>())) {
        if (generation !== this.generation) return;
        if (index < source.starts.length) this.board.set(index, { t: source.starts[index], blob });
      }
    })().catch(() => {
      // Try again on the next look.
      if (generation === this.generation) this.loadingSource = null;
    });
    return this.loadingSource;
  }

  /**
   * Asks for the exact picture under the pointer, one at a time. Through the Worker it follows the pointer once it has
   * been on the bar a moment. At the sparse density each one costs Vercel's bandwidth (or a slow HLS segment), so only
   * where the pointer rests, as before the Worker, and at most as many as the storyboard.
   */
  private pump() {
    const source = this.source;
    if (this.target === null || !source || !this.decodes() || this.pointed) return;
    const cheap = source.density === DENSE;
    if (!cheap && this.sparsePointers >= SPARSE.most) return;
    // After TorBox's slow-down it tries again by itself, so a pointer resting there gets its picture.
    const wait = Math.max(this.quietUntil, (cheap ? this.hoverSince : this.pointedAt.since) + REST_MS) - performance.now();
    if (wait > 0) {
      this.restTimer ||= window.setTimeout(() => {
        this.restTimer = 0;
        this.pump();
      }, wait);
      return;
    }
    const index = this.index(this.target);
    if (this.has(index) || this.loading.has(index) || this.pointerFailed.has(index)) return;
    if (!cheap) this.sparsePointers++;
    void this.fetchPointed(index);
  }

  private async fetchPointed(index: number) {
    const pointed = new AbortController();
    this.pointed = pointed;
    const generation = this.generation;
    // Moving on doesn't cancel it: it comes in a moment and is kept, and the next one starts when it's done.
    const frame = await this.picture(index, pointed.signal);
    if (generation !== this.generation) return;
    this.pointed = null;
    if (frame) this.keep(this.board, index, frame);
    // A failed one isn't asked for again while the pointer stays, or a pointer resting on it would ask forever. One
    // TorBox wouldn't give yet is asked for again after the wait, and one that failed after the pointer left, on its
    // next visit.
    else if (!this.quiet() && this.target !== null) this.pointerFailed.add(index);
    this.pump();
  }

  /** While the film plays and nobody points at the bar, one at a time, so pictures never take the film's bandwidth. */
  private wantedLanes() {
    const main = this.main;
    return main && !main.paused && this.target === null ? 1 : this.source!.lanes;
  }

  private fillLanes() {
    if (!this.source || !this.boardQueue?.length) return;
    // Counted first: a lane with nothing to take ends at once, and a loop on `this.lanes` would start it forever.
    for (let n = this.wantedLanes() - this.lanes; n > 0; n--) {
      this.lanes++;
      void this.lane();
    }
  }

  /** One storyboard picture after another, waiting while the main video buffers so it gets the network. */
  private async lane() {
    const generation = this.generation;
    try {
      while (generation === this.generation && this.decodes() && this.lanes <= this.wantedLanes()) {
        const main = this.main;
        const quiet = this.quietUntil - performance.now();
        if (quiet > 0 || (main && !main.paused && main.readyState < 3)) {
          await new Promise((resolve) => window.setTimeout(resolve, Math.max(quiet, 2000)));
          continue;
        }
        const place = this.takeBoard();
        if (!place) return;
        const load = new AbortController();
        this.boardLoads.add(load);
        const frame = await this.picture(place.index, load.signal);
        if (generation !== this.generation) return;
        this.boardLoads.delete(load);
        if (frame) this.keep(this.board, place.index, frame);
        // A place TorBox wouldn't give yet goes back for after the wait. One that failed (a dropped connection, the
        // Worker going down) gets one more go, at the back.
        else if (this.quiet()) this.boardQueue!.push(place);
        else if (!this.retried.has(place.index)) {
          this.retried.add(place.index);
          this.boardQueue!.push(place);
        }
      }
    } finally {
      if (generation === this.generation) this.lanes--;
    }
  }

  /** The next storyboard place: the one nearest the pointer, or the next in order when nobody points. */
  private takeBoard() {
    const queue = this.boardQueue!;
    const { starts, density } = this.source!;
    const limit = boardSize(starts.at(-1) ?? 0, density);
    let best = -1;
    let distance = Infinity;
    for (let j = 0; j < queue.length; j++) {
      const { index, rank } = queue[j];
      if (rank >= limit || this.has(index) || this.loading.has(index)) continue;
      if (this.target === null) {
        best = j;
        break;
      }
      const d = Math.abs(starts[index] - this.target);
      if (d < distance) {
        best = j;
        distance = d;
      }
    }
    return best === -1 ? null : queue.splice(best, 1)[0];
  }

  /** A picture as a JPEG, kept on this device when it's from the file, or null when it couldn't be had. */
  private async picture(index: number, signal: AbortSignal): Promise<Frame | null> {
    const source = this.source!;
    const generation = this.generation;
    this.loading.add(index);
    try {
      const bitmap = await source.picture(index, signal);
      this.failures = 0;
      if (!bitmap) return null;
      const t = source.starts[index];
      const blob = await toJpeg(bitmap).catch(() => null);
      if (generation !== this.generation) {
        bitmap.close();
        return null;
      }
      // A browser that can't make the JPEG keeps the decoded picture: more memory, but it still shows.
      if (!blob) return { t, bitmap };
      const frame: Frame = { t, blob };
      // Decoded already, so it can show at once.
      this.remember(frame, bitmap, generation);
      if (source.file) void keepPicture(source.file, index, blob).catch(() => {});
      return frame;
    } catch (error) {
      // A download that stopped or failed isn't the decoder's fault.
      if (error instanceof DecodeError) this.failures++;
      if (error instanceof SlowDown && generation === this.generation)
        this.quietUntil = Math.max(this.quietUntil, performance.now() + Math.max(error.seconds * 1000, SLOW_DOWN_MS));
      return null;
    } finally {
      if (generation === this.generation) this.loading.delete(index);
    }
  }

  private decodes() {
    return this.failures < 3;
  }

  private quiet() {
    return this.quietUntil > performance.now();
  }

  private keep(into: Map<number, Frame>, index: number, frame: Frame) {
    const old = into.get(index);
    if (old) this.forget(old);
    into.delete(index);
    into.set(index, frame);
    if (into === this.recent && into.size > KEEP) {
      const [oldest, gone] = into.entries().next().value!;
      this.forget(gone);
      into.delete(oldest);
    }
    if (this.target === null) return;
    // It shows if it's nearer the pointer than what's up.
    if (!this.drawn || Math.abs(frame.t - this.target) < Math.abs(this.drawn.t - this.target)) this.show(this.target);
  }

  private forget(frame: Frame) {
    frame.bitmap?.close();
    this.decoded.get(frame)?.close();
    this.decoded.delete(frame);
  }

  /** Keeps a decoded picture for drawing; the least recently drawn let go first. */
  private remember(frame: Frame, bitmap: ImageBitmap, generation: number) {
    if (generation !== this.generation) return bitmap.close();
    this.decoded.get(frame)?.close();
    this.decoded.delete(frame);
    this.decoded.set(frame, bitmap);
    if (this.decoded.size > DECODED) {
      const [oldest, gone] = this.decoded.entries().next().value!;
      // The card may be showing it: the canvas keeps its own copy of the pixels.
      gone.close();
      this.decoded.delete(oldest);
    }
  }

  private has(index: number) {
    return this.recent.has(index) || this.board.has(index);
  }

  private find(index: number) {
    const frame = this.recent.get(index);
    if (frame) {
      // Seen again, so it's the last to go.
      this.recent.delete(index);
      this.recent.set(index, frame);
      return frame;
    }
    return this.board.get(index);
  }

  /** The kept picture nearest `index`. */
  private nearest(index: number) {
    for (let d = 0; d <= REACH; d++) {
      const frame = this.find(index - d) ?? this.find(index + d);
      if (frame) return frame;
    }
    return null;
  }

  private index(t: number) {
    const starts = this.source!.starts;
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  private draw(frame: Frame) {
    if (frame === this.drawn) {
      // Back on what's up: a picture still decoding for an earlier spot mustn't replace it.
      this.wanted = null;
      return;
    }
    const bitmap = frame.bitmap ?? this.decoded.get(frame);
    if (!bitmap) {
      this.wanted = frame;
      const generation = this.generation;
      void createImageBitmap(frame.blob!)
        .then((b) => {
          this.remember(frame, b, generation);
          if (generation === this.generation && this.wanted === frame) this.draw(frame);
        })
        .catch(() => {});
      return;
    }
    this.wanted = null;
    if (!frame.bitmap) {
      // Drawn again, so it's the last to go.
      this.decoded.delete(frame);
      this.decoded.set(frame, bitmap);
    }
    const canvas = this.canvas;
    if (!canvas) return;
    if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
    }
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
    this.drawn = frame;
    this.refresh();
  }

  /** Showing a picture, and whether it's from further off than the storyboard's spacing (then it's dimmed). */
  private refresh() {
    const drawn = this.drawn;
    const far = drawn !== null && this.target !== null && Math.abs(drawn.t - this.target) > this.source!.density.spacing;
    this.setState({ shown: drawn !== null, stale: far });
  }

  private setState(state: PreviewState) {
    if (state.shown === this.state.shown && state.stale === this.state.stale) return;
    this.state = state;
    this.listener?.(state);
  }
}

/** How many storyboard pictures a title of `seconds` gets. */
const boardSize = (seconds: number, { spacing, most }: Source["density"]) => Math.min(most, Math.max(8, Math.ceil(seconds / spacing)));

/** A connection that asks for less data (a phone's data saver): the sparse storyboard. */
const savesData = () => (navigator as { connection?: { saveData?: boolean } }).connection?.saveData === true;

/**
 * The file's own keyframes, read by the frames Worker or Krida's server, or null when it has no index or this browser
 * can't decode them. After 3 failures in a row from the Worker, it reads through Krida's server, at the sparse density.
 */
async function fileSource(size: number): Promise<Source | null> {
  const [index, ticket] = await Promise.all([keyframeIndex(size), frameTicket(size).catch(() => null)]);
  if (!index || typeof VideoDecoder === "undefined") return null;
  const description = Uint8Array.from(atob(index.private), (c) => c.charCodeAt(0));
  const codec = codecFromRecord(index.codec, description);
  if (!codec || !(await VideoDecoder.isConfigSupported({ codec, description })).supported) return null;
  let worker = ticket ?? undefined;
  let failures = 0;
  const source: Source = {
    starts: index.points.map(([ms]) => ms / 1000),
    lanes: 4,
    density: worker && !savesData() ? DENSE : SPARSE,
    file: size,
    picture: async (i, signal) => {
      const through = worker;
      let data: Uint8Array;
      try {
        data = await keyframe(size, index.points[i], index.track, signal, through);
        if (through) failures = 0;
      } catch (error) {
        // TorBox failing or asking to slow down isn't the Worker failing: only no answer, or a refusal, is.
        const workerFailed = !(error instanceof SlowDown || error instanceof FileError);
        if (through && !signal.aborted && workerFailed && ++failures >= 3) {
          worker = undefined;
          source.density = SPARSE;
        }
        throw error;
      }
      // A file that doesn't say its size has 0 here, which the decoder refuses.
      const sized = index.width > 0 && index.height > 0;
      return decodeKeyframe({ codec, description, data, ...(sized && { width: index.width, height: index.height }) }, WIDTH);
    },
  };
  return source;
}

/** The first frame of each of TorBox's HLS segments. */
async function hlsSource(src: string): Promise<Source> {
  const res = await fetch(src);
  if (!res.ok) throw new Error(`Playlist ${res.status}`);
  const segments = parsePlaylist(await res.text(), src);
  return {
    starts: segments.map((s) => s.start),
    lanes: 1,
    density: SPARSE,
    picture: async (i, signal) => {
      const frame = await fetchKeyframe(segments[i].url, signal);
      return frame ? decodeKeyframe(frame, WIDTH) : null;
    },
  };
}

/** Each segment's start time and absolute address, from a media playlist. */
export function parsePlaylist(text: string, base: string): { start: number; url: string }[] {
  const segments: { start: number; url: string }[] = [];
  let t = 0;
  let length = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#EXTINF:")) length = parseFloat(line.slice(8));
    else if (line && !line.startsWith("#")) {
      segments.push({ start: t, url: new URL(line, base).href });
      t += length;
    }
  }
  return segments;
}

/**
 * Up to `count` places spread over `total`, ordered so each step halves the gaps: the middle, then the quarters,
 * then the eighths. However far the storyboard has got, it covers the whole bar, so the first 120 of a dense
 * storyboard are a sparse one.
 */
export function storyboardOrder(total: number, count: number) {
  const picks: number[] = [];
  const seen = new Set<number>();
  for (let level = 1; picks.length < Math.min(count, total) && level <= 30; level++) {
    for (let k = 1; k < 2 ** level && picks.length < count; k += 2) {
      const index = Math.floor((k / 2 ** level) * total);
      if (!seen.has(index)) {
        seen.add(index);
        picks.push(index);
      }
    }
  }
  return picks;
}

/** One preview per stream, kept across audio switches, fed by the main video as it plays. */
export function useFramePreview(src: string, size: number | undefined, main: HTMLVideoElement | null) {
  const preview = useMemo(() => new FramePreview(src, size), [src, size]);
  useEffect(() => () => preview.destroy(), [preview]);
  useEffect(() => (main ? preview.watch(main) : undefined), [preview, main]);
  return preview;
}
