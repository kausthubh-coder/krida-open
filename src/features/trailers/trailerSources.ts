import { useEffect, useMemo, useState } from "react";
import { trailers } from "../../data/api";
import { getMeta, useAsync, type MediaType } from "../../data/cinemeta";
import { trailerIds } from "./trailers";
import type { TrailerSource } from "./trailerPlayer";

type TrailerFile = { height: number; url: string };

// Asked again this soon when IMDb didn't answer (it failed), rather than never for the visit.
const RETRY_MS = 10 * 60_000;
// The most one request asks about (/api/trailers takes 30).
const PER_REQUEST = 30;
const NONE: TrailerFile[] = [];

const known = new Map<string, { files: TrailerFile[]; expires: number }>();
const asking = new Map<string, Promise<TrailerFile[]>>();
let batch: Map<string, (files: TrailerFile[]) => void> | null = null;

/**
 * A title's IMDb trailer files (none when it has no trailer or IMDb can't be reached), kept until their links
 * expire. Titles asked for in the same moment (a row coming into reach) go in one request. Asking ahead of time
 * means a trailer is known before its poster is rested on.
 */
export function askImdb(id: string): Promise<TrailerFile[]> {
  const hit = known.get(id);
  if (hit && hit.expires > Date.now()) return Promise.resolve(hit.files);
  let ask = asking.get(id);
  if (!ask) {
    ask = new Promise((resolve) => {
      if (!batch) {
        const waiting = (batch = new Map());
        setTimeout(() => {
          batch = null;
          void send(waiting);
        });
      }
      batch.set(id, resolve);
    });
    asking.set(id, ask);
  }
  return ask;
}

async function send(waiting: Map<string, (files: TrailerFile[]) => void>) {
  const ids = [...waiting.keys()];
  const parts = [];
  for (let i = 0; i < ids.length; i += PER_REQUEST) parts.push(ids.slice(i, i + PER_REQUEST));
  const found = (await Promise.all(parts.map((part) => trailers(part).catch(() => [])))).flat();
  for (const t of found) known.set(t.id, { files: t.files, expires: t.expires });
  const answered = new Set(found.map((t) => t.id));
  for (const [id, resolve] of waiting) {
    if (!answered.has(id)) known.set(id, { files: NONE, expires: Date.now() + RETRY_MS });
    asking.delete(id);
    resolve(known.get(id)!.files);
  }
}

/** IMDb's trailer files for a title: none when it has none (`imdbId` null), undefined until known. */
function useImdbFiles(imdbId: string | null | undefined) {
  const [answer, setAnswer] = useState<{ id: string; files: TrailerFile[] }>();
  useEffect(() => {
    if (!imdbId) return;
    let alive = true;
    void askImdb(imdbId).then((files) => alive && setAnswer({ id: imdbId, files }));
    return () => {
      alive = false;
    };
  }, [imdbId]);
  return imdbId === null ? NONE : answer && answer.id === imdbId ? answer.files : undefined;
}

/**
 * What a title's muted trailer plays, best first: IMDb's file at about `height`, then YouTube (the id its row
 * carries, else Cinemeta's). Its details are fetched only when needed: anime for its IMDb id (and backdrop), and
 * a title IMDb has no trailer for, for YouTube's. Nothing is asked until `enabled`. Sources are undefined
 * until IMDb has answered; the details come back too, for anime's backdrop.
 */
export function useTitleTrailer(item: { id: string; type: MediaType; trailer?: string } | undefined, height: number, enabled: boolean) {
  const on = enabled && !!item;
  const imdb = !!item?.id.startsWith("tt");
  const direct = useImdbFiles(on && imdb ? item.id : undefined);
  const needMeta = on && (!imdb || (!item.trailer && direct?.length === 0));
  const meta = useAsync(needMeta ? `meta:${item.type}:${item.id}` : null, () => getMeta(item!.type, item!.id));
  const linked = useImdbFiles(on && !imdb ? (meta.data ? (meta.data.imdb_id ?? null) : meta.error ? null : undefined) : undefined);
  const files = imdb ? direct : linked;
  const youtube = (item?.trailer ? [item.trailer] : meta.data ? trailerIds(meta.data) : []).join();
  const sources = useMemo((): TrailerSource[] | undefined => {
    if (!files) return undefined;
    // The smallest file at least this tall, or the largest there is.
    const file = files.find((f) => f.height >= height) ?? files.at(-1);
    return [...(file ? [{ kind: "file" as const, url: file.url }] : []), ...youtube.split(",").filter(Boolean).map((id) => ({ kind: "youtube" as const, id }))];
  }, [files, height, youtube]);
  return { sources, meta };
}
