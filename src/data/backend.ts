/**
 * Which Convex backend this tab talks to. Branch previews get their own backend with throwaway
 * profiles; to try a change on your real account, a preview can switch to production instead. That
 * runs the branch's frontend against real data, so what you do there (ratings, Plan to watch, watching)
 * is saved for real. Production and local builds always use their own backend.
 */
const PRODUCTION = "https://industrious-axolotl-949.convex.cloud";
const KEY = "krida.backend";

export const isPreviewBuild = import.meta.env.VITE_KRIDA_PREVIEW === "true";

function read() {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export const onProduction = isPreviewBuild && read() === "production";
export const CONVEX_URL: string = onProduction ? PRODUCTION : (import.meta.env.VITE_CONVEX_URL as string);
// The HLS proxy must use the same deployment as queries and mutations.
export const CONVEX_SITE_URL: string = onProduction
  ? PRODUCTION.replace(/\.cloud$/, ".site")
  : (import.meta.env.VITE_CONVEX_SITE_URL as string);

export function switchBackend(to: "preview" | "production") {
  localStorage.setItem(KEY, to);
  location.reload();
}
