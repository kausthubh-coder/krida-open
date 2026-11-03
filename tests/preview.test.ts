/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import { internal } from "../convex/_generated/api";
import schema from "../convex/schema";

const modules = import.meta.glob(["../convex/**/*.ts", "../convex/**/*.js", "!../convex/**/*.d.ts"]);
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

test("preview setup creates usable separate profiles and preserves them on another run", async () => {
  vi.stubEnv("KRIDA_PREVIEW", "true");
  vi.stubEnv("KRIDA_PREVIEW_PASSWORD", "preview-test-password");
  const t = convexTest(schema, modules);
  const profiles = () => t.run((ctx) => ctx.db.query("profiles").collect());
  await t.mutation(internal.preview.seed, {});
  const first = await profiles();
  expect(first.map((p) => p.name)).toEqual(["Preview one", "Preview two"]);
  await t.mutation(internal.preview.seed, {});
  expect(await profiles()).toEqual(first);
});

test("preview setup cannot seed production or a deployment without a password", async () => {
  const t = convexTest(schema, modules);
  vi.stubEnv("KRIDA_PREVIEW", "false");
  await expect(t.mutation(internal.preview.seed, {})).rejects.toThrow("Preview setup is disabled");
  vi.stubEnv("KRIDA_PREVIEW", "true");
  vi.stubEnv("KRIDA_PREVIEW_PASSWORD", "");
  await expect(t.mutation(internal.preview.seed, {})).rejects.toThrow("Set KRIDA_PREVIEW_PASSWORD");
  expect(await t.run((ctx) => ctx.db.query("profiles").collect())).toEqual([]);
});

test("nightly stats schedule one job per profile, except on previews", async () => {
  const t = convexTest(schema, modules);
  await t.mutation(internal.profiles.add, { name: "Stats-QA", hue: 145, password: "pw" });
  const scheduled = () => t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).map((job) => job.name));
  vi.stubEnv("KRIDA_PREVIEW", "true");
  await t.action(internal.wrapped.computeAll, {});
  expect(await scheduled()).toEqual([]);
  vi.stubEnv("KRIDA_PREVIEW", "false");
  await t.action(internal.wrapped.computeAll, {});
  expect(await scheduled()).toEqual(["wrapped:compute"]);
});
