import { ConvexError } from "convex/values";
import { type MutationCtx, type QueryCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { kindOf, type Screen } from "./rank";
import { hasTorBox } from "./accounts";
import { removeProfile } from "./profiles";

type Media = NonNullable<Doc<"rooms">["media"]>;

export const CLOSE_GRACE_MS = 30_000;

/** A party nobody has touched for this long no longer counts as the one you're in. */
export const PARTY_TTL_MS = 12 * 60 * 60 * 1000;

/** Heartbeats arrive every 5–10 s; anyone silent for longer than this isn't "here". */
const PRESENT_MS = 20_000;

/** Gone this long without leaving (closed the tab, laptop asleep) counts as having left. */
export const AWAY_LEAVE_MS = 10 * 60 * 1000;

/** A party with nobody watching or in the lobby for this long ends. */
export const IDLE_CLOSE_MS = 30 * 60 * 1000;

/** How long a switch request waits for an answer. */
export const SWITCH_TTL_MS = 30_000;

/** Everyone's in for a suggestion: this long to cancel before it starts. */
const START_DELAY_MS = 3_000;

/** Housekeeping (invites, people who left without leaving, idle parties) runs this often while a room is open. */
const SWEEP_EVERY_MS = 2 * 60 * 1000;

export const SUGGESTION_LIMIT = 20;

export const QUEUE_LIMIT = 50;

/** The binge group someone picked earlier in this room, if `media` is an episode of the same show. */
export const bingeFor = (room: Pick<Doc<"rooms">, "binge">, media: Media) =>
  media.type === "series" && room.binge?.show === media.imdbId ? room.binge.group : undefined;

export async function getRoomOrThrow(ctx: MutationCtx, roomId: Id<"rooms">) {
  const room = await ctx.db.get(roomId);
  if (!room || room.closedAt) throw new ConvexError({ code: "NOT_FOUND", message: "This party has ended" });
  return room;
}

export async function memberRow(ctx: QueryCtx, roomId: Id<"rooms">, profileId: Id<"profiles">) {
  return await ctx.db
    .query("roomMembers")
    .withIndex("by_room_profile", (q) => q.eq("roomId", roomId).eq("profileId", profileId))
    .first();
}

export function removedFromParty() {
  return new ConvexError({ code: "FORBIDDEN", message: "The host removed you from this party" });
}

/**
 * Reading or acting on a room takes having joined it. Any row counts, left or swept: a laptop waking may send a
 * pause before its heartbeat puts it back. Not one the host kicked.
 */
export async function requireMember(ctx: QueryCtx, roomId: Id<"rooms">, profileId: Id<"profiles">) {
  const member = await memberRow(ctx, roomId, profileId);
  if (!member) throw new ConvexError({ code: "FORBIDDEN", message: "You're not in this party" });
  if (member.kicked) throw removedFromParty();
  return member;
}

/** A temporary guest whose 24 hours are up: out of every room at once, before expireTemporary removes them. */
export const expired = (profile: Doc<"profiles">, now = Date.now()) => profile.expiresAt !== undefined && profile.expiresAt <= now;

/**
 * Who may join a room: its host's account, anyone with its invite link or an invite, and anyone who was in it before.
 * Never someone the host removed, and a guest only into the room its link was for.
 */
export async function requireMayJoin(ctx: QueryCtx, room: Doc<"rooms">, profile: Doc<"profiles">, code?: string) {
  await requireGuestRoom(ctx, profile, room._id);
  const row = await memberRow(ctx, room._id, profile._id);
  if (row?.kicked) throw removedFromParty();
  if (row || isGuest(profile)) return;
  if (profile.accountId && profile.accountId === (await hostAccount(ctx, room))) return;
  if (code && room.linkCode && safeCodeEqual(code, room.linkCode)) return;
  const invites = await ctx.db.query("invites").withIndex("by_room", (q) => q.eq("roomId", room._id)).collect();
  const invited = invites.some((i) =>
    i.kind === "knock" ? i.fromId === profile._id && i.status === "accepted" : i.toId === profile._id && (i.status === "pending" || i.status === "accepted"));
  if (!invited) throw new ConvexError({ code: "FORBIDDEN", message: "Ask the host for this party's link" });
}

const safeCodeEqual = (a: string, b: string) => a.length === b.length && [...a].every((c, i) => c === b[i]);

/** The account the room's host is in (rooms from before accounts don't say). */
export async function hostAccount(ctx: QueryCtx, room: Doc<"rooms">) {
  return room.hostAccountId ?? (await ctx.db.get(room.hostId))?.accountId;
}

/** A guest from a one-use link (a temporary profile) watches only in the party they were invited to. */
export function isGuest(profile: Doc<"profiles">) {
  return profile.expiresAt !== undefined;
}

export function guestOnly() {
  return new ConvexError({ code: "FORBIDDEN", message: "Guests can only watch in the party they were invited to" });
}

export async function requireGuestRoom(ctx: QueryCtx, profile: Doc<"profiles">, roomId: Id<"rooms">) {
  if (!isGuest(profile)) return;
  const invites = await ctx.db
    .query("temporaryInvites")
    .withIndex("by_room", (q) => q.eq("roomId", roomId))
    .collect();
  if (!invites.some((i) => i.profileId === profile._id)) throw guestOnly();
}

/** Where playback is right now, from the room's last anchor. */
export function currentPosition(room: Doc<"rooms">, now = Date.now()) {
  const p = room.playback;
  return p.playing ? p.position + (now - p.anchorAt) / 1000 : p.position;
}

export function mediaTitle(media: Media) {
  return media.season !== undefined && media.episode !== undefined
    ? `${media.name} S${media.season} E${media.episode}`
    : media.name;
}

export async function upsertMember(
  ctx: MutationCtx,
  roomId: Id<"rooms">,
  profileId: Id<"profiles">,
  watching = true,
  screen?: Screen,
) {
  const now = Date.now();
  const member = await ctx.db
    .query("roomMembers")
    .withIndex("by_room_profile", (q) => q.eq("roomId", roomId).eq("profileId", profileId))
    .first();
  if (member)
    await ctx.db.patch(member._id, { left: false, swept: false, lastSeenAt: now, watching, ...(screen ? { screen } : {}) });
  else
    await ctx.db.insert("roomMembers", {
      roomId,
      profileId,
      joinedAt: now,
      lastSeenAt: now,
      buffering: false,
      position: 0,
      watching,
      left: false,
      screen,
    });
}

/**
 * Someone leaving a party behind for good: leave every other party they're still in. A room they're watching
 * alone (on the TV, say, while the phone joins a party) carries on. A party they host goes to someone else, or ends.
 */
export async function leaveOtherParties(ctx: MutationCtx, profileId: Id<"profiles">, keep: Id<"rooms">) {
  // Nothing deletes memberships, so only recent ones are read. Anyone silent for AWAY_LEAVE_MS is swept out, and a
  // swept row silent for PARTY_TTL_MS no longer comes back (heartbeat), so older rows are out for good.
  const memberships = await ctx.db
    .query("roomMembers")
    .withIndex("by_profile", (q) => q.eq("profileId", profileId).gt("lastSeenAt", Date.now() - PARTY_TTL_MS))
    .collect();
  for (const m of memberships) {
    // A row the sweep counted out is still one heartbeat from being back in: it needs leaving too.
    if (m.roomId === keep || (m.left && !m.swept)) continue;
    if ((await ctx.db.get(m.roomId))?.kind !== "party") continue;
    await ctx.db.patch(m._id, { left: true, watching: false, swept: false });
    const room = await ctx.db.get(m.roomId);
    const rows = await ctx.db.query("roomMembers").withIndex("by_room", (q) => q.eq("roomId", m.roomId)).collect();
    const stillHere = rows.filter((r) => r.profileId !== profileId && !r.left);
    if (room && !room.closedAt && room.hostId === profileId && stillHere.length > 0) await handOff(ctx, room, stillHere);
    else if (!m.left) await ctx.scheduler.runAfter(CLOSE_GRACE_MS, internal.rooms.closeIfEmpty, { roomId: m.roomId });
  }
}

/**
 * The host is gone while others are still here. The room plays the host's account's TorBox, so it goes to whoever
 * joined first among those whose account has TorBox, someone of the host's own account before anyone else; a guest
 * never hosts. With nobody like that, the party ends for everyone rather than play on without a host.
 */
export async function handOff(ctx: MutationCtx, room: Doc<"rooms">, remaining: Doc<"roomMembers">[]) {
  const from = await hostAccount(ctx, room);
  const candidates = [];
  for (const m of [...remaining].sort((a, b) => a.joinedAt - b.joinedAt)) {
    const profile = await ctx.db.get(m.profileId);
    if (!profile || profile._id === room.hostId || isGuest(profile) || m.kicked) continue;
    if (await hasTorBox(ctx, profile.accountId)) candidates.push(profile);
  }
  const next = candidates.find((p) => p.accountId === from) ?? candidates[0];
  if (!next) return await closeRoom(ctx, room);
  await ctx.db.patch(room._id, { hostId: next._id, hostAccountId: next.accountId });
  if (room.kind === "party") await event(ctx, room._id, next._id, "is the host now");
}

/**
 * A friend dropped into a solo room and has gone again: with only the host left and nobody invited, it's watching
 * alone again, so it no longer shows as a party or outlives the host walking away.
 */
export async function backToSoloIfAlone(ctx: MutationCtx, roomId: Id<"rooms">, stillHere: Doc<"roomMembers">[]) {
  const room = await ctx.db.get(roomId);
  if (!room?.startedSolo || room.kind !== "party") return;
  if (stillHere.length !== 1 || stillHere[0].profileId !== room.hostId) return;
  const invites = await ctx.db
    .query("invites")
    .withIndex("by_room", (q) => q.eq("roomId", roomId))
    .collect();
  if (invites.some((i) => i.status === "pending" && i.kind !== "knock")) return;
  await ctx.db.patch(roomId, { kind: "solo" });
}

export async function event(ctx: MutationCtx, roomId: Id<"rooms">, profileId: Id<"profiles">, body: string) {
  await ctx.db.insert("messages", { roomId, profileId, kind: "event", body, createdAt: Date.now() });
}

/** Members who are in the room right now (lobby or player), not browsing elsewhere or gone. */
export async function presentMembers(ctx: MutationCtx, roomId: Id<"rooms">) {
  const now = Date.now();
  const rows = await ctx.db
    .query("roomMembers")
    .withIndex("by_room", (q) => q.eq("roomId", roomId))
    .collect();
  return rows.filter((m) => !m.left && (m.watching ?? true) && now - m.lastSeenAt < PRESENT_MS);
}

/**
 * Nobody but `by` is in the player: stop the shared clock, so whoever comes back carries on from where it was left
 * instead of minutes later. `since` is when `by` stopped watching, at most the presence window ago. Returns whether
 * it stopped.
 */
export async function pauseIfNobodyWatching(ctx: MutationCtx, room: Doc<"rooms">, by: Id<"profiles">, since: number) {
  if (!room.playback.playing) return false;
  const others = (await presentMembers(ctx, room._id)).filter((m) => m.profileId !== by);
  if (others.length > 0) return false;
  const now = Date.now();
  const at = Math.max(since, room.playback.anchorAt, now - PRESENT_MS);
  await ctx.db.patch(room._id, {
    playback: { playing: false, position: currentPosition(room, at), anchorAt: now, seq: room.playback.seq + 1, action: "pause", by },
  });
  return true;
}

/**
 * The screen to pick a stream for: SDR if anyone here, or whoever asked, is on one. An SDR picture looks right on
 * an HDR screen; an HDR one comes out dark on SDR. The app's pick only when everyone is in Krida for Windows, since
 * a browser plays the same file through TorBox's conversion. Unknown when nobody has said (older tabs).
 */
export async function screenFor(ctx: MutationCtx, roomId: Id<"rooms">, by?: Id<"profiles">): Promise<Screen | undefined> {
  const now = Date.now();
  const rows = await ctx.db
    .query("roomMembers")
    .withIndex("by_room", (q) => q.eq("roomId", roomId))
    .collect();
  const screens = rows
    .filter((m) => m.profileId === by || (!m.left && (m.watching ?? true) && now - m.lastSeenAt < PRESENT_MS))
    .map((m) => m.screen);
  if (screens.includes("sdr")) return "sdr";
  if (screens.includes("hdr")) return "hdr";
  return screens.length > 0 && screens.every((s) => s === "app") ? "app" : undefined;
}

/** End a room: everyone out, pending invites cancelled, its link and its guests' links dead, its guests gone. */
export async function closeRoom(ctx: MutationCtx, room: Doc<"rooms">) {
  const now = Date.now();
  await ctx.db.patch(room._id, {
    closedAt: now,
    linkCode: undefined,
    starting: undefined,
    switchRequest: undefined,
    playback: { ...room.playback, playing: false, position: currentPosition(room, now), anchorAt: now },
  });
  const members = await ctx.db
    .query("roomMembers")
    .withIndex("by_room", (q) => q.eq("roomId", room._id))
    .collect();
  // Swept rows too: a room opened again within the grace period mustn't take back a laptop that wakes later.
  for (const m of members) if (!m.left || m.swept) await ctx.db.patch(m._id, { left: true, watching: false, swept: false });
  const invites = await ctx.db
    .query("invites")
    .withIndex("by_room", (q) => q.eq("roomId", room._id))
    .collect();
  for (const i of invites) if (i.status === "pending") await ctx.db.patch(i._id, { status: "cancelled" });
  // A guest exists for this party only.
  for (const invite of await ctx.db.query("temporaryInvites").withIndex("by_room", (q) => q.eq("roomId", room._id)).collect()) {
    if (invite.profileId) await removeProfile(ctx, invite.profileId);
    await ctx.db.delete(invite._id);
  }
}

/**
 * When everyone in the room is in for one suggestion, start a short countdown. Anyone can cancel it;
 * otherwise `startSuggestion` puts it on.
 */
export async function maybeStart(ctx: MutationCtx, roomId: Id<"rooms">) {
  const room = await ctx.db.get(roomId);
  // Only from the lobby: a vote can never cut into something that's playing.
  if (!room || room.closedAt || room.starting || room.status !== "idle") return;
  const present = await presentMembers(ctx, roomId);
  // Alone, there's nobody to agree with: Play now is the way.
  if (present.length < 2) return;
  const ready = (room.suggestions ?? []).find((s) => present.every((m) => s.inIds.includes(m.profileId)));
  if (!ready) return;
  const at = Date.now() + START_DELAY_MS;
  await ctx.db.patch(roomId, { starting: { suggestionId: ready.id, at } });
  await ctx.scheduler.runAfter(START_DELAY_MS, internal.rooms.startSuggestion, { roomId, suggestionId: ready.id, at });
}

export async function startJob(
  ctx: MutationCtx,
  room: Doc<"rooms">,
  args: { index?: number; key?: string; startAt: number; media?: Media; by: Id<"profiles">; autoStreak?: number },
) {
  const media = args.media ?? room.media;
  if (!media) throw new ConvexError({ code: "INVALID", message: "Pick something to watch first" });
  const jobId = (room.jobId ?? 0) + 1;
  const now = Date.now();
  const switching = !!args.media && args.media.videoId !== room.media?.videoId;
  const lastKind = args.index === undefined && args.key === undefined ? await lastSourceOf(ctx, args.by, room, media) : undefined;
  await ctx.db.patch(room._id, {
    ...(lastKind ? { binge: lastKind } : {}),
    ...(args.media ? { media: args.media, streamId: undefined, source: undefined, sourceIndex: undefined } : {}),
    // A new title settles whatever was pending about the old one.
    ...(switching
      ? {
          stopAfter: undefined,
          credits: undefined,
          suggestions: (room.suggestions ?? []).filter((s) => s.media.videoId !== media.videoId),
        }
      : {}),
    queue: (room.queue ?? []).filter((q) => q.media.videoId !== media.videoId),
    next: room.next?.media.videoId === media.videoId
      ? (room.queue ?? []).find((q) => q.media.videoId !== media.videoId)
      : room.next,
    starting: undefined,
    switchRequest: undefined,
    status: "preparing",
    step: "Finding sources…",
    stepNote: undefined,
    error: undefined,
    errorDetail: undefined,
    sourceFallback: undefined,
    jobId,
    requestedBy: args.by,
    autoStreak: args.autoStreak ?? 0,
    lastActiveAt: now,
    playback: {
      ...room.playback,
      playing: false,
      position: args.startAt,
      anchorAt: now,
      seq: room.playback.seq + 1,
      action: "preparing",
      by: args.by,
    },
  });
  await ctx.scheduler.runAfter(0, internal.engine.prepare, {
    roomId: room._id,
    jobId,
    index: args.index,
    key: args.key,
    startAt: args.startAt,
    screen: await screenFor(ctx, room._id, args.by),
  });
}

/**
 * With "Reuse the last source" on, the kind of file the profile last played of this show (`lastSources`), for the
 * room's binge group, unless the room already keeps to one for it. Episodes only.
 */
async function lastSourceOf(ctx: MutationCtx, profileId: Id<"profiles">, room: Doc<"rooms">, media: Media) {
  if (media.type !== "series" || bingeFor(room, media)) return undefined;
  const profile = await ctx.db.get(profileId);
  if (!profile?.prefs.reuseSource) return undefined;
  const row = await ctx.db
    .query("lastSources")
    .withIndex("by_profile_show", (q) => q.eq("profileId", profileId).eq("show", media.imdbId))
    .unique();
  return row ? { show: media.imdbId, group: row.group } : undefined;
}

/** Keeps the kind of file a profile just started on a show's episode, for "Reuse the last source". */
export async function rememberSource(
  ctx: MutationCtx,
  profileId: Id<"profiles"> | undefined,
  media: Media | undefined,
  source: { bingeGroup?: string; filename?: string; resolution?: string },
) {
  const group = kindOf(source);
  if (!profileId || media?.type !== "series" || !group) return;
  const row = await ctx.db
    .query("lastSources")
    .withIndex("by_profile_show", (q) => q.eq("profileId", profileId).eq("show", media.imdbId))
    .unique();
  if (row) await ctx.db.patch(row._id, { group, at: Date.now() });
  else await ctx.db.insert("lastSources", { profileId, show: media.imdbId, group, at: Date.now() });
}

/**
 * Books the next sweep unless one is waiting. Sweeps book themselves while any room is open, so a deployment
 * with no rooms (most previews, most of the day) runs none; a cron every 15 minutes picks up anything missed.
 */
export async function bookSweep(ctx: MutationCtx) {
  const row = await ctx.db.query("jobs").withIndex("by_name", (q) => q.eq("name", "sweep")).first();
  const job = row?.jobId ? await ctx.db.system.get(row.jobId) : null;
  if (job?.state.kind === "pending") return;
  const jobId = await ctx.scheduler.runAfter(SWEEP_EVERY_MS, internal.rooms.sweep, {});
  if (row) await ctx.db.patch(row._id, { jobId });
  else await ctx.db.insert("jobs", { name: "sweep", jobId });
}

export async function newRoom(
  ctx: MutationCtx,
  host: Doc<"profiles">,
  kind: "solo" | "party",
  media: Media | undefined,
) {
  const now = Date.now();
  await bookSweep(ctx);
  return await ctx.db.insert("rooms", {
    hostId: host._id,
    hostAccountId: host.accountId,
    kind,
    media,
    status: media ? "choosing" : "idle",
    playback: { playing: false, position: 0, anchorAt: now, seq: 0 },
    createdAt: now,
    lastActiveAt: now,
    jobId: 0,
  });
}
