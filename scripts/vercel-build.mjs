import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function deploymentArgs(env) {
  const key = env.CONVEX_DEPLOY_KEY ?? "";
  if (env.VERCEL_ENV === "production") {
    if (!key.startsWith("prod:industrious-axolotl-949|")) throw new Error("Production needs Krida's production deploy key");
  } else if (env.VERCEL_ENV === "preview") {
    if (!key.startsWith("preview:kausthubh-nandimandalam:krida-open|")) throw new Error("Previews need Krida's preview deploy key");
  } else {
    throw new Error("This command only runs in Vercel production or preview builds");
  }
  return ["deploy", "--typecheck", "enable", "--cmd-url-env-var-name", "VITE_CONVEX_URL",
    "--cmd", "node scripts/build-frontend.mjs", "--preview-run", "preview:seed"];
}

function run(file, args) {
  const result = spawnSync(process.execPath, [file, ...args], { stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = deploymentArgs(process.env);
  // Fail checks before changing either backend.
  run("scripts/vercel-build.test.mjs", []);
  run("node_modules/vitest/vitest.mjs", ["run"]);
  run("node_modules/typescript/bin/tsc", ["-p", "tsconfig.test.json", "--noEmit"]);
  run("node_modules/convex/bin/main.js", args);
  if (process.env.VERCEL_ENV === "preview") {
    // --preview-run only seeds a newly claimed backend. Also repair a retried first build.
    const url = new URL(readFileSync(".convex-build-url.local", "utf8"));
    if (!url.hostname.endsWith(".convex.cloud") || ["industrious-axolotl-949", "fastidious-oyster-35"].includes(url.hostname.split(".")[0])) {
      throw new Error("Refusing to seed a shared backend");
    }
    run("node_modules/convex/bin/main.js", ["run", "preview:seed", "--deployment", url.hostname.split(".")[0]]);
  }
}
