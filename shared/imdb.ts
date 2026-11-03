import { isImdbId } from "./ids.js";
/**
 * IMDb's own trailer files. They are plain MP4s, so they play in a <video> with nothing drawn over them, where
 * YouTube's embed shows its title and a pause button for the first 3 s. IMDb's site reads them from this
 * GraphQL API, which isn't documented: everything here fails soft, and Home falls back to YouTube.
 */
const ENDPOINT = "https://caching.graphql.imdb.com/";
const TRAILER = "amzn1.imdb.video.contenttype.trailer";
const HEIGHTS: Record<string, number> = { DEF_SD: 360, DEF_480p: 480, DEF_720p: 720, DEF_1080p: 1080 };
// Links are signed for about a day; without an Expires to read, assume half that.
const FALLBACK_TTL = 12 * 60 * 60 * 1000;


/** A title's trailer: its MP4 files, smallest first, and when their links stop working (ms). No files: it has none. */
export type ImdbTrailer = { id: string; files: { height: number; url: string }[]; expires: number };

type Node = { contentType?: { id?: string }; playbackURLs?: { url?: string; videoDefinition?: string; mimeType?: string }[] };

/** Trailers for these IMDb ids, in one request. Titles IMDb didn't answer for are left out. */
export async function imdbTrailers(ids: string[]): Promise<ImdbTrailer[]> {
  const valid = ids.filter(isImdbId);
  if (!valid.length) return [];
  const fields = "primaryVideos(first: 5) { edges { node { contentType { id } playbackURLs { url videoDefinition mimeType } } } }";
  const query = `{ ${valid.map((id, i) => `t${i}: title(id: "${id}") { ${fields} }`).join(" ")} }`;
  const res = await fetch(ENDPOINT, {
    method: "POST",
    // Without a client name IMDb answers 403.
    headers: { "content-type": "application/json", "x-imdb-client-name": "imdb-web-next" },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error(`IMDb answered ${res.status}`);
  const body = (await res.json()) as { data?: Record<string, { primaryVideos?: { edges?: { node?: Node }[] } } | null> };
  const now = Date.now();
  return valid.flatMap((id, i) => {
    const title = body.data?.[`t${i}`];
    if (title === undefined) return [];
    const node = title?.primaryVideos?.edges?.map((e) => e.node).find((n) => n?.contentType?.id === TRAILER);
    const files = (node?.playbackURLs ?? [])
      .flatMap((p) => (p.mimeType === "video/mp4" && p.url?.startsWith("https://") && p.videoDefinition && HEIGHTS[p.videoDefinition] ? [{ height: HEIGHTS[p.videoDefinition], url: p.url }] : []))
      .sort((a, b) => a.height - b.height);
    const signed = files.map((f) => Number(new URL(f.url).searchParams.get("Expires")) * 1000).filter((x) => x > now);
    return [{ id, files, expires: signed.length ? Math.min(...signed) : now + FALLBACK_TTL }];
  });
}
