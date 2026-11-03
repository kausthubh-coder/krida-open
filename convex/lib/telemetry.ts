import { scrub } from "../../shared/logs";
import { POSTHOG_HOST } from "../../shared/posthog";
import { isProduction } from "./deployment";

/*
 * What actions did, for PostHog next to the browser's events (src/data/telemetry.ts): a Play's build step by step, a
 * Simkl sync, an action that failed. Only production sends, and only with a PostHog project key (POSTHOG_KEY on
 * Convex), so dev, previews, QA backends and copies of Krida without one stay quiet. Queries and
 * mutations can't call out; their errors reach the browser, which reports them.
 */

type Properties = Record<string, unknown>;

// Convex provides process.env in every runtime; declared here so the web app's typecheck agrees.
declare const process: { env: Record<string, string | undefined> };

async function send(body: Record<string, unknown>) {
  const key = process.env.POSTHOG_KEY;
  if (!isProduction() || !key) return;
  await fetch(`${POSTHOG_HOST}/i/v0/e/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // Errors can quote a provider's URL with its key in it; the event is scrubbed, not the project key beside it.
    body: JSON.stringify({ api_key: key, timestamp: new Date().toISOString(), ...JSON.parse(scrub(JSON.stringify(body))) }),
  }).catch(() => {});
}

/** An event from the backend, about a profile (its id, as the browser identifies it) or about Krida itself. */
export function track(event: string, properties: Properties, profileId?: string) {
  return send({
    event,
    distinct_id: profileId ?? "krida-backend",
    // Only production sends; saying so puts these events on the dashboards and alerts, which filter on it.
    properties: { ...properties, source: "convex", environment: "production", ...(profileId ? {} : { $process_person_profile: false }) },
  });
}

/** An error for PostHog's error tracking, with its stack as it was thrown. */
export function trackError(error: unknown, properties: Properties, profileId?: string) {
  const e = error instanceof Error ? error : new Error(String(error));
  return track("$exception", { ...properties, $exception_list: [{ type: e.name, value: e.message, stack: e.stack }], stack: e.stack }, profileId);
}
