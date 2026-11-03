// Focused checks for the overlapping playback, party and source-picker changes.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { rolldown } from "rolldown";
import { getFunctionName } from "convex/server";

const out = path.resolve(".artifacts/merge-check");
await mkdir(out, { recursive: true });
const bundle = await rolldown({
  input: { rooms: "convex/rooms.ts", sources: "convex/sources.ts", rank: "convex/lib/rank.ts" },
  platform: "node",
  external: [/^convex\//],
});
await bundle.write({ dir: out, format: "esm" });
await bundle.close();
const rooms = await import(pathToFileURL(path.join(out, "rooms.js")));
const sources = await import(pathToFileURL(path.join(out, "sources.js")));
const rank = await import(pathToFileURL(path.join(out, "rank.js")));
const media = (episode) => ({ type: "series", imdbId: "tt123", videoId: `tt123:1:${episode}`, name: "Example", season: 1, episode });
let checks = 0;
async function check(name, run) {
  await run();
  checks++;
  console.log(`PASS ${name}`);
}

function context() {
  const now = Date.now();
  const data = new Map([
    ["me", { _id: "me", name: "Me", hue: 100, prefs: {} }],
    ["friend", { _id: "friend", name: "Friend", hue: 200, prefs: { skipIntro: false } }],
    ["session", { _id: "session", table: "sessions", profileId: "me" }],
    ["room", { _id: "room", table: "rooms", hostId: "me", kind: "party", status: "ready", media: media(1), autoStreak: 2,
      lastActiveAt: now, playback: { playing: true, position: 20, anchorAt: now, seq: 1 } }],
    ["member", { _id: "member", table: "roomMembers", roomId: "room", profileId: "me", lastSeenAt: now, left: false, watching: true }],
    ["other", { _id: "other", table: "roomMembers", roomId: "room", profileId: "friend", lastSeenAt: now, left: false, watching: true }],
  ]);
  let serial = 0;
  const jobs = [];
  const db = {
    get: async (id) => structuredClone(data.get(id) ?? null),
    patch: async (id, values) => { for (const [key, value] of Object.entries(values)) { if (value === undefined) delete data.get(id)[key]; else data.get(id)[key] = structuredClone(value); } },
    insert: async (table, values) => { const id = `new${++serial}`; data.set(id, { ...structuredClone(values), _id: id, table }); return id; },
    replace: async (id, values) => { data.set(id, { ...structuredClone(values), _id: id, table: data.get(id)?.table }); },
    delete: async (id) => { data.delete(id); },
    // Mutations change rows through convex/functions.ts, which asks each id's table; none of these is a synced one.
    normalizeId: () => null,
    system: {},
    query: (table) => {
      const filters = [];
      const builder = {
        eq: (key, value) => { filters.push((row) => row[key] === value); return builder; },
        gt: (key, value) => { filters.push((row) => row[key] > value); return builder; },
      };
      const rows = () => [...data.values()].filter((row) => row.table === table && filters.every((f) => f(row)));
      const query = {
        withIndex: (_name, filter) => { filter?.(builder); return query; },
        collect: async () => structuredClone(rows()),
        first: async () => structuredClone(rows()[0] ?? null),
        unique: async () => table === "sessions" ? data.get("session") : rows()[0] ?? null,
      };
      return query;
    },
  };
  return { data, jobs, db, scheduler: { runAfter: async (delay, fn, args) => jobs.push({ delay, fn: getFunctionName(fn), args }) } };
}
const call = (fn, ctx, args = {}) => fn._handler(ctx, { token: "controlled", roomId: "room", ...args });

await check("automatic advance increments the streak and consumes Next", async () => {
  const c = context();
  await call(rooms.setNext, c, { media: media(2) });
  assert.equal(c.data.get("room").queue.length, 1);
  assert.equal(await call(rooms.advance, c, { fromVideoId: media(1).videoId, media: media(2), auto: true }), true);
  assert.equal(c.data.get("room").autoStreak, 3);
  assert.equal(c.data.get("room").next, undefined);
  assert.deepEqual(c.data.get("room").queue, []);
  assert.equal(await call(rooms.advance, c, { fromVideoId: media(1).videoId, media: media(2), auto: true }), false);
});
await check("manual advance resets the still-watching streak", async () => {
  const c = context();
  await call(rooms.advance, c, { fromVideoId: media(1).videoId, media: media(2) });
  assert.equal(c.data.get("room").autoStreak, 0);
});
await check("Stop here blocks automatic advance and lining up Next resumes it", async () => {
  const c = context();
  await call(rooms.setStopAfter, c, { on: true, videoId: media(1).videoId });
  assert.equal(await call(rooms.advance, c, { fromVideoId: media(1).videoId, media: media(2), auto: true }), false);
  await call(rooms.setNext, c, { media: media(2) });
  assert.equal(c.data.get("room").stopAfter, undefined);
  await call(rooms.clearNext, c);
  assert.equal(c.data.get("room").next, undefined);
  assert.deepEqual(c.data.get("room").queue, []);
});
await check("legacy queues remain usable and visible as Next", async () => {
  const c = context();
  await call(rooms.queueAdd, c, { media: media(2) });
  await call(rooms.queueAdd, c, { media: media(3) });
  const first = c.data.get("room").queue[0];
  await call(rooms.queueRemove, c, { itemId: first.id });
  assert.equal(c.data.get("room").next.media.videoId, media(3).videoId);
  await call(rooms.queueRestore, c, { item: first, index: 0 });
  assert.equal(c.data.get("room").next.media.videoId, media(2).videoId);
  await call(rooms.queueMove, c, { itemId: first.id, to: 1 });
  assert.equal(c.data.get("room").next.media.videoId, media(3).videoId);
});
await check("party members expose automatic playback preferences", async () => {
  const c = context();
  const room = await call(rooms.get, c);
  assert.equal(room.members.find((m) => m.isMe).auto.skipIntro, true);
  assert.equal(room.members.find((m) => !m.isMe).auto.skipIntro, false);
  assert.deepEqual(room.queue, []);
});
await check("both votes schedule a start; cancellation defeats the pending job", async () => {
  const c = context(); c.data.get("room").status = "idle";
  await call(rooms.suggest, c, { media: media(2) });
  const suggestion = c.data.get("room").suggestions[0];
  suggestion.inIds.push("friend");
  await call(rooms.heartbeat, c);
  const start = structuredClone(c.data.get("room").starting);
  assert.ok(start);
  await call(rooms.cancelStart, c);
  await call(rooms.startSuggestion, c, { suggestionId: suggestion.id, at: start.at });
  assert.equal(c.data.get("room").status, "idle");
  assert.ok(!c.data.get("room").suggestions[0].inIds.includes("me"));
});
await check("switching asks first and a decline keeps the current video", async () => {
  const c = context();
  assert.equal(await call(rooms.requestSwitch, c, { media: media(2) }), "asked");
  const request = c.data.get("room").switchRequest;
  // The others answer; only whoever asked can call it off.
  c.data.get("session").profileId = "friend";
  await call(rooms.answerSwitch, c, { requestId: request.id, accept: false });
  assert.equal(c.data.get("room").media.videoId, media(1).videoId);
  c.data.get("session").profileId = "me";
  await call(rooms.cancelSwitch, c);
  assert.equal(c.data.get("room").switchRequest, undefined);
});
await check("an accepted switch starts the new video; an expired one does not", async () => {
  const c = context();
  await call(rooms.requestSwitch, c, { media: media(2) });
  const request = c.data.get("room").switchRequest;
  request.createdAt -= 31_000;
  // The others answer.
  c.data.get("session").profileId = "friend";
  assert.equal(await call(rooms.answerSwitch, c, { requestId: request.id, accept: true }), "expired");
  // An expired request is cleared; asked again, it can be accepted.
  c.data.get("session").profileId = "me";
  await call(rooms.requestSwitch, c, { media: media(2) });
  const again = c.data.get("room").switchRequest;
  c.data.get("session").profileId = "friend";
  await call(rooms.answerSwitch, c, { requestId: again.id, accept: true });
  assert.equal(c.data.get("room").media.videoId, media(2).videoId);
  assert.equal(c.data.get("room").status, "preparing");
});
await check("a sleeping member returns on heartbeat while an explicit leaver stays out", async () => {
  const c = context();
  Object.assign(c.data.get("member"), { left: true, swept: true });
  await call(rooms.heartbeat, c);
  assert.equal(c.data.get("member").left, false);
  Object.assign(c.data.get("member"), { left: true, swept: false });
  await call(rooms.heartbeat, c);
  assert.equal(c.data.get("member").left, true);
});
await check("a party waits 30 idle minutes to close, and invites expire after 10", async () => {
  const c = context();
  const now = Date.now();
  c.data.get("room").lastActiveAt = now - 11 * 60_000;
  c.data.get("member").lastSeenAt = now - 11 * 60_000;
  c.data.get("other").lastSeenAt = now - 11 * 60_000;
  c.data.set("invite", { _id: "invite", table: "invites", roomId: "room", status: "pending", createdAt: now - 11 * 60_000 });
  await rooms.sweep._handler(c, {});
  assert.equal(c.data.get("room").closedAt, undefined);
  assert.equal(c.data.get("member").swept, true);
  assert.equal(c.data.get("invite").status, "expired");
  await call(rooms.heartbeat, c);
  assert.equal(c.data.get("member").left, false);
  c.data.get("room").lastActiveAt = now - 31 * 60_000;
  await rooms.sweep._handler(c, {});
  assert.ok(c.data.get("room").closedAt);
});
await check("source APIs keep the legacy array and offer ranked results without credentials", async () => {
  const items = [{ url: "https://private.invalid/secret", name: "Addon 1080p", description: "", filename: "Example.S01E02.1080p.mkv", size: 2e9 }];
  const ctx = {
    runQuery: async (fn) => {
      const name = getFunctionName(fn);
      if (name === "profiles:validate") return "me";
      if (name === "profiles:prefsOf") return { audioLang: "eng" };
      // Since sources come from each profile's addons: this profile's stream addons and the cache scope they make.
      if (name === "addons:originOf") return { addons: [], scope: "controlled~none" };
      throw Error(name);
    },
    // A cached list: the claim hands it back without fetching.
    runMutation: async (fn) => {
      const name = getFunctionName(fn);
      if (name === "sources:claimList") return { items };
      throw Error(name);
    },
  };
  const legacy = await sources.list._handler(ctx, { token: "controlled", type: "series", videoId: "tt123:1:2" });
  const ranked = await sources.listRanked._handler(ctx, { token: "controlled", type: "series", videoId: "tt123:1:2" });
  assert.ok(Array.isArray(legacy)); assert.equal(legacy.length, 1);
  assert.equal(ranked.options.length, 1);
  assert.ok(!JSON.stringify([legacy, ranked]).includes("secret"));
});
await check("ranking recognizes the wrong episode and excessive 4K bitrate", async () => {
  assert.equal(rank.mismatchOf("Example.S01E03.mkv", { type: "series", season: 1, episode: 2 }), "Episode 3");
  assert.equal(rank.mismatchOf("Example.S01E02.mkv", { type: "series", season: 1, episode: 2 }), undefined);
  assert.equal(rank.speedOf({ resolution: "2160p", bitrate: 99 }), "buffer");
  assert.equal(rank.speedOf({ resolution: "2160p", bitrate: 23 }), "smooth");
});
console.log(`${checks} focused integration checks passed. These use controlled data, not real playback.`);
