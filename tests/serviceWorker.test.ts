// @vitest-environment node
// node, not edge-runtime: the worker runs from its source text, and edge-runtime forbids new Function.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, test, vi } from "vitest";

const source = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
const ORIGIN = "https://krida-open.vercel.app";

type FetchEvent = { request: Request; respondWith: (response: Promise<Response>) => void; waitUntil: (p: Promise<unknown>) => void };

let onFetch: (event: FetchEvent) => void;
let stored: Map<string, Response>;
let network: ReturnType<typeof vi.fn>;

// public/sw.js with its globals faked: the Cache API as a map, and fetch as the browser's HTTP cache in front of
// Vercel. The browser cache holds a 404 for one chunk, caught mid-deploy with /assets/'s year-long cache header.
beforeEach(() => {
  stored = new Map();
  const cache = {
    put: async (request: Request, response: Response) => void stored.set(request.url, response),
    keys: async () => [...stored.keys()].map((url) => new Request(url)),
    delete: async (request: Request) => stored.delete(request.url),
  };
  const caches = {
    open: async () => cache,
    match: async (request: Request) => stored.get(request.url)?.clone(),
  };
  network = vi.fn(async (request: Request, init?: RequestInit) => {
    const fromBrowserCache = init?.cache === undefined || init.cache === "default";
    if (request.url.endsWith("/assets/home-abc.js") && fromBrowserCache) return new Response("Not found", { status: 404 });
    return new Response("export default 1", { status: 200 });
  });
  const self = {
    location: new URL(`${ORIGIN}/sw.js`),
    addEventListener: (type: string, listener: (event: FetchEvent) => void) => {
      if (type === "fetch") onFetch = listener;
    },
  };
  new Function("self", "caches", "fetch", source)(self, caches, network);
});

async function get(path: string) {
  const pending: Promise<unknown>[] = [];
  let response: Promise<Response> | undefined;
  onFetch({ request: new Request(`${ORIGIN}${path}`), respondWith: (r) => (response = r), waitUntil: (p) => pending.push(p) });
  const result = await response!;
  await Promise.all(pending);
  return result;
}

describe("the service worker", () => {
  test("loads a built file whose copy in the browser's cache is a 404", async () => {
    const response = await get("/assets/home-abc.js");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("export default 1");
    expect(network).toHaveBeenLastCalledWith(expect.objectContaining({ url: `${ORIGIN}/assets/home-abc.js` }), { cache: "reload" });
  });

  test("keeps the file it got past the browser's cache, so the next load comes from the worker", async () => {
    await get("/assets/home-abc.js");
    expect([...stored.keys()]).toEqual([`${ORIGIN}/assets/home-abc.js`]);
    network.mockClear();
    expect((await get("/assets/home-abc.js")).status).toBe(200);
    expect(network).toHaveBeenCalledTimes(0);
  });

  test("asks the network once for a built file that loads", async () => {
    expect((await get("/assets/index-abc.js")).status).toBe(200);
    expect(network).toHaveBeenCalledTimes(1);
  });
});
