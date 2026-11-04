import { useEffect, useSyncExternalStore } from "react";
import type { ImdbTrailer } from "../../shared/imdb";
import { CONVEX_URL } from "./backend";
import { SESSION_KEY } from "./session";
import { logProblem } from "./log";
import { track } from "./telemetry";
import type { ShownRow } from "../../server/catalogs";
import type { RecItem } from "../../server/meta";
import type { KeyframeIndex } from "../../server/mkv";
import type { PersonPage } from "../../server/people";
import type { SearchCursor, SearchOut, SearchPage } from "../../server/search";
import type { Art, Facts } from "../../server/titles";

/*
 * Krida's public-data endpoints (api/*, server/*): titles, ratings, search, catalogs and trailers. They ask TMDB,
 * MDBList and TorBox with the keys of your account (the session goes with every call), but answer the same for
 * everyone, so Vercel's CDN keeps their answers; what you've done with a title (watched, rated, saved) is added here in
 * the browser from your own data.
 */

type Params = Record<string, string | number | undefined>;

export class ApiError extends Error {}
/** Fired when /api says TMDB turned the account's key down. */
export const KEY_REFUSED = "krida:key-refused";
/** Your account has no key for this (`needs`): Settings → Connections is where it's added. */
export class NeedsKeyError extends ApiError {
  readonly needs: "tmdb" | "mdblist" | "torbox";
  constructor(message: string, needs: "tmdb" | "mdblist" | "torbox") {
    super(message);
    this.needs = needs;
  }
}
/** The server answered, but the file couldn't give this keyframe (none there, or TorBox failed or took too long). */
export class FileError extends ApiError {}

/** A server asked to slow down (TorBox's 429), for this many seconds. */
export class SlowDown extends ApiError {
  readonly seconds: number;
  constructor(seconds: number) {
    super("Asked to slow down");
    this.seconds = seconds;
  }
}

/** Every endpoint asks who's asking, to use their account's keys (server/session.ts). Answers are the same for everyone. */
function sessionHeaders(): Record<string, string> {
  const token = localStorage.getItem(SESSION_KEY);
  return token ? { "x-krida-backend": CONVEX_URL, "x-krida-session": token } : {};
}

async function get<T>(path: string, params: Params = {}): Promise<T> {
  const url = new URL(`/api/${path}`, location.origin);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  const started = Date.now();
  const note = (message: string, status?: number) =>
    logProblem("api", `/api/${path}: ${message}`, { url: url.pathname + url.search, status, ms: Date.now() - started });
  const fail = (message: string, status: number) => {
    note(message, status);
    return new ApiError(message);
  };
  const res = await fetch(url, { headers: sessionHeaders() }).catch((error: unknown) => {
    note(`couldn't reach it: ${String(error)}`);
    throw error;
  });
  const text = await res.text();
  // Every call, so slow endpoints show up and not only failing ones. HIT means Vercel's CDN answered without a function.
  track("api_call", { path, status: res.status, ms: Date.now() - started, cache: res.headers.get("x-vercel-cache") ?? undefined });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw fail(`Krida's server answered ${res.status} without data`, res.status);
  }
  const problem = body as { error?: string; needs?: "tmdb" | "mdblist" | "torbox"; refused?: "tmdb" } | null;
  // TMDB turned the account's key down: the app has it checked again, which routes to fixing it (main's Gate).
  if (res.status === 403 && problem?.refused) window.dispatchEvent(new Event(KEY_REFUSED));
  // Not a failure to log: the account hasn't added that key yet.
  if (res.status === 403 && problem?.needs) throw new NeedsKeyError(problem.error ?? "Add your key in Settings", problem.needs);
  if (!res.ok) throw fail(problem?.error ?? `Krida's server answered ${res.status}`, res.status);
  return body as T;
}

/** Where a film's keyframes are, read from its own file's index, or null when it has none (server/mkv.ts). */
export const keyframeIndex = (size: number) => get<KeyframeIndex | null>("frames", { size });

/** Where the frames Worker is and a day's ticket to read this film there, or null where it isn't set up. */
export const frameTicket = (size: number) => get<FramesWorker | null>("frames", { size, ticket: 1 });
export type FramesWorker = { url: string; expires: number; ticket: string };

/**
 * One keyframe of a film, compressed, at a place from its index: from the frames Worker when there's a ticket, else
 * from /api/frame.
 */
export async function keyframe(size: number, [, cluster, relative]: KeyframeIndex["points"][number], track: number, signal: AbortSignal, worker?: FramesWorker) {
  const url = new URL(worker ? `${worker.url}/frame` : "/api/frame", location.origin);
  const params = { size, cluster, relative, track, ...(worker && { expires: worker.expires, ticket: worker.ticket }) };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  // A keyframe that hasn't come in 20 s isn't coming: let the storyboard move on.
  const res = await fetch(url, { headers: worker ? {} : sessionHeaders(), signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) });
  // An error's body isn't needed: let the connection go now, not when the timeout fires.
  if (!res.ok) await res.body?.cancel();
  if (res.status === 429) throw new SlowDown(Number(res.headers.get("retry-after")) || 10);
  // The Worker marks what's about the file; anything else from it is the Worker failing.
  const aboutFile = !worker || res.headers.get("x-frames-error") === "file";
  if (aboutFile && (res.status === 404 || res.status === 502 || res.status === 504)) throw new FileError(`TorBox couldn't give that keyframe (${res.status})`);
  if (!res.ok) throw new ApiError(`${worker ? "The frames Worker" : "Krida's server"} answered ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

type Kind = "movie" | "series";
export type { KeyframeIndex, PersonPage, RecItem, SearchCursor, SearchOut, SearchPage, ShownRow };
export type TitleInfo = { ratings: Facts["ratings"]; certification: string | null; trailer: string | null } | null;

export const search = (q: string) => get<SearchOut>("search", { q });
export const searchPage = (q: string, cursor: SearchCursor) =>
  get<SearchPage>("search-page", { q, cursor: [cursor.movie, cursor.tv, cursor.multi].map((x) => x ?? "-").join(",") });
/** A person's page by TMDB id, or by a name a title's credits give (`title` is that title's IMDb id). */
export const person = (id: string, title?: string) => get<PersonPage>("search", { person: id, title });
export const titleInfo = (id: string, type: Kind) => get<TitleInfo>("title", { id, type });
export const artwork = (id: string, lookup: { name?: string; year?: string; type?: Kind } = {}) => get<Art>("artwork", { id, ...lookup });
export const animeBackdrop = (tmdbId: string, type: Kind) => get<string | null>("anime-backdrop", { tmdbId, type });
export const moreLike = (id: string, type: Kind) => get<RecItem[]>("more-like", { id, type });
export const trailers = (ids: string[]) => get<ImdbTrailer[]>("trailers", { ids: [...ids].sort().join(",") });
export const starter = () => get<{ items: Pick<RecItem, "id" | "type" | "name" | "poster" | "year">[] }>("starter");
export const rows = () => get<{ rows: ShownRow[] }>("rows");
/** An addon's answer through Krida's server, for an addon the browser can't read itself (no CORS headers). */
export const proxied = <T,>(url: string) => get<T>("rows", { addon: url });

/*
 * An answer every screen shares (Home's catalog rows), fetched once and asked again when the tab comes back after
 * `maxAge`, like a subscription that refreshes about as often as the answer changes. Null when it couldn't be fetched
 * and there's no earlier answer.
 */
type Shared<T> = { value?: T | null; at: number; loading?: Promise<void>; listeners: Set<() => void> };
const shared = new Map<string, Shared<unknown>>();

function entry<T>(key: string) {
  let e = shared.get(key) as Shared<T> | undefined;
  if (!e) shared.set(key, (e = { at: 0, listeners: new Set() }));
  return e;
}

function refresh<T>(key: string, load: () => Promise<T>, maxAge: number) {
  const e = entry<T>(key);
  if (e.loading || Date.now() - e.at < maxAge) return;
  e.loading = load()
    .then((value) => {
      e.value = value;
      e.at = Date.now();
    }, (error: unknown) => {
      // The last answer stays; asked again a minute later, on the next visit or return to the tab. A missing key
      // is asked again on the next visit at once: Home is warmed as a profile is made, before onboarding has its
      // TMDB key, and it should have its rows the moment onboarding ends.
      e.value ??= null;
      e.at = error instanceof NeedsKeyError ? 0 : Date.now() - maxAge + 60_000;
    })
    .finally(() => {
      e.loading = undefined;
      for (const listener of e.listeners) listener();
    });
}

export function useShared<T>(key: string, load: () => Promise<T>, maxAge: number): T | null | undefined {
  const e = entry<T>(key);
  const value = useSyncExternalStore(
    (listener) => {
      e.listeners.add(listener);
      return () => e.listeners.delete(listener);
    },
    () => e.value,
  );
  useEffect(() => {
    refresh(key, load, maxAge);
    const visible = () => document.visibilityState === "visible" && refresh(key, load, maxAge);
    document.addEventListener("visibilitychange", visible);
    return () => document.removeEventListener("visibilitychange", visible);
  }, [key, load, maxAge]);
  return value;
}

/** A shared answer already fetched, without asking for it. */
export const peekShared = <T,>(key: string) => (shared.get(key) as Shared<T> | undefined)?.value;

/** Starts fetching a shared answer early (hovering the nav), so the screen opens with it. */
export const prefetchShared = <T,>(key: string, load: () => Promise<T>, maxAge: number) => refresh(key, load, maxAge);

const ROWS_MAX_AGE = 30 * 60_000;
const NO_CATALOG = async () => ({ rows: [] as ShownRow[] });
/** Home's catalog rows. Not asked for while `tmdb` is false: they're TMDB's and Netflix's, found with the account's key. */
export const useCatalogRows = (tmdb = true) => useShared(tmdb ? "rows" : "rows:none", tmdb ? rows : NO_CATALOG, ROWS_MAX_AGE);
export const prefetchCatalogRows = () => prefetchShared("rows", rows, ROWS_MAX_AGE);
