// A small Matroska file for tests: built byte by byte, so it needs no ffmpeg (tests/mkv.test.ts, tests/framesWorker.test.ts).

/** An EBML element: its id's bytes, an 8-byte size, then the data. */
export function el(id: number, data: number[] | Uint8Array): number[] {
  const idBytes: number[] = [];
  for (let v = id; v > 0; v = Math.floor(v / 256)) idBytes.unshift(v % 256);
  const size = [0x01, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 7, v = data.length; i > 0; i--, v = Math.floor(v / 256)) size[i] = v % 256;
  return [...idBytes, ...size, ...data];
}
const uint = (id: number, v: number, bytes = 4) => el(id, Array.from({ length: bytes }, (_, i) => Math.floor(v / 256 ** (bytes - 1 - i)) % 256));
const text = (id: number, s: string) => el(id, [...new TextEncoder().encode(s)]);
/** A SimpleBlock on track 1: track number, a 16-bit time, flags, then the frame. */
export const block = (key: boolean, frame: number[]) => el(0xa3, [0x81, 0, 0, key ? 0x80 : 0, ...frame]);

export const avcC = [1, 0x64, 0x00, 0x28, 0xff, 0xe1, 0, 4, 0x67, 0x64, 0x00, 0x28, 1, 0, 2, 0x68, 0xee];
export const keyA = Array.from({ length: 700 }, (_, i) => i % 251);
export const keyB = Array.from({ length: 300 }, (_, i) => (i * 7) % 253);

/**
 * A small MKV: header, SeekHead, Info, Tracks, two clusters (each a keyframe then another frame) and Cues at the end.
 * The first cue gives the block's place inside its cluster; the second leaves it out. Positions in the SeekHead and
 * Cues count from the Segment's data, so the file is built twice: once to measure, once with the real numbers.
 */
export function file() {
  const build = (cuesAt: number, cluster1: number, cluster2: number, relative1: number) => {
    const seekHead = el(0x114d9b74, el(0x4dbb, [...el(0x53ab, [0x1c, 0x53, 0xbb, 0x6b]), ...uint(0x53ac, cuesAt, 8)]));
    const info = el(0x1549a966, uint(0x2ad7b1, 1_000_000));
    const tracks = el(0x1654ae6b, el(0xae, [...uint(0xd7, 1, 1), ...uint(0x83, 1, 1), ...text(0x86, "V_MPEG4/ISO/AVC"), ...el(0x63a2, avcC), ...el(0xe0, [...uint(0xb0, 640, 2), ...uint(0xba, 360, 2)])]));
    const c1 = el(0x1f43b675, [...uint(0xe7, 0, 2), ...block(true, keyA), ...block(false, [9, 9, 9])]);
    const c2 = el(0x1f43b675, [...uint(0xe7, 2000, 2), ...block(false, [8, 8]), ...block(true, keyB)]);
    const cuePoint = (time: number, cluster: number, relative?: number) =>
      el(0xbb, [...uint(0xb3, time), ...el(0xb7, [...uint(0xf7, 1, 1), ...uint(0xf1, cluster, 8), ...(relative === undefined ? [] : uint(0xf0, relative))])]);
    const cues = el(0x1c53bb6b, [...cuePoint(0, cluster1, relative1), ...cuePoint(2000, cluster2)]);
    const body = [...seekHead, ...info, ...tracks];
    const segmentData = [...body, ...c1, ...c2, ...cues];
    return { bytes: [...el(0x1a45dfa3, text(0x4282, "matroska")), ...el(0x18538067, segmentData)], at: { c1: body.length, c2: body.length + c1.length, cues: body.length + c1.length + c2.length, relative1: 1 + 8 + 2 } };
  };
  const { at } = build(0, 0, 0, 0);
  const { bytes } = build(at.cues, at.c1, at.c2, at.relative1);
  return Uint8Array.from(bytes);
}
