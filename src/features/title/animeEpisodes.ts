import type { Meta } from "../../data/cinemeta";

/**
 * Episode details for new anime, the way Hayase gets them. Kitsu's addon knows nothing about a show's episodes
 * until it has an IMDb id: no titles, no stills, and the premiere date on every episode it expects. So:
 * - Kitsu maps its id to AniList's, exactly (`/anime/{id}/mappings`).
 * - AniList's airing schedule says which episodes exist and when each airs.
 * - ani.zip has each episode's title, overview and still (from TVDB), and the show's TMDB id for the backdrop.
 * All three are free, need no key and answer browsers, so the page asks them; AniList allows 30 requests a
 * minute per address, and a page asks once.
 */
export type AnimeSources = {
  anilist?: { episodes: number | null; schedule: { episode: number; airingAt: number }[] } | null;
  anizip?: AniZip | null;
};

export type AniZip = {
  episodeCount?: number;
  images?: { coverType: string; url: string }[];
  mappings?: { themoviedb_id?: string | number | null };
  episodes?: Record<
    string,
    { title?: Record<string, string | null>; overview?: string | null; summary?: string | null; image?: string | null; airDateUtc?: string | null }
  >;
};

const getJson = async <T>(url: string, init?: RequestInit) => {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
  return (await res.json()) as T;
};

export async function anilistIdFor(kitsuId: string) {
  const body = await getJson<{ data?: { attributes: { externalSite: string; externalId: string } }[] }>(
    `https://kitsu.app/api/edge/anime/${encodeURIComponent(kitsuId)}/mappings?page[limit]=20`,
  );
  const id = body.data?.find((m) => m.attributes.externalSite === "anilist/anime")?.attributes.externalId;
  return id && /^\d+$/.test(id) ? Number(id) : null;
}

export async function animeSources(anilistId: number): Promise<AnimeSources> {
  const [anilist, anizip] = await Promise.all([
    getJson<{ data?: { Media?: { episodes: number | null; airingSchedule: { nodes: { episode: number; airingAt: number }[] } } } }>(
      "https://graphql.anilist.co",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          query: "query($id:Int){Media(id:$id){episodes airingSchedule(perPage:50){nodes{episode airingAt}}}}",
          variables: { id: anilistId },
        }),
      },
    )
      .then((b) => (b.data?.Media ? { episodes: b.data.Media.episodes, schedule: b.data.Media.airingSchedule.nodes } : null))
      .catch(() => null),
    getJson<AniZip>(`https://api.ani.zip/mappings?anilist_id=${anilistId}`).catch(() => null),
  ]);
  return { anilist, anizip };
}

/** ani.zip's TMDB id for the show, which TMDB's backdrop is fetched by. */
export const tmdbIdOf = (sources: AnimeSources) => {
  const id = sources.anizip?.mappings?.themoviedb_id;
  return id && /^\d+$/.test(String(id)) ? String(id) : null;
};

/**
 * Kitsu's meta with what AniList and ani.zip know. Kitsu, AniList and ani.zip (AniDB) all number a season's
 * entry from 1, so episodes match by number. Whatever none of them has stays as Kitsu has it, except Kitsu's
 * guessed dates: when every episode carries the premiere, the list ends where AniList's does.
 */
export function fillAnime(meta: Meta, sources: AnimeSources, backdrop: string | null): Meta {
  const { anilist, anizip } = sources;
  const regular = (meta.videos ?? []).filter((v) => v.season > 0);
  const guessed = regular.length > 1 && new Set(regular.map((v) => v.released)).size === 1;
  const airs = new Map(anilist?.schedule.map((s) => [s.episode, new Date(s.airingAt * 1000).toISOString()]));
  // Hayase's count: AniList's when it has one, else the furthest episode anyone has scheduled.
  const total = anilist?.episodes ?? (Math.max(0, ...airs.keys(), anizip?.episodeCount ?? 0) || null);
  const videos = (meta.videos ?? [])
    .filter((v) => v.season <= 0 || !guessed || !total || v.episode <= total)
    .map((v) => {
      if (v.season <= 0) return v;
      const e = anizip?.episodes?.[String(v.episode)];
      return {
        ...v,
        name: e?.title?.en ?? e?.title?.["x-jat"] ?? v.name,
        overview: e?.overview ?? e?.summary ?? v.overview,
        released: airs.get(v.episode) ?? e?.airDateUtc ?? (guessed ? undefined : v.released),
        thumbnail: e?.image ?? v.thumbnail,
      };
    });
  const fanart = anizip?.images?.find((i) => i.coverType === "Fanart")?.url;
  return { ...meta, background: backdrop ?? fanart ?? meta.background, videos };
}
