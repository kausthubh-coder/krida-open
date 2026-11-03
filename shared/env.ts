// Convex and Vercel both provide process.env; declared here so the web app's typecheck agrees.
declare const process: { env: Record<string, string | undefined> };

/** A server secret (API keys live in Convex's and Vercel's settings, never in the browser). */
export function env(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} on the server`);
  return value;
}
