// Convex provides process.env in every runtime; declared here so the web app's typecheck agrees.
declare const process: { env: Record<string, string | undefined> };

const PRODUCTION = "industrious-axolotl-949";

export const isProduction = () => (process.env.CONVEX_CLOUD_URL ?? "").includes(PRODUCTION);

/**
 * Functions that wipe or rewrite real data run anywhere but production unless the caller says it means production.
 * `npx convex run --prod` reaches them as easily as dev does, so the second key turns a slip into an error.
 */
export function assertSafeTarget(what: string, confirmProd: boolean | undefined) {
  if (isProduction() && confirmProd !== true) {
    throw new Error(`${what} changes real data on production. Pass "confirmProd": true only with the developer's go (docs/ops.md).`);
  }
}

const DEV = "fastidious-oyster-35";

/**
 * QA sign-in (profiles.qaSignIn: a QA profile's name and password, no Clerk) works only on a backend on this machine
 * and on dev, so scripts can drive the app without a browser Clerk login. Everywhere else, production first, it
 * doesn't exist.
 */
export function qaSignInAllowed() {
  const url = process.env.CONVEX_CLOUD_URL ?? "";
  if (url.includes(PRODUCTION)) return false;
  return url.includes(DEV) || /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(url);
}
