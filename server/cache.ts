import { getCache } from "@vercel/functions";

declare const process: { env: Record<string, string | undefined> };

/*
 * What TMDB, MDBList, Cinemeta and the catalogs said, kept in Vercel's runtime cache: one per region, shared by every
 * function there, and kept across deploys (the CDN's copy of a response isn't). Off Vercel (dev, tests) it is this
 * process's memory. Asking for a key that is already loading waits for that load instead of starting another.
 */

type Store = { get(key: string): Promise<unknown>; set(key: string, value: unknown, ttl: number): Promise<void> };

const MEMORY_KEYS = 20_000;
const memory = new Map<string, { value: unknown; until: number }>();
const local: Store = {
  async get(key) {
    const hit = memory.get(key);
    if (!hit) return undefined;
    if (hit.until > Date.now()) return hit.value;
    memory.delete(key);
    return undefined;
  },
  async set(key, value, ttl) {
    memory.delete(key);
    memory.set(key, { value, until: Date.now() + ttl * 1000 });
    for (const oldest of memory.keys()) {
      if (memory.size <= MEMORY_KEYS) break;
      memory.delete(oldest);
    }
  },
};

let store: Store | undefined;
function runtime(): Store {
  if (store) return store;
  if (process.env.VERCEL) {
    // Bumped when what's kept changes shape, so a deploy never reads an older kind of answer.
    const cache = getCache({ namespace: "krida-1" });
    return (store = { get: (key) => cache.get(key), set: (key, value, ttl) => cache.set(key, value, { ttl }) });
  }
  return (store = local);
}

/** For tests: forget everything, and keep answers in memory (Vercel's builds, which run them, look like Vercel). */
export function clearCache() {
  store = local;
  memory.clear();
  loading.clear();
  kept.clear();
}

const loading = new Map<string, Promise<unknown>>();

// Values are boxed, so "nothing" (null) can be remembered too.
type Box = { v: unknown };
const read = async (key: string) => ((await runtime().get(key).catch(() => undefined)) as Box | undefined) ?? undefined;

/** What's kept for `key`, if anything, without loading it. */
export async function peek<T>(key: string): Promise<T | undefined> {
  const hit = await read(key);
  return hit ? (hit.v as T) : undefined;
}

/** Keeps `value` for `key` for `ttl` seconds. */
export async function keep(key: string, value: unknown, ttl: number) {
  await runtime().set(key, { v: value } satisfies Box, ttl).catch(() => {});
}

/**
 * `load()`'s answer for `key`, from the cache while it's fresh. `ttl` is in seconds and may depend on the answer (a miss
 * is asked about again sooner). A load that throws isn't kept.
 */
export async function cached<T>(key: string, ttl: number | ((value: T) => number), load: () => Promise<T>): Promise<T> {
  const hit = await read(key);
  if (hit) return hit.v as T;
  const pending = loading.get(key);
  if (pending) return (await pending) as T;
  const next = (async () => {
    const value = await load();
    const seconds = typeof ttl === "function" ? ttl(value) : ttl;
    if (seconds > 0) await runtime().set(key, { v: value } satisfies Box, seconds).catch(() => {});
    return value;
  })();
  loading.set(key, next);
  try {
    return await next;
  } finally {
    loading.delete(key);
  }
}

/**
 * Many keys at once: the cached ones are read, and the rest are loaded together by `loadMissing` (one MDBList batch,
 * say), which answers for the ids it knows. Ids it leaves out aren't kept, so a failed batch is asked again next time.
 */
export async function cachedMany<T>(
  prefix: string, ids: string[], ttl: number | ((value: T) => number), loadMissing: (ids: string[]) => Promise<Map<string, T>>,
): Promise<Map<string, T>> {
  const out = new Map<string, T>();
  const unique = [...new Set(ids)];
  const hits = await Promise.all(unique.map((id) => read(`${prefix}:${id}`)));
  const missing: string[] = [];
  unique.forEach((id, i) => {
    const hit = hits[i];
    if (hit) out.set(id, hit.v as T);
    else missing.push(id);
  });
  if (missing.length === 0) return out;
  const found = await loadMissing(missing);
  await Promise.all([...found].map(async ([id, value]) => {
    out.set(id, value);
    const seconds = typeof ttl === "function" ? ttl(value) : ttl;
    if (seconds > 0) await runtime().set(`${prefix}:${id}`, { v: value } satisfies Box, seconds).catch(() => {});
  }));
  return out;
}

const kept = new Map<string, { value: Promise<unknown>; until: number }>();

/**
 * `load()`'s answer kept in this instance's memory only, for answers built from cached parts that are too big for the
 * runtime cache (it takes 2 MB an item). A failed load isn't kept.
 */
export function inMemory<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
  const hit = kept.get(key);
  if (hit && hit.until > Date.now()) return hit.value as Promise<T>;
  const value = load();
  kept.set(key, { value, until: Date.now() + ttl * 1000 });
  value.catch(() => kept.get(key)?.value === value && kept.delete(key));
  return value;
}

export const HOUR = 60 * 60;
export const DAY = 24 * HOUR;
