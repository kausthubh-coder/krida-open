// The first picture of an HLS segment, from the start of the file alone. Every segment opens on a keyframe, so
// reading MPEG-TS packets until the video's second frame begins gives a picture that decodes on its own. That's a
// few hundred KB of a segment that can be 15 MB.

const PACKET = 188;
const H264 = 0x1b;
const HEVC = 0x24;

export type Keyframe = {
  codec: string;
  data: Uint8Array;
  /** The configuration record (hvcC or avcC) for frames whose NAL units are length-prefixed; none for Annex B. */
  description?: Uint8Array;
  /** The picture's size, when the file says. */
  width?: number;
  height?: number;
};

/**
 * Reads TS packets as they arrive and returns the first video frame once it's complete (the next one starts), or
 * what there is at the end. `push` returns the frame when it's done, so the caller can stop the download there.
 */
export class FirstFrameReader {
  private pending = new Uint8Array(0);
  private pmtPid = -1;
  private videoPid = -1;
  private streamType = 0;
  private parts: Uint8Array[] = [];
  private started = false;
  private done: Keyframe | null = null;

  push(chunk: Uint8Array): Keyframe | null {
    if (this.done) return this.done;
    const buf = concat(this.pending, chunk);
    let off = 0;
    // Each packet starts with 0x47; anything else means we've lost our place.
    while (off + PACKET <= buf.length) {
      if (buf[off] !== 0x47) throw new Error("Not an MPEG-TS stream");
      if (this.packet(buf.subarray(off, off + PACKET))) return this.done;
      off += PACKET;
    }
    this.pending = buf.slice(off);
    return null;
  }

  /** The end of the data: the frame read so far, if it's whole enough to have a codec. */
  end(): Keyframe | null {
    if (this.done || !this.started) return this.done;
    return this.finish();
  }

  /** True once the frame is done. */
  private packet(p: Uint8Array) {
    const pusi = (p[1] & 0x40) !== 0;
    const pid = ((p[1] & 0x1f) << 8) | p[2];
    const adaptation = (p[3] >> 4) & 3;
    let start = 4;
    if (adaptation & 2) start += 1 + p[4];
    if (!(adaptation & 1) || start >= PACKET) return false;
    const payload = p.subarray(start);
    if (pid === 0 && pusi) this.pmtPid = patPmtPid(payload);
    else if (pid === this.pmtPid && pusi && this.videoPid < 0) [this.videoPid, this.streamType] = pmtVideo(payload);
    else if (pid === this.videoPid && this.videoPid >= 0) {
      if (pusi) {
        if (this.started) return !!this.finish();
        this.started = true;
        // Skip the PES header: 6 fixed bytes, 3 more, then its optional fields.
        this.parts.push(payload.subarray(9 + payload[8]));
      } else if (this.started) this.parts.push(payload);
    }
    return false;
  }

  private finish() {
    const data = this.parts.reduce(concat, new Uint8Array(0));
    const codec = codecString(this.streamType, data);
    this.done = codec ? { codec, data } : null;
    return this.done;
  }
}

/** The PMT's PID, from a PAT section. */
function patPmtPid(payload: Uint8Array) {
  const s = 1 + payload[0];
  const length = ((payload[s + 1] & 0x0f) << 8) | payload[s + 2];
  // Programs follow the 8-byte header, 4 bytes each, before the CRC. Program 0 is the network PID.
  for (let i = s + 8; i + 4 <= s + 3 + length - 4; i += 4) {
    const program = (payload[i] << 8) | payload[i + 1];
    if (program !== 0) return ((payload[i + 2] & 0x1f) << 8) | payload[i + 3];
  }
  return -1;
}

/** The video stream's PID and type (H.264 or HEVC), from a PMT section. */
function pmtVideo(payload: Uint8Array): [number, number] {
  const s = 1 + payload[0];
  const length = ((payload[s + 1] & 0x0f) << 8) | payload[s + 2];
  const infoLength = ((payload[s + 10] & 0x0f) << 8) | payload[s + 11];
  const end = s + 3 + length - 4;
  for (let i = s + 12 + infoLength; i + 5 <= end; ) {
    const type = payload[i];
    const pid = ((payload[i + 1] & 0x1f) << 8) | payload[i + 2];
    if (type === H264 || type === HEVC) return [pid, type];
    i += 5 + (((payload[i + 3] & 0x0f) << 8) | payload[i + 4]);
  }
  return [-1, 0];
}

/** The codec string WebCodecs wants, read from the frame's sequence parameter set. */
export function codecString(streamType: number, annexB: Uint8Array): string | null {
  for (const nal of nalUnits(annexB)) {
    if (streamType === H264 && (nal[0] & 0x1f) === 7 && nal.length >= 4) {
      return `avc1.${hex(nal[1])}${hex(nal[2])}${hex(nal[3])}`;
    }
    if (streamType === HEVC && ((nal[0] >> 1) & 0x3f) === 33) {
      // profile_tier_level comes right after the SPS's first byte.
      const sps = unescape(nal.subarray(2));
      return sps.length < 13 ? null : hevcString("hev1", sps.subarray(1, 13));
    }
  }
  return null;
}

/** The codec string WebCodecs wants, from a Matroska CodecID and its configuration record (hvcC or avcC). */
export function codecFromRecord(codecId: string, record: Uint8Array): string | null {
  if (codecId === "V_MPEG4/ISO/AVC" && record.length >= 4) return `avc1.${hex(record[1])}${hex(record[2])}${hex(record[3])}`;
  // hvcC keeps the same 12 bytes of profile, tier and level from its second byte.
  if (codecId === "V_MPEGH/ISO/HEVC" && record.length >= 23) return hevcString("hvc1", record.subarray(1, 13));
  return null;
}

/**
 * An HEVC codec string from the 12 bytes of profile_tier_level: profile space, tier and profile, 4 of compatibility
 * flags, 6 of constraints, then the level (ISO/IEC 14496-15, annex E).
 */
function hevcString(kind: string, ptl: Uint8Array) {
  const space = ["", "A", "B", "C"][ptl[0] >> 6];
  const tier = ptl[0] & 0x20 ? "H" : "L";
  const profile = ptl[0] & 0x1f;
  const compat = reverseBits(((ptl[1] << 24) | (ptl[2] << 16) | (ptl[3] << 8) | ptl[4]) >>> 0);
  const constraints = [...ptl.subarray(5, 11)];
  while (constraints.length && constraints.at(-1) === 0) constraints.pop();
  return [`${kind}.${space}${profile}`, compat.toString(16), `${tier}${ptl[11]}`, ...constraints.map((b) => b.toString(16))].join(".");
}

function* nalUnits(data: Uint8Array) {
  let start = -1;
  for (let i = 0; i + 2 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      if (start >= 0) yield data.subarray(start, i);
      start = i + 3;
      i += 2;
    }
  }
  if (start >= 0 && start < data.length) yield data.subarray(start);
}

/** Drops the 0x03 bytes that keep 00 00 0x out of a NAL unit. */
function unescape(nal: Uint8Array) {
  const out: number[] = [];
  for (let i = 0; i < nal.length; i++) {
    if (i >= 2 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) continue;
    out.push(nal[i]);
  }
  return Uint8Array.from(out);
}

function reverseBits(n: number) {
  let r = 0;
  for (let i = 0; i < 32; i++) r = ((r << 1) | ((n >>> i) & 1)) >>> 0;
  return r;
}

const hex = (b: number) => b.toString(16).padStart(2, "0");

function concat(a: Uint8Array, b: Uint8Array) {
  if (!a.length) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/** Most keyframes fit in one piece this size (4K HEVC measured 40 to 900 KB); bigger ones take another. */
const PIECE = 512 * 1024;

/** Downloads the start of a segment, a piece at a time, until its first frame is whole. */
export async function fetchKeyframe(url: string, signal: AbortSignal): Promise<Keyframe | null> {
  const frames = new FirstFrameReader();
  for (let from = 0; from < 8 * PIECE; from += PIECE) {
    const res = await fetch(url, { signal, headers: { Range: `bytes=${from}-${from + PIECE - 1}` } });
    // Past the end of a short segment.
    if (res.status === 416) return frames.end();
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    const frame = frames.push(bytes);
    if (frame) return frame;
    // A server that ignores the range sends it all at once.
    if (res.status === 200 || bytes.length < PIECE) return frames.end();
  }
  return null;
}

/** This browser couldn't decode a keyframe (as opposed to not getting one). */
export class DecodeError extends Error {}

/** Decodes one keyframe into a small picture. */
export async function decodeKeyframe(frame: Keyframe, width: number): Promise<ImageBitmap> {
  let picture: VideoFrame | null = null;
  let failure: unknown = null;
  const decoder = new VideoDecoder({
    output: (f) => {
      picture?.close();
      picture = f;
    },
    error: (e) => (failure = e),
  });
  try {
    // Without a description the data is Annex B, with its parameter sets in band.
    // Krida for Windows' WebView2, told no size, decodes a 4K HEVC frame whole but says only its top-left 1280x720 is
    // the picture, so the card showed that corner blown up. Told the size, it says all of it.
    decoder.configure({ codec: frame.codec, description: frame.description, codedWidth: frame.width, codedHeight: frame.height, optimizeForLatency: true });
    decoder.decode(new EncodedVideoChunk({ type: "key", timestamp: 0, data: frame.data }));
    await decoder.flush();
  } catch (error) {
    throw new DecodeError(String(error));
  } finally {
    if (decoder.state !== "closed") decoder.close();
  }
  const out = picture as VideoFrame | null;
  if (!out) throw new DecodeError(String(failure ?? "The keyframe didn't decode"));
  try {
    const height = Math.round((width * out.displayHeight) / out.displayWidth);
    return await createImageBitmap(out, { resizeWidth: width, resizeHeight: height, resizeQuality: "medium" });
  } finally {
    out.close();
  }
}
