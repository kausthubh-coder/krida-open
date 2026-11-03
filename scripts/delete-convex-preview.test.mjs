import { strict as assert } from "node:assert";
import { test } from "node:test";
import { previewsFor } from "./delete-convex-preview.mjs";

const deployments = [
  { name: "fastidious-oyster-35", deploymentType: "dev", previewIdentifier: null },
  { name: "industrious-axolotl-949", deploymentType: "prod", previewIdentifier: null },
  { name: "nautical-bison-106", deploymentType: "preview", previewIdentifier: "t3/liquid-glass" },
  { name: "grateful-narwhal-193", deploymentType: "preview", previewIdentifier: "t3/home-trailers" },
];

test("only the closed branch's preview is picked", () => {
  assert.deepEqual(previewsFor(deployments, "t3/liquid-glass").map((d) => d.name), ["nautical-bison-106"]);
  assert.deepEqual(previewsFor(deployments, "t3/other"), []);
});

test("production and dev are never picked, whatever they're labelled", () => {
  const labelled = deployments.map((d) => ({ ...d, previewIdentifier: "main" }));
  assert.deepEqual(previewsFor(labelled, "main").map((d) => d.name), ["nautical-bison-106", "grateful-narwhal-193"]);
});
