import { describe, expect, test } from "vitest";
import { parsePlaylist, storyboardOrder } from "../src/features/player/framePreview";
import { codecString, FirstFrameReader } from "../src/features/player/keyframes";

const H264 = 0x1b;
const HEVC = 0x24;
const VIDEO_PID = 0x100;
const PMT_PID = 0x1000;

/** Puts the 0x03 bytes back into a NAL unit, as an encoder would. */
function escape(bytes: number[]) {
  const out: number[] = [];
  let zeros = 0;
  for (const b of bytes) {
    if (zeros >= 2 && b <= 3) {
      out.push(3);
      zeros = 0;
    }
    out.push(b);
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return out;
}

/** 188-byte packets carrying `payload` on `pid`, the first marked as a start, the last padded. */
function packets(pid: number, payload: number[], start = true) {
  const out: number[] = [];
  for (let i = 0, first = true; i < payload.length || first; first = false) {
    const room = 184;
    const chunk = payload.slice(i, i + room);
    i += room;
    const header = [0x47, (first && start ? 0x40 : 0) | (pid >> 8), pid & 0xff];
    if (chunk.length === room) out.push(...header, 0x10, ...chunk);
    else {
      // Adaptation field stuffing fills the packet: its length byte, a flags byte, then 0xff.
      const fill = room - chunk.length - 1;
      out.push(...header, 0x30, fill, ...(fill > 0 ? [0x00, ...Array(fill - 1).fill(0xff)] : []), ...chunk);
    }
  }
  return out;
}

function section(tableId: number, body: number[]) {
  const length = body.length + 4;
  return [0x00, tableId, 0xb0 | (length >> 8), length & 0xff, ...body, 0, 0, 0, 0];
}

const pat = () => packets(0, section(0x00, [0, 1, 0xc1, 0, 0, 0, 1, 0xe0 | (PMT_PID >> 8), PMT_PID & 0xff]));
const pmt = (type: number) =>
  packets(PMT_PID, section(0x02, [0, 1, 0xc1, 0, 0, 0xe0 | (VIDEO_PID >> 8), VIDEO_PID & 0xff, 0xf0, 0, type, 0xe0 | (VIDEO_PID >> 8), VIDEO_PID & 0xff, 0xf0, 0]));
/** A PES packet: start code, video stream id, length 0, flags, a 5-byte PTS. */
const pes = (es: number[]) => [0, 0, 1, 0xe0, 0, 0, 0x80, 0x80, 5, 0x21, 0, 1, 0, 1, ...es];

const hevcSps = [0x42, 0x01, ...escape([0x01, 0x01, 0x60, 0x00, 0x00, 0x00, 0x90, 0x00, 0x00, 0x00, 0x00, 0x00, 153, 0xa0])];

describe("codecString", () => {
  test("reads an H.264 profile and level", () => {
    expect(codecString(H264, Uint8Array.from([0, 0, 0, 1, 0x67, 0x64, 0x00, 0x28, 0xac, 0, 0, 1, 0x68, 0xee]))).toBe("avc1.640028");
  });

  test("reads an HEVC Main profile at level 5.1, past the escape bytes", () => {
    expect(hevcSps).toContain(3);
    expect(codecString(HEVC, Uint8Array.from([0, 0, 1, 0x40, 0x01, 0x0c, 0, 0, 1, ...hevcSps]))).toBe("hev1.1.6.L153.90");
  });

  test("reads HEVC Main 10 in the high tier", () => {
    const sps = [0x42, 0x01, ...escape([0x01, 0x22, 0x20, 0x00, 0x00, 0x00, 0xb0, 0x00, 0x00, 0x00, 0x00, 0x00, 156])];
    expect(codecString(HEVC, Uint8Array.from([0, 0, 1, ...sps]))).toBe("hev1.2.4.H156.b0");
  });

  test("has nothing without a sequence parameter set", () => {
    expect(codecString(H264, Uint8Array.from([0, 0, 1, 0x65, 0x88, 0x84]))).toBe(null);
  });
});

describe("FirstFrameReader", () => {
  const es = [0, 0, 0, 1, ...hevcSps, 0, 0, 0, 1, 0x26, 0x01, ...Array.from({ length: 600 }, (_, i) => (i % 250) + 4)];
  const stream = [...pat(), ...pmt(HEVC), ...packets(VIDEO_PID, pes(es)), ...packets(VIDEO_PID, pes([0, 0, 1, 0x02, 0x01, 9]))];

  test("returns the first frame whole, with its codec, once the next one starts", () => {
    const reader = new FirstFrameReader();
    const frame = reader.push(Uint8Array.from(stream));
    expect(frame?.codec).toBe("hev1.1.6.L153.90");
    expect([...frame!.data]).toEqual(es);
  });

  test("works from pieces that split packets anywhere", () => {
    const reader = new FirstFrameReader();
    const bytes = Uint8Array.from(stream);
    let frame = null;
    for (let i = 0; i < bytes.length && !frame; i += 97) frame = reader.push(bytes.subarray(i, i + 97));
    expect([...frame!.data]).toEqual(es);
  });

  test("waits for more while the frame may go on", () => {
    const reader = new FirstFrameReader();
    expect(reader.push(Uint8Array.from([...pat(), ...pmt(HEVC), ...packets(VIDEO_PID, pes(es))]))).toBe(null);
    expect([...reader.end()!.data]).toEqual(es);
  });

  test("refuses what isn't MPEG-TS", () => {
    expect(() => new FirstFrameReader().push(new Uint8Array(376).fill(0x20))).toThrow("Not an MPEG-TS stream");
  });
});

describe("parsePlaylist", () => {
  test("gives each segment its start and an absolute address", () => {
    const text = "#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXTINF:5.000,\nvideo1.ts\n#EXTINF:4.5,\nhttps://cdn.example/video2.ts\n#EXTINF:5,\nvideo3.ts\n#EXT-X-ENDLIST\n";
    expect(parsePlaylist(text, "https://site.example/hls/playlist.m3u8?s=1")).toEqual([
      { start: 0, url: "https://site.example/hls/video1.ts" },
      { start: 5, url: "https://cdn.example/video2.ts" },
      { start: 9.5, url: "https://site.example/hls/video3.ts" },
    ]);
  });
});

describe("storyboardOrder", () => {
  test("halves the gaps: middle, quarters, eighths", () => {
    expect(storyboardOrder(100, 7)).toEqual([50, 25, 75, 12, 37, 62, 87]);
  });

  test("stops at the count, each segment once", () => {
    const order = storyboardOrder(2029, 100);
    expect(order.length).toBe(100);
    expect(new Set(order).size).toBe(100);
  });

  test("the first places of a dense storyboard are a sparse one, spread over the whole bar", () => {
    // A 166-minute film: 3,845 keyframes, 1,000 pictures at 10 s. The first 63 split the bar into 64 even parts.
    const first = storyboardOrder(3845, 1000).slice(0, 63).sort((a, b) => a - b);
    expect(first).toEqual(Array.from({ length: 63 }, (_, i) => Math.floor(((i + 1) / 64) * 3845)));
  });

  test("covers a short title whole", () => {
    expect([...storyboardOrder(5, 100)].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
  });
});
