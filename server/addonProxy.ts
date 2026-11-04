import { BadRequest, UpstreamError } from "./http.js";

declare const process: { env: Record<string, string | undefined> };

/*
 * The one way to an addon that doesn't send CORS headers: the browser asks /api/rows?addon=<url> and this fetches it.
 * Only what the browser reads from addons goes through (manifests, catalogs, metadata, subtitles); streams are asked
 * by Convex, never here. Only public web addresses, so it can't be pointed at Vercel's own network.
 */

const RESOURCE = /\/(manifest\.json|(catalog|meta|subtitles)\/[^/]+\/[^/]+(\/[^/]+)?\.json)$/;
const PRIVATE = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[)/;
/** Catalogs with many genres run to a few hundred KB; past this it isn't an addon answering. */
const MAX_BYTES = 4_000_000;

export function proxiedUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BadRequest("Not a link");
  }
  // `npm run dev` and the QA app run stand-in addons on this machine.
  const local = !process.env.VERCEL_ENV && url.protocol === "http:" && /^(127\.0\.0\.1|localhost)$/.test(url.hostname);
  if (!local && !isPublic(url)) throw new BadRequest("Only public https addons");
  if (url.username || url.password || !RESOURCE.test(url.pathname)) throw new BadRequest("Not an addon resource");
  return url;
}

const isPublic = (url: URL) => url.protocol === "https:" && !PRIVATE.test(url.hostname);

/** Redirects are followed by hand, each one checked like the first link, so a public addon can't send this inward. */
async function fetchAddon(url: URL, hops = 3): Promise<Response> {
  const res = await fetch(url, { headers: { accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(12_000) }).catch(() => {
    throw new UpstreamError(`${url.host} couldn't be reached`);
  });
  const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
  if (!location) return res;
  const next = new URL(location, url);
  if (hops === 0 || !isPublic(next) || next.username || next.password) throw new UpstreamError(`${url.host} redirected somewhere Krida won't follow`);
  return await fetchAddon(next, hops - 1);
}

export async function proxyAddon(raw: string): Promise<unknown> {
  const url = proxiedUrl(raw);
  const res = await fetchAddon(url);
  if (!res.ok) throw new UpstreamError(`${url.host} answered ${res.status}`);
  const length = Number(res.headers.get("content-length") ?? 0);
  if (length > MAX_BYTES) throw new UpstreamError(`${url.host} answered with too much`);
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new UpstreamError(`${url.host} answered with too much`);
  try {
    return JSON.parse(text);
  } catch {
    throw new UpstreamError(`${url.host} didn't answer with JSON`);
  }
}
