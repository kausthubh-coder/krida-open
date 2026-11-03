import type { DebridService, KeyKind } from "./accounts";

// Convex provides process.env in every runtime; declared here so the web app's typecheck agrees.
declare const process: { env: Record<string, string | undefined> };

/*
 * A key is checked with its provider before it's saved, by asking the cheapest "who am I" each one has. A key the
 * provider turns down is refused with words a person can act on; a provider that can't be reached is said apart, so
 * nobody is told their good key is wrong.
 */

export type KeyCheck = { ok: true } | { ok: false; message: string };

export const SERVICE_NAMES: Record<DebridService, string> = {
  torbox: "TorBox",
  realdebrid: "Real-Debrid",
  alldebrid: "AllDebrid",
  premiumize: "Premiumize",
  debridlink: "Debrid-Link",
  offcloud: "Offcloud",
  easydebrid: "EasyDebrid",
};

type Ask = { url: string; bearer?: boolean; ok: (status: number, body: any) => boolean };

const enc = encodeURIComponent;

function ask(kind: KeyKind, key: string, service?: DebridService): Ask {
  if (kind === "tmdb") return { url: `https://api.themoviedb.org/3/configuration?api_key=${enc(key)}`, ok: (s) => s === 200 };
  if (kind === "mdblist") return { url: `https://api.mdblist.com/user?apikey=${enc(key)}`, ok: (s, b) => s === 200 && !b?.error };
  switch (service) {
    case "torbox":
      return { url: `${process.env.TORBOX_API_URL ?? "https://api.torbox.app/v1/api"}/user/me`, bearer: true, ok: (s, b) => s === 200 && b?.success === true };
    case "realdebrid":
      return { url: "https://api.real-debrid.com/rest/1.0/user", bearer: true, ok: (s, b) => s === 200 && typeof b?.id === "number" };
    // AllDebrid and Premiumize answer 200 either way and say in the body.
    case "alldebrid":
      return { url: "https://api.alldebrid.com/v4/user?agent=krida", bearer: true, ok: (s, b) => s === 200 && b?.status === "success" };
    case "premiumize":
      return { url: `https://www.premiumize.me/api/account/info?apikey=${enc(key)}`, ok: (s, b) => s === 200 && b?.status === "success" };
    case "debridlink":
      return { url: "https://debrid-link.com/api/v2/account/infos", bearer: true, ok: (s, b) => s === 200 && b?.success === true };
    case "offcloud":
      return { url: `https://offcloud.com/api/account/info?key=${enc(key)}`, ok: (s) => s === 200 };
    case "easydebrid":
      return { url: "https://easydebrid.com/api/v1/user/details", bearer: true, ok: (s) => s === 200 };
    default:
      throw new Error("Pick a debrid service");
  }
}

export const providerName = (kind: KeyKind, service?: DebridService) =>
  kind === "tmdb" ? "TMDB" : kind === "mdblist" ? "MDBList" : SERVICE_NAMES[service!];

/** What a provider said about a key: it works, it turned it down, or it couldn't be asked right now. */
export type Verdict = "ok" | "refused" | "unreachable" | "busy";

export async function askProvider(kind: KeyKind, key: string, service?: DebridService): Promise<Verdict> {
  const { url, bearer, ok } = ask(kind, key, service);
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: "application/json", ...(bearer && { authorization: `Bearer ${key}` }) }, signal: AbortSignal.timeout(15_000) });
  } catch {
    return "unreachable";
  }
  const body = await res.json().catch(() => null);
  if (ok(res.status, body)) return "ok";
  if (res.status >= 500 || res.status === 429) return "busy";
  return "refused";
}

export async function checkKey(kind: KeyKind, key: string, service?: DebridService): Promise<KeyCheck> {
  const name = providerName(kind, service);
  // TMDB's long "read access token" is a different thing from the API key Krida asks with.
  if (kind === "tmdb" && key.startsWith("eyJ"))
    return { ok: false, message: "That's TMDB's read access token. Paste the shorter API key from the same page." };
  switch (await askProvider(kind, key, service)) {
    case "ok":
      return { ok: true };
    case "unreachable":
      return { ok: false, message: `Couldn't reach ${name}. Try again in a moment.` };
    case "busy":
      return { ok: false, message: `${name} isn't answering right now. Try again in a moment.` };
    case "refused":
      return { ok: false, message: `${name} didn't accept that key. Check it and paste it again.` };
  }
}
