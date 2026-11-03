import { afterEach, describe, expect, test, vi } from "vitest";
import { getMeta } from "../src/data/cinemeta";

// What the title page loads first: Cinemeta's details for a title, straight from the browser.
const dorothy = { meta: { id: "tt38915678", imdb_id: "tt38915678", name: "Dorothy", type: "movie" } };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function cinemeta(...answers: (Response | Error)[]) {
  const fetch = vi.fn(async () => {
    const next = answers.shift();
    if (!next) throw new Error("no more answers");
    if (next instanceof Error) throw next;
    return next;
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

/** getMeta with the waits between tries skipped. */
async function load(type: "movie" | "series", id: string) {
  vi.useFakeTimers();
  const result = getMeta(type, id).then((meta) => ({ meta }), (error: Error) => ({ error: error.message }));
  await vi.runAllTimersAsync();
  return result;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("loading a title's details from Cinemeta", () => {
  test("a 503, then an answer: the page loads", async () => {
    const fetch = cinemeta(new Response("Service Unavailable", { status: 503 }), json(dorothy));
    expect(await load("movie", "tt38915678")).toEqual({ meta: { ...dorothy.meta, videos: [] } });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test("the connection dropping twice, then an answer: the page loads", async () => {
    const fetch = cinemeta(new TypeError("Failed to fetch"), new TypeError("Failed to fetch"), json({ meta: { ...dorothy.meta, id: "tt1" } }));
    expect(await load("movie", "tt1")).toEqual({ meta: { ...dorothy.meta, id: "tt1", videos: [] } });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  test("three failures in a row: the error, after three tries", async () => {
    const fetch = cinemeta(json({}, 502), json({}, 503), json({}, 500));
    expect(await load("movie", "tt2")).toEqual({ error: "Cinemeta answered 500" });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  test("no details for the title: Not found at once, since asking again gets the same answer", async () => {
    const fetch = cinemeta(json({}));
    expect(await load("series", "tt38051359")).toEqual({ error: "Not found" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("a 404 isn't asked again", async () => {
    const fetch = cinemeta(json({ err: "not found" }, 404));
    expect(await load("movie", "tt3")).toEqual({ error: "Cinemeta answered 404" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
