import { useEffect, useState } from "react";
import { CINEMETA, KITSU } from "../../shared/addons";
import { logProblem } from "./log";
import { track } from "./telemetry";

/** Anime from the AniList rows uses Kitsu ids; this public addon has their details and episodes. */

export type MediaType = "movie" | "series";

export type MetaPreview = {
  id: string;
  type: MediaType;
  name: string;
  poster?: string;
  background?: string;
  logo?: string;
  releaseInfo?: string;
  description?: string;
  imdbRating?: string;
};

export type Video = {
  id: string;
  season: number;
  episode: number;
  name?: string;
  title?: string;
  released?: string;
  thumbnail?: string;
  overview?: string;
  description?: string;
  /** Anime episodes map back to IMDb, which IntroDB and subtitles understand. */
  imdb_id?: string;
  imdbSeason?: number;
  imdbEpisode?: number;
};

export type Meta = MetaPreview & {
  genres?: string[];
  genre?: string[];
  runtime?: string;
  year?: string;
  cast?: string[];
  director?: string[];
  videos?: Video[];
  /** YouTube ids, newest first. */
  trailers?: { source: string; type: string }[];
  trailerStreams?: { title: string; ytId: string }[];
  country?: string;
  /** Kitsu titles map back to IMDb, which MDBList knows (and has MyAnimeList's score for). */
  imdb_id?: string;
};

const cache = new Map<string, Promise<unknown>>();

function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  let hit = cache.get(key) as Promise<T> | undefined;
  if (!hit) {
    hit = load();
    cache.set(key, hit);
    hit.catch(() => cache.delete(key));
  }
  return hit;
}

// Cinemeta now and then fails a request it answers a second later, more often for a title it hasn't stored yet (it
// builds those on the spot). Before trying again, wait this long; after the last, the error shows.
const RETRY_AFTER_MS = [700, 2000];
// A request that hangs this long is given up on, so the page doesn't wait on a skeleton forever.
const TIMEOUT_MS = 15_000;

async function getJson<T>(url: string): Promise<T> {
  const started = Date.now();
  const failures: string[] = [];
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) }).catch((error: unknown) =>
      error instanceof Error ? error : new Error(String(error)),
    );
    if (res instanceof Response && res.ok) {
      const body = (await res.json()) as T;
      track("meta_call", { host: new URL(url).host, ms: Date.now() - started, tries: attempt + 1 });
      if (failures.length) logProblem("meta", `Loaded on try ${attempt + 1}: ${url}`, { failures, ms: Date.now() - started });
      return body;
    }
    const failure = res instanceof Response ? new Error(`Cinemeta answered ${res.status}`) : res;
    // A 404 or 400 says the same thing every time.
    if (res instanceof Response && res.status < 500 && res.status !== 429) {
      logProblem("meta", `Answered ${res.status}: ${url}`, { ms: Date.now() - started });
      throw failure;
    }
    failures.push(failure.message);
    const wait = RETRY_AFTER_MS[attempt];
    if (wait === undefined) {
      logProblem("meta", `Failed ${failures.length} times: ${url}`, { failures, ms: Date.now() - started });
      throw failure;
    }
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

export function searchType(type: MediaType, query: string) {
  const q = query.trim().toLowerCase();
  return cached(`search:${type}:${q}`, async () => {
    const body = await getJson<{ metas?: MetaPreview[] }>(
      `${CINEMETA}/catalog/${type}/top/search=${encodeURIComponent(q)}.json`,
    );
    return (body.metas ?? []).map((m) => ({ ...m, type }));
  });
}

/** Movies and shows interleaved, so the best match of each kind comes first. */
export async function searchAll(query: string) {
  const [movies, series] = await Promise.all([searchType("movie", query), searchType("series", query)]);
  const out: MetaPreview[] = [];
  for (let i = 0; i < Math.max(movies.length, series.length); i++) {
    if (movies[i]) out.push(movies[i]);
    if (series[i]) out.push(series[i]);
  }
  return out;
}

export function getMeta(type: MediaType, id: string) {
  return cached(`meta:${type}:${id}`, async () => {
    const base = id.startsWith("kitsu:") ? KITSU : CINEMETA;
    const body = await getJson<{ meta?: Meta }>(`${base}/meta/${type}/${encodeURIComponent(id)}.json`);
    if (!body.meta) {
      logProblem("meta", `No details for ${type} ${id}`);
      throw new Error("Not found");
    }
    const meta = { ...body.meta, type };
    meta.videos = (meta.videos ?? [])
      .filter((v) => typeof v.season === "number" && typeof v.episode === "number")
      .sort((a, b) => a.season - b.season || a.episode - b.episode);
    return meta;
  });
}

/** Metahub artwork by IMDb id. Other ids (anime) bring their own artwork, so these are undefined. */
const metahub = (kind: string, id: string) =>
  id.startsWith("tt") ? `https://images.metahub.space/${kind}/${id}/img` : undefined;
export const art = {
  poster: (id: string) => metahub("poster/medium", id),
  background: (id: string) => metahub("background/medium", id),
  backgroundLarge: (id: string) => metahub("background/large", id),
  logo: (id: string) => metahub("logo/medium", id),
};

export function episodeTitle(v: Video) {
  return v.name || v.title || `Episode ${v.episode}`;
}

/** The episode after `videoId`, skipping specials (season 0). */
export function nextEpisode(meta: Meta, videoId: string) {
  const list = (meta.videos ?? []).filter((v) => v.season > 0);
  const i = list.findIndex((v) => v.id === videoId);
  if (i === -1) return undefined;
  const next = list[i + 1];
  if (!next) return undefined;
  if (next.released && new Date(next.released).getTime() > Date.now()) return undefined;
  return next;
}

/**
 * The episode after `videoId` (specials aside), out yet or not, and whether it's still to come at `now`: Continue
 * watching's next episode once one is finished.
 */
export function followingEpisode(meta: Meta, videoId: string, now = Date.now()): { video: Video; upcoming: boolean } | undefined {
  const list = (meta.videos ?? []).filter((v) => v.season > 0);
  const i = list.findIndex((v) => v.id === videoId);
  const next = i === -1 ? undefined : list[i + 1];
  if (!next) return undefined;
  return { video: next, upcoming: !!next.released && new Date(next.released).getTime() > now };
}

type AsyncState<T> = { data?: T; error?: Error; loading: boolean };

/** Small fetch hook backed by the shared cache, so going back is instant. */
export function useAsync<T>(key: string | null, load: () => Promise<T>): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T> & { key: string | null }>({ key, loading: !!key });
  useEffect(() => {
    if (!key) {
      setState({ key, loading: false });
      return;
    }
    let alive = true;
    setState((s) => (s.key === key ? s : { key, loading: true }));
    load().then(
      (data) => alive && setState({ key, data, loading: false }),
      (error: Error) => alive && setState({ key, error, loading: false }),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state.key === key ? state : { loading: !!key };
}
