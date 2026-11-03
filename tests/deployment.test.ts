/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";

const modules = import.meta.glob(["../convex/**/*.ts", "../convex/**/*.js", "!../convex/**/*.d.ts"]);
afterEach(() => { vi.unstubAllEnvs(); });

const PROD = "https://industrious-axolotl-949.convex.cloud";
const DEV = "https://fastidious-oyster-35.convex.cloud";

async function withProfile() {
  const t = convexTest(schema, modules);
  const profileId = await t.mutation(internal.profiles.add, { name: "Guard-QA", hue: 145, password: "old-password" });
  const names = async () => (await t.run((ctx) => ctx.db.query("profiles").collect())).map((p) => p.name);
  return { t, profileId, names };
}

/** QA sign-in only answers on dev and local backends, so these sign in as dev. */
const qaSignIn = async (t: ReturnType<typeof convexTest>, password: string) => {
  const was = process.env.CONVEX_CLOUD_URL;
  vi.stubEnv("CONVEX_CLOUD_URL", DEV);
  try {
    return await t.mutation(api.profiles.qaSignIn, { name: "Guard-QA", password });
  } finally {
    vi.stubEnv("CONVEX_CLOUD_URL", was);
  }
};

test("profiles:remove refuses production without confirmProd and keeps the profile", async () => {
  vi.stubEnv("CONVEX_CLOUD_URL", PROD);
  const { t, names } = await withProfile();
  await expect(t.mutation(internal.profiles.remove, { name: "Guard-QA" })).rejects.toThrow("profiles:remove changes real data on production");
  expect(await names()).toEqual(["Guard-QA"]);
  await t.mutation(internal.profiles.remove, { name: "Guard-QA", confirmProd: true });
  expect(await names()).toEqual([]);
});

test("profiles:remove runs on dev without confirmProd", async () => {
  vi.stubEnv("CONVEX_CLOUD_URL", DEV);
  const { t, names } = await withProfile();
  await t.mutation(internal.profiles.remove, { name: "Guard-QA" });
  expect(await names()).toEqual([]);
});

test("profiles:resetPassword refuses production without confirmProd and keeps the old password", async () => {
  vi.stubEnv("CONVEX_CLOUD_URL", PROD);
  const { t } = await withProfile();
  await expect(t.mutation(internal.profiles.resetPassword, { name: "Guard-QA", password: "new-password" })).rejects.toThrow("profiles:resetPassword changes real data on production");
  const session = await qaSignIn(t, "old-password");
  expect(session.ok && session.token).toMatch(/^[0-9a-f]{32,}$/);
});

test("profiles:resetPassword on dev replaces the password", async () => {
  vi.stubEnv("CONVEX_CLOUD_URL", DEV);
  const { t } = await withProfile();
  await t.mutation(internal.profiles.resetPassword, { name: "Guard-QA", password: "new-password" });
  expect(await qaSignIn(t, "old-password")).toEqual({ ok: false, message: "Wrong password. Check it and try again." });
  const session = await qaSignIn(t, "new-password");
  expect(session.ok && session.token).toMatch(/^[0-9a-f]{32,}$/);
});

test("QA sign-in answers only on dev and local backends, and only for QA profiles", async () => {
  const { t } = await withProfile();
  const off = { code: "FORBIDDEN", message: "QA sign-in is off on this deployment" };
  for (const url of [PROD, "https://happy-otter-123.convex.cloud", ""]) {
    vi.stubEnv("CONVEX_CLOUD_URL", url);
    await expect(t.mutation(api.profiles.qaSignIn, { name: "Guard-QA", password: "old-password" })).rejects.toThrow(expect.objectContaining({ data: off }));
  }
  vi.stubEnv("CONVEX_CLOUD_URL", "http://127.0.0.1:3210");
  const local = await t.mutation(api.profiles.qaSignIn, { name: "Guard-QA", password: "old-password" });
  expect(local.ok && local.token).toMatch(/^[0-9a-f]{64}$/);
  await t.run(async (ctx) => {
    const salt = "s";
    await ctx.db.insert("profiles", { name: "Maya", hue: 1, order: 1, failedAttempts: 0, prefs: { audioLang: "eng", sounds: true }, salt, passwordHash: "x" });
  });
  await expect(t.mutation(api.profiles.qaSignIn, { name: "Maya", password: "x" })).rejects.toThrow(
    expect.objectContaining({ data: { code: "FORBIDDEN", message: "Only QA profiles sign in this way" } }),
  );
});

test("admin:resetActivity refuses production without confirmProd and clears sessions on dev", async () => {
  vi.stubEnv("CONVEX_CLOUD_URL", PROD);
  const { t } = await withProfile();
  await qaSignIn(t, "old-password");
  await expect(t.mutation(internal.admin.resetActivity, {})).rejects.toThrow("admin:resetActivity changes real data on production");
  expect(await t.run((ctx) => ctx.db.query("sessions").collect())).toHaveLength(1);
  vi.stubEnv("CONVEX_CLOUD_URL", DEV);
  const counts = await t.mutation(internal.admin.resetActivity, {});
  expect(counts.sessions).toBe(1);
  expect(await t.run((ctx) => ctx.db.query("sessions").collect())).toEqual([]);
});
