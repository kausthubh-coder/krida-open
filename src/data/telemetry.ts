import { useEffect, useRef } from "react";
import type { CaptureResult, PostHog, Properties } from "posthog-js";
import { scrub } from "../../shared/logs";
import { POSTHOG_APP } from "../../shared/posthog";

/*
 * Everything Krida does in the browser, sent to PostHog so a bug, a slow screen or a stall can be seen afterwards:
 * errors with readable stacks, a replay of each session with its console and network, clicks, web vitals, and Krida's
 * own timings (`track`). Two people use Krida, so it records everything rather than samples. It loads after the first
 * screen has painted, and keeps what happens before that until it's there.
 *
 * Only builds with a PostHog project key (VITE_POSTHOG_KEY) that name an environment send: Vercel's production and
 * previews (scripts/build-frontend.mjs) or a checkout that sets VITE_KRIDA_TELEMETRY. Dev, QA, the regression gate and
 * any copy of Krida without its own PostHog project stay quiet.
 */

const KEY = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
const ENVIRONMENT = KEY ? (import.meta.env.VITE_KRIDA_TELEMETRY as string | undefined) : undefined;
const BUILD = (import.meta.env.VITE_KRIDA_COMMIT as string | undefined)?.slice(0, 7);
/** Krida's own address for PostHog (vercel.json, vite.config.ts), so blockers that know PostHog's don't drop it. */
const RELAY = "/relay";
// What can wait before PostHog has loaded; more than this before then is a loop, not a page loading.
const MAX_WAITING = 300;

let posthog: PostHog | null = null;
const waiting: ((posthog: PostHog) => void)[] = [];

function whenReady(send: (posthog: PostHog) => void) {
  if (posthog) send(posthog);
  else if (ENVIRONMENT && waiting.length < MAX_WAITING) waiting.push(send);
}

/** Where this page runs: the browser, the installed web app, or one of Krida's apps, which all show the live site. */
export function platform() {
  if ((window as { KridaAndroid?: unknown }).KridaAndroid) return "android";
  if (window.kridaDesktop) return `${window.kridaDesktop.platform === "macos" ? "mac" : "windows"} ${window.kridaDesktop.version}`;
  return matchMedia("(display-mode: standalone)").matches ? "web app" : "web";
}

const where = () => ({ platform: platform(), build: BUILD ?? "dev", environment: ENVIRONMENT });

/** One of Krida's own events ("play_timing", "api_call"…), kept with the time it happened even if PostHog loads later. */
export function track(event: string, properties?: Properties) {
  const timestamp = new Date();
  whenReady((p) => p.capture(event, properties, { timestamp }));
}

/** An error, with its stack, for PostHog's error tracking. */
export function trackError(error: unknown, properties?: Properties) {
  whenReady((p) => p.captureException(error, properties));
}

/** Ties what follows to a profile, or to no one after signing out. */
export function identify(profile: { _id: string; name: string } | null) {
  whenReady((p) => {
    if (profile) p.identify(profile._id, { name: profile.name });
    else {
      // Forgetting the profile forgets every registered fact too: put back where this page runs.
      p.reset();
      p.register(where());
    }
  });
}

/** Facts sent with every event from here on, like the party being watched in. */
export function setContext(properties: Properties) {
  whenReady((p) => p.register(properties));
}

// Every string PostHog sends goes through scrub(): page URLs carry OAuth and join codes, stream URLs session tokens.
const scrubbed = <T>(value: T): T => JSON.parse(scrub(JSON.stringify(value))) as T;

function scrubRequest<T extends { name?: string; requestHeaders?: unknown; responseHeaders?: unknown; requestBody?: string | null; responseBody?: string | null }>(request: T): T {
  const headers = (h: unknown) => (h ? scrubbed(Object.fromEntries(h instanceof Headers ? h.entries() : Object.entries(h as Record<string, string>))) : h);
  return {
    ...request,
    name: request.name && scrub(request.name),
    requestHeaders: headers(request.requestHeaders),
    responseHeaders: headers(request.responseHeaders),
    requestBody: request.requestBody && scrub(request.requestBody),
    responseBody: request.responseBody && scrub(request.responseBody),
  };
}

/** Loads PostHog once the first screen has painted. */
export function startTelemetry() {
  if (!ENVIRONMENT) return;
  const load = () =>
    void import("posthog-js").then(({ default: p }) => {
      p.init(KEY!, {
        api_host: RELAY,
        ui_host: POSTHOG_APP,
        defaults: "2026-08-30",
        person_profiles: "identified_only",
        capture_pageview: "history_change",
        autocapture: true,
        rageclick: true,
        capture_dead_clicks: true,
        enable_heatmaps: true,
        // Errors come from src/data/log.ts, which catches them from the first line, before PostHog is here.
        capture_exceptions: false,
        capture_performance: { web_vitals: true, network_timing: true },
        enable_recording_console_log: true,
        disable_surveys: true,
        // PostHog drops what looks like a bot; an app's web view or a test browser must never be taken for one.
        opt_out_useragent_filter: true,
        session_recording: {
          maskAllInputs: false,
          // A playing <video> can't be recorded anyway, and its src may carry a session token.
          blockSelector: "video",
          recordHeaders: true,
          recordBody: true,
          maskCapturedNetworkRequestFn: scrubRequest,
        },
        // `token` is the project key, which PostHog files the event by: everything but it is scrubbed.
        before_send: (event: CaptureResult | null) =>
          event ? { ...event, properties: { ...scrubbed(event.properties), token: event.properties.token as unknown } } : null,
      });
      p.register(where());
      posthog = p;
      for (const send of waiting.splice(0)) send(p);
    });
  const idle = () => ("requestIdleCallback" in window ? requestIdleCallback(load, { timeout: 4000 }) : setTimeout(load, 1500));
  if (document.readyState === "complete") idle();
  else addEventListener("load", idle, { once: true });
}

const started = new Map<string, number>();

/** Starts a clock for something that ends on another screen, like Play pressed here and the picture shown in the room. */
export function startTimer(key: string) {
  started.set(key, performance.now());
}

/** How long ago `startTimer(key)` ran, if it was within the last minute. */
export function timerSince(key: string) {
  const at = started.get(key);
  return at !== undefined && performance.now() - at < 60_000 ? Math.round(performance.now() - at) : undefined;
}

let firstReady = true;

/**
 * Sends `page_ready` the first time `ready` is true for a `key` (a title's id, a search): how long since that screen
 * opened, and since Krida started.
 */
export function useReadyTiming(page: string, ready: boolean, key = page) {
  const screen = useRef({ opened: 0, sent: false });
  useEffect(() => {
    screen.current = { opened: performance.now(), sent: false };
  }, [key]);
  useEffect(() => {
    if (!ready || screen.current.sent) return;
    screen.current.sent = true;
    const now = performance.now();
    // The first screen of a load is the cold start: Krida's whole startup, not just this screen's data.
    track("page_ready", { page, ms: Math.round(now - screen.current.opened), sinceStart: Math.round(now), coldStart: firstReady });
    firstReady = false;
  }, [page, ready, key]);
}
