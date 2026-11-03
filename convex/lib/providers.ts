import { parseDuration } from "./parse";
import { namesEpisode, type RankContext } from "./rank";
import type { AccountKeys } from "./accounts";
import type { SourceOrigin, StreamAddon } from "./addons";
import { mergeStreams, resourceUrl, serves, toStream, type AddonStream } from "../../shared/stremio";
import { containerOf } from "../../shared/formats";

// Convex provides process.env in every runtime; declared here so the web app's typecheck agrees.
declare const process: { env: Record<string, string | undefined> };

// The real services unless a local backend points elsewhere: `npm run regress` runs a stand-in for both, so playback
// can be walked without the owner's keys. Production and dev never set these.
const torboxApi = () => process.env.TORBOX_API_URL ?? "https://api.torbox.app/v1/api";
const introDbApi = () => process.env.INTRODB_API_URL ?? "https://api.introdb.app";

export function env(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} on the Convex deployment`);
  return value;
}

/**
 * The account's TorBox key. TorBox streams play anywhere (its HLS turns any file into something a browser plays), and
 * parties and previews run on them; another service's files are played from the addon's link instead (`resolveDirect`).
 */
export function torboxKeyOf(keys: AccountKeys): string {
  if (keys.debrid?.service === "torbox") return keys.debrid.key;
  if (keys.debrid) throw new SourceError("This needs TorBox. Your debrid service plays in Krida for Windows or Mac, or an external player.", "torbox");
  throw new SourceError("Add your TorBox key in Settings → Connections to play here.", "torbox");
}

/** Whether the account's streams go through TorBox, or play straight from the addon's link (another service). */
export const viaTorBox = (keys: AccountKeys) => keys.debrid?.service === "torbox";

/** Said before anything is fetched when the account has no debrid service at all. */
export function requireDebrid(keys: AccountKeys) {
  if (!keys.debrid) throw new SourceError("Add a debrid service in Settings → Connections to play here.", "torbox");
}

/** Why a copy of a title didn't start, so a failed Play can say what happened to each copy it tried. */
export type FailKind = "slow" | "notCached" | "notReady" | "torrent" | "wrongFile" | "brokenLink" | "unreachable" | "torbox";

export class SourceError extends Error {
  readonly kind?: FailKind;
  constructor(message: string, kind?: FailKind) {
    super(message);
    this.kind = kind;
  }
}

/**
 * The addons gave no list: busy, down, or every one of them failed. Worth asking once more, and then using the list
 * they gave earlier.
 */
export class NoList extends SourceError {}

/** A link its host says is gone (404 or 410). Play skips it until the title's list is fetched again. */
export class UnavailableSource extends SourceError {}

// ---------- Stream addons ----------

/** Past the top results of each addon nobody scrolls. */
const MAX_PER_ADDON = 150;
/** The slowest list measured took 9.6 s (October 2026); two tries and the wait between stay inside FETCH_TTL_MS. */
const LIST_TIMEOUT_MS = 20_000;

export type RawSource = AddonStream & {
  /** The addon's `behaviorHints.bingeGroup`: the same on every episode for one kind of file, so the next episode can
   * play the same kind (see `chosenCandidates` in engine.ts). */
  bingeGroup?: string;
  unavailable?: boolean;
};

/** One addon's streams for a title; a NoList when it failed in a way that trying again might fix. */
async function askAddon(addon: StreamAddon, type: string, videoId: string): Promise<RawSource[]> {
  let res: Response;
  try {
    res = await fetch(resourceUrl(addon.url, "stream", type, videoId), { signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
  } catch (error) {
    console.error(`${addon.name} stream`, error instanceof Error ? error.message : error);
    throw new NoList(`${addon.name} isn’t answering right now. Try again in a few minutes.`);
  }
  if (res.status === 429) throw new NoList(`${addon.name} is busy right now. Try again in a minute.`);
  if (res.status >= 500) throw new NoList(`${addon.name} isn’t answering right now. Try again in a few minutes.`);
  if (!res.ok) throw new NoList(`${addon.name} answered ${res.status}. Try again in a moment.`);
  const streams = ((await res.json().catch(() => ({}))) as { streams?: unknown[] }).streams ?? [];
  return streams.slice(0, MAX_PER_ADDON).map(toStream).filter((s): s is AddonStream => s !== null);
}

/**
 * A title's sources from the profile's stream addons, asked at once, merged in the profile's addon order. Addons that
 * don't list this type or id prefix aren't asked. One that fails costs only its own sources; when all fail, NoList
 * says which.
 */
export async function fetchSources(type: string, videoId: string, origin: SourceOrigin): Promise<RawSource[]> {
  const asked = origin.addons.filter((a) => serves(a.manifest, "stream", type, videoId));
  if (origin.addons.length === 0) throw new SourceError("Install a stream addon in Settings → Addons to find sources.");
  if (asked.length === 0) throw new SourceError("None of your addons finds sources for this kind of title.");
  const answers = await Promise.allSettled(asked.map((a) => askAddon(a, type, videoId)));
  const lists = answers.flatMap((a) => (a.status === "fulfilled" ? [a.value] : []));
  if (lists.length === 0) {
    const failed = answers.map((a) => (a as PromiseRejectedResult).reason);
    if (failed.length === 1) throw failed[0];
    const names = asked.map((a) => a.name);
    throw new NoList(`Your addons didn’t answer (${names.slice(0, 3).join(", ")}). Try again in a minute.`);
  }
  return mergeStreams(lists);
}

// ---------- TorBox ----------

async function torbox(key: string, path: string, signal?: AbortSignal, form?: FormData) {
  const res = await fetch(`${torboxApi()}${path}`, { method: form ? "POST" : "GET", headers: { authorization: `Bearer ${key}` }, body: form, signal });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.success) {
    const detail = body?.detail || body?.error || `HTTP ${res.status}`;
    throw new SourceError(`TorBox: ${detail}`, "torbox");
  }
  return body.data;
}

/** A source that didn't reach TorBox within its time: the next copy is tried. `host` is the step it was waiting on. */
export class SlowSource extends SourceError {
  readonly host: string;
  readonly ms: number;
  constructor(host: string, ms: number) {
    super(`${host} didn't reach TorBox in ${Math.round(ms / 1000)} s`, "slow");
    this.host = host;
    this.ms = ms;
  }
}

/**
 * Follow the addon's playback redirects just far enough to learn which TorBox torrent and file it
 * points at. We never download the video here. `episode` picks the file out of a season pack when the addon
 * doesn't name it. Past `limitMs` it gives up with SlowSource: a service adding a file to TorBox can hold its
 * redirect for a minute (StremThru held one for 62 s while another copy of the episode answered in 2 s). It carries
 * on without us, so that copy is quick next time. `onTimed` hears how long each service took, for the failure log.
 */
export async function resolveToTorbox(
  key: string,
  source: RawSource,
  episode: RankContext,
  { limitMs, onTimed }: { limitMs?: number; onTimed?: (host: string, ms: number) => void } = {},
) {
  const started = Date.now();
  const abort = new AbortController();
  const timer = limitMs === undefined ? undefined : setTimeout(() => abort.abort(), limitMs);
  const timed = async <T>(host: string, run: () => Promise<T>) => {
    const t0 = Date.now();
    try {
      return await run();
    } catch (error) {
      if (abort.signal.aborted) throw new SlowSource(host, Date.now() - started);
      throw error;
    } finally {
      onTimed?.(host, Date.now() - t0);
    }
  };
  try {
    return await findTorrent(key, source, episode, abort.signal, timed);
  } finally {
    clearTimeout(timer);
  }
}

async function findTorrent(
  key: string,
  source: RawSource,
  episode: RankContext,
  signal: AbortSignal,
  timed: <T>(host: string, run: () => Promise<T>) => Promise<T>,
) {
  let url = source.url;
  let hash: string | undefined;
  let torrentId: number | undefined;
  // A torrent-only stream (an addon with no debrid set up): TorBox can still play it if it has the file cached.
  const magnet = url.startsWith("magnet:");
  if (magnet) hash = /btih:([a-f0-9]{40})/i.exec(url)?.[1]?.toLowerCase();
  for (let hop = 0; hop < 8 && !magnet; hop++) {
    const parsed = new URL(url);
    const torrent = parsed.searchParams.get("torrent_id");
    const fileId = parsed.searchParams.get("file_id");
    if (parsed.host === "api.torbox.app" && torrent) {
      if (fileId !== null) return { torrentId: Number(torrent), fileId: Number(fileId), hash };
      // A torrent without its file: file 0 of a season pack is episode 1, so find the file below.
      torrentId = Number(torrent);
      break;
    }
    hash ??= /\b[a-f0-9]{40}\b/i.exec(decodeURIComponent(url))?.[0]?.toLowerCase();
    if (/tb-cdn\.io$/.test(parsed.host)) break;
    const res = await timed(parsed.host, async () => {
      const res = await fetch(url, { redirect: "manual", headers: { range: "bytes=0-0" }, signal }).catch((error) => {
        if (signal.aborted) throw error;
        throw new SourceError(`${parsed.host} couldn't be reached`, "unreachable");
      });
      await res.body?.cancel();
      return res;
    });
    const location = res.headers.get("location");
    if (!location) {
      if (res.status === 404 || res.status === 410) throw new UnavailableSource(`${parsed.hostname} answered ${res.status}`, "brokenLink");
      if (res.status >= 400) throw new SourceError(`The source answered ${res.status}`, "brokenLink");
      break;
    }
    url = new URL(location, url).toString();
  }

  // No direct ids in the redirect chain: find the torrent the addon just added to TorBox.
  const list = (await timed("api.torbox.app", () => torbox(key, "/torrents/mylist?bypass_cache=true", signal))) as any[];
  const torrent =
    (torrentId !== undefined && list.find((t) => t.id === torrentId)) ||
    (hash && list.find((t) => t.hash?.toLowerCase() === hash)) ||
    list.find((t) => t.files?.some((f: any) => source.filename && f.short_name === source.filename)) ||
    // Another debrid service's link, or a bare torrent: the same file, when TorBox has it cached.
    (hash && (await timed("api.torbox.app", () => addCached(key, hash, signal))));
  if (!torrent) throw new SourceError("This source didn't reach TorBox. It may not be cached.", "notCached");
  const files: any[] = torrent.files ?? [];
  const file =
    files.find((f) => source.size && f.size === source.size) ??
    files.find((f) => source.filename && f.short_name === source.filename) ??
    videoFile(files, episode);
  if (!file) throw new SourceError("Couldn't find the video file inside this torrent", "wrongFile");
  return { torrentId: torrent.id as number, fileId: file.id as number, hash: torrent.hash as string };
}

/** Adds a torrent TorBox already has cached to the account and returns it with its files; null when it isn't cached. */
async function addCached(key: string, hash: string, signal: AbortSignal) {
  const cached = await torbox(key, `/torrents/checkcached?hash=${hash}&format=list`, signal);
  if (!Array.isArray(cached) || cached.length === 0) return null;
  const form = new FormData();
  form.set("magnet", `magnet:?xt=urn:btih:${hash}`);
  const added = await torbox(key, "/torrents/createtorrent", signal, form);
  const id = Number(added?.torrent_id);
  if (!Number.isFinite(id)) return null;
  return await torbox(key, `/torrents/mylist?id=${id}&bypass_cache=true`, signal);
}

/**
 * The file to play when the addon didn't say which: a movie's biggest video, or the one an episode's name points
 * to. A pack without that episode fails, so the next source is tried rather than another episode playing.
 */
function videoFile(files: any[], episode: RankContext) {
  const videos = files.filter((f) => /video/.test(f.mimetype ?? ""));
  if (episode.type === "movie" || episode.episode === undefined || videos.length === 1)
    return videos.sort((a, b) => b.size - a.size)[0];
  const named = videos.filter((f) => namesEpisode(String(f.short_name ?? ""), episode));
  if (named.length === 0) throw new SourceError("This source doesn't have this episode", "wrongFile");
  return named.sort((a, b) => b.size - a.size)[0];
}

export async function createStream(key: string, torrentId: number, fileId: number) {
  const data = await torbox(
    key,
    `/stream/createstream?id=${torrentId}&file_id=${fileId}&type=torrent&scrobbling_enabled=false`,
  );
  const meta = data.metadata ?? {};
  const video = meta.video ?? {};
  const intro = data.intro_information;
  // TorBox guesses intros several ways; only the one read from the file's own chapter marks is reliable.
  const chapterIntro =
    intro && typeof intro.end_time === "number" && intro.end_time > 0 && /chapter/i.test(String(intro.title ?? ""))
      ? { start: Number(intro.start_time) || 0, end: Number(intro.end_time), source: "chapters" }
      : undefined;
  return {
    chapterIntro,
    presignedToken: String(data.presigned_token),
    domain: String(data.domain),
    hash: data.hash ? String(data.hash) : undefined,
    duration: parseDuration(video.duration),
    width: typeof video.width === "number" ? video.width : undefined,
    height: typeof video.height === "number" ? video.height : undefined,
    videoCodec: video.codec ? String(video.codec) : undefined,
    size: typeof data.size === "number" ? data.size : undefined,
    osHash: data.open_subtitles_hash ? String(data.open_subtitles_hash) : undefined,
    audios: ((meta.audios ?? []) as any[]).map((a) => ({
      language: a.language ? String(a.language) : undefined,
      title: a.title ? String(a.title) : undefined,
      codec: a.codec ? String(a.codec) : undefined,
      channels: typeof a.channels === "number" ? a.channels : undefined,
    })),
    // The file's own subtitle tracks, in file order: track n is mpv's `sid` n. TorBox's browser stream can't carry
    // them (checked October 2026: its segments hold only H.264 and AAC), so only Krida for Windows shows them.
    subtitles: ((meta.subtitles ?? []) as any[]).map((s) => ({
      language: s.language ? String(s.language) : undefined,
      title: s.title ? String(s.title) : undefined,
      codec: s.codec ? String(s.codec) : undefined,
    })),
  };
}

type Segment = { start: number; end: number; source: string };

function segment(raw: any, maxLength: number): Segment | undefined {
  const start = Number(raw?.start_sec);
  const end = Number(raw?.end_sec);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > maxLength) return undefined;
  return { start, end, source: "introdb" };
}

/**
 * Crowd-verified intro, recap and outro (credits) times from introdb.app, for an episode or a movie.
 * Missing parts are simply undefined.
 */
export async function fetchSegments(imdbId: string, season?: number, episode?: number) {
  const params =
    season !== undefined && episode !== undefined
      ? `imdb_id=${encodeURIComponent(imdbId)}&season=${season}&episode=${episode}`
      : `imdb_id=${encodeURIComponent(imdbId)}&is_movie=true`;
  try {
    const res = await fetch(`${introDbApi()}/segments?${params}`);
    if (!res.ok) return {};
    const body = await res.json();
    return {
      intro: segment(body.intro, 600),
      recap: segment(body.recap, 600),
      outro: segment(body.outro, 1800),
    };
  } catch {
    return {};
  }
}

/** A file's download link, which reads the whole original file with Range. It carries the account key. */
export async function fileLink(key: string, torrentId: number, fileId: number) {
  return String(
    await torbox(key, `/torrents/requestdl?token=${key}&torrent_id=${torrentId}&file_id=${fileId}&zip_link=false&redirect=false`),
  );
}

// ---------- Direct links (any other debrid service) ----------

/**
 * The videos addons redirect to instead of a file when the debrid service can't give one yet: Torrentio's and Comet's
 * "downloading", "failed …" and "limits exceeded" clips. Played, they'd show a message as if it were the film.
 */
const PLACEHOLDER = /\/(videos|static)\/(downloading|failed|limits|blocked|uncached|not_?cached)[^/]*\.mp4$/i;

/**
 * Follows the addon's link (the addon asks its debrid service for the file, then redirects to it) to the file itself,
 * reading one byte, so a link that doesn't play is found here rather than in the player. Returns the file's link,
 * which holds no API key, and its container. A torrent (a magnet) has no link to follow without TorBox.
 */
export async function resolveDirect(
  source: Pick<RawSource, "url" | "filename">,
  { limitMs, onTimed }: { limitMs?: number; onTimed?: (host: string, ms: number) => void } = {},
): Promise<{ url: string; container?: string }> {
  if (!/^https?:\/\//.test(source.url)) throw new SourceError("This copy is a torrent, and only TorBox plays torrents.", "torrent");
  const started = Date.now();
  const signal = limitMs === undefined ? undefined : AbortSignal.timeout(limitMs);
  let url = source.url;
  for (let hop = 0; hop < 8; hop++) {
    const host = new URL(url).host;
    const t0 = Date.now();
    const res = await fetch(url, { redirect: "manual", headers: { range: "bytes=0-0" }, signal }).catch(() => {
      if (signal?.aborted) throw new SlowSource(host, Date.now() - started);
      throw new SourceError(`${host} couldn't be reached`, "unreachable");
    }).finally(() => onTimed?.(host, Date.now() - t0));
    await res.body?.cancel();
    const location = res.headers.get("location");
    if (location && res.status >= 300 && res.status < 400) {
      url = new URL(location, url).toString();
      if (PLACEHOLDER.test(new URL(url).pathname)) throw new SourceError("The debrid service doesn't have this file ready.", "notReady");
      continue;
    }
    if (res.status === 404 || res.status === 410) throw new UnavailableSource(`${host} answered ${res.status}`, "brokenLink");
    if (res.status >= 400) throw new SourceError(`The source answered ${res.status}`, "brokenLink");
    return { url, container: containerOf(res.headers.get("content-type"), url, source.filename) };
  }
  throw new SourceError("The source sent Krida round in circles", "brokenLink");
}

export function playlistUrl(domain: string, presignedToken: string, audio: number) {
  return `${domain}/stream/${presignedToken}/null/null/${audio}/`;
}
