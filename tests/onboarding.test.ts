/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { sha256 } from "../convex/lib/auth";
import schema from "../convex/schema";
import { route, type Status } from "../src/features/onboarding/route";

/*
 * The rules of docs/models/Onboarding.tla, in code: the route (src/features/onboarding/route.ts) and the status it
 * routes on (convex/onboarding.ts), and the TorBox gates on Play and parties.
 */

const modules = import.meta.glob(["../convex/**/*.ts", "../convex/**/*.js", "!../convex/**/*.d.ts"]);
const now = Date.parse("2026-11-03T20:00:00Z");
const dune = { type: "movie" as const, imdbId: "tt15239678", videoId: "tt15239678", name: "Dune: Part Two" };

/** The keys providers accept in these tests; `dead` holds keys they accepted once and refuse now. */
const GOOD = new Set(["tmdb-good", "tb-good", "rd-good"]);
const asked: string[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  asked.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    asked.push(url.hostname);
    const bearer = new Headers(init?.headers).get("authorization")?.replace("Bearer ", "") ?? "";
    if (url.hostname === "api.themoviedb.org")
      return GOOD.has(url.searchParams.get("api_key") ?? "") ? Response.json({ images: {} }) : Response.json({ status_code: 7 }, { status: 401 });
    if (url.hostname === "api.torbox.app")
      return GOOD.has(bearer) ? Response.json({ success: true, data: { id: 1 } }) : Response.json({ success: false, error: "BAD_TOKEN" }, { status: 401 });
    if (url.hostname === "api.real-debrid.com")
      return GOOD.has(bearer) ? Response.json({ id: 5 }) : Response.json({ error: "bad_token" }, { status: 401 });
    throw new Error(`Unexpected ${url}`);
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  GOOD.clear();
  for (const key of ["tmdb-good", "tb-good", "rd-good"]) GOOD.add(key);
});

/** One account with two profiles (signed in as "one" and "two"), no keys yet, and a party guest with no account. */
async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const accountId = await ctx.db.insert("accounts", { name: "Home", createdAt: now });
    const make = async (name: string, token: string, account: Id<"accounts"> | undefined, expiresAt?: number) => {
      const id = await ctx.db.insert("profiles", {
        name, hue: 145, order: 0, failedAttempts: 0, prefs: { audioLang: "eng", sounds: false }, accountId: account, expiresAt,
      });
      // Chosen after a Clerk sign-in, as every real account's session is (a guest's has no Clerk user).
      await ctx.db.insert("sessions", { profileId: id, tokenHash: await sha256(token), createdAt: now, clerkUserId: account ? "user_home" : undefined });
      return id;
    };
    return { accountId, one: await make("One", "one", accountId), two: await make("Two", "two", accountId), guest: await make("Guest", "guest", undefined, now + 60_000) };
  });
  const status = (token = "one") => t.query(api.onboarding.status, { token });
  const save = (kind: "tmdb" | "debrid", key: string, service?: "torbox" | "realdebrid") =>
    t.action(api.accounts.save, { token: "one", kind, key, service });
  const addAddon = (profileId: Id<"profiles">) =>
    t.run((ctx) => ctx.db.insert("addons", {
      profileId, url: "https://torrentio.strem.fun/torbox=tb-good", enabled: true, order: 0, installedAt: now,
      manifest: { id: "com.stremio.torrentio.addon", version: "1.0.0", name: "Torrentio", resources: [{ name: "stream", types: ["movie", "series"] }], types: ["movie", "series"], catalogs: [] },
    }));
  return { t, ...ids, status, save, addAddon };
}

const fresh: Status = { tmdb: "none", tmdbAsked: false, debrid: null, torbox: false, play: false, debridAsked: false, addons: "todo", extrasAsked: false, mdblist: false };
/** Every status: each field through its values (`tmdbAsked` unset too, as servers before it answer). */
function* statuses(): Generator<Status> {
  for (const tmdb of ["none", "valid", "invalid"] as const)
    for (const tmdbAsked of [false, true, undefined])
      for (const debrid of [null, { service: "torbox" as const, valid: true }, { service: "realdebrid" as const, valid: false }])
        for (const debridAsked of [false, true])
          for (const addons of ["todo", "installed", "skipped"] as const)
            for (const extrasAsked of [false, true])
              yield { tmdb, tmdbAsked, debrid, torbox: debrid?.service === "torbox", play: debrid?.valid === true, debridAsked, addons, extrasAsked, mdblist: extrasAsked };
}

describe("the route", () => {
  test("signed out, the route is the landing page", () => {
    for (const status of [...statuses(), null])
      for (const profile of [false, true]) expect(route({ signedIn: false, profile, status })).toBe("landing");
  });

  test("route sends to the first step still needed", () => {
    for (const status of statuses()) {
      const screen = route({ signedIn: true, profile: true, status });
      // TmdbAskedBeforeHome: no key, or one TMDB refuses, is the TMDB step until it's skipped.
      if (status.tmdb !== "valid" && !status.tmdbAsked) expect(screen).toBe("tmdbKey");
      else if (!status.debridAsked) expect(screen).toBe("debrid");
      else if (status.addons === "todo") expect(screen).toBe("addons");
      else if (!status.extrasAsked) expect(screen).toBe("extras");
      else expect(screen).toBe("home");
    }
    // HomeNeedsProfile: without a profile chosen, the picker, whatever the account has done.
    for (const status of [...statuses(), null]) expect(route({ signedIn: true, profile: false, status })).toBe("picker");
    // A party guest has no account and plays on the host's keys.
    expect(route({ signedIn: true, profile: true, status: null })).toBe("home");
  });
});

describe("onboarding status", () => {
  test("follows the steps, and resumes from the account and profile on any device", async () => {
    const { t, one, status, save, addAddon } = await setup();
    expect(await status()).toEqual(fresh);
    expect(await save("tmdb", "tmdb-good")).toEqual({ ok: true });
    expect(await status()).toEqual({ ...fresh, tmdb: "valid", tmdbAsked: true });

    // Skipping the debrid step is remembered on the account.
    await t.mutation(api.onboarding.pass, { token: "one", step: "debrid" });
    expect(route({ signedIn: true, profile: true, status: await status() })).toBe("addons");

    // An addon installed and Continue: installed. The other profile still has its own addons step.
    await addAddon(one);
    await t.mutation(api.onboarding.pass, { token: "one", step: "addons" });
    // With a stream addon, Play works without a debrid service: the addon's plain web videos play (lib/accounts.ts).
    expect(await status()).toEqual({ ...fresh, tmdb: "valid", tmdbAsked: true, debridAsked: true, addons: "installed", play: true });
    expect(await status("two")).toEqual({ ...fresh, tmdb: "valid", tmdbAsked: true, debridAsked: true, addons: "todo" });
    await t.mutation(api.onboarding.pass, { token: "two", step: "addons" });
    expect((await status("two"))?.addons).toBe("skipped");

    await t.mutation(api.onboarding.pass, { token: "one", step: "extras" });
    expect(route({ signedIn: true, profile: true, status: await status() })).toBe("home");
    expect(route({ signedIn: true, profile: true, status: await status("two") })).toBe("home");
  });

  test("a party guest has none, and can't pass a step", async () => {
    const { t, status } = await setup();
    expect(await status("guest")).toBe(null);
    expect(await status("nobody")).toBe(null);
    await expect(t.mutation(api.onboarding.pass, { token: "guest", step: "debrid" })).rejects.toThrow("Only profiles in an account have keys");
    await expect(t.mutation(api.onboarding.skipTmdb, { token: "guest" })).rejects.toThrow("Only profiles in an account have keys");
  });

  test("the TMDB step can be skipped, and Home comes without a key", async () => {
    const { t, status } = await setup();
    expect(route({ signedIn: true, profile: true, status: await status() })).toBe("tmdbKey");
    await t.mutation(api.onboarding.skipTmdb, { token: "one" });
    // Kept on the account: the other profile, on any device, is past it too.
    expect(await status()).toEqual({ ...fresh, tmdbAsked: true });
    expect(route({ signedIn: true, profile: true, status: await status("two") })).toBe("debrid");
    for (const step of ["debrid", "addons", "extras"] as const) await t.mutation(api.onboarding.pass, { token: "one", step });
    expect(await status()).toEqual({ ...fresh, tmdbAsked: true, debridAsked: true, addons: "skipped", extrasAsked: true });
    expect(route({ signedIn: true, profile: true, status: await status() })).toBe("home");
  });

  test("a key that stops working asks once more, and can be skipped then too", async () => {
    const { t, status, save } = await setup();
    await t.mutation(api.onboarding.skipTmdb, { token: "one" });
    for (const step of ["debrid", "addons", "extras"] as const) await t.mutation(api.onboarding.pass, { token: "one", step });
    vi.setSystemTime(now + 60_000);
    await save("tmdb", "tmdb-good");
    // A skip from before the key doesn't count for it: TMDB refusing it later is the TMDB step again.
    GOOD.delete("tmdb-good");
    vi.setSystemTime(now + 7 * 60 * 60_000);
    await t.action(api.onboarding.recheck, { token: "one" });
    expect(await status()).toMatchObject({ tmdb: "invalid", tmdbAsked: false });
    expect(route({ signedIn: true, profile: true, status: await status() })).toBe("tmdbKey");
    await t.mutation(api.onboarding.skipTmdb, { token: "one" });
    expect(await status()).toMatchObject({ tmdb: "invalid", tmdbAsked: true });
    expect(route({ signedIn: true, profile: true, status: await status() })).toBe("home");
  });

  test("a TMDB key removed in Settings leaves the account at Home", async () => {
    const { t, status, save } = await setup();
    await save("tmdb", "tmdb-good");
    for (const step of ["debrid", "addons", "extras"] as const) await t.mutation(api.onboarding.pass, { token: "one", step });
    await t.mutation(api.accounts.clear, { token: "one", kind: "tmdb" });
    expect(await status()).toMatchObject({ tmdb: "none", tmdbAsked: true });
    expect(route({ signedIn: true, profile: true, status: await status() })).toBe("home");
  });

  test("a refused TMDB key is marked invalid", async () => {
    const { t, status, save } = await setup();
    await save("tmdb", "tmdb-good");
    await t.mutation(api.onboarding.pass, { token: "one", step: "debrid" });
    // TMDB stops taking the key: the next check marks it, and the route goes back to the TMDB step.
    GOOD.delete("tmdb-good");
    await t.action(api.onboarding.recheck, { token: "one" });
    expect((await status())?.tmdb).toBe("invalid");
    expect(route({ signedIn: true, profile: true, status: await status() })).toBe("tmdbKey");
    // A new key it accepts puts it right.
    expect(await save("tmdb", "tmdb-good")).toEqual({ ok: false, message: "TMDB didn't accept that key. Check it and paste it again." });
    GOOD.add("tmdb-new");
    expect(await save("tmdb", "tmdb-new")).toEqual({ ok: true });
    expect((await status())?.tmdb).toBe("valid");
  });

  test("a recheck asks at most every few hours, and an unreachable provider changes nothing", async () => {
    const { t, status, save } = await setup();
    await save("tmdb", "tmdb-good");
    asked.length = 0;
    await t.action(api.onboarding.recheck, { token: "one" });
    await t.action(api.onboarding.recheck, { token: "one" });
    expect(asked).toEqual(["api.themoviedb.org"]);
    // A refusal /api saw asks again after a minute, not before.
    GOOD.delete("tmdb-good");
    await t.action(api.onboarding.recheck, { token: "one", force: true });
    expect((await status())?.tmdb).toBe("valid");
    vi.setSystemTime(now + 61_000);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    await t.action(api.onboarding.recheck, { token: "one", force: true });
    expect((await status())?.tmdb).toBe("valid");
  });

  test("a QA sign-in's stand-in keys are never rechecked", async () => {
    const { t, one, status, save } = await setup();
    await save("tmdb", "tmdb-good");
    await t.run(async (ctx) => {
      await ctx.db.insert("sessions", { profileId: one, tokenHash: await sha256("qa"), createdAt: now });
    });
    GOOD.delete("tmdb-good");
    asked.length = 0;
    await t.action(api.onboarding.recheck, { token: "qa", force: true });
    expect(asked).toEqual([]);
    expect((await status("qa"))?.tmdb).toBe("valid");
  });

  test("TorBox gates follow the account's debrid", async () => {
    const { t, status, save } = await setup();
    await save("tmdb", "tmdb-good");
    expect((await status())?.torbox).toBe(false);
    await save("debrid", "rd-good", "realdebrid");
    expect(await status()).toMatchObject({ debrid: { service: "realdebrid", valid: true }, torbox: false, play: true, debridAsked: true });
    await save("debrid", "tb-good", "torbox");
    expect((await status())?.torbox).toBe(true);
    // TorBox refuses the key later.
    GOOD.delete("tb-good");
    vi.setSystemTime(now + 7 * 60 * 60_000);
    await t.action(api.onboarding.recheck, { token: "one" });
    expect(await status()).toMatchObject({ debrid: { service: "torbox", valid: false }, torbox: false, play: false, tmdb: "valid" });
    await expect(t.mutation(api.rooms.createParty, { token: "one", inviteIds: [] })).rejects.toThrow("Parties need TorBox");
    // Removed in Settings: still no TorBox, and the debrid step stays done.
    await t.mutation(api.accounts.clear, { token: "one", kind: "debrid" });
    expect(await status()).toMatchObject({ debrid: null, torbox: false, play: false, debridAsked: true });
  });

  test("a working TorBox key opens both", async () => {
    const { t, status, save } = await setup();
    await save("debrid", "tb-good", "torbox");
    expect((await status())?.torbox).toBe(true);
    const roomId = await t.mutation(api.rooms.create, { token: "one", media: dune });
    expect((await t.run((ctx) => ctx.db.get(roomId)))?.media?.videoId).toBe(dune.videoId);
    const partyId = await t.mutation(api.rooms.createParty, { token: "one", inviteIds: [] });
    expect((await t.run((ctx) => ctx.db.get(partyId)))?.kind).toBe("party");
  });

  test("another debrid service plays alone, but hosts no party", async () => {
    const { t, status, save } = await setup();
    await save("debrid", "rd-good", "realdebrid");
    expect(await status()).toMatchObject({ torbox: false, play: true });
    const roomId = await t.mutation(api.rooms.create, { token: "one", media: dune });
    expect((await t.run((ctx) => ctx.db.get(roomId)))?.status).toBe("preparing");
    await expect(t.mutation(api.rooms.createParty, { token: "one", inviteIds: [], media: dune })).rejects.toEqual(
      expect.objectContaining({ data: { code: "NEEDS_TORBOX", message: "Parties need TorBox. Add a TorBox key in Settings → Connections." } }),
    );
  });

  test("Play without a debrid service and parties without TorBox refuse up front", async () => {
    const { t } = await setup();
    await expect(t.mutation(api.rooms.create, { token: "one", media: dune })).rejects.toEqual(
      expect.objectContaining({ data: { code: "NEEDS_DEBRID", message: "Playing needs a debrid service. Add one in Settings → Connections." } }),
    );
    await expect(t.mutation(api.rooms.createParty, { token: "one", inviteIds: [], media: dune })).rejects.toEqual(
      expect.objectContaining({ data: { code: "NEEDS_TORBOX", message: "Parties need TorBox. Add a TorBox key in Settings → Connections." } }),
    );
    // Nothing started: no room, no stream job.
    expect(await t.run(async (ctx) => [(await ctx.db.query("rooms").collect()).length, (await ctx.db.system.query("_scheduled_functions").collect()).length])).toEqual([0, 0]);
  });
});
