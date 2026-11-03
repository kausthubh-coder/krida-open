import { strict as assert } from "node:assert";
import { test } from "node:test";
import { deploymentArgs } from "./vercel-build.mjs";

test("production and previews select the deployment through their scoped key", () => {
  for (const [VERCEL_ENV, CONVEX_DEPLOY_KEY] of [
    ["production", "prod:industrious-axolotl-949|test"],
    ["preview", "preview:kausthubh-nandimandalam:krida-open|test"],
  ]) {
    assert.ok(deploymentArgs({ VERCEL_ENV, CONVEX_DEPLOY_KEY }).includes("VITE_CONVEX_URL"));
  }
});

test("a preview cannot use production credentials or another project's key", () => {
  for (const CONVEX_DEPLOY_KEY of ["", "prod:industrious-axolotl-949|test", "preview:other:project|test"]) {
    assert.throws(() => deploymentArgs({ VERCEL_ENV: "preview", CONVEX_DEPLOY_KEY }));
  }
  assert.throws(() => deploymentArgs({ VERCEL_ENV: "production", CONVEX_DEPLOY_KEY: "preview:kausthubh-nandimandalam:krida-open|test" }));
  assert.throws(() => deploymentArgs({ VERCEL_ENV: "development", CONVEX_DEPLOY_KEY: "prod:industrious-axolotl-949|test" }));
});
