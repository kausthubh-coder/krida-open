/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { sha256 } from "../convex/lib/auth";
import schema from "../convex/schema";

const modules = import.meta.glob(["../convex/**/*.ts", "../convex/**/*.js", "!../convex/**/*.d.ts"]);

/** Manifests the stubbed internet serves, by base URL. */
const manifests: Record<string, unknown> = {};
const asked: string[] = [];
const manifest = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, name, version: "1.0.0", types: ["movie", "series"], resources: ["stream"], idPrefixes: ["tt"], catalogs: [], ...extra,
});

beforeEach(() => {
  asked.length = 0;
  for (const k of Object.keys(manifests)) delete manifests[k];
  manifests["https://torrentio.strem.fun/torbox=A-key"] = manifest("com.stremio.torrentio.addon", "Torrentio TB");
  manifests["https://addon.example"] = manifest("example.catalogs", "Example catalogs", {
    resources: ["catalog"], catalogs: [{ type: "movie", id: "top", name: "Top" }],
  });
  manifests["https://setup.example"] = manifest("setup.first", "Needs setup", { behaviorHints: { configurable: true, configurationRequired: true } });
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
    const url = String(input);
    asked.push(url);
    const base = url.replace(/\/manifest\.json$/, "");
    if (base in manifests) return Response.json(manifests[base]);
    if (url.startsWith("https://down.example")) throw new TypeError("fetch failed");
    return new Response("Not found", { status: 404 });
  }));
});
afterEach(() => vi.unstubAllGlobals());

/** Two accounts: A with two profiles and a TorBox key, B with one profile and no keys; and a temporary guest. */
async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const make = async (name: string, accountId: Id<"accounts"> | undefined, token: string, expiresAt?: number) => {
      const profileId = await ctx.db.insert("profiles", {
        name, hue: 1, passwordHash: "x", salt: "x", order: 0, failedAttempts: 0, prefs: { audioLang: "eng", sounds: false }, accountId, expiresAt,
      });
      await ctx.db.insert("sessions", { profileId, tokenHash: await sha256(token), createdAt: Date.now() });
      return profileId;
    };
    const a = await ctx.db.insert("accounts", { name: "A", createdAt: Date.now() });
    const b = await ctx.db.insert("accounts", { name: "B", createdAt: Date.now() });
    await ctx.db.insert("accountKeys", { accountId: a, debrid: { service: "torbox", key: "A-key" }, updatedAt: Date.now() });
    return {
      a1: await make("A one", a, "a1"),
      a2: await make("A two", a, "a2"),
      b1: await make("B one", b, "b1"),
      guest: await make("Guest", undefined, "guest", Date.now() + 60_000),
    };
  });
  const names = async (token: string) => (await t.query(api.addons.list, { token })).map((x) => [x.manifest.name, x.enabled]);
  return { t, ...ids, names };
}

describe("installing an addon", () => {
  test("by a pasted link fetches its manifest and adds it at the end", async () => {
    const { t, names } = await setup();
    expect(await t.action(api.addons.install, { token: "a1", url: "stremio://addon.example/manifest.json" })).toEqual({ ok: true, name: "Example catalogs" });
    expect(await t.action(api.addons.installSuggested, { token: "a1", suggestion: "torrentio" })).toEqual({ ok: true, name: "Torrentio TB" });
    expect(asked).toEqual(["https://addon.example/manifest.json", "https://torrentio.strem.fun/torbox=A-key/manifest.json"]);
    expect(await names("a1")).toEqual([["Example catalogs", true], ["Torrentio TB", true]]);
    const [first] = await t.query(api.addons.list, { token: "a1" });
    expect(first.manifest.catalogs).toEqual([{ type: "movie", id: "top", name: "Top" }]);
  });

  test("the same addon twice is refused", async () => {
    const { t } = await setup();
    await t.action(api.addons.install, { token: "a1", url: "https://addon.example/manifest.json" });
    expect(await t.action(api.addons.install, { token: "a1", url: "addon.example" })).toEqual({ ok: false, message: "Example catalogs is already installed." });
  });

  test("a link that fails says why, and nothing is saved", async () => {
    const { t, names } = await setup();
    expect(await t.action(api.addons.install, { token: "a1", url: "https://missing.example/manifest.json" })).toEqual({
      ok: false, message: "missing.example answered 404. Check the link and try again.",
    });
    expect(await t.action(api.addons.install, { token: "a1", url: "https://down.example/manifest.json" })).toEqual({
      ok: false, message: "Couldn’t reach down.example. Check the link and try again.",
    });
    expect(await t.action(api.addons.install, { token: "a1", url: "http://addon.example/manifest.json" })).toEqual({
      ok: false, message: "Addons need a secure link (https://).",
    });
    expect(await t.action(api.addons.install, { token: "a1", url: "https://192.168.1.4/manifest.json" })).toEqual({
      ok: false, message: "That addon runs on a private network, which Krida can’t reach.",
    });
    expect(await t.action(api.addons.install, { token: "a1", url: "https://setup.example/manifest.json" })).toEqual({
      ok: false, message: "Needs setup needs setting up first. Set it up on its page, then paste the link it gives you.", configure: "https://setup.example/configure",
    });
    expect(await names("a1")).toEqual([]);
  });

  test("suggestions need the account's debrid key, and say which are installed", async () => {
    const { t } = await setup();
    expect(await t.query(api.addons.suggestions, { token: "b1" })).toEqual({ service: null, items: [] });
    expect(await t.action(api.addons.installSuggested, { token: "b1", suggestion: "comet" })).toEqual({
      ok: false, message: "Add your debrid key in Settings → Connections first.",
    });
    await t.action(api.addons.installSuggested, { token: "a1", suggestion: "torrentio" });
    expect((await t.query(api.addons.suggestions, { token: "a1" })).items.map((s) => [s.id, s.installed])).toEqual([["torrentio", true], ["comet", false]]);
    // The key never goes to the browser by way of suggestions.
    expect(JSON.stringify(await t.query(api.addons.suggestions, { token: "a1" }))).not.toContain("A-key");
  });

  test("a temporary guest, with no account, gets no suggestions", async () => {
    const { t } = await setup();
    expect(await t.action(api.addons.installSuggested, { token: "guest", suggestion: "torrentio" })).toEqual({
      ok: false, message: "Add your debrid key in Settings → Connections first.",
    });
  });

  test("a Stremio account's links are each fetched and checked", async () => {
    const { t, names } = await setup();
    await t.action(api.addons.install, { token: "a1", url: "https://addon.example" });
    expect(await t.action(api.addons.importUrls, {
      token: "a1",
      urls: ["https://torrentio.strem.fun/torbox=A-key/manifest.json", "https://addon.example/manifest.json", "https://missing.example/manifest.json", "ftp://x"],
    })).toEqual({
      added: ["Torrentio TB"],
      already: 1,
      failed: [
        { host: "ftp://x", message: "Not an addon link Krida can reach." },
        { host: "missing.example", message: "missing.example answered 404. Check the link and try again." },
      ],
    });
    expect(await names("a1")).toEqual([["Example catalogs", true], ["Torrentio TB", true]]);
  });
});

describe("a profile's addons", () => {
  test("are its own: another profile, even in the same account, has its own list", async () => {
    const { t, names } = await setup();
    await t.action(api.addons.install, { token: "a1", url: "https://addon.example" });
    expect(await names("a2")).toEqual([]);
    expect(await names("b1")).toEqual([]);
  });

  test("turn off, reorder and go", async () => {
    const { t, names } = await setup();
    await t.action(api.addons.install, { token: "a1", url: "https://addon.example" });
    await t.action(api.addons.installSuggested, { token: "a1", suggestion: "torrentio" });
    const [example, torrentio] = await t.query(api.addons.list, { token: "a1" });
    await t.mutation(api.addons.setEnabled, { token: "a1", addonId: example._id, enabled: false });
    await t.mutation(api.addons.reorder, { token: "a1", ids: [torrentio._id, example._id] });
    expect(await names("a1")).toEqual([["Torrentio TB", true], ["Example catalogs", false]]);
    await t.mutation(api.addons.remove, { token: "a1", addonId: torrentio._id });
    expect(await names("a1")).toEqual([["Example catalogs", false]]);
  });

  test("another account's profile can't read, change, reorder or reload them", async () => {
    const { t, names } = await setup();
    await t.action(api.addons.install, { token: "a1", url: "https://addon.example" });
    const [addon] = await t.query(api.addons.list, { token: "a1" });
    const notFound = { code: "NOT_FOUND", message: "That addon isn’t installed anymore." };
    await expect(t.mutation(api.addons.setEnabled, { token: "b1", addonId: addon._id, enabled: false })).rejects.toMatchObject({ data: notFound });
    await expect(t.mutation(api.addons.remove, { token: "b1", addonId: addon._id })).rejects.toMatchObject({ data: notFound });
    await expect(t.action(api.addons.reload, { token: "b1", addonId: addon._id })).rejects.toMatchObject({ data: notFound });
    await expect(t.mutation(api.addons.reorder, { token: "b1", ids: [addon._id] })).rejects.toMatchObject({
      data: { code: "BAD_ORDER", message: "Your addons changed meanwhile. Try again." },
    });
    // Not even a housemate changes them.
    await expect(t.mutation(api.addons.remove, { token: "a2", addonId: addon._id })).rejects.toMatchObject({ data: notFound });
    expect(await names("a1")).toEqual([["Example catalogs", true]]);
  });

  test("need a session", async () => {
    const { t } = await setup();
    await expect(t.query(api.addons.list, { token: "nobody" })).rejects.toMatchObject({ data: { code: "UNAUTHENTICATED", message: "Sign in to continue" } });
    await expect(t.action(api.addons.install, { token: "nobody", url: "https://addon.example" })).rejects.toMatchObject({
      data: { code: "UNAUTHENTICATED", message: "Sign in to continue" },
    });
  });

  test("reloading picks up a changed manifest", async () => {
    const { t } = await setup();
    await t.action(api.addons.install, { token: "a1", url: "https://addon.example" });
    manifests["https://addon.example"] = manifest("example.catalogs", "Example catalogs", {
      resources: ["catalog"], catalogs: [{ type: "movie", id: "top", name: "Top" }, { type: "series", id: "new", name: "New shows" }],
    });
    const [addon] = await t.query(api.addons.list, { token: "a1" });
    expect(await t.action(api.addons.reload, { token: "a1", addonId: addon._id })).toEqual({ ok: true, name: "Example catalogs" });
    expect((await t.query(api.addons.list, { token: "a1" }))[0].manifest.catalogs.map((c) => c.name)).toEqual(["Top", "New shows"]);
  });

  test("copy from another profile in the same account, after its own and without repeats", async () => {
    const { t, a1, names } = await setup();
    await t.action(api.addons.install, { token: "a1", url: "https://addon.example" });
    await t.action(api.addons.installSuggested, { token: "a1", suggestion: "torrentio" });
    await t.action(api.addons.install, { token: "a2", url: "https://addon.example" });
    expect(await t.mutation(api.addons.copyFrom, { token: "a2", fromProfileId: a1 })).toEqual({ added: 1 });
    expect(await names("a2")).toEqual([["Example catalogs", true], ["Torrentio TB", true]]);
  });

  test("can't be copied from another account's profile, nor by a guest", async () => {
    const { t, a1, b1 } = await setup();
    await t.action(api.addons.install, { token: "a1", url: "https://addon.example" });
    const forbidden = { code: "FORBIDDEN", message: "You can copy addons only from another profile in your account." };
    await expect(t.mutation(api.addons.copyFrom, { token: "b1", fromProfileId: a1 })).rejects.toMatchObject({ data: forbidden });
    await expect(t.mutation(api.addons.copyFrom, { token: "guest", fromProfileId: a1 })).rejects.toMatchObject({ data: forbidden });
    await expect(t.mutation(api.addons.copyFrom, { token: "a1", fromProfileId: a1 })).rejects.toMatchObject({ data: forbidden });
    await expect(t.mutation(api.addons.copyFrom, { token: "a1", fromProfileId: b1 })).rejects.toMatchObject({ data: forbidden });
  });

  test("Play asks only the enabled ones that have streams, in order", async () => {
    const { t, a1 } = await setup();
    await t.action(api.addons.install, { token: "a1", url: "https://addon.example" });
    await t.action(api.addons.installSuggested, { token: "a1", suggestion: "torrentio" });
    const origin = await t.query(internal.addons.originOf, { profileId: a1 });
    expect(origin.addons.map((a) => a.name)).toEqual(["Torrentio TB"]);
    const [, torrentio] = await t.query(api.addons.list, { token: "a1" });
    await t.mutation(api.addons.setEnabled, { token: "a1", addonId: torrentio._id, enabled: false });
    const off = await t.query(internal.addons.originOf, { profileId: a1 });
    expect(off.addons).toEqual([]);
    expect(off.scope).not.toBe(origin.scope);
  });

  test("go with their profile", async () => {
    const { t, a2 } = await setup();
    await t.action(api.addons.install, { token: "a2", url: "https://addon.example" });
    const { removeProfile } = await import("../convex/lib/profiles");
    await t.run(async (ctx) => await removeProfile(ctx, a2));
    expect(await t.run(async (ctx) => (await ctx.db.query("addons").collect()).length)).toBe(0);
  });
});
