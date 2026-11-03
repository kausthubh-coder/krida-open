/*
 * TorBox from Vercel and the frames Worker (workers/frames), for reading a film's own file (server/mkv.ts) with the
 * TorBox key of the account that asked. TorBox's file links carry that key, so they stay here: the browser gets
 * keyframes, never a link.
 */
import { SlowDown, UpstreamError } from "./http.js";
import type { Read } from "./mkv.js";

declare const process: { env: Record<string, string | undefined> };

const api = () => process.env.TORBOX_API_URL ?? "https://api.torbox.app/v1/api";

/** A network failure reaching TorBox (fetch rejects, or a body breaks off) is TorBox's: an UpstreamError. */
async function reach<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof TypeError) throw new UpstreamError(`Couldn't reach TorBox: ${error.message}`);
    throw error;
  }
}

async function torbox(key: string, path: string) {
  const headers = { authorization: `Bearer ${key}` };
  const res = await reach(() => fetch(`${api()}${path}`, { headers }));
  if (res.status === 429) {
    await res.body?.cancel();
    throw new SlowDown(Number(res.headers.get("retry-after")) || 10);
  }
  const body = (await res.json().catch(() => null)) as { success?: boolean; data?: unknown } | null;
  if (!res.ok || !body?.success) throw new UpstreamError(`TorBox answered ${res.status}`);
  return body.data;
}

// What this instance has looked up lately, per account (keyed by its key): which torrent holds a file of a given size,
// and its link. Torrent ids belong to one account's TorBox, so nothing here is shared between accounts.
const files = new Map<string, Map<number, { torrentId: number; fileId: number }>>();
const links = new Map<string, { url: string; until: number }>();
const filesOf = (key: string) => {
  let known = files.get(key);
  if (!known) {
    if (files.size > 100) files.clear();
    files.set(key, (known = new Map()));
  }
  return known;
};
const LINK_MS = 60 * 60_000;

/**
 * The file in the account's torrents that is exactly `size` bytes. A film's size picks out its file: two different
 * multi-GB files of the same size don't happen. Null when no torrent has it.
 */
async function findFile(key: string, size: number) {
  const mine = filesOf(key);
  const known = mine.get(size);
  if (known) return known;
  for (const bypass of [false, true]) {
    const list = (await torbox(key, `/torrents/mylist?bypass_cache=${bypass}`)) as { id: number; files?: { id: number; size: number }[] }[];
    for (const t of list ?? []) for (const f of t.files ?? []) mine.set(f.size, { torrentId: t.id, fileId: f.id });
    if (mine.has(size)) return mine.get(size)!;
  }
  return null;
}

/** The file's download link, asked for again once it's an hour old. Null when the account doesn't have the file. */
async function link(key: string, size: number) {
  const known = links.get(`${key} ${size}`);
  if (known && known.until > Date.now()) return known.url;
  const file = await findFile(key, size);
  if (!file) return null;
  const url = String(await torbox(key, `/torrents/requestdl?token=${key}&torrent_id=${file.torrentId}&file_id=${file.fileId}&zip_link=false&redirect=false`));
  if (links.size > 1000) links.clear();
  links.set(`${key} ${size}`, { url, until: Date.now() + LINK_MS });
  return url;
}

/**
 * A read that hangs this long is given up on, so it can't hold up the pictures behind it. Reads take 0.2 to 2 s; a
 * stretch of a file TorBox hasn't served lately can take far longer, and a later try usually works.
 */
const READ_MS = 10_000;

/**
 * Reads `from` to `to` (exclusive) of the file that is `size` bytes in the TorBox of `key`, or null when that account
 * doesn't have it.
 */
export async function fileReader(key: string, size: number): Promise<Read | null> {
  if (!(await link(key, size))) return null;
  return async (from, to) => {
    const end = Math.min(to, size) - 1;
    if (end < from) return new Uint8Array(0);
    // TorBox sometimes refuses a read once (a 400 on a link it just gave out); a fresh link a moment later works.
    for (let attempt = 1; ; attempt++) {
      const url = await link(key, size);
      if (!url) throw new UpstreamError("The file left the account");
      const signal = AbortSignal.timeout(READ_MS);
      const res = await reach(() => fetch(url, { headers: { range: `bytes=${from}-${end}` }, signal }));
      if (res.status === 206) return new Uint8Array(await reach(() => res.arrayBuffer()));
      // Too many reads: the link is fine, so it's neither refreshed nor tried again. The browser waits and slows down.
      if (res.status === 429) {
        await res.body?.cancel();
        throw new SlowDown(Number(res.headers.get("retry-after")) || 10);
      }
      // Anything but the range asked for (a 200 would be the whole film) is stopped and refused.
      await res.body?.cancel();
      links.delete(`${key} ${size}`);
      if (attempt === 2) throw new UpstreamError(`The file answered ${res.status}`);
    }
  };
}
