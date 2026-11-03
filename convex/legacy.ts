// Convex provides process.env in every runtime; declared here so the web app's typecheck agrees.
declare const process: { env: Record<string, string | undefined> };

/*
 * For tabs still on the build from before /api: their calls to the old actions (titles.*, trailers.imdb,
 * recs.moreLikeThis) get the same answers from the Vercel functions that replaced them. Remove once those tabs have
 * reloaded, with the old queries listed in docs/database-reads.md.
 */
const SITE = "https://krida-open.vercel.app";

export async function fromApi<T>(path: string, params: Record<string, string | undefined>, token?: string): Promise<T> {
  const url = new URL(`/api/${path}`, SITE);
  for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);
  const headers: Record<string, string> = token ? { "x-krida-backend": process.env.CONVEX_CLOUD_URL ?? "", "x-krida-session": token } : {};
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${path} answered ${res.status}`);
  return (await res.json()) as T;
}
