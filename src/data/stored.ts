import { useEffect, useMemo } from "react";
import { useQuery } from "convex-helpers/react/cache/hooks";
import type { OptionalRestArgsOrSkip } from "convex/react";
import { getFunctionName, type FunctionArgs, type FunctionReference, type FunctionReturnType } from "convex/server";

/*
 * The last result of a few big queries (Home's rows, the Library), kept in localStorage so opening Krida shows
 * them at once while the live result loads; the live one replaces it as soon as it arrives. Convex keeps query
 * results only in memory, and its cache provider only for a few minutes after a page unmounts.
 *
 * Results are kept per session (the key hashes the arguments, token included, so it never stores the token) and
 * per build: this module's URL carries the bundle's hash, and a new build may read a result differently. A result
 * whose shape rarely changes can outlive builds instead (`acrossBuilds`), so the first open after a deploy still has it.
 */

const PREFIX = "krida.q.";
const BUILD = hash(import.meta.url);
// Kept across builds. "_" never appears in a build's hash, so these never pass for one.
const ANY_BUILD = `${PREFIX}_.`;
// localStorage holds about 5 MB per site; a result bigger than this isn't worth the parse on every open.
const MAX_CHARS = 1_500_000;

/** FNV-1a: short, stable keys without keeping what's hashed. */
function hash(text: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

function drop(which: (key: string) => boolean) {
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith(PREFIX) && which(key)) localStorage.removeItem(key);
  } catch {
    // Storage blocked (private mode, a policy): nothing is kept.
  }
}
// Results from an older build are dropped once per load.
drop((key) => !key.startsWith(`${PREFIX}${BUILD}.`) && !key.startsWith(ANY_BUILD));

function read(key: string): unknown {
  try {
    const text = localStorage.getItem(key);
    return text === null ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
}

function write(key: string, value: unknown) {
  const text = JSON.stringify(value);
  if (text.length > MAX_CHARS) return localStorage.removeItem(key);
  try {
    localStorage.setItem(key, text);
  } catch {
    // Full: make room by dropping every other kept result, then try once more.
    drop((other) => other !== key);
    try {
      localStorage.setItem(key, text);
    } catch {
      // Still too big: go without.
    }
  }
}

/** Forgets every kept result, for signing out. */
export function forgetStored() {
  drop(() => true);
}

/**
 * `useQuery` that answers with the last result this session saw until the live one arrives. Only for queries
 * whose screens can show a slightly old answer for a moment: never for one that decides access.
 */
export function useStoredQuery<Q extends FunctionReference<"query">>(query: Q, args: FunctionArgs<Q>): FunctionReturnType<Q> | undefined {
  const live: FunctionReturnType<Q> | undefined = useQuery(query, ...([args] as unknown as OptionalRestArgsOrSkip<Q>));
  return useStored(getFunctionName(query), args, live);
}

/**
 * The same for a value built from queries in the browser: `name` and `args` say which one it is. With `acrossBuilds`,
 * a new build reads what an older one kept, so `name` must change whenever the value's shape does.
 */
export function useStored<T>(name: string, args: unknown, live: T | undefined, { acrossBuilds = false } = {}): T | undefined {
  const key = `${acrossBuilds ? ANY_BUILD : `${PREFIX}${BUILD}.`}${hash(`${name}:${JSON.stringify(args)}`)}`;
  const kept = useMemo(() => read(key) as T | undefined, [key]);
  useEffect(() => {
    if (live === undefined) return;
    // Written when the page is idle: a big result takes a few milliseconds to serialise. Safari has no idle callback.
    if (typeof requestIdleCallback !== "function") {
      const t = setTimeout(() => write(key, live), 1000);
      return () => clearTimeout(t);
    }
    const id = requestIdleCallback(() => write(key, live), { timeout: 2000 });
    return () => cancelIdleCallback(id);
  }, [key, live]);
  return live !== undefined ? live : kept;
}
