import { useCallback, useEffect, useRef, useState } from "react";
import { parseTags, tagsTitle } from "../../../../shared/tags";
import { search, searchPage } from "../../../data/api";
import { useAuthed } from "../../../data/session";
import { searchAll, useAsync } from "../../../data/cinemeta";
import { useNeedsTmdbKey } from "../../../data/keys";
import type { Found, Result } from "./Results";

const NO_BATCHES: Result[][] = [];

// Going back to a recent search is instant, with every page it had loaded. Statuses on the cards are
// live (useWatchStatus), so a cached search never shows an old one. The nav's suggestions and the
// Search page share it, so "See all results" opens on what the nav already found.
const CACHED_QUERIES = 20;
const cache = new Map<string, Promise<Found>>();
function cachePut(key: string, value: Promise<Found>) {
  cache.delete(key);
  cache.set(key, value);
  for (const oldest of cache.keys()) {
    if (cache.size <= CACHED_QUERIES) break;
    cache.delete(oldest);
  }
}
function remember(key: string, load: () => Promise<Found>): Promise<Found> {
  let hit = cache.get(key);
  if (!hit) {
    const loading = load();
    loading.catch(() => cache.get(key) === loading && cache.delete(key));
    hit = loading;
  }
  cachePut(key, hit);
  return hit;
}
let lastAnswer: { token: string; query: string; data: Found } | undefined;

/** The URL for a query; the Movies/Shows filter stays as it was. */
export const paramsFor = (q: string) => (current: URLSearchParams): Record<string, string> => {
  const type = current.get("type");
  return q ? { q, ...(type ? { type } : {}) } : {};
};

/** Names searched on Cinemeta alone: what Krida's server finds without TMDB, or when it can't answer. */
const fromCinemeta = async (query: string): Promise<Found> => ({
  results: (await searchAll(query)).map((m) => ({ id: m.id, type: m.type, name: m.name, poster: m.poster, year: m.releaseInfo })),
  person: null,
  anime: [],
  genre: null,
});

/**
 * Search through Krida's server (TMDB, Cinemeta, Kitsu); straight to Cinemeta if the server can't answer, or while the
 * account has no TMDB key (no people, anime seasons or genre and language searches then: those are TMDB's).
 */
export function useSearch(query: string) {
  const { token } = useAuthed();
  const needsKey = useNeedsTmdbKey();
  const [attempt, setAttempt] = useState(0);
  const key = query.length >= 2 ? `search:${token}:${needsKey ? "cinemeta" : "krida"}:${query.toLowerCase()}:${attempt}` : null;
  const state = useAsync<Found>(key, () =>
    remember(key!, () =>
      needsKey ? fromCinemeta(query) : search(query)
        .then((found) => {
          if (parseTags(query) && !found.tags) throw new Error("Tag search is unavailable");
          return found;
        })
        .catch(async (error: unknown) => {
          // Cinemeta searches names, so it cannot recover a language/genre discovery request.
          if (parseTags(query)) throw error;
          return await fromCinemeta(query);
        }),
    ),
  );
  // `batches` holds what each later batch added, newest last, so auto-loading can tell when they stop adding anything.
  const [more, setMore] = useState<{ key: string | null; data?: Found; batches: Result[][]; loading: boolean; error?: Error }>({
    key: null,
    batches: [],
    loading: false,
  });
  const lifetime = useRef({ active: true });
  const pending = useRef<object | null>(null);
  useEffect(() => {
    const session = { active: true };
    lifetime.current = session;
    pending.current = null;
    return () => { session.active = false; };
  }, [key]);
  const data = more.key === key && more.data ? more.data : state.data;
  // The last answer, kept on screen while the next query loads, so refining a search doesn't blank it.
  // It starts from the last answer anywhere: Enter in the nav opens the Search page on what the
  // suggestions showed, instead of an empty page while the full query is still on its way.
  const [last, setLast] = useState(() => (lastAnswer?.token === token ? lastAnswer : undefined));
  useEffect(() => {
    if (!data) return;
    lastAnswer = { token, query, data };
    setLast(lastAnswer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);
  const batches = more.key === key ? more.batches : NO_BATCHES;
  const loadingMore = more.key === key && more.loading;
  const moreError = more.key === key ? more.error : undefined;
  const loadMore = useCallback(async () => {
    if (!key || !data?.nextCursor || pending.current) return;
    const session = lifetime.current;
    const request = {};
    pending.current = request;
    setMore({ key, data, batches, loading: true });
    try {
      const batch = await searchPage(query, data.nextCursor);
      if (!session.active) return;
      const seen = new Set([
        ...(data.genre?.results ?? []), ...data.results, ...(data.person?.titles ?? []), ...data.anime,
      ].map((r) => `${r.type}:${r.id}`));
      const added = batch.results.filter((r) => {
        const id = `${r.type}:${r.id}`;
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
      const next: Found = {
        ...data, nextCursor: batch.nextCursor,
        ...(data.tags
          ? { genre: { title: tagsTitle(data.tags), results: [...(data.genre?.results ?? []), ...added] } }
          : { results: [...data.results, ...added] }),
      };
      cachePut(key, Promise.resolve(next));
      setMore({ key, data: next, batches: [...batches, added], loading: false });
    } catch (error) {
      if (session.active) setMore({ key, data, batches, loading: false, error: error instanceof Error ? error : new Error("Couldn't load more titles") });
    } finally {
      if (pending.current === request) pending.current = null;
    }
  }, [key, data, batches, query]);
  return {
    ...state,
    data,
    stale: state.loading && last?.query !== query ? last : undefined,
    batches,
    loadingMore,
    moreError,
    loadMore,
    hasMore: !!data?.nextCursor,
    retry: () => setAttempt((n) => n + 1),
  };
}
export type SearchState = ReturnType<typeof useSearch>;
