import { afterEach, describe, expect, test, vi } from "vitest";
import { track, trackError } from "../convex/lib/telemetry";

const PROD = "https://industrious-axolotl-949.convex.cloud";
const DEV = "https://fastidious-oyster-35.convex.cloud";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.doUnmock("posthog-node");
  vi.doUnmock("@vercel/functions");
});

function captureFetch() {
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    sent.push({ url, body: JSON.parse(String(init.body)) });
    return new Response("{}");
  }));
  return sent;
}

describe("Convex actions' PostHog events", () => {
  test("production sends the event to PostHog with the profile, and takes secrets out of it", async () => {
    vi.stubEnv("CONVEX_CLOUD_URL", PROD);
    vi.stubEnv("POSTHOG_KEY", "phc_test");
    const sent = captureFetch();
    await track("play_build", { videoId: "tt0111161", ms: 4210, attempts: [{ source: 0, failed: "bad link https://x.dev/f?apikey=abc123" }] }, "profile1");
    expect(sent).toEqual([
      {
        url: "https://us.i.posthog.com/i/v0/e/",
        body: {
          api_key: "phc_test",
          timestamp: expect.any(String),
          event: "play_build",
          distinct_id: "profile1",
          properties: { videoId: "tt0111161", ms: 4210, attempts: [{ source: 0, failed: "bad link https://x.dev/f?apikey=<redacted>" }], source: "convex", environment: "production" },
        },
      },
    ]);
  });

  test("an error goes to error tracking with its type, message and stack; without a profile it makes no person", async () => {
    vi.stubEnv("CONVEX_CLOUD_URL", PROD);
    vi.stubEnv("POSTHOG_KEY", "phc_test");
    const sent = captureFetch();
    const error = new TypeError("TorBox answered 500");
    await trackError(error, { action: "sources.list" });
    expect(sent.map((s) => [s.body.event, s.body.distinct_id, s.body.properties])).toEqual([
      [
        "$exception",
        "krida-backend",
        {
          action: "sources.list",
          $exception_list: [{ type: "TypeError", value: "TorBox answered 500", stack: error.stack }],
          stack: error.stack,
          source: "convex",
          environment: "production",
          $process_person_profile: false,
        },
      ],
    ]);
  });

  test("dev, previews and local backends send nothing", async () => {
    vi.stubEnv("CONVEX_CLOUD_URL", DEV);
    const sent = captureFetch();
    await track("play_build", { ms: 1 });
    await trackError(new Error("x"), {});
    expect(sent).toEqual([]);
  });

  test("production without a PostHog project key sends nothing", async () => {
    vi.stubEnv("CONVEX_CLOUD_URL", PROD);
    vi.stubEnv("POSTHOG_KEY", "");
    const sent = captureFetch();
    await track("play_build", { ms: 1 });
    await trackError(new Error("x"), {});
    expect(sent).toEqual([]);
  });
});

describe("/api's PostHog events", () => {
  async function endpointWith(env: Record<string, string>) {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    const events: { event: string; properties: Record<string, unknown> }[] = [];
    const errors: unknown[] = [];
    vi.doMock("@vercel/functions", () => ({ waitUntil: (p: Promise<unknown>) => p, getCache: () => ({}) }));
    vi.doMock("posthog-node", () => ({
      PostHog: class {
        captureImmediate = async (e: { event: string; properties: Record<string, unknown> }) => void events.push(e);
        captureExceptionImmediate = async (error: unknown) => void errors.push(error);
      },
    }));
    const { endpoint } = await import("../server/http");
    return { endpoint, events, errors };
  }

  test("a run that fails reports its status, time, each upstream call and the error", async () => {
    const upstream = vi.fn(async () => new Response("nope", { status: 503 }));
    vi.stubGlobal("fetch", upstream);
    const { endpoint, events, errors } = await endpointWith({ VERCEL_ENV: "production", POSTHOG_KEY: "phc_test" });
    const boom = new Error("TMDB answered 503");
    const handler = endpoint(async () => {
      await fetch("https://api.themoviedb.org/3/movie/1?api_key=k");
      throw boom;
    });
    const response = await handler.fetch(new Request("https://krida-open.vercel.app/api/title?id=tt1"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(response.status).toBe(502);
    expect(events).toEqual([
      {
        distinctId: "krida-api",
        event: "api_request",
        properties: {
          path: "/api/title",
          method: "GET",
          status: 502,
          ms: expect.any(Number),
          upstream: [{ host: "api.themoviedb.org", ms: expect.any(Number), status: 503 }],
          upstreamMs: expect.any(Number),
          region: undefined,
          environment: "production",
          $process_person_profile: false,
        },
      },
    ]);
    expect(errors).toEqual([boom]);
  });

  test("production without a PostHog project key sends nothing and leaves fetch alone", async () => {
    const upstream = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", upstream);
    vi.stubEnv("POSTHOG_KEY", "");
    const { endpoint, events } = await endpointWith({ VERCEL_ENV: "production" });
    await endpoint(async () => Response.json({ ok: true })).fetch(new Request("https://x.dev/api/rows"));
    expect(events).toEqual([]);
    expect(globalThis.fetch).toBe(upstream);
  });

  test("without VERCEL_ENV or KRIDA_TELEMETRY (dev, QA) nothing is sent and fetch is left alone", async () => {
    const upstream = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", upstream);
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("KRIDA_TELEMETRY", "");
    const { endpoint, events } = await endpointWith({});
    const response = await endpoint(async () => Response.json({ ok: true })).fetch(new Request("https://x.dev/api/rows"));
    expect(await response.json()).toEqual({ ok: true });
    expect(events).toEqual([]);
    expect(globalThis.fetch).toBe(upstream);
  });
});
