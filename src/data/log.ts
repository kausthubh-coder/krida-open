import type { ConvexReactClient } from "convex/react";
import { api } from "../../convex/_generated/api";
import { DETAIL_MAX, MESSAGE_MAX, scrub } from "../../shared/logs";
import { SESSION_KEY } from "./session";
import { platform, track, trackError } from "./telemetry";

/*
 * Tells Convex when something fails here (convex/logs.ts), so a bug someone saw once can be looked up afterwards with
 * `node scripts/logs.mjs`. Only failures are sent, each kind and message once per page load, and at most a few. PostHog
 * (src/data/telemetry.ts) gets every one, with the session's replay around it.
 */

const MAX_PER_LOAD = 20;
const BUILD = (import.meta.env.VITE_KRIDA_COMMIT as string | undefined)?.slice(0, 7);

let client: ConvexReactClient | null = null;
const sent = new Set<string>();

/** Notes a failure: `kind` to filter by ("meta", "api", "player"…), what failed, and what helps to find out why. */
export function logProblem(kind: string, message: string, detail?: Record<string, unknown> | string) {
  if (kind !== "error" && kind !== "rejection") track("problem", { kind, message, ...(typeof detail === "string" ? { detail } : detail) });
  const key = `${kind}:${message}`;
  if (!client || sent.has(key) || sent.size >= MAX_PER_LOAD) return;
  sent.add(key);
  const extra = detail === undefined ? undefined : typeof detail === "string" ? detail : JSON.stringify(detail);
  void client
    .mutation(api.logs.report, {
      token: localStorage.getItem(SESSION_KEY) ?? undefined,
      kind,
      message: scrub(message, MESSAGE_MAX),
      detail: extra === undefined ? undefined : scrub(extra, DETAIL_MAX),
      page: location.pathname + location.search,
      platform: platform(),
      build: BUILD,
    })
    .catch(() => {});
}

/** Starts sending, and catches what nothing else did: uncaught errors and rejected promises. */
export function startLogs(convex: ConvexReactClient) {
  client = convex;
  addEventListener("error", (event) => {
    // A failed <img> or <video> fires here too, without an error: those have their own handling.
    if (!(event.error instanceof Error)) return;
    trackError(event.error);
    logProblem("error", event.error.message, event.error.stack);
  });
  addEventListener("unhandledrejection", (event) => {
    const reason: unknown = event.reason;
    trackError(reason);
    if (reason instanceof Error) logProblem("rejection", reason.message, reason.stack);
    else logProblem("rejection", String(reason));
  });
}
