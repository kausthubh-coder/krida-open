import { spawnSync } from "node:child_process";
import { globSync, rmSync, writeFileSync } from "node:fs";

const url = new URL(process.env.VITE_CONVEX_URL ?? "");
if (url.protocol !== "https:" || !url.hostname.endsWith(".convex.cloud")) {
  throw new Error("Convex must supply the backend URL before building the frontend");
}
// The HLS proxy must use the same deployment as queries and mutations.
const env = {
  ...process.env,
  VITE_CONVEX_SITE_URL: url.origin.replace(/\.cloud$/, ".site"),
  // Previews offer a switch to production on the profile screen (src/data/backend.ts).
  VITE_KRIDA_PREVIEW: process.env.VERCEL_ENV === "preview" ? "true" : "",
  // The page compares it with /version.json to offer a reload once a newer build is live (src/ui/appStatus.ts).
  VITE_KRIDA_COMMIT: process.env.VERCEL_GIT_COMMIT_SHA ?? "",
  // Production and previews send errors, replays and timings to PostHog (src/data/telemetry.ts).
  VITE_KRIDA_TELEMETRY: process.env.VERCEL_ENV ?? "",
};
for (const [file, args] of [
  ["node_modules/typescript/bin/tsc", ["-b"]],
  ["node_modules/vite/bin/vite.js", ["build"]],
]) {
  const result = spawnSync(process.execPath, [file, ...args], { stdio: "inherit", env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
// PostHog reads stacks through the build's source maps: they're uploaded (POSTHOG_CLI_API_KEY, in Vercel's env), then
// deleted, so the site never serves them. A failed upload leaves stacks minified but doesn't stop the deploy.
if (env.POSTHOG_CLI_API_KEY) {
  const release = ["--release-name", "krida", "--release-version", env.VITE_KRIDA_COMMIT || "local"];
  for (const step of ["inject", "upload"]) {
    const result = spawnSync("node_modules/.bin/posthog-cli", ["sourcemap", step, "--directory", "dist/assets", ...release], { stdio: "inherit", env });
    if (result.status !== 0) {
      console.warn(`posthog-cli sourcemap ${step} failed; this build's stacks stay minified in PostHog`);
      break;
    }
  }
}
for (const map of globSync("dist/**/*.map")) rmSync(map);
writeFileSync(".convex-build-url.local", url.origin);
// Which commit the site serves, for ship-krida's deploy watch where GitHub's commit statuses can't be read (cloud).
writeFileSync("dist/version.json", `${JSON.stringify({ commit: process.env.VERCEL_GIT_COMMIT_SHA ?? "" })}\n`);
