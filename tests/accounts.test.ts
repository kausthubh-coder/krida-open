/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, onTestFinished, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { sha256 } from "../convex/lib/auth";
import schema from "../convex/schema";

const modules = import.meta.glob(["../convex/**/*.ts", "../convex/**/*.js", "!../convex/**/*.d.ts"]);

/** Keys each provider accepts in these tests; anything else it turns down the way it really does. */
const GOOD = { tmdb: "tmdb-good", mdblist: "mdb-good", torbox: "tb-good", realdebrid: "rd-good", premiumize: "pm-good" };
const asked: string[] = [];

beforeEach(() => {
  asked.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    asked.push(url.origin + url.pathname);
    const bearer = new Headers(init?.headers).get("authorization")?.replace("Bearer ", "");
    if (url.hostname === "api.themoviedb.org")
      return url.searchParams.get("api_key") === GOOD.tmdb ? Response.json({ images: {} }) : Response.json({ status_code: 7 }, { status: 401 });
    if (url.hostname === "api.mdblist.com")
      return url.searchParams.get("apikey") === GOOD.mdblist ? Response.json({ user_id: 1 }) : Response.json({ error: "Invalid API key" }, { status: 403 });
    if (url.hostname === "api.torbox.app")
      return bearer === GOOD.torbox ? Response.json({ success: true, data: { id: 1 } }) : Response.json({ success: false, error: "BAD_TOKEN" }, { status: 401 });
    if (url.hostname === "api.real-debrid.com")
      return bearer === GOOD.realdebrid ? Response.json({ id: 5, username: "x" }) : Response.json({ error: "bad_token" }, { status: 401 });
    // Premiumize answers 200 either way and says in the body.
    if (url.hostname === "www.premiumize.me")
      return Response.json(url.searchParams.get("apikey") === GOOD.premiumize ? { status: "success" } : { status: "error", message: "Not logged in." });
    throw new Error(`Unexpected ${url}`);
  }));
});
afterEach(() => vi.unstubAllGlobals());

/** Two accounts, A with two profiles and B with one, plus a temporary party guest with no account. */
async function setup() {
  const t = convexTest(schema, modules);
  const sessions = await t.run(async (ctx) => {
    const make = async (name: string, accountId: Id<"accounts"> | undefined, token: string, expiresAt?: number) => {
      const profileId = await ctx.db.insert("profiles", {
        name, hue: 1, passwordHash: "x", salt: "x", order: 0, failedAttempts: 0, prefs: { audioLang: "eng", sounds: false }, accountId, expiresAt,
      });
      await ctx.db.insert("sessions", { profileId, tokenHash: await sha256(token), createdAt: Date.now() });
      return token;
    };
    const a = await ctx.db.insert("accounts", { name: "A", createdAt: Date.now() });
    const b = await ctx.db.insert("accounts", { name: "B", createdAt: Date.now() });
    return {
      a1: await make("A one", a, "a1"),
      a2: await make("A two", a, "a2"),
      b1: await make("B one", b, "b1"),
      guest: await make("Guest", undefined, "guest", Date.now() + 60_000),
    };
  });
  return { t, ...sessions };
}

describe("an account's keys", () => {
  test("are checked with their provider, saved, and read by every profile in the account", async () => {
    const { t, a1, a2 } = await setup();
    expect(await t.action(api.accounts.save, { token: a1, kind: "tmdb", key: ` ${GOOD.tmdb} ` })).toEqual({ ok: true });
    expect(await t.action(api.accounts.save, { token: a1, kind: "mdblist", key: GOOD.mdblist })).toEqual({ ok: true });
    expect(await t.action(api.accounts.save, { token: a2, kind: "debrid", service: "torbox", key: GOOD.torbox })).toEqual({ ok: true });
    expect(asked).toEqual(["https://api.themoviedb.org/3/configuration", "https://api.mdblist.com/user", "https://api.torbox.app/v1/api/user/me"]);
    const both = { tmdb: GOOD.tmdb, mdblist: GOOD.mdblist, debrid: { service: "torbox", key: GOOD.torbox } };
    expect(await t.query(api.accounts.keys, { token: a1 })).toEqual(both);
    expect(await t.query(api.accounts.keys, { token: a2 })).toEqual(both);
    expect(await t.query(api.accounts.connections, { token: a2 })).toEqual({
      tmdb: "…good", mdblist: "…good", debrid: { service: "torbox", hint: "…good" },
    });
  });

  test("a key the provider turns down isn't saved, and says what to do", async () => {
    const { t, a1 } = await setup();
    expect(await t.action(api.accounts.save, { token: a1, kind: "tmdb", key: "wrong" })).toEqual({
      ok: false, message: "TMDB didn't accept that key. Check it and paste it again.",
    });
    expect(await t.action(api.accounts.save, { token: a1, kind: "debrid", service: "premiumize", key: "wrong" })).toEqual({
      ok: false, message: "Premiumize didn't accept that key. Check it and paste it again.",
    });
    expect(await t.action(api.accounts.save, { token: a1, kind: "tmdb", key: "eyJhbGciOiJIUzI1NiJ9.long.token" })).toEqual({
      ok: false, message: "That's TMDB's read access token. Paste the shorter API key from the same page.",
    });
    expect(await t.action(api.accounts.save, { token: a1, kind: "debrid", key: GOOD.torbox })).toEqual({ ok: false, message: "Pick your debrid service first." });
    expect(await t.query(api.accounts.keys, { token: a1 })).toEqual({});
  });

  test("a provider that can't be reached isn't blamed on the key", async () => {
    const { t, a1 } = await setup();
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    expect(await t.action(api.accounts.save, { token: a1, kind: "debrid", service: "realdebrid", key: GOOD.realdebrid })).toEqual({
      ok: false, message: "Couldn't reach Real-Debrid. Try again in a moment.",
    });
  });

  test("another account's session can't read them", async () => {
    const { t, a1, b1 } = await setup();
    await t.action(api.accounts.save, { token: a1, kind: "tmdb", key: GOOD.tmdb });
    await t.action(api.accounts.save, { token: a1, kind: "debrid", service: "torbox", key: GOOD.torbox });
    expect(await t.query(api.accounts.keys, { token: b1 })).toEqual({});
    expect(await t.query(api.accounts.connections, { token: b1 })).toEqual({ tmdb: null, mdblist: null, debrid: null });
  });

  test("another account's session can't change them: its writes land in its own account", async () => {
    const { t, a1, b1 } = await setup();
    await t.action(api.accounts.save, { token: a1, kind: "tmdb", key: GOOD.tmdb });
    await t.action(api.accounts.save, { token: a1, kind: "debrid", service: "torbox", key: GOOD.torbox });
    await t.mutation(api.accounts.clear, { token: b1, kind: "tmdb" });
    await t.mutation(api.accounts.clear, { token: b1, kind: "debrid" });
    await t.action(api.accounts.save, { token: b1, kind: "debrid", service: "realdebrid", key: GOOD.realdebrid });
    expect(await t.query(api.accounts.keys, { token: a1 })).toEqual({ tmdb: GOOD.tmdb, debrid: { service: "torbox", key: GOOD.torbox } });
    expect(await t.query(api.accounts.keys, { token: b1 })).toEqual({ debrid: { service: "realdebrid", key: GOOD.realdebrid } });
  });

  test("a guest without an account, or no session, has none and can't add any", async () => {
    const { t, guest } = await setup();
    expect(await t.query(api.accounts.keys, { token: guest })).toBe(null);
    expect(await t.query(api.accounts.connections, { token: guest })).toBe(null);
    expect(await t.query(api.accounts.keys, { token: "nobody" })).toBe(null);
    await expect(t.action(api.accounts.save, { token: guest, kind: "tmdb", key: GOOD.tmdb })).rejects.toThrow("Only profiles in an account have keys");
    await expect(t.mutation(api.accounts.clear, { token: guest, kind: "tmdb" })).rejects.toThrow("Only profiles in an account have keys");
    await expect(t.mutation(api.accounts.clear, { token: "nobody", kind: "tmdb" })).rejects.toThrow("Sign in to continue");
    expect(asked).toEqual([]);
  });

  test("clearing one leaves the others", async () => {
    const { t, a1, a2 } = await setup();
    await t.action(api.accounts.save, { token: a1, kind: "tmdb", key: GOOD.tmdb });
    await t.action(api.accounts.save, { token: a1, kind: "mdblist", key: GOOD.mdblist });
    await t.mutation(api.accounts.clear, { token: a2, kind: "tmdb" });
    expect(await t.query(api.accounts.keys, { token: a1 })).toEqual({ mdblist: GOOD.mdblist });
  });
});

describe("profiles made from the CLI and seeds", () => {
  test("QA profiles share one account, and others get their own", async () => {
    const t = convexTest(schema, modules);
    const one = await t.mutation(internal.profiles.add, { name: "Regress-QA-one", hue: 1, password: "pw" });
    const two = await t.mutation(internal.profiles.add, { name: "Worktree-QA-two", hue: 2, password: "pw" });
    const solo = await t.mutation(internal.profiles.add, { name: "Someone", hue: 3, password: "pw" });
    const named = await t.mutation(internal.profiles.add, { name: "Ratings-QA-x", hue: 4, password: "pw", account: "Elsewhere" });
    const accounts = await t.run(async (ctx) => {
      const name = async (id: Id<"profiles">) => (await ctx.db.get((await ctx.db.get(id))!.accountId!))!.name;
      return [await name(one), await name(two), await name(solo), await name(named)];
    });
    expect(accounts).toEqual(["QA", "QA", "Someone", "Elsewhere"]);
  });

  test("a seed puts every profile in one account, and keys can be set for it by name", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.profiles.seed, { profiles: [{ name: "One", hue: 1, password: "pw" }, { name: "Two", hue: 2, password: "pw" }], account: "Home" });
    const accountId = await t.mutation(internal.accounts.setKeysFor, { account: "Home", keys: { tmdb: "t" } });
    const owners = await t.run(async (ctx) => (await ctx.db.query("profiles").collect()).map((p) => p.accountId));
    expect(owners).toEqual([accountId, accountId]);
    expect(await t.query(internal.accounts.keysOfAccount, { accountId })).toEqual({ tmdb: "t" });
  });
});

describe("Simkl", () => {
  afterEach(() => vi.unstubAllEnvs());

  test("is offered only where the deployment has its own Simkl app", async () => {
    const t = convexTest(schema, modules);
    vi.stubEnv("SIMKL_CLIENT_ID", "");
    expect(await t.query(api.simkl.enabled, {})).toBe(false);
    vi.stubEnv("SIMKL_CLIENT_ID", "client");
    expect(await t.query(api.simkl.enabled, {})).toBe(true);
  });
});

/*
 * The rules of docs/models/AccountIsolation.tla, one test per invariant (docs/models/README.md): Clerk accounts, the
 * profiles in them, the sessions choosing one makes, and what each can see.
 */
describe("AccountIsolation", () => {
  const forbidden = (message: string) => expect.objectContaining({ data: { code: "FORBIDDEN", message } });
  const signIn = expect.objectContaining({ data: { code: "UNAUTHENTICATED", message: "Sign in to continue" } });

  /** Two Clerk users, Ada (two profiles, one with a PIN) and Ben (one), each signed in on one device. */
  async function clerkAccounts() {
    const t = convexTest(schema, modules);
    const ada = t.withIdentity({ subject: "user_ada", name: "Ada", sid: "sess_ada_laptop" });
    const ben = t.withIdentity({ subject: "user_ben", name: "Ben", sid: "sess_ben_phone" });
    const adaOne = await ada.mutation(api.profiles.create, { name: "Ada", hue: 20 });
    const adaKid = await ada.mutation(api.profiles.create, { name: "Kid", hue: 200, pin: "1234" });
    const benOne = await ben.mutation(api.profiles.create, { name: "Ben", hue: 90 });
    const choose = async (who: typeof ada, profileId: Id<"profiles">, pin?: string) => {
      const r = await who.mutation(api.profiles.choose, { profileId, pin });
      if (!r.ok) throw new Error(r.message);
      return r.token;
    };
    const sessionsOf = (profileId: Id<"profiles">) =>
      t.run((ctx) => ctx.db.query("sessions").withIndex("by_profile", (q) => q.eq("profileId", profileId)).collect());
    return { t, ada, ben, adaOne, adaKid, benOne, choose, sessionsOf };
  }

  test("first sign-in makes the account; it holds at most 8 profiles", async () => {
    const t = convexTest(schema, modules);
    const cleo = t.withIdentity({ subject: "user_cleo", name: "Cleo" });
    const accountId = await cleo.mutation(api.profiles.ensureAccount, {});
    expect(await cleo.mutation(api.profiles.ensureAccount, {})).toBe(accountId);
    expect((await t.run((ctx) => ctx.db.get(accountId)))?.clerkUserId).toBe("user_cleo");
    for (let i = 1; i <= 8; i++) await cleo.mutation(api.profiles.create, { name: `P${i}`, hue: i });
    await expect(cleo.mutation(api.profiles.create, { name: "P9", hue: 9 })).rejects.toThrow(
      expect.objectContaining({ data: { code: "LIMIT", message: "An account has at most 8 profiles" } }),
    );
    await expect(t.mutation(api.profiles.create, { name: "Nobody", hue: 1 })).rejects.toThrow(signIn);
  });

  test("SessionInOwnAccount: choosing another account's profile is refused", async () => {
    const { ada, benOne, sessionsOf } = await clerkAccounts();
    await expect(ada.mutation(api.profiles.choose, { profileId: benOne })).rejects.toThrow(forbidden("That profile isn't in your account"));
    await expect(ada.mutation(api.profiles.deleteProfile, { profileId: benOne })).rejects.toThrow(forbidden("That profile isn't in your account"));
    expect(await sessionsOf(benOne)).toEqual([]);
  });

  test("SignOutEndsSessions: signing out of the account ends its profile sessions", async () => {
    const { t, ada, ben, adaOne, choose } = await clerkAccounts();
    const token = await choose(ada, adaOne);
    expect((await ada.query(api.profiles.me, { token }))?.name).toBe("Ada");
    // Someone else's browser can't use it.
    expect(await ben.query(api.profiles.me, { token })).toBeNull();
    await expect(ben.query(api.rooms.live, { token })).rejects.toThrow(signIn);
    // Krida's own server, which has no Clerk sign-in, can.
    expect((await t.query(api.profiles.me, { token }))?.viaAccount).toBe(true);
    expect(await ada.mutation(api.profiles.signOutAccount, { token })).toBe(1);
    expect(await ada.query(api.profiles.me, { token })).toBeNull();
    const accountId = (await t.run((ctx) => ctx.db.get(adaOne)))!.accountId;
    expect(await t.run((ctx) => ctx.db.query("sessions").withIndex("by_account", (q) => q.eq("accountId", accountId)).collect())).toEqual([]);
  });

  test("PinRespected: a PIN profile needs its PIN", async () => {
    const { ada, adaKid, choose, sessionsOf } = await clerkAccounts();
    expect(await ada.mutation(api.profiles.choose, { profileId: adaKid })).toEqual({ ok: false, message: "Enter the PIN." });
    expect(await ada.mutation(api.profiles.choose, { profileId: adaKid, pin: "0000" })).toEqual({ ok: false, message: "Wrong PIN. Try again." });
    expect(await sessionsOf(adaKid)).toEqual([]);
    expect(await choose(ada, adaKid, "1234")).toMatch(/^[0-9a-f]{64}$/);
    // Five wrong tries lock it for five minutes, even with the right PIN.
    for (let i = 0; i < 5; i++) await ada.mutation(api.profiles.choose, { profileId: adaKid, pin: "9999" });
    expect(await ada.mutation(api.profiles.choose, { profileId: adaKid, pin: "1234" })).toEqual({ ok: false, message: "Too many wrong tries. Try again in 5 min." });
    expect((await ada.query(api.profiles.list, {})).map((p) => [p.name, p.hasPin])).toEqual([["Ada", false], ["Kid", true]]);
  });

  test("PinRespected: setting a PIN ends the profile's other sessions", async () => {
    const { t, ada, adaOne, choose } = await clerkAccounts();
    const laptop = await choose(ada, adaOne);
    const phone = await choose(t.withIdentity({ subject: "user_ada", name: "Ada", sid: "sess_ada_phone" }), adaOne);
    await expect(ada.mutation(api.profiles.setPin, { token: laptop, pin: "12a4" })).rejects.toThrow(
      expect.objectContaining({ data: { code: "INVALID", message: "A PIN is 4 digits" } }),
    );
    await ada.mutation(api.profiles.setPin, { token: laptop, pin: "4321" });
    expect(await ada.query(api.profiles.me, { token: phone })).toBeNull();
    expect((await ada.query(api.profiles.me, { token: laptop }))?.hasPin).toBe(true);
    expect(await ada.mutation(api.profiles.choose, { profileId: adaOne })).toEqual({ ok: false, message: "Enter the PIN." });
    await ada.mutation(api.profiles.setPin, { token: laptop, pin: null });
    expect(await choose(ada, adaOne)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("KeysIsolated: keys are read only from the caller's account", async () => {
    const { t, ada, ben, adaOne, benOne, choose } = await clerkAccounts();
    const adaToken = await choose(ada, adaOne);
    const benToken = await choose(ben, benOne);
    expect(await ada.action(api.accounts.save, { token: adaToken, kind: "tmdb", key: GOOD.tmdb })).toEqual({ ok: true });
    expect(await t.query(api.accounts.keys, { token: adaToken })).toEqual({ tmdb: GOOD.tmdb, mdblist: undefined, debrid: undefined });
    expect(await t.query(api.accounts.keys, { token: benToken })).toEqual({ tmdb: undefined, mdblist: undefined, debrid: undefined });
    const snapshot = (await import("./api-snapshot.json")).default as Record<string, { args: Record<string, unknown> | "any" }>;
    expect(Object.entries(snapshot).filter(([, e]) => e.args !== "any" && "accountId" in e.args).map(([name]) => name)).toEqual([]);
  });

  test("ProfileListIsolated: the picker lists only my account's profiles", async () => {
    const { t, ada, ben, adaOne, choose } = await clerkAccounts();
    expect((await ada.query(api.profiles.list, {})).map((p) => p.name)).toEqual(["Ada", "Kid"]);
    expect((await ben.query(api.profiles.list, {})).map((p) => p.name)).toEqual(["Ben"]);
    expect(await t.run(async (ctx) => (await ctx.db.query("profiles").collect()).length)).toBe(3);
    // Signed out, nothing; with only a session (QA sign-ins), that session's account.
    expect(await t.query(api.profiles.list, {})).toEqual([]);
    expect((await t.query(api.profiles.list, { token: await choose(ada, adaOne) })).map((p) => p.name)).toEqual(["Ada", "Kid"]);
  });

  /** Rooms for the listing rules: Kid hosts one, Ben hosts one Ada was invited to and one she wasn't. */
  async function rooms() {
    const f = await clerkAccounts();
    await f.t.run(async (ctx) => {
      for (const p of [f.adaOne, f.benOne]) {
        const accountId = (await ctx.db.get(p))!.accountId!;
        await ctx.db.insert("accountKeys", { accountId, debrid: { service: "torbox", key: `tb-${p}` }, updatedAt: Date.now() });
      }
    });
    const ada = await f.choose(f.ada, f.adaOne);
    const kid = await f.choose(f.ada, f.adaKid, "1234");
    const ben = await f.choose(f.ben, f.benOne);
    // One party at a time per profile, so Ben's account's second profile hosts the other.
    const bo = await f.choose(f.ben, await f.ben.mutation(api.profiles.create, { name: "Bo", hue: 100 }));
    const ours = await f.t.mutation(api.rooms.createParty, { token: kid, inviteIds: [] });
    const invitedTo = await f.t.mutation(api.rooms.createParty, { token: ben, inviteIds: [] });
    const notInvited = await f.t.mutation(api.rooms.createParty, { token: bo, inviteIds: [] });
    await f.t.run((ctx) => ctx.db.insert("invites", { roomId: invitedTo, fromId: f.benOne, toId: f.adaOne, status: "pending", createdAt: Date.now() }));
    return { ...f, tokens: { ada, kid, ben, bo }, ours, invitedTo, notInvited };
  }

  test("RoomListIsolated: rooms.live lists only my account's rooms and rooms I'm invited to", async () => {
    const { t, tokens, ours, invitedTo } = await rooms();
    expect((await t.query(api.rooms.live, { token: tokens.ada })).map((r) => r._id).sort()).toEqual([ours, invitedTo].sort());
  });

  test("MemberListIsolated: another account's members show only in a room I'm in", async () => {
    const { t, tokens, invitedTo } = await rooms();
    const code = await t.mutation(api.rooms.shareLink, { token: tokens.ben, roomId: invitedTo });
    await t.mutation(api.rooms.join, { token: tokens.kid, roomId: invitedTo, code });
    const listed = (await t.query(api.rooms.live, { token: tokens.ada })).find((r) => r._id === invitedTo);
    expect(listed?.members.map((m) => m.name)).toEqual(["Kid"]);
    await t.mutation(api.rooms.join, { token: tokens.ada, roomId: invitedTo });
    expect((await t.query(api.rooms.get, { token: tokens.ada, roomId: invitedTo }))?.members.map((m) => m.name)).toEqual(["Ben", "Kid", "Ada"]);
  });

  test("MemberListIsolated: room reads refuse non-members", async () => {
    const { t, tokens, notInvited } = await rooms();
    const out = forbidden("You're not in this party");
    await expect(t.query(api.rooms.get, { token: tokens.ada, roomId: notInvited })).rejects.toThrow(out);
    await expect(t.query(api.rooms.people, { token: tokens.ada, roomId: notInvited })).rejects.toThrow(out);
    await expect(t.query(api.messages.list, { token: tokens.ada, roomId: notInvited })).rejects.toThrow(out);
    await expect(t.query(api.invites.forRoom, { token: tokens.ada, roomId: notInvited })).rejects.toThrow(out);
  });

  test("MembersInvitedOrSameAccount: joining another account's room needs its link", async () => {
    const { t, tokens, ours, notInvited } = await rooms();
    await expect(t.mutation(api.rooms.join, { token: tokens.ben, roomId: ours })).rejects.toThrow(forbidden("Ask the host for this party's link"));
    await expect(t.mutation(api.invites.knock, { token: tokens.ben, roomId: ours })).rejects.toThrow(forbidden("Ask the host for this party's link"));
    await t.mutation(api.rooms.join, { token: tokens.ada, roomId: ours });
    const code = await t.mutation(api.rooms.shareLink, { token: tokens.kid, roomId: ours });
    await t.mutation(api.rooms.join, { token: tokens.ben, roomId: ours, code });
    expect((await t.query(api.rooms.get, { token: tokens.kid, roomId: ours }))?.members.map((m) => m.name)).toEqual(["Kid", "Ada", "Ben"]);
    await expect(t.mutation(api.rooms.join, { token: tokens.ada, roomId: notInvited })).rejects.toThrow(forbidden("Ask the host for this party's link"));
  });

  test("DeletedLeavesNothing: deleting a profile ends its sessions, memberships and hosted rooms", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    onTestFinished(() => { vi.useRealTimers(); });
    const { t, ada, adaKid, tokens, ours, invitedTo } = await rooms();
    const code = await t.mutation(api.rooms.shareLink, { token: tokens.ben, roomId: invitedTo });
    await t.mutation(api.rooms.join, { token: tokens.kid, roomId: invitedTo, code });
    expect(await ada.mutation(api.profiles.deleteProfile, { profileId: adaKid })).toEqual({ ok: false, message: "Enter the PIN." });
    expect(await ada.mutation(api.profiles.deleteProfile, { profileId: adaKid, pin: "1234" })).toEqual({ ok: true });
    expect(await t.query(api.profiles.me, { token: tokens.kid })).toBeNull();
    expect(await t.run((ctx) => ctx.db.query("roomMembers").withIndex("by_profile", (q) => q.eq("profileId", adaKid)).collect())).toEqual([]);
    expect((await t.run((ctx) => ctx.db.get(ours)))?.closedAt).toBe(Date.now());
    // A party it was only in carries on.
    expect((await t.run((ctx) => ctx.db.get(invitedTo)))?.closedAt).toBe(undefined);
  });
});
