// The stream pipeline without a browser: a wrong QA password is refused, sources list without leaking URLs, a room
// prepares a stream, and its proxied playlist loads (and refuses a bad token). Needs a *-QA-* profile on the dev
// backend (real TorBox streams); refuses production.
// Usage: KRIDA_QA_PASSWORD=… node scripts/e2e-backend.mjs <movie|series> <videoId> [profile]
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import { checks, convexSignIn, convexUrls, qaProfiles } from "./lib/qa.ts";

const [type, videoId, name] = process.argv.slice(2);
if (!type || !videoId) throw new Error("Usage: node scripts/e2e-backend.mjs <movie|series> <videoId> [profile]");
const { url, siteUrl: site } = convexUrls();
if (!site) throw new Error("Set CONVEX_SITE with CONVEX_URL: the playlist is served from the backend's site URL.");
const c = new ConvexHttpClient(url); const api = anyApi;
const [profile] = qaProfiles([name]);
const { check, finish } = checks();
const bad = await c.mutation(api.profiles.qaSignIn, { name: profile.name, password: "wrong" });
check("a wrong password is refused", !bad.ok && !bad.token, JSON.stringify(bad));
const { token } = await convexSignIn(c, profile);
let t = Date.now();
const sources = await c.action(api.sources.list, { token, type, videoId });
console.log("sources", sources.length, "in", Date.now()-t, "ms; first:", JSON.stringify(sources[0]));
check("sources don't leak stream URLs", !JSON.stringify(sources).includes("playback") && !JSON.stringify(sources).includes("stremio/"));
t = Date.now();
const imdbId = videoId.split(":")[0];
const roomId = await c.mutation(api.rooms.create, { token, media: { type, imdbId, videoId, name: "test" } });
let room, last;
while (true) {
  room = await c.query(api.rooms.get, { token, roomId });
  if (room.step !== last) { console.log(`  ${((Date.now()-t)/1000).toFixed(1)}s ${room.status} ${room.step ?? ""}`); last = room.step; }
  if (room.status === "ready" || room.status === "error") break;
  await new Promise(r=>setTimeout(r,500));
}
console.log("room", room.status, room.error ?? "", JSON.stringify(room.source), "audios", room.stream?.audios?.map(a=>a.language).join(","), "duration", room.stream?.duration);
check("the room prepares a stream", room.status === "ready", room.error ?? "");
if (room.status === "ready") {
  const a = Math.max(0, room.stream.audios.findIndex(x=>x.language==="eng"));
  const pl = `${site}/hls/playlist.m3u8?s=${room.stream._id}&a=${a}&t=${token}`;
  const res = await fetch(pl); const text = await res.text();
  const segments = text.split("\n").filter(l=>l&&!l.startsWith("#"));
  check("the proxied playlist loads", res.ok && segments.length > 0, `${res.status} ${res.headers.get("content-type")}, ${segments.length} segments`);
  if (process.env.TORBOX_API_KEY) check("the playlist doesn't leak the TorBox key", !text.includes(process.env.TORBOX_API_KEY));
  else console.log("set TORBOX_API_KEY to check the playlist doesn't leak it");
  console.log("first seg:", segments[0]?.replace(/stream\/[^/]+/,"stream/<pt>"));
  const noauth = await fetch(`${site}/hls/playlist.m3u8?s=${room.stream._id}&a=0&t=nope`);
  check("a bad token can't load the playlist", noauth.status === 401, String(noauth.status));
}

await c.mutation(api.rooms.leave, { token, roomId });
await c.mutation(api.profiles.signOut, { token });
finish();
