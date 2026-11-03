import { AsyncLocalStorage } from "node:async_hooks";
import { waitUntil } from "@vercel/functions";
import { PostHog } from "posthog-node";
import { scrub } from "../shared/logs.js";
import { POSTHOG_HOST } from "../shared/posthog.js";

declare const process: { env: Record<string, string | undefined> };

/*
 * What each /api run did, sent to PostHog: its path, status and time, every service it called on the way and how long
 * each took, and the error when it failed. Vercel keeps a Hobby project's logs an hour; this keeps them a year. Only
 * Vercel's production and previews send (VERCEL_ENV), or a checkout that sets KRIDA_TELEMETRY, so dev and QA stay quiet;
 * and only with a PostHog project key (POSTHOG_KEY), so a copy of Krida without one sends nothing.
 */

const environment = process.env.KRIDA_TELEMETRY || process.env.VERCEL_ENV;
const key = process.env.POSTHOG_KEY;
const posthog = environment && key
  ? new PostHog(key, {
      host: POSTHOG_HOST,
      flushAt: 1,
      // Upstream errors can quote a provider's URL with its key in it.
      before_send: (event) => (event ? { ...event, properties: JSON.parse(scrub(JSON.stringify(event.properties ?? {}))) } : null),
    })
  : null;

type Call = { host: string; ms: number; status: number };
const calls = new AsyncLocalStorage<Call[]>();

// Times each outgoing fetch made while answering a request. Fluid compute answers several requests in one instance at
// once, so each request's calls are kept apart by AsyncLocalStorage rather than in one list.
if (posthog) {
  const send = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const list = calls.getStore();
    if (!list) return send(input, init);
    const host = new URL(input instanceof Request ? input.url : String(input)).host;
    const started = performance.now();
    try {
      const response = await send(input, init);
      list.push({ host, ms: Math.round(performance.now() - started), status: response.status });
      return response;
    } catch (error) {
      list.push({ host, ms: Math.round(performance.now() - started), status: 0 });
      throw error;
    }
  };
}

/** Runs one request's answer and reports it; `failed` is called by the answer with an error it turned into a 502. */
export async function reported(request: Request, answer: (failed: (error: unknown) => void) => Promise<Response>) {
  if (!posthog) return answer(() => {});
  const started = performance.now();
  const list: Call[] = [];
  let error: unknown;
  const response = await calls.run(list, () => answer((e) => (error = e)));
  const properties = {
    path: new URL(request.url).pathname,
    method: request.method,
    status: response.status,
    ms: Math.round(performance.now() - started),
    upstream: list,
    upstreamMs: list.reduce((sum, call) => sum + call.ms, 0),
    region: process.env.VERCEL_REGION,
    environment,
    $process_person_profile: false,
  };
  // After the answer has gone, so reporting never slows it.
  waitUntil(
    Promise.all([
      posthog.captureImmediate({ distinctId: "krida-api", event: "api_request", properties }),
      error === undefined ? undefined : posthog.captureExceptionImmediate(error, "krida-api", properties),
    ]).catch(() => {}),
  );
  return response;
}
