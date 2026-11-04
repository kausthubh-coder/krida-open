/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import { sha256 } from "../convex/lib/auth";

const modules = import.meta.glob(["../convex/**/*.ts", "../convex/**/*.js", "!../convex/**/*.d.ts"]);
afterEach(() => vi.unstubAllGlobals());

test("reconfiguring a manifest id replaces only this profile's addon, keeping its id, order and off switch", async () => {
  const t = convexTest(schema, modules);
  const manifest = (name: string) => ({ id: "same.addon", name, version: "1.0.0", types: ["movie"], resources: ["stream"], catalogs: [] });
  const profileId = await t.run(async (ctx) => {
    const accountId = await ctx.db.insert("accounts", { name: "A", createdAt: Date.now() });
    const profile = async (token: string) => {
      const profileId = await ctx.db.insert("profiles", { accountId, name: token, hue: 1, order: 0, failedAttempts: 0, prefs: { audioLang: "eng", sounds: false } });
      await ctx.db.insert("sessions", { profileId, tokenHash: await sha256(token), createdAt: Date.now() });
      return profileId;
    };
    const first = await profile("one");
    await profile("two");
    return first;
  });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(manifest(url.includes("new") ? "New setup" : "Original"))));
  await t.action(api.addons.install, { token: "one", url: "https://old.example/manifest.json" });
  await t.action(api.addons.install, { token: "two", url: "https://old.example/manifest.json" });
  const [before] = await t.query(api.addons.list, { token: "one" });
  await t.mutation(api.addons.setEnabled, { token: "one", addonId: before._id, enabled: false });
  await t.run(async (ctx) => {
    await ctx.db.patch(before._id, { order: 4 });
    await ctx.db.insert("addons", { profileId, url: "https://other.example", manifest: { ...before.manifest, id: "other", name: "Other" }, enabled: true, order: 5, installedAt: 0 });
  });
  expect(await t.action(api.addons.install, { token: "one", url: "https://new.example/manifest.json" })).toEqual({ ok: true, name: "New setup", updated: true });
  const after = await t.query(api.addons.list, { token: "one" });
  expect(after.map((a) => [a._id, a.url, a.manifest.name, a.enabled])).toEqual([
    [before._id, "https://new.example", "New setup", false],
    [after[1]._id, "https://other.example", "Other", true],
  ]);
  expect(await t.run(async (ctx) => (await ctx.db.get(before._id))?.order)).toBe(4);
  expect((await t.query(api.addons.list, { token: "two" })).map((a) => [a.url, a.manifest.name])).toEqual([["https://old.example", "Original"]]);
});
