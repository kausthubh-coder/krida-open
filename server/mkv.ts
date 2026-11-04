/*
 * Just enough Matroska to find a film's keyframes without downloading it: the track's codec, the index of keyframes at
 * the end of the file (Cues), and the one block a cue points at. Everything is read with Range requests through
 * `read(from, to)`, so a 30 GB file costs a few hundred KB per picture.
 */

const ID = {
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Seek: 0x4dbb,
  SeekID: 0x53ab,
  SeekPosition: 0x53ac,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  Cues: 0x1c53bb6b,
  CuePoint: 0xbb,
  CueTime: 0xb3,
  CueTrackPositions: 0xb7,
  CueTrack: 0xf7,
  CueClusterPosition: 0xf1,
  CueRelativePosition: 0xf0,
  Cluster: 0x1f43b675,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  ReferenceBlock: 0xfb,
};

export type Read = (from: number, to: number) => Promise<Uint8Array>;

/** A film's keyframes: its video codec, and where each keyframe's block sits in the file, by time. */
export type KeyframeIndex = {
  codec: string;
  /** The decoder's configuration record (hvcC or avcC), base64. */
  private: string;
  width: number;
  height: number;
  track: number;
  /** [milliseconds, the cluster's offset in the file, the block's offset inside the cluster or -1], by time. */
  points: [number, number, number][];
};

type Element = { id: number; start: number; dataStart: number; end: number };

/** Reads an element's header at `pos` in `buf`. `end` is Infinity for an element of unknown size. */
function element(buf: Uint8Array, pos: number): Element | null {
  const id = vint(buf, pos, true);
  if (!id) return null;
  const size = vint(buf, pos + id.length, false);
  if (!size) return null;
  const dataStart = pos + id.length + size.length;
  return { id: id.value, start: pos, dataStart, end: size.unknown ? Infinity : dataStart + size.value };
}

function vint(buf: Uint8Array, pos: number, keepMarker: boolean) {
  const first = buf[pos];
  if (first === undefined || first === 0) return null;
  let length = 1;
  while (!(first & (0x80 >> (length - 1)))) length++;
  if (length > 8 || pos + length > buf.length) return null;
  let value = keepMarker ? first : first & (0xff >> length);
  let ones = value === (0xff >> length);
  for (let i = 1; i < length; i++) {
    value = value * 256 + buf[pos + i];
    ones &&= buf[pos + i] === 0xff;
  }
  return { value, length, unknown: !keepMarker && ones };
}

/** The children of the element spanning `from` to `to` in `buf`. */
function* children(buf: Uint8Array, from: number, to: number) {
  for (let pos = from; pos < Math.min(to, buf.length); ) {
    const e = element(buf, pos);
    if (!e || e.end === Infinity) return;
    yield e;
    pos = e.end;
  }
}

const uint = (buf: Uint8Array, e: Element) => {
  let v = 0;
  for (let i = e.dataStart; i < e.end; i++) v = v * 256 + buf[i];
  return v;
};

/** Reads the header, the video track and the Cues. Null when the file has no index to read (then use HLS). */
export async function readIndex(read: Read): Promise<KeyframeIndex | null> {
  const head = await read(0, 256 * 1024);
  const ebml = element(head, 0);
  if (!ebml || ebml.id !== 0x1a45dfa3) return null;
  const segment = element(head, ebml.end);
  if (!segment || segment.id !== ID.Segment) return null;
  const base = segment.dataStart;

  // The SeekHead says where the top-level parts are; Info and Tracks are usually in the first read too.
  const at = new Map<number, number>();
  let scale = 1_000_000;
  let track: Omit<KeyframeIndex, "points"> | null = null;
  const readTracks = (buf: Uint8Array, e: Element) => {
    for (const entry of children(buf, e.dataStart, e.end)) {
      if (entry.id !== ID.TrackEntry) continue;
      const f: Record<number, Element> = {};
      for (const c of children(buf, entry.dataStart, entry.end)) f[c.id] = c;
      if (!f[ID.TrackType] || uint(buf, f[ID.TrackType]) !== 1 || !f[ID.CodecID] || !f[ID.CodecPrivate]) continue;
      const video: Record<number, Element> = {};
      if (f[ID.Video]) for (const c of children(buf, f[ID.Video].dataStart, f[ID.Video].end)) video[c.id] = c;
      return {
        codec: new TextDecoder().decode(buf.subarray(f[ID.CodecID].dataStart, f[ID.CodecID].end)),
        private: base64(buf.subarray(f[ID.CodecPrivate].dataStart, f[ID.CodecPrivate].end)),
        width: video[ID.PixelWidth] ? uint(buf, video[ID.PixelWidth]) : 0,
        height: video[ID.PixelHeight] ? uint(buf, video[ID.PixelHeight]) : 0,
        track: uint(buf, f[ID.TrackNumber]),
      };
    }
    return null;
  };
  for (const e of children(head, base, segment.end)) {
    if (e.end > head.length) break;
    if (e.id === ID.SeekHead) {
      for (const seek of children(head, e.dataStart, e.end)) {
        let id = 0;
        let pos = -1;
        for (const c of children(head, seek.dataStart, seek.end)) {
          if (c.id === ID.SeekID) id = uint(head, c);
          if (c.id === ID.SeekPosition) pos = uint(head, c);
        }
        if (pos >= 0) at.set(id, base + pos);
      }
    } else if (e.id === ID.Info) {
      for (const c of children(head, e.dataStart, e.end)) if (c.id === ID.TimecodeScale) scale = uint(head, c);
    } else if (e.id === ID.Tracks) track = readTracks(head, e);
    else if (e.id === ID.Cluster) break;
  }
  if (!track && at.has(ID.Tracks)) {
    const from = at.get(ID.Tracks)!;
    const buf = await read(from, from + 64 * 1024);
    const e = element(buf, 0);
    if (e?.id === ID.Tracks && e.end <= buf.length) track = readTracks(buf, e);
  }
  const cuesAt = at.get(ID.Cues);
  if (!track || cuesAt === undefined) return null;

  // The Cues: usually a few hundred KB at the end of the file.
  let cues = await read(cuesAt, cuesAt + 512 * 1024);
  const top = element(cues, 0);
  if (!top || top.id !== ID.Cues || top.end === Infinity || top.end > 16 * 1024 * 1024) return null;
  if (top.end > cues.length) cues = await read(cuesAt, cuesAt + top.end);
  const points: KeyframeIndex["points"] = [];
  for (const point of children(cues, top.dataStart, top.end)) {
    if (point.id !== ID.CuePoint) continue;
    let time = -1;
    for (const c of children(cues, point.dataStart, point.end)) {
      if (c.id === ID.CueTime) time = uint(cues, c);
      if (c.id !== ID.CueTrackPositions || time < 0) continue;
      let t = -1;
      let cluster = -1;
      let relative = -1;
      for (const p of children(cues, c.dataStart, c.end)) {
        if (p.id === ID.CueTrack) t = uint(cues, p);
        if (p.id === ID.CueClusterPosition) cluster = uint(cues, p);
        if (p.id === ID.CueRelativePosition) relative = uint(cues, p);
      }
      if (t === track.track && cluster >= 0) points.push([Math.round((time * scale) / 1e6), base + cluster, relative]);
    }
  }
  points.sort((a, b) => a[0] - b[0]);
  return points.length ? { ...track, points } : null;
}

/**
 * The frame in the keyframe block a cue points at: the block at `relative` inside the cluster at `cluster`, or the
 * cluster's first keyframe of `track` when the cue doesn't say. Null when there isn't one to read.
 */
export async function readKeyframe(read: Read, cluster: number, relative: number, track: number): Promise<Uint8Array | null> {
  const PIECE = 512 * 1024;
  // A cue's relative position counts from the cluster's data, after its header (at most 12 bytes). A keyframe is
  // usually near its cluster's start, so one read covers the header and the block. Further in, the header and the
  // block are read apart, so a position far into the cluster (or a made-up one) costs no more than a near one.
  // Offsets below count from `start`; without a relative position, the walk starts at the cluster's data.
  const near = relative <= 1024 * 1024;
  let start = cluster;
  let buf = await read(cluster, near ? cluster + Math.max(relative, 0) + 12 + PIECE : cluster + 12);
  const head = element(buf, 0);
  if (!head || head.id !== ID.Cluster) return null;
  let pos = head.dataStart + Math.max(relative, 0);
  if (!near) {
    start = cluster + pos;
    buf = await read(start, start + PIECE);
    pos = 0;
  }
  const from = pos;
  while (pos - from < 8 * 1024 * 1024) {
    if (pos + 12 > buf.length) buf = concat(buf, await read(start + buf.length, start + pos + PIECE));
    const e = element(buf, pos);
    if (!e || e.end === Infinity) return null;
    if (e.id === ID.SimpleBlock || e.id === ID.BlockGroup) {
      if (e.end - pos > 16 * 1024 * 1024) return null;
      if (e.end > buf.length) buf = concat(buf, await read(start + buf.length, start + e.end));
      const block = e.id === ID.SimpleBlock ? e : [...children(buf, e.dataStart, e.end)].find((c) => c.id === ID.Block);
      const number = block && vint(buf, block.dataStart, false);
      if (block && number && number.value === track) {
        const flags = buf[block.dataStart + number.length + 2];
        // Video blocks aren't laced; a laced one isn't a single frame to hand to a decoder.
        if (flags & 0x06) return null;
        // The cue named this block; otherwise only a keyframe will do (a BlockGroup's is one unless it references another).
        const key = e.id === ID.BlockGroup ? ![...children(buf, e.dataStart, e.end)].some((c) => c.id === ID.ReferenceBlock) : flags & 0x80;
        if (relative >= 0 || key) return buf.slice(block.dataStart + number.length + 3, block.end);
      }
      if (relative >= 0) return null;
    }
    // Without a relative position, walk the cluster to the track's first keyframe.
    pos = e.end;
  }
  return null;
}

function concat(a: Uint8Array, b: Uint8Array) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

function base64(bytes: Uint8Array) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export type SubtitleTrack = { track: number; language: string; name: string; codec: string };
export type SubtitleCue = { start: number; end: number; text: string };
export const SUBTITLE_READ_LIMIT = 16 * 1024 * 1024;
/** Range reads a walk of an unindexed subtitle track may make before giving up. */
const SCAN_REQUESTS = 200;

/** Sparse EBML reads. Video/audio payloads are skipped by their element size, never buffered whole. */
export async function readSubtitles(read: Read, size: number, wanted?: number, budget = SUBTITLE_READ_LIMIT) {
  let spent = 0;
  let requests = 0;
  let windowAt = -1;
  let window = new Uint8Array(0);
  let readAhead = 64;
  const bytes = async (from: number, length: number): Promise<Uint8Array> => {
    if (from >= windowAt && from + length <= windowAt + window.length) return window.subarray(from - windowAt, from - windowAt + length);
    const count = Math.min(Math.max(length, readAhead), size - from, Math.max(length, budget - spent));
    if (count < length || spent + count > budget || ++requests > 50_000) throw new Error("Subtitle read limit exceeded or truncated file");
    spent += count;
    windowAt = from;
    window = new Uint8Array(await read(from, from + count));
    if (window.length !== count) throw new Error("Truncated subtitle data");
    return window.subarray(0, length);
  };
  const header = async (pos: number): Promise<Element> => {
    const buf = await bytes(pos, Math.min(12, size - pos));
    const e = element(buf, 0);
    if (!e || (!Number.isSafeInteger(e.end) && e.end !== Infinity)) throw new Error("Invalid Matroska element");
    return { id: e.id, start: pos, dataStart: pos + e.dataStart, end: e.end === Infinity ? Infinity : pos + e.end };
  };
  const value = async (e: Element) => {
    const buf = await bytes(e.dataStart, e.end - e.dataStart);
    return uint(buf, { ...e, dataStart: 0, end: buf.length });
  };
  const tracks: SubtitleTrack[] = [];
  const skipped: { codec: string; name: string }[] = [];
  const defaults = new Map<number, number>();
  const cues: SubtitleCue[] = [];
  const ebml = await header(0);
  if (ebml.id !== 0x1a45dfa3) return { tracks, skipped, cues };
  const segment = await header(ebml.end);
  if (segment.id !== ID.Segment) return { tracks, skipped, cues };
  const end = Math.min(size, segment.end);
  let scale = 1_000_000;
  let firstCluster = end;
  let cuesAt: number | undefined;
  const metadataSeen = new Set<number>();
  const metadata = async (top: Element) => {
    if (![ID.Tracks, ID.Info].includes(top.id) || metadataSeen.has(top.start)) return;
    metadataSeen.add(top.start);
    const buf = await bytes(top.start, top.end - top.start);
    const e = element(buf, 0)!;
    if (top.id === ID.Info) {
      for (const c of children(buf, e.dataStart, e.end)) if (c.id === ID.TimecodeScale) scale = uint(buf, c);
      return;
    }
    for (const entry of children(buf, e.dataStart, e.end)) {
      if (entry.id !== ID.TrackEntry) continue;
      const fields = new Map([...children(buf, entry.dataStart, entry.end)].map((c) => [c.id, c]));
      const n = (id: number, fallback = 0) => fields.has(id) ? uint(buf, fields.get(id)!) : fallback;
      const s = (id: number, fallback = "") => {
        const f = fields.get(id);
        return f ? new TextDecoder().decode(buf.subarray(f.dataStart, f.end)) : fallback;
      };
      if (n(ID.TrackType) !== 17) continue;
      const codec = s(ID.CodecID);
      const name = s(0x536e);
      // Image tracks need OCR or a bitmap renderer and cannot be presented as browser text cues.
      if (!["S_TEXT/UTF8", "S_TEXT/ASS", "S_TEXT/SSA", "S_TEXT/WEBVTT"].includes(codec) || fields.has(0x6d80)) {
        skipped.push({ codec, name });
        continue;
      }
      const track = n(ID.TrackNumber);
      if (tracks.some((t) => t.track === track)) continue;
      tracks.push({ track, language: s(0x22b59d, s(0x22b59c, "eng")), name, codec });
      defaults.set(track, n(0x23e383) / 1e9);
    }
  };
  // Follow SeekHead entries as well: some muxers put Tracks after the first cluster.
  const seen = new Set<number>();
  const scanMetadata = async (e: Element) => {
    if (seen.has(e.start)) return;
    seen.add(e.start);
    await metadata(e);
    if (e.id !== ID.SeekHead) return;
    const buf = await bytes(e.start, e.end - e.start);
    const top = element(buf, 0)!;
    for (const seek of children(buf, top.dataStart, top.end)) {
      let id = 0;
      let at = -1;
      for (const c of children(buf, seek.dataStart, seek.end)) {
        if (c.id === ID.SeekID) id = uint(buf, c);
        if (c.id === ID.SeekPosition) at = segment.dataStart + uint(buf, c);
      }
      if ([ID.Tracks, ID.Info].includes(id) && at >= segment.dataStart && at < end) await metadata(await header(at));
      if (id === ID.Cues && at >= segment.dataStart && at < end) cuesAt = at;
    }
  };
  for (let pos = segment.dataStart; pos < end;) {
    const e = await header(pos);
    if (e.id === ID.Cluster) { firstCluster = pos; break; }
    if (e.end > end || e.end <= pos) throw new Error("Invalid Matroska metadata");
    await scanMetadata(e);
    pos = e.end;
  }
  // Listing needs no cluster reads; extraction scans every cluster, including those absent from Cues.
  if (wanted === undefined || !tracks.some((t) => t.track === wanted)) return { tracks, skipped, cues };
  const pending: { start: number; end?: number; text: string }[] = [];
  const block = async (e: Element, time: number, duration?: number, absolute?: number) => {
    const head = await bytes(e.dataStart, Math.min(12, e.end - e.dataStart));
    const track = vint(head, 0, false);
    if (!track || track.value !== wanted) return;
    if (head[track.length + 2] & 0x06) throw new Error("Laced subtitle blocks are unsupported");
    let relative = head[track.length] * 256 + head[track.length + 1];
    if (relative >= 32768) relative -= 65536;
    const start = absolute ?? (time + relative) * scale / 1e9;
    const text = new TextDecoder().decode(await bytes(e.dataStart + track.length + 3, e.end - e.dataStart - track.length - 3));
    const length = duration === undefined ? defaults.get(wanted) : duration * scale / 1e9;
    pending.push({ start, end: length ? start + length : undefined, text });
  };
  const group = async (e: Element, time: number, absolute?: number) => {
    let b: Element | undefined;
    let duration: number | undefined;
    for (let g = e.dataStart; g < e.end;) {
      const child = await header(g);
      if (child.end > e.end || child.end <= g) throw new Error("Invalid block group");
      if (child.id === ID.Block) b = child;
      if (child.id === 0x9b) duration = await value(child);
      g = child.end;
    }
    if (b) await block(b, time, duration, absolute);
  };
  // Matroska recommends indexing every subtitle frame. A subtitle index with relative positions lets us read
  // only those blocks, instead of requesting a header for every video/audio block. Older muxers fall back below.
  const indexed: { cluster: number; relative: number; time: number }[] = [];
  let usableIndex = true;
  if (cuesAt !== undefined) {
    const top = await header(cuesAt);
    if (top.id === ID.Cues && top.end <= end) {
      const buf = await bytes(top.start, top.end - top.start);
      const local = element(buf, 0)!;
      for (const point of children(buf, local.dataStart, local.end)) {
        if (point.id !== ID.CuePoint) continue;
        const fields = [...children(buf, point.dataStart, point.end)];
        const time = fields.find((f) => f.id === ID.CueTime);
        for (const position of fields.filter((f) => f.id === ID.CueTrackPositions)) {
          const f = new Map([...children(buf, position.dataStart, position.end)].map((c) => [c.id, c]));
          if (!f.has(ID.CueTrack) || uint(buf, f.get(ID.CueTrack)!) !== wanted) continue;
          if (!time || !f.has(ID.CueClusterPosition) || !f.has(ID.CueRelativePosition)) { usableIndex = false; continue; }
          indexed.push({ time: uint(buf, time) * scale / 1e9, cluster: segment.dataStart + uint(buf, f.get(ID.CueClusterPosition)!), relative: uint(buf, f.get(ID.CueRelativePosition)!) });
        }
      }
    }
  }
  if (usableIndex && indexed.length) {
    const seenBlocks = new Set<number>();
    for (const cue of indexed) {
      const cluster = await header(cue.cluster);
      if (cluster.id !== ID.Cluster) throw new Error("Invalid subtitle cue cluster");
      const pos = cluster.dataStart + cue.relative;
      if (seenBlocks.has(pos)) continue;
      seenBlocks.add(pos);
      const e = await header(pos);
      if (e.end > Math.min(cluster.end, end)) throw new Error("Invalid subtitle cue block");
      const before = pending.length;
      if (e.id === ID.BlockGroup) await group(e, 0, cue.time);
      else if (e.id === ID.SimpleBlock) await block(e, 0, undefined, cue.time);
      else throw new Error("Invalid subtitle cue block");
      if (pending.length === before) throw new Error("Subtitle cue points at another track");
    }
  }
  // Without the subtitle track in the Cues, its blocks are found only by walking every block header, one Range read
  // per video block on a real film. A short file is walked; a long one gives up after SCAN_REQUESTS reads, and the
  // player names the file's tracks without them. Small windows still let one read cover several small blocks.
  readAhead = 2048;
  const scanFrom = requests;
  for (let pos = firstCluster; !(usableIndex && indexed.length) && pos < end;) {
    if (requests - scanFrom > SCAN_REQUESTS) throw new Error("Subtitle track isn't indexed; too far to scan");
    const cluster = await header(pos);
    if (cluster.id !== ID.Cluster) { if (cluster.end > end) break; pos = cluster.end; continue; }
    let time = 0;
    let p = cluster.dataStart;
    for (; p < Math.min(cluster.end, end);) {
      if (requests - scanFrom > SCAN_REQUESTS) throw new Error("Subtitle track isn't indexed; too far to scan");
      const e = await header(p);
      if (cluster.end === Infinity && [ID.Cluster, ID.Cues, ID.Tracks, ID.Info].includes(e.id)) break;
      if (e.end > Math.min(cluster.end, end) || e.end <= p) throw new Error("Invalid cluster element");
      if (e.id === 0xe7) time = await value(e);
      if (e.id === ID.SimpleBlock) await block(e, time);
      if (e.id === ID.BlockGroup) {
        await group(e, time);
      }
      p = e.end;
    }
    pos = p;
  }
  pending.sort((a, b) => a.start - b.start);
  for (let i = 0; i < pending.length; i++) {
    const c = pending[i];
    const stop = c.end ?? pending[i + 1]?.start;
    if (stop === undefined) throw new Error("Subtitle block has no duration");
    if (stop > c.start) cues.push({ start: c.start, end: stop, text: c.text });
  }
  return { tracks, skipped, cues };
}
