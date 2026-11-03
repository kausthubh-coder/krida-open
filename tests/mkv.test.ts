import { describe, expect, test } from "vitest";
import { readIndex, readKeyframe, type Read } from "../server/mkv";
import { codecFromRecord } from "../src/features/player/keyframes";
import { avcC, block, el, file, keyA, keyB } from "./mkvFile";

const reader = (bytes: Uint8Array) => {
  const reads: [number, number][] = [];
  const read: Read = async (from, to) => {
    reads.push([from, to]);
    return bytes.slice(from, Math.min(to, bytes.length));
  };
  return { read, reads };
};

describe("readIndex", () => {
  test("finds the video track and every keyframe's place in the file", async () => {
    const bytes = file();
    const index = await readIndex(reader(bytes).read);
    const segmentData = 4 + 8 + 2 + 8 + 8 + 4 + 8;
    expect(index?.codec).toBe("V_MPEG4/ISO/AVC");
    expect(index?.private).toBe(btoa(String.fromCharCode(...avcC)));
    expect([index?.width, index?.height, index?.track]).toEqual([640, 360, 1]);
    expect(index?.points.map(([ms, , relative]) => [ms, relative])).toEqual([[0, 11], [2000, -1]]);
    // Cluster offsets are absolute: the Segment's data starts after the EBML header and the Segment's own header.
    expect(bytes[index!.points[0][1]]).toBe(0x1f);
    expect(index!.points[0][1]).toBeGreaterThan(segmentData);
  });

  test("has nothing for a file that isn't Matroska", async () => {
    expect(await readIndex(reader(new Uint8Array(4096).fill(7)).read)).toBe(null);
  });
});

describe("readKeyframe", () => {
  test("reads the block a cue points at, without the block's header", async () => {
    const bytes = file();
    const { read } = reader(bytes);
    const index = (await readIndex(read))!;
    const [, cluster, relative] = index.points[0];
    expect([...(await readKeyframe(read, cluster, relative, 1))!]).toEqual(keyA);
  });

  test("walks past a frame that isn't a keyframe when the cue doesn't say where the block is", async () => {
    const bytes = file();
    const { read } = reader(bytes);
    const index = (await readIndex(read))!;
    const [, cluster, relative] = index.points[1];
    expect(relative).toBe(-1);
    expect([...(await readKeyframe(read, cluster, relative, 1))!]).toEqual(keyB);
  });

  test("reads only the cluster's header and the block, however far into the cluster it is", async () => {
    const bytes = file();
    const index = (await readIndex(reader(bytes).read))!;
    const [, cluster] = index.points[0];
    const { read, reads } = reader(bytes);
    // A made-up place 10 GB into the cluster: two small reads, no keyframe.
    expect(await readKeyframe(read, cluster, 10_000_000_000, 1)).toBe(null);
    expect(reads.map(([from, to]) => to - from)).toEqual([12, 512 * 1024, 512 * 1024]);
  });

  test("reads a keyframe more than 1 MB into its cluster from where it is", async () => {
    // A cluster with 1.2 MB of padding (a Void element), then the keyframe; the cue says where the keyframe is.
    const padding = el(0xec, new Uint8Array(1_200_000));
    const bytes = Uint8Array.from(el(0x1f43b675, [...padding, ...block(true, keyA)]));
    const { read, reads } = reader(bytes);
    expect([...(await readKeyframe(read, 0, padding.length, 1))!]).toEqual(keyA);
    expect(reads.map(([from, to]) => [from, to - from])).toEqual([[0, 12], [12 + padding.length, 512 * 1024]]);
  });

  test("refuses a place that isn't a cluster", async () => {
    expect(await readKeyframe(reader(file()).read, 0, -1, 1)).toBe(null);
  });
});

describe("codecFromRecord", () => {
  test("reads an avcC record", () => {
    expect(codecFromRecord("V_MPEG4/ISO/AVC", Uint8Array.from(avcC))).toBe("avc1.640028");
  });

  test("reads an hvcC record's profile, tier and level", () => {
    const hvcC = [1, 0x22, 0x20, 0, 0, 0, 0xb0, 0, 0, 0, 0, 0, 153, 0xf0, 0, 0xfc, 0xfd, 0xfa, 0xfa, 0, 0, 0x0f, 0];
    expect(codecFromRecord("V_MPEGH/ISO/HEVC", Uint8Array.from(hvcC))).toBe("hvc1.2.4.H153.b0");
  });

  test("has nothing for a codec it doesn't know", () => {
    expect(codecFromRecord("V_AV1", Uint8Array.from([0x81, 0, 0, 0]))).toBe(null);
  });
});
