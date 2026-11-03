import { afterEach, expect, test, vi } from "vitest";
import { SlowDown } from "../server/http";
import { fileReader } from "../server/torbox";

const API = "https://torbox.test/v1/api";

/** An account with one file of `size` bytes. Each read of it answers the next status in `answers`, then 206. */
function account(size: number, answers: number[]) {
  const links: string[] = [];
  const reads: string[] = [];
  vi.stubEnv("TORBOX_API_URL", API);
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url.startsWith(`${API}/torrents/mylist`)) return Response.json({ success: true, data: [{ id: 7, files: [{ id: 3, size }] }] });
    if (url.startsWith(`${API}/torrents/requestdl`)) {
      links.push(`https://cdn.test/file/${links.length + 1}`);
      return Response.json({ success: true, data: links.at(-1) });
    }
    reads.push(url);
    const status = answers.shift() ?? 206;
    return status === 206 ? new Response(Uint8Array.from([1, 2, 3]), { status }) : new Response("no", { status });
  }));
  return { links, reads };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

test("a refused read is tried once more with a fresh link", async () => {
  const { links, reads } = account(5_000_000_001, [400]);
  const read = (await fileReader("key", 5_000_000_001))!;
  expect([...(await read(0, 3))]).toEqual([1, 2, 3]);
  expect(reads).toEqual(["https://cdn.test/file/1", "https://cdn.test/file/2"]);
  expect(links).toEqual(["https://cdn.test/file/1", "https://cdn.test/file/2"]);
});

test("two refusals in a row fail the read", async () => {
  const { reads } = account(5_000_000_002, [400, 403]);
  const read = (await fileReader("key", 5_000_000_002))!;
  await expect(read(0, 3)).rejects.toThrow("The file answered 403");
  expect(reads).toEqual(["https://cdn.test/file/1", "https://cdn.test/file/2"]);
});

test("a file the account doesn't have has no reader", async () => {
  account(5_000_000_003, []);
  expect(await fileReader("key", 5_000_000_004)).toBe(null);
});

test("a 429 asks the caller to slow down, without a new link or another read", async () => {
  const { links, reads } = account(5_000_000_005, [429]);
  const read = (await fileReader("key", 5_000_000_005))!;
  const error = await read(0, 3).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(SlowDown);
  expect((error as SlowDown).seconds).toBe(10);
  expect(reads).toEqual(["https://cdn.test/file/1"]);
  expect(links).toEqual(["https://cdn.test/file/1"]);
});

test("TorBox's API asking to slow down, when finding the file or its link, is a slow-down too", async () => {
  for (const [size, limited] of [[5_000_000_006, "mylist"], [5_000_000_007, "requestdl"]] as const) {
      vi.stubEnv("TORBOX_API_URL", API);
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes(`/torrents/${limited}`)) return new Response("slow down", { status: 429, headers: { "Retry-After": "60" } });
      if (url.includes("/torrents/mylist")) return Response.json({ success: true, data: [{ id: 7, files: [{ id: 3, size }] }] });
      return Response.json({ success: true, data: "https://cdn.test/file/1" });
    }));
    const error = await fileReader("key", size).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SlowDown);
    expect((error as SlowDown).seconds).toBe(60);
  }
});
