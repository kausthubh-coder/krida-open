/*
 * The Stremio addon protocol, as Krida speaks it: manifest links, what an addon's manifest says it serves, the URL of
 * each resource, and the addons Krida suggests. Used by Convex (installing, streams), Vercel (the addon proxy) and the
 * browser (catalogs, search, subtitles), so it stays plain TypeScript with no fetch of its own.
 *
 * Routes (checked 3 Nov 2026): `/manifest.json`, `/{resource}/{type}/{id}.json` and
 * `/{resource}/{type}/{id}/{extra}.json`, the extra being `search=x&skip=100&genre=y`.
 */

export type AddonResource = { name: string; types: string[]; idPrefixes?: string[] };
export type CatalogExtra = { name: string; isRequired?: boolean; options?: string[] };
export type AddonCatalog = { type: string; id: string; name: string; extra?: CatalogExtra[] };
/** A manifest, trimmed to what Krida uses, with every resource spelled out (a bare name takes the manifest's types). */
export type AddonManifest = {
  id: string;
  name: string;
  version: string;
  description?: string;
  logo?: string;
  types: string[];
  resources: AddonResource[];
  catalogs: AddonCatalog[];
  configurable?: boolean;
  configurationRequired?: boolean;
};

/** Long enough for any real addon; a manifest past these is cut, so one addon can't fill a profile's document. */
const MAX_CATALOGS = 100;
const MAX_OPTIONS = 200;
const MAX_TEXT = 300;

const text = (x: unknown, max = MAX_TEXT) => (typeof x === "string" && x.trim() ? x.trim().slice(0, max) : undefined);
const strings = (x: unknown, max = 50) =>
  Array.isArray(x) ? [...new Set(x.filter((s): s is string => typeof s === "string" && s.length > 0 && s.length <= 100))].slice(0, max) : [];

export class AddonUrlError extends Error {}

/**
 * The addon's base URL from whatever someone pasted: a manifest link, a `stremio://` install link, or the base itself.
 * Throws AddonUrlError with a message for the person when it isn't a web address.
 */
export function addonBase(input: string): string {
  let raw = input.trim();
  if (!raw) throw new AddonUrlError("Paste the addon’s link first.");
  raw = raw.replace(/^stremio:\/\//i, "https://");
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && !/^https?:\/\//i.test(raw)) throw new AddonUrlError("Addons need a web link (https://).");
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AddonUrlError("That isn’t a link. Paste the addon’s manifest link, ending in manifest.json.");
  }
  if (url.username || url.password) throw new AddonUrlError("Links with a user name and password in them aren’t supported.");
  const path = url.pathname.replace(/\/manifest\.json$/i, "").replace(/\/+$/, "");
  return `${url.protocol}//${url.host}${path}`;
}

export const manifestUrl = (base: string) => `${base}/manifest.json`;

/** A Stremio link opens a title or a reviewable addon install, always on Krida. */
export function stremioPage(input: string): string | null {
  try {
    const url = new URL(input);
    if (url.protocol !== "stremio:" || url.username || url.password) return null;
    const detail = /^\/detail\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (!url.host && detail) return `/title/${detail[1]}/${detail[2]}`;
    if (!url.host || !/\/manifest\.json$/i.test(url.pathname)) return null;
    return `/settings/addons?addon=${encodeURIComponent(manifestUrl(addonBase(input)))}`;
  } catch {
    return null;
  }
}

/**
 * Curated community manifests checked with curl on 4 November 2026. Torrentio, Comet and MediaFusion aren't here: the
 * suggestions above this list install them already set up with the account's debrid key, and bare they'd find only
 * torrents. Peerflix is the same, so it goes to its setup page.
 */
export const COMMUNITY_ADDONS = [
  { name: "Cinemeta", url: "https://v3-cinemeta.strem.io/manifest.json", configurationRequired: false },
  { name: "OpenSubtitles v3", url: "https://opensubtitles-v3.strem.io/manifest.json", configurationRequired: false },
  { name: "Anime Kitsu", url: "https://anime-kitsu.strem.fun/manifest.json", configurationRequired: false },
  { name: "Peerflix", url: "https://peerflix.mov/manifest.json", configurationRequired: true },
  { name: "TMDB Addon", url: "https://94c8cb9f702d-tmdb-addon.baby-beamup.club/manifest.json", configurationRequired: false },
  { name: "Streaming Catalogs", url: "https://7a82163c306e-stremio-netflix-catalog-addon.baby-beamup.club/manifest.json", configurationRequired: false },
  { name: "Trakt lists", url: "https://2ecbbd610840-trakt.baby-beamup.club/manifest.json", configurationRequired: false },
];

/** Extras in the order Stremio writes them, `skip` last; values are encoded, names never need it. */
export function extraPath(extra: Record<string, string | number | undefined>) {
  return Object.entries(extra)
    .filter(([, v]) => v !== undefined && v !== "")
    .sort(([a], [b]) => (a === "skip" ? 1 : b === "skip" ? -1 : 0))
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");
}

/** One resource's URL: `{base}/{resource}/{type}/{id}[/{extra}].json`. */
export function resourceUrl(base: string, resource: string, type: string, id: string, extra: Record<string, string | number | undefined> = {}) {
  const extras = extraPath(extra);
  return `${base}/${resource}/${encodeURIComponent(type)}/${encodeURIComponent(id)}${extras ? `/${extras}` : ""}.json`;
}

function resourcesOf(raw: unknown, types: string[], idPrefixes: string[] | undefined): AddonResource[] {
  if (!Array.isArray(raw)) return [];
  const out: AddonResource[] = [];
  for (const r of raw) {
    if (typeof r === "string") out.push({ name: r, types, ...(idPrefixes ? { idPrefixes } : {}) });
    else if (r && typeof r === "object" && typeof (r as { name?: unknown }).name === "string") {
      const o = r as { name: string; types?: unknown; idPrefixes?: unknown };
      const own = strings(o.idPrefixes);
      const prefixes = Array.isArray(o.idPrefixes) ? own : idPrefixes;
      out.push({ name: o.name, types: Array.isArray(o.types) ? strings(o.types) : types, ...(prefixes ? { idPrefixes: prefixes } : {}) });
    }
  }
  return out.slice(0, 20);
}

function catalogsOf(raw: unknown): AddonCatalog[] {
  if (!Array.isArray(raw)) return [];
  const out: AddonCatalog[] = [];
  for (const c of raw) {
    const type = text(c?.type, 50);
    const id = text(c?.id, 200);
    if (!type || !id) continue;
    // Older manifests list extras as names: `extraSupported` and `extraRequired`.
    const required = strings(c.extraRequired);
    const extra: CatalogExtra[] = Array.isArray(c.extra)
      ? c.extra.flatMap((e: any) => {
          const name = text(e?.name, 50);
          if (!name) return [];
          const options = strings(e.options, MAX_OPTIONS);
          return [{ name, ...(e.isRequired === true ? { isRequired: true } : {}), ...(options.length ? { options } : {}) }];
        })
      : strings(c.extraSupported).map((name) => ({ name, ...(required.includes(name) ? { isRequired: true } : {}) }));
    out.push({ type, id, name: text(c.name) ?? id, ...(extra.length ? { extra: extra.slice(0, 10) } : {}) });
  }
  return out.slice(0, MAX_CATALOGS);
}

/** A manifest Krida can use, or what's wrong with it, in words for the person who pasted it. */
export function parseManifest(raw: unknown): { ok: true; manifest: AddonManifest } | { ok: false; message: string } {
  if (!raw || typeof raw !== "object") return { ok: false, message: "That link didn’t give an addon manifest." };
  const m = raw as Record<string, any>;
  const id = text(m.id, 200);
  const name = text(m.name, 100);
  if (!id || !name) return { ok: false, message: "That manifest has no id or name, so it isn’t a Stremio addon." };
  const types = strings(m.types);
  const idPrefixes = Array.isArray(m.idPrefixes) ? strings(m.idPrefixes) : undefined;
  const resources = resourcesOf(m.resources, types, idPrefixes);
  if (resources.length === 0) return { ok: false, message: `${name} doesn’t say what it serves (its manifest lists no resources).` };
  return {
    ok: true,
    manifest: {
      id,
      name,
      version: text(m.version, 50) ?? "0.0.0",
      ...(text(m.description, 500) ? { description: text(m.description, 500) } : {}),
      ...(text(m.logo, 500)?.startsWith("http") ? { logo: text(m.logo, 500) } : {}),
      types,
      resources,
      catalogs: catalogsOf(m.catalogs),
      ...(m.behaviorHints?.configurable === true ? { configurable: true } : {}),
      ...(m.behaviorHints?.configurationRequired === true ? { configurationRequired: true } : {}),
    },
  };
}

/** Whether an addon answers `resource` for this type and id (its types, and its id prefixes when it lists any). */
export function serves(manifest: Pick<AddonManifest, "resources">, resource: string, type: string, id: string) {
  return manifest.resources.some(
    (r) => r.name === resource && r.types.includes(type) && (!r.idPrefixes || r.idPrefixes.some((p) => id.startsWith(p))),
  );
}

export const hasResource = (manifest: Pick<AddonManifest, "resources">, resource: string) => manifest.resources.some((r) => r.name === resource);

/** Extras a catalog can't do without, other than paging. A catalog that needs one is search-only or filter-only. */
const needs = (c: AddonCatalog) => (c.extra ?? []).filter((e) => e.isRequired && e.name !== "skip").map((e) => e.name);
/** The kinds of title Krida opens and plays; an addon's channels, TV and "other" lists aren't shown. */
const KINDS = ["movie", "series", "anime"];
/** Catalogs that can be a row on Home: of a kind Krida plays, needing nothing but paging. */
export const isRow = (c: AddonCatalog) => KINDS.includes(c.type) && needs(c).length === 0;
/** Catalogs that answer a search, as their own section of Search. */
export const isSearchable = (c: AddonCatalog) =>
  KINDS.includes(c.type) && (c.extra ?? []).some((e) => e.name === "search") && needs(c).every((n) => n === "search");
/** A catalog's genre choices, when it can be filtered by genre. */
export const genresOf = (c: AddonCatalog) => (c.extra ?? []).find((e) => e.name === "genre")?.options ?? [];

/** A Home row's key for an addon's catalog. The addon's manifest id keeps it stable across reinstalls and profiles. */
export const catalogRowKey = (addonId: string, c: Pick<AddonCatalog, "type" | "id">) => `addon:${addonId}:${c.type}:${c.id}`;

/** A short, stable digest (cyrb53), for keys built from links that may carry someone's key. */
export function digest(value: string) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

// ---------- Suggestions ----------

export type DebridService = "torbox" | "realdebrid" | "alldebrid" | "premiumize" | "debridlink" | "offcloud" | "easydebrid";
export type SuggestionId = "torrentio" | "comet" | "mediafusion";

/**
 * Addons Krida offers to install, set up with the account's debrid key. Each format was checked against the live
 * service on 4 Nov 2026 (Torrentio answers `{service}={key}` for all seven; Comet takes its settings as base64 JSON;
 * MediaFusion seals them on its own server). TorBox's own addon (stremio.torbox.app) no longer resolves, so it isn't
 * offered.
 */
export const SUGGESTIONS: { id: SuggestionId; name: string; description: string }[] = [
  { id: "torrentio", name: "Torrentio", description: "Torrents from the big public trackers, checked against your debrid service." },
  { id: "comet", name: "Comet", description: "A fast debrid search, with files already in your debrid account first." },
  { id: "mediafusion", name: "MediaFusion", description: "Torrents from many more sites and trackers, with your debrid service’s cached files." },
];

/**
 * AIOStreams puts many addons behind one link, but it keeps each setup on its own server behind a password, and its
 * public instance won't run Torrentio, so it's set up on its page and its link pasted here like any other.
 */
export const AIOSTREAMS_SETUP = "https://aiostreams.elfhosted.com/stremio/configure";
const MEDIAFUSION = "https://mediafusion.elfhosted.com";

/**
 * Comet's settings go in the path as base64 JSON, which Comet reads with Python's plain `b64decode`. A `/` in it would
 * split the path; in base64 of ASCII text only a `?` (0x3F) can make one, so `?` and anything past ASCII are written
 * as JSON escapes instead.
 */
function cometConfig(service: DebridService, key: string) {
  const json = JSON.stringify({
    debridServices: [{ service, apiKey: key }], enableTorrent: false, resultFormat: ["all"],
    maxResultsPerResolution: 0, maxSize: 0, cachedOnly: false, removeTrash: true,
  });
  return btoa(json.replace(/[?\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`));
}

/**
 * A suggestion's base URL, with the debrid key in it (so it's built on the server, from the account's key). MediaFusion
 * checks the key with the debrid service and seals the settings into its link itself; what it says when it refuses
 * comes back as an AddonUrlError, in its words.
 */
export async function suggestionBase(id: SuggestionId, debrid: { service: DebridService; key: string }): Promise<string> {
  if (id === "torrentio") return `https://torrentio.strem.fun/${debrid.service}=${encodeURIComponent(debrid.key)}`;
  if (id === "comet") return `https://comet.elfhosted.com/${cometConfig(debrid.service, debrid.key)}`;
  const res = await fetch(`${MEDIAFUSION}/encrypt-user-data`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ streaming_provider: { service: debrid.service, token: debrid.key } }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!res) throw new AddonUrlError("Couldn’t reach MediaFusion. Try again.");
  const body = (await res.json().catch(() => null)) as { status?: string; encrypted_str?: string; message?: string } | null;
  if (res.ok && body?.status === "success" && body.encrypted_str && /^[\w.=-]+$/.test(body.encrypted_str)) return `${MEDIAFUSION}/${body.encrypted_str}`;
  throw new AddonUrlError(body?.message ? `MediaFusion: ${body.message}` : `MediaFusion answered ${res.status}. Try again.`);
}

// ---------- Streams ----------

/** One stream as Krida's ranking reads it (convex/lib/parse.ts reads AIOStreams' marks: ⚡ cached, 👥 seeders, 📦 size). */
export type AddonStream = {
  url: string;
  name: string;
  description: string;
  filename?: string;
  size?: number;
  bingeGroup?: string;
};

const SIZE = /📦\s*([\d.]+)\s*(TB|GB|MB)/iu;
const UNITS = { TB: 1e12, GB: 1e9, MB: 1e6 } as const;

/**
 * An addon's stream in Krida's terms. Torrentio and Comet mark a file your debrid service already has as "[TB+]" or
 * "[TB⚡]", seeders as 👤 and sizes as 💾; they become ⚡, 👥 and 📦. A stream that's only a torrent becomes a magnet
 * link, which TorBox can add when it has the file cached. Streams for another app (YouTube, an external page) are
 * dropped: they can't play here.
 */
export function toStream(s: any): AddonStream | null {
  if (!s || typeof s !== "object") return null;
  const hash = typeof s.infoHash === "string" && /^[a-f0-9]{40}$/i.test(s.infoHash) ? s.infoHash.toLowerCase() : undefined;
  const url = typeof s.url === "string" && /^https?:\/\//.test(s.url) ? s.url : hash ? `magnet:?xt=urn:btih:${hash}` : undefined;
  if (!url) return null;
  const rawName = String(s.name ?? "").slice(0, 300);
  const description = String(s.description ?? s.title ?? "").slice(0, 1500).replace(/👤/gu, "👥").replace(/💾/gu, "📦");
  const marker = /\[[A-Za-z]{2,3}(\+|⚡)\]/u;
  const name = marker.test(rawName) ? `⚡ ${rawName.replace(marker, "").trim()}` : rawName;
  const hints = s.behaviorHints ?? {};
  const marked = SIZE.exec(description);
  const size =
    typeof hints.videoSize === "number" ? hints.videoSize
    : marked ? Math.round(Number(marked[1]) * UNITS[marked[2].toUpperCase() as keyof typeof UNITS])
    : undefined;
  return {
    url,
    name,
    description,
    ...(typeof hints.filename === "string" ? { filename: hints.filename } : {}),
    ...(size ? { size } : {}),
    ...(typeof hints.bingeGroup === "string" ? { bingeGroup: hints.bingeGroup } : {}),
  };
}

/** Streams from several addons as one list, in the profile's addon order, each link once. */
export function mergeStreams(lists: AddonStream[][], max = 300): AddonStream[] {
  const seen = new Set<string>();
  const out: AddonStream[] = [];
  for (const list of lists)
    for (const s of list) {
      if (seen.has(s.url)) continue;
      seen.add(s.url);
      out.push(s);
    }
  return out.slice(0, max);
}

// ---------- Stremio account import ----------

export const STREMIO_API = "https://api.strem.io/api";

/**
 * The addon links in a Stremio account's collection (`addonCollectionGet`'s `result.addons[].transportUrl`), without
 * the ones that only run on the Stremio app's own machine. Cinemeta comes too: it gives Stremio's Home its rows.
 */
export function importableUrls(body: unknown): string[] {
  const addons = (body as { result?: { addons?: unknown } } | null)?.result?.addons;
  if (!Array.isArray(addons)) return [];
  const urls: string[] = [];
  for (const a of addons) {
    const url = typeof a?.transportUrl === "string" ? a.transportUrl : undefined;
    if (!url) continue;
    let base: string;
    try {
      base = addonBase(url);
    } catch {
      continue;
    }
    const host = new URL(base).hostname;
    if (host === "127.0.0.1" || host === "localhost") continue;
    if (!urls.includes(base)) urls.push(base);
  }
  return urls;
}
