/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import schema from "../convex/schema";
import { sha256 } from "../convex/lib/auth";

const modules = import.meta.glob(["../convex/**/*.ts", "../convex/**/*.js", "!../convex/**/*.d.ts"]);
const token = "prefs-test-session";

async function fixture() {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    const id = await ctx.db.insert("profiles", {
      name: "Prefs test", hue: 145, passwordHash: "unused", salt: "unused", order: 0,
      failedAttempts: 0, prefs: { audioLang: "eng", subLang: "eng", sounds: true },
    });
    await ctx.db.insert("sessions", { profileId: id, tokenHash: await sha256(token), createdAt: Date.now() });
  });
  return t;
}

test("changed settings merge, so two quick switches both stick", async () => {
  const t = await fixture();
  // Both sent from the same (stale) view of the settings.
  await t.mutation(api.profiles.update, { token, prefsPatch: { skipIntro: false } });
  await t.mutation(api.profiles.update, { token, prefsPatch: { autoNext: false } });
  const me = await t.query(api.profiles.me, { token });
  expect(me?.prefs).toEqual({ audioLang: "eng", subLang: "eng", sounds: true, skipIntro: false, autoNext: false });
});

test("subtitles turn off with null, and older tabs still replace the whole object", async () => {
  const t = await fixture();
  await t.mutation(api.profiles.update, { token, prefsPatch: { subLang: null } });
  expect((await t.query(api.profiles.me, { token }))?.prefs).toEqual({ audioLang: "eng", sounds: true });
  await t.mutation(api.profiles.update, { token, prefs: { audioLang: "jpn", sounds: false } });
  expect((await t.query(api.profiles.me, { token }))?.prefs).toEqual({ audioLang: "jpn", sounds: false });
});

test("every setting a profile stores can be changed, and nothing else", async () => {
  const { prefsValidator } = await import("../convex/schema");
  const { prefsPatchValidator } = await import("../convex/lib/prefs");
  expect(Object.keys(prefsPatchValidator.fields).sort()).toEqual(Object.keys(prefsValidator.fields).sort());
});
