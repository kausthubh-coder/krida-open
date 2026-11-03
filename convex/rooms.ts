import { ConvexError, v } from "convex/values";
import { internalQuery, query } from "./_generated/server";
import { internalMutation, mutation } from "./functions";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { profileFromToken, publicProfile, randomHex, requireProfile } from "./lib/auth";
import { hasDebrid, hasTorBox, keysRow, needsTorBox, playNeedsDebrid } from "./lib/accounts";
import { removeProfile } from "./lib/profiles";
import { mediaValidator, screenValidator, sourceFallbackValidator, sourceSummaryValidator, suggestionValidator } from "./schema";
import { INVITE_TTL_MS } from "./invites";
import { AWAY_LEAVE_MS, CLOSE_GRACE_MS, IDLE_CLOSE_MS, PARTY_TTL_MS, QUEUE_LIMIT, SUGGESTION_LIMIT, SWITCH_TTL_MS, backToSoloIfAlone, bookSweep, closeRoom, currentPosition, event, expired, getRoomOrThrow, bingeFor, guestOnly, handOff, hostAccount, isGuest, leaveOtherParties, maybeStart, mediaTitle, memberRow, newRoom, pauseIfNobodyWatching, presentMembers, rememberSource, requireMayJoin, requireMember, screenFor, startJob, upsertMember } from "./lib/rooms";

/** Press Play outside a party: a room just for you, which a friend can still join. */
export const create = mutation({
  args: {
    token: v.string(),
    media: mediaValidator,
    startAt: v.optional(v.number()),
    sourceIndex: v.optional(v.number()),
    // The picked source's key; positions shift when the list is fetched again.
    sourceKey: v.optional(v.string()),
    screen: v.optional(screenValidator),
  },
  handler: async (ctx, { token, media, startAt = 0, sourceIndex, sourceKey, screen }) => {
    const profile = await requireProfile(ctx, token);
    if (isGuest(profile)) throw guestOnly();
    // The stream comes from the account's debrid service: without one, say so now rather than fail once the job runs.
    if (!(await hasDebrid(ctx, profile.accountId))) throw playNeedsDebrid();
    const roomId = await newRoom(ctx, profile, "solo", media);
    await upsertMember(ctx, roomId, profile._id, true, screen);
    await startJob(ctx, (await ctx.db.get(roomId))!, { index: sourceIndex, key: sourceKey, startAt, by: profile._id });
    return roomId;
  },
});

/**
 * A watch party: starts empty or with something picked, and invites profiles of the host's account (anyone else
 * joins through its link, `shareLink`). Everyone watches the host's TorBox stream, so the host's account needs TorBox.
 */
export const createParty = mutation({
  args: {
    token: v.string(),
    media: v.optional(mediaValidator),
    startAt: v.optional(v.number()),
    inviteIds: v.array(v.id("profiles")),
    screen: v.optional(screenValidator),
  },
  handler: async (ctx, { token, media, startAt = 0, inviteIds, screen }) => {
    const profile = await requireProfile(ctx, token);
    if (isGuest(profile)) throw guestOnly();
    if (!(await hasTorBox(ctx, profile.accountId))) throw needsTorBox();
    const roomId = await newRoom(ctx, profile, "party", media);
    await leaveOtherParties(ctx, profile._id, roomId);
    await upsertMember(ctx, roomId, profile._id, true, screen);
    await event(ctx, roomId, profile._id, "started the party");
    if (media) await startJob(ctx, (await ctx.db.get(roomId))!, { startAt, by: profile._id });
    const now = Date.now();
    for (const toId of new Set(inviteIds)) {
      if (toId === profile._id || (await ctx.db.get(toId))?.accountId !== profile.accountId) continue;
      await ctx.db.insert("invites", { roomId, fromId: profile._id, toId, status: "pending", createdAt: now });
    }
    return roomId;
  },
});

/** The room, for its members only: whoever isn't in it (or was removed) gets FORBIDDEN, not its people or its chat. */
export const get = query({
  args: { token: v.string(), roomId: v.id("rooms") },
  handler: async (ctx, { token, roomId }) => {
    const me = await requireProfile(ctx, token);
    const room = await ctx.db.get(roomId);
    if (!room) return null;
    await requireMember(ctx, roomId, me._id);
    const memberRows = await ctx.db
      .query("roomMembers")
      .withIndex("by_room", (q) => q.eq("roomId", roomId))
      .collect();
    const members = [];
    for (const m of memberRows) {
      if (m.left) continue;
      const profile = await ctx.db.get(m.profileId);
      if (!profile || expired(profile)) continue;
      members.push({
        ...publicProfile(profile),
        lastSeenAt: m.lastSeenAt,
        buffering: m.buffering,
        watching: m.watching ?? true,
        position: m.position,
        isMe: profile._id === me._id,
        // In a party, a skip moves everyone, so it only happens when everyone has it on.
        auto: {
          skipIntro: profile.prefs.skipIntro ?? true,
          skipRecap: profile.prefs.skipRecap ?? true,
          autoNext: profile.prefs.autoNext ?? true,
        },
      });
    }
    const stream = room.streamId ? await ctx.db.get(room.streamId) : null;
    // Whether this profile may have the stream's own file (desktop.fileLink): the app plays it in mpv, and a direct
    // stream's file is the only way to play it. A guest from another account plays the room's HLS instead.
    const ownFile =
      !!stream && !!me.accountId && stream.accountId === me.accountId &&
      (!!stream.direct || (await keysRow(ctx, me.accountId))?.debrid?.service === "torbox");
    return {
      _id: room._id,
      kind: room.kind ?? "solo",
      hostId: room.hostId,
      media: room.media,
      queue: room.queue ?? [],
      next: room.next ?? room.queue?.[0],
      suggestions: room.suggestions ?? [],
      starting: room.starting,
      switchRequest: room.switchRequest,
      stopAfter: room.stopAfter,
      credits: room.credits,
      requestedBy: room.requestedBy,
      status: room.status,
      step: room.step,
      stepNote: room.stepNote,
      error: room.error,
      errorDetail: room.errorDetail,
      sourceFallback: room.sourceFallback,
      source: room.source,
      sourceIndex: room.sourceIndex,
      sourceKey: stream?.sourceKey,
      // The binge group the next episodes try first, so the player warms them again after a pick.
      binge: room.binge?.group,
      playback: room.playback,
      autoStreak: room.autoStreak ?? 0,
      closedAt: room.closedAt,
      members,
      stream: stream
        ? {
            _id: stream._id,
            duration: stream.duration,
            width: stream.width,
            height: stream.height,
            videoCodec: stream.videoCodec,
            size: stream.size,
            osHash: stream.osHash,
            intro: stream.intro,
            recap: stream.recap,
            outro: stream.outro,
            audios: stream.audios,
            subtitles: stream.subtitles ?? [],
            // Another debrid service's file, played as it is: what it's stored in and its sound, never its link.
            direct: stream.direct ? { container: stream.direct.container, audio: stream.direct.audio ?? [] } : undefined,
            ownFile,
          }
        : null,
    };
  },
});

/**
 * Join a room: from its host's account, with its invite link (`code`), with an invite, or back into one you were in
 * (requireMayJoin).
 */
export const join = mutation({
  args: { token: v.string(), roomId: v.id("rooms"), code: v.optional(v.string()) },
  handler: async (ctx, { token, roomId, code }) => {
    const profile = await requireProfile(ctx, token);
    const room = await ctx.db.get(roomId);
    if (!room) throw new ConvexError({ code: "NOT_FOUND", message: "This party doesn’t exist" });
    const ended = new ConvexError({ code: "NOT_FOUND", message: "This party has ended" });
    // The host coming back to a room that emptied out a moment ago reopens it; an old link to a long-ended party
    // doesn't (it would pull you out of the one you're in now), and nobody else reopens it without its host.
    if (room.closedAt && (profile._id !== room.hostId || Date.now() - room.closedAt > 2 * CLOSE_GRACE_MS)) throw ended;
    // The host left alone a moment ago and the room is about to close: there's nobody to watch with.
    if (!room.closedAt && profile._id !== room.hostId && (await memberRow(ctx, roomId, room.hostId))?.left) throw ended;
    await requireMayJoin(ctx, room, profile, code);
    if (room.closedAt) {
      await ctx.db.patch(roomId, { closedAt: undefined });
      await bookSweep(ctx);
    }
    const existing = await ctx.db
      .query("roomMembers")
      .withIndex("by_room_profile", (q) => q.eq("roomId", roomId).eq("profileId", profile._id))
      .first();
    const isNew = !existing || existing.left;
    await upsertMember(ctx, roomId, profile._id);
    // Someone dropping into a solo room turns it into a party, until the host is alone in it again.
    const kind = room.kind === "party" || profile._id !== room.hostId ? "party" : "solo";
    if (kind === "party") await leaveOtherParties(ctx, profile._id, roomId);
    const startedSolo = room.kind !== "party" && kind === "party";
    await ctx.db.patch(roomId, { kind, lastActiveAt: Date.now(), ...(startedSolo ? { startedSolo } : {}) });
    if (isNew && profile._id !== room.hostId) await event(ctx, roomId, profile._id, "joined");
    const invites = await ctx.db
      .query("invites")
      .withIndex("by_room", (q) => q.eq("roomId", roomId))
      .collect();
    for (const i of invites) {
      if (i.toId === profile._id && i.status === "pending") await ctx.db.patch(i._id, { status: "accepted" });
    }
  },
});

export const leave = mutation({
  args: { token: v.string(), roomId: v.id("rooms"), announce: v.optional(v.boolean()) },
  handler: async (ctx, { token, roomId, announce }) => {
    const profile = await requireProfile(ctx, token);
    const room = await ctx.db.get(roomId);
    if (!room || room.closedAt) return;
    const members = await ctx.db
      .query("roomMembers")
      .withIndex("by_room", (q) => q.eq("roomId", roomId))
      .collect();
    if (!members.some((m) => m.profileId === profile._id)) return;
    // Leaving on purpose, so a laptop the sweep counted out doesn't bring them back when it wakes.
    for (const m of members) if (m.profileId === profile._id) await ctx.db.patch(m._id, { left: true, watching: false, swept: false });
    if (announce) await event(ctx, roomId, profile._id, "left the party");
    const stillHere = members.filter((m) => m.profileId !== profile._id && !m.left);
    if (room.hostId === profile._id && stillHere.length > 0) {
      await handOff(ctx, room, stillHere);
      if ((await ctx.db.get(roomId))?.closedAt) return;
    }
    if (room.startedSolo) await backToSoloIfAlone(ctx, roomId, stillHere);
    if (stillHere.length === 0) {
      // A refresh or a quick back-and-forth shouldn't end the room; close it only if nobody returns.
      await ctx.scheduler.runAfter(CLOSE_GRACE_MS, internal.rooms.closeIfEmpty, { roomId });
    } else if (room.playback.playing && !(await pauseIfNobodyWatching(ctx, room, profile._id, Date.now()))) {
      // Re-anchor the shared clock where it is, so nobody's position jumps when one person leaves.
      await ctx.db.patch(roomId, {
        playback: { ...room.playback, position: currentPosition(room), anchorAt: Date.now() },
      });
    }
  },
});

export const closeIfEmpty = internalMutation({
  args: { roomId: v.id("rooms") },
  handler: async (ctx, { roomId }) => {
    const room = await ctx.db.get(roomId);
    if (!room || room.closedAt) return;
    const members = await ctx.db
      .query("roomMembers")
      .withIndex("by_room", (q) => q.eq("roomId", roomId))
      .collect();
    if (members.some((m) => !m.left)) return;
    await closeRoom(ctx, room);
  },
});

/**
 * Every minute: people gone for 10 minutes without leaving are counted as left, invites past their
 * time expire, and rooms nobody has watched in for 30 minutes end.
 */
export const sweep = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    // Open rooms only: this runs every minute, and closed ones are most of the table.
    const rooms = await ctx.db
      .query("rooms")
      .withIndex("by_open", (q) => q.eq("closedAt", undefined))
      .collect();
    for (const room of rooms) {
      const invites = await ctx.db
        .query("invites")
        .withIndex("by_room", (q) => q.eq("roomId", room._id))
        .collect();
      for (const i of invites) {
        if (i.status === "pending" && now - i.createdAt > INVITE_TTL_MS) await ctx.db.patch(i._id, { status: "expired" });
      }
      const members = await ctx.db
        .query("roomMembers")
        .withIndex("by_room", (q) => q.eq("roomId", room._id))
        .collect();
      for (const m of members) {
        if (m.left) continue;
        if (now - m.lastSeenAt > AWAY_LEAVE_MS) {
          await ctx.db.patch(m._id, { left: true, watching: false, swept: true });
          if (room.kind === "party") await event(ctx, room._id, m.profileId, "left the party");
        }
      }
      if (now - room.lastActiveAt > IDLE_CLOSE_MS) {
        await closeRoom(ctx, room);
        continue;
      }
      const stillHere = members.filter((m) => !m.left && now - m.lastSeenAt <= AWAY_LEAVE_MS);
      if (stillHere.length > 0 && !stillHere.some((m) => m.profileId === room.hostId)) {
        await handOff(ctx, room, stillHere);
        if ((await ctx.db.get(room._id))?.closedAt) continue;
      }
      if (room.startedSolo) await backToSoloIfAlone(ctx, room._id, stillHere);
    }
    // Rooms still open: come back. None: nothing runs until the next one opens.
    if (rooms.some((r) => !(now - r.lastActiveAt > IDLE_CLOSE_MS))) await bookSweep(ctx);
  },
});

export const heartbeat = mutation({
  args: {
    token: v.string(),
    roomId: v.id("rooms"),
    position: v.optional(v.number()),
    buffering: v.optional(v.boolean()),
    // Optional so tabs still running the previous version keep their presence.
    watching: v.optional(v.boolean()),
    screen: v.optional(screenValidator),
  },
  handler: async (ctx, { token, roomId, position, buffering, watching = true, screen }) => {
    const profile = await requireProfile(ctx, token);
    const member = await ctx.db
      .query("roomMembers")
      .withIndex("by_room_profile", (q) => q.eq("roomId", roomId).eq("profileId", profile._id))
      .first();
    if (!member || member.kicked) return;
    const now = Date.now();
    if (member.left) {
      // Pressed Leave: stay out. Counted as gone by the sweep (laptop asleep): back in, if the party's on and they
      // weren't away longer than a party lasts (leaveOtherParties doesn't look further back).
      const room = await ctx.db.get(roomId);
      if (!member.swept || !room || room.closedAt || now - member.lastSeenAt > PARTY_TTL_MS) return;
      if (room.kind === "party") await event(ctx, roomId, profile._id, "is back");
      // Back while the host is still away: someone here hosts, or the party ends.
      if (profile._id !== room.hostId && (await memberRow(ctx, roomId, room.hostId))?.left !== false) {
        await ctx.db.patch(member._id, { left: false, swept: false, lastSeenAt: now });
        const rows = await ctx.db.query("roomMembers").withIndex("by_room", (q) => q.eq("roomId", roomId)).collect();
        await handOff(ctx, room, rows.filter((r) => !r.left));
        if ((await ctx.db.get(roomId))?.closedAt) return;
      }
    }
    await ctx.db.patch(member._id, {
      left: false,
      swept: false,
      lastSeenAt: now,
      watching,
      ...(position !== undefined ? { position } : {}),
      ...(screen ? { screen } : {}),
      buffering: watching ? (buffering ?? false) : false,
    });
    // Someone in the lobby or the player keeps the party alive; browsing elsewhere doesn't.
    if (watching) {
      const room = await ctx.db.get(roomId);
      if (room && !room.closedAt && now - room.lastActiveAt > 60_000) await ctx.db.patch(roomId, { lastActiveAt: now });
      // Someone arriving in the lobby may be the last "in" a suggestion was waiting for.
      if (room && room.status === "idle" && !room.starting && (room.suggestions ?? []).length > 0) await maybeStart(ctx, roomId);
    } else if (!member.left && member.watching === false) {
      // A second beat in a row from outside the player: one alone could be a phone browsing while the same profile
      // watches on the TV, whose beats in between say watching. Nobody else in the player stops the clock.
      const room = await ctx.db.get(roomId);
      if (room && !room.closedAt) await pauseIfNobodyWatching(ctx, room, profile._id, member.lastSeenAt);
    }
  },
});

export const control = mutation({
  args: {
    token: v.string(),
    roomId: v.id("rooms"),
    playing: v.boolean(),
    position: v.number(),
    action: v.string(),
    // The title the player was showing: a late press from the one before mustn't move the next one.
    videoId: v.optional(v.string()),
    // The client's estimate of server time at the press; `position` is as of then.
    at: v.optional(v.number()),
  },
  handler: async (ctx, { token, roomId, playing, position, action, videoId, at }) => {
    const profile = await requireProfile(ctx, token);
    const room = await getRoomOrThrow(ctx, roomId);
    await requireMember(ctx, roomId, profile._id);
    if (videoId !== undefined && (videoId !== room.media?.videoId || room.status !== "ready")) return;
    const now = Date.now();
    await ctx.db.patch(roomId, {
      lastActiveAt: now,
      playback: {
        playing,
        position: Math.max(0, position),
        // Never in the future, and a slow request can't push everyone more than 3 s back.
        anchorAt: at === undefined ? now : Math.min(now, Math.max(now - 3000, at)),
        seq: room.playback.seq + 1,
        by: profile._id,
        action,
      },
      // Someone pausing or seeking is still awake; automatic skips and catching up don't count.
      ...(action === "pause" || action === "seek" ? { autoStreak: 0 } : {}),
    });
  },
});

/** Server time, for clients to measure their clock offset. A mutation so it is never cached. */
export const clock = mutation({
  args: {},
  handler: async () => Date.now(),
});

export const chooseSource = mutation({
  // `key` names the file; `index` alone is from tabs opened before keys, and can point elsewhere after a refetch.
  args: { token: v.string(), roomId: v.id("rooms"), index: v.number(), key: v.optional(v.string()) },
  handler: async (ctx, { token, roomId, index, key }) => {
    const profile = await requireProfile(ctx, token);
    const room = await getRoomOrThrow(ctx, roomId);
    await requireMember(ctx, roomId, profile._id);
    await startJob(ctx, room, { index, key, startAt: currentPosition(room), by: profile._id });
  },
});

export const retry = mutation({
  args: { token: v.string(), roomId: v.id("rooms") },
  handler: async (ctx, { token, roomId }) => {
    const profile = await requireProfile(ctx, token);
    const room = await getRoomOrThrow(ctx, roomId);
    await requireMember(ctx, roomId, profile._id);
    await startJob(ctx, room, { startAt: currentPosition(room), by: profile._id });
  },
});

/** Switch what everyone is watching. */
export const playNow = mutation({
  args: {
    token: v.string(),
    roomId: v.id("rooms"),
    media: mediaValidator,
    startAt: v.optional(v.number()),
    sourceIndex: v.optional(v.number()),
    sourceKey: v.optional(v.string()),
  },
  handler: async (ctx, { token, roomId, media, startAt = 0, sourceIndex, sourceKey }) => {
    const profile = await requireProfile(ctx, token);
    const room = await getRoomOrThrow(ctx, roomId);
    await requireMember(ctx, roomId, profile._id);
    await upsertMember(ctx, roomId, profile._id);
    await startJob(ctx, room, { media, startAt, index: sourceIndex, key: sourceKey, by: profile._id });
    if (room.kind === "party") await event(ctx, roomId, profile._id, `put on ${mediaTitle(media)}`);
  },
});

/** Kept for tabs still running the previous version (their "next episode" button). */
export const changeMedia = mutation({
  args: { token: v.string(), roomId: v.id("rooms"), media: mediaValidator, startAt: v.optional(v.number()) },
  handler: async (ctx, { token, roomId, media, startAt = 0 }) => {
    const profile = await requireProfile(ctx, token);
    const room = await getRoomOrThrow(ctx, roomId);
    await requireMember(ctx, roomId, profile._id);
    await startJob(ctx, room, { media, startAt, by: profile._id });
  },
});

/** Auto-advance when something ends. Every client may ask; only the first request for this title wins. */
export const advance = mutation({
  args: {
    token: v.string(),
    roomId: v.id("rooms"),
    fromVideoId: v.string(),
    media: mediaValidator,
    // The old multi-item Up next, for tabs opened before the single Next slot.
    queueItemId: v.optional(v.string()),
    // Started by the Up next countdown rather than a press.
    auto: v.optional(v.boolean()),
  },
  handler: async (ctx, { token, roomId, fromVideoId, media, queueItemId, auto }) => {
    const profile = await requireProfile(ctx, token);
    const room = await getRoomOrThrow(ctx, roomId);
    await requireMember(ctx, roomId, profile._id);
    if (room.media?.videoId !== fromVideoId || room.status !== "ready") return false;
    if (room.stopAfter?.videoId === fromVideoId) return false;
    if (queueItemId) await ctx.db.patch(roomId, { queue: (room.queue ?? []).filter((q) => q.id !== queueItemId) });
    await startJob(ctx, (await ctx.db.get(roomId))!, {
      media,
      startAt: 0,
      by: profile._id,
      autoStreak: auto ? (room.autoStreak ?? 0) + 1 : 0,
    });
    return true;
  },
});

/** Back to picking: stop for everyone and show the lobby. */
export const stop = mutation({
  args: { token: v.string(), roomId: v.id("rooms") },
  handler: async (ctx, { token, roomId }) => {
    const profile = await requireProfile(ctx, token);
    const room = await getRoomOrThrow(ctx, roomId);
    await requireMember(ctx, roomId, profile._id);
    const now = Date.now();
    await ctx.db.patch(roomId, {
      status: "idle",
      media: undefined,
      streamId: undefined,
      source: undefined,
      sourceIndex: undefined,
      step: undefined,
      stepNote: undefined,
      error: undefined,
      // Both: readers fall back to the legacy queue, which would bring "after this" back on the next title.
      next: undefined,
      queue: [],
      starting: undefined,
      switchRequest: undefined,
      stopAfter: undefined,
      credits: undefined,
      jobId: (room.jobId ?? 0) + 1,
      lastActiveAt: now,
      playback: { playing: false, position: 0, anchorAt: now, seq: room.playback.seq + 1, by: profile._id, action: "stop" },
    });
    await event(ctx, roomId, profile._id, "went back to picking");
    await maybeStart(ctx, roomId);
  },
});

// ---------- after this ----------

/** "Watch after this": the one thing lined up after the current title. Replaces whatever was there. */
export const setNext = mutation({
  args: { token: v.string(), roomId: v.id("rooms"), media: mediaValidator },
  handler: async (ctx, { token, roomId, media }) => {
    const profile = await requireProfile(ctx, token);
    const room = await getRoomOrThrow(ctx, roomId);
    await requireMember(ctx, roomId, profile._id);
    if (room.next?.media.videoId === media.videoId) return;
    if (room.media?.videoId === media.videoId)
      throw new ConvexError({ code: "INVALID", message: "That’s what’s on now" });
    const now = Date.now();
    const next = { id: randomHex(6), media, addedBy: profile._id, addedAt: now };
    await ctx.db.patch(roomId, {
      next,
      queue: [next],
      // Picking what comes next means you want something to come next.
      stopAfter: undefined,
      lastActiveAt: now,
    });
    // Get it ready now, so it starts at once when its turn comes.
    await ctx.scheduler.runAfter(0, internal.engine.warm, {
      media,
      profileId: profile._id,
      keysFrom: room.hostId,
      screen: await screenFor(ctx, roomId, profile._id),
      binge: bingeFor(room, media),
    });
    await event(ctx, roomId, profile._id, `lined up ${mediaTitle(media)} for after this`);
  },
});

export const clearNext = mutation({
  args: { token: v.string(), roomId: v.id("rooms") },
  handler: async (ctx, { token, roomId }) => {
    const profile = await requireProfile(ctx, token);
    await getRoomOrThrow(ctx, roomId);
    await requireMember(ctx, roomId, profile._id);
    await ctx.db.patch(roomId, { next: undefined, queue: [] });
  },
});

/** Watch credits: Up next waits for the end of this video instead of counting down over its credits, for everyone. */
export const watchCredits = mutation({
  // The video the person was watching: if it has already moved on, the click is stale.
  args: { token: v.string(), roomId: v.id("rooms"), videoId: v.string() },
  handler: async (ctx, { token, roomId, videoId }) => {
    const profile = await requireProfile(ctx, token);
    const room = await getRoomOrThrow(ctx, roomId);
    await requireMember(ctx, roomId, profile._id);
    if (room.media?.videoId !== videoId || room.credits?.videoId === videoId) return;
    await ctx.db.patch(roomId, { credits: { by: profile._id, videoId } });
  },
});

/** Autoplay off (or back on) after the current title, for everyone. */
export const setStopAfter = mutation({
  // The title the person was looking at: if it has already moved on, the click is stale.
  args: { token: v.string(), roomId: v.id("rooms"), on: v.boolean(), videoId: v.string() },
  handler: async (ctx, { token, roomId, on, videoId }) => {
    const profile = await requireProfile(ctx, token);
    const room = await getRoomOrThrow(ctx, roomId);
    await requireMember(ctx, roomId, profile._id);
    if (!room.media || room.media.videoId !== videoId || on === !!room.stopAfter) return;
    await ctx.db.patch(roomId, { stopAfter: on ? { by: profile._id, videoId: room.media.videoId } : undefined });
    await event(
      ctx,
      roomId,
      profile._id,
      on ? `stopped autoplay after ${room.media.type === "series" ? "this episode" : "this"}` : "turned autoplay back on",
    );
  },
});

// ---------- the lobby's table ----------

/** Put something on the table. Suggesting what's already there counts as being in for it. */
export const suggest = mutation({
  args: { token: v.string(), roomId: v.id("rooms"), media: mediaValidator },
  handler: async (ctx, { token, roomId, media }) => {
    const profile = await requireProfile(ctx, token);
    const room = await getRoomOrThrow(ctx, roomId);
    await requireMember(ctx, roomId, profile._id);
    const list = room.suggestions ?? [];
    const existing = list.find((s) => s.media.videoId === media.videoId);
    if (existing) {
      if (!existing.inIds.includes(profile._id)) {
        await ctx.db.patch(roomId, {
          suggestions: list.map((s) => (s.id === existing.id ? { ...s, inIds: [...s.inIds, profile._id] } : s)),
        });
        await event(ctx, roomId, profile._id, `is in for ${mediaTitle(media)}`);
      }
    } else {
      if (list.length >= SUGGESTION_LIMIT) throw new ConvexError({ code: "INVALID", message: "The table is full" });
      const item = { id: randomHex(6), media, by: profile._id, inIds: [profile._id], createdAt: Date.now() };
      await ctx.db.patch(roomId, { suggestions: [...list, item], lastActiveAt: Date.now() });
      await ctx.scheduler.runAfter(0, internal.engine.warm, {
        media,
        profileId: profile._id,
        keysFrom: room.hostId,
        screen: await screenFor(ctx, roomId, profile._id),
      });
      await event(ctx, roomId, profile._id, `suggested ${mediaTitle(media)}`);
    }
    await maybeStart(ctx, roomId);
  },
});

/** I'm in, or I'm out. */
export const vote = mutation({
  args: { token: v.string(), roomId: v.id("rooms"), suggestionId: v.string(), in: v.boolean() },
  handler: async (ctx, { token, roomId, suggestionId, in: isIn }) => {
    const profile = await requireProfile(ctx, token);
    const room = await getRoomOrThrow(ctx, roomId);
    await requireMember(ctx, roomId, profile._id);
    const target = (room.suggestions ?? []).find((s) => s.id === suggestionId);
    if (!target || target.inIds.includes(profile._id) === isIn) return;
    await ctx.db.patch(roomId, {
      suggestions: (room.suggestions ?? []).map((s) =>
        s.id === suggestionId
          ? { ...s, inIds: isIn ? [...s.inIds, profile._id] : s.inIds.filter((id) => id !== profile._id) }
          : s,
      ),
      ...(!isIn && room.starting?.suggestionId === suggestionId ? { starting: undefined } : {}),
    });
    if (isIn) {
      await event(ctx, roomId, profile._id, `is in for ${mediaTitle(target.media)}`);
      await maybeStart(ctx, roomId);
    }
  },
});

export const removeSuggestion = mutation({
  args: { token: v.string(), roomId: v.id("rooms"), suggestionId: v.string() },
  handler: async (ctx, { token, roomId, suggestionId }) => {
    const profile = await requireProfile(ctx, token);
    const room = await getRoomOrThrow(ctx, roomId);
    await requireMember(ctx, roomId, profile._id);
    await ctx.db.patch(roomId, {
      suggestions: (room.suggestions ?? []).filter((s) => s.id !== suggestionId),
      ...(room.starting?.suggestionId === suggestionId ? { starting: undefined } : {}),
    });
  },
});

/** Undo for a removal: back where it was. */
export const restoreSuggestion = mutation({
  args: { token: v.string(), roomId: v.id("rooms"), item: suggestionValidator, index: v.number() },
  handler: async (ctx, { token, roomId, item, index }) => {
    const profile = await requireProfile(ctx, token);
    const room = await getRoomOrThrow(ctx, roomId);
    await requireMember(ctx, roomId, profile._id);
    const list = (room.suggestions ?? []).filter((s) => s.id !== item.id);
    list.splice(Math.min(index, list.length), 0, item);
    await ctx.db.patch(roomId, { suggestions: list });
  },
});

/** Stop the "starting in 3" countdown. */
export const cancelStart = mutation({
  args: { token: v.string(), roomId: v.id("rooms") },
  handler: async (ctx, { token, roomId }) => {
    const profile = await requireProfile(ctx, token);
    const room = await getRoomOrThrow(ctx, roomId);
    await requireMember(ctx, roomId, profile._id);
    if (!room.starting) return;
    const target = (room.suggestions ?? []).find((s) => s.id === room.starting!.suggestionId);
    // Cancelling means you're not in after all, or the countdown would just restart.
    await ctx.db.patch(roomId, {
      starting: undefined,
      suggestions: (room.suggestions ?? []).map((s) =>
        s.id === target?.id ? { ...s, inIds: s.inIds.filter((id) => id !== profile._id) } : s,
      ),
    });
    if (target) await event(ctx, roomId, profile._id, `held off on ${mediaTitle(target.media)}`);
  },
});

/** Play something from the table right away, without waiting for everyone. */
export const playSuggestion = mutation({
  args: { token: v.string(), roomId: v.id("rooms"), suggestionId: v.string() },
  handler: async (ctx, { token, roomId, suggestionId }) => {
    const profile = await requireProfile(ctx, token);
    const room = await getRoomOrThrow(ctx, roomId);
    await requireMember(ctx, roomId, profile._id);
    const target = (room.suggestions ?? []).find((s) => s.id === suggestionId);
    if (!target) return;
    await upsertMember(ctx, roomId, profile._id);
    await startJob(ctx, room, { media: target.media, startAt: 0, by: profile._id });
    await event(ctx, roomId, profile._id, `put on ${mediaTitle(target.media)}`);
  },
});

export const startSuggestion = internalMutation({
  args: { roomId: v.id("rooms"), suggestionId: v.string(), at: v.number() },
  handler: async (ctx, { roomId, suggestionId, at }) => {
    const room = await ctx.db.get(roomId);
    if (!room || room.closedAt || room.starting?.suggestionId !== suggestionId || room.starting.at !== at) return;
    const target = (room.suggestions ?? []).find((s) => s.id === suggestionId);
    if (!target) return;
    await startJob(ctx, room, { media: target.media, startAt: 0, by: target.by });
    await event(ctx, roomId, target.by, `put on ${mediaTitle(target.media)}`);
  },
});

// ---------- switching while someone is watching ----------

/**
 * Play something else. If someone else is watching right now, ask them first; otherwise (alone, or
 * between titles) it plays straight away. Returns which happened.
 */
export const requestSwitch = mutation({
  args: { token: v.string(), roomId: v.id("rooms"), media: mediaValidator, startAt: v.optional(v.number()) },
  handler: async (ctx, { token, roomId, media, startAt = 0 }) => {
    const profile = await requireProfile(ctx, token);
    const room = await getRoomOrThrow(ctx, roomId);
    await requireMember(ctx, roomId, profile._id);
    const watching = room.status === "ready" || room.status === "preparing";
    const others = (await presentMembers(ctx, roomId)).filter((m) => m.profileId !== profile._id);
    if (!watching || others.length === 0 || room.kind !== "party") {
      await upsertMember(ctx, roomId, profile._id);
      await startJob(ctx, room, { media, startAt, by: profile._id });
      if (room.kind === "party") await event(ctx, roomId, profile._id, `put on ${mediaTitle(media)}`);
      return "played" as const;
    }
    await ctx.db.patch(roomId, {
      switchRequest: { id: randomHex(6), media, startAt, by: profile._id, createdAt: Date.now() },
    });
    return "asked" as const;
  },
});

export const answerSwitch = mutation({
  args: { token: v.string(), roomId: v.id("rooms"), requestId: v.string(), accept: v.boolean() },
  handler: async (ctx, { token, roomId, requestId, accept }) => {
    const profile = await requireProfile(ctx, token);
    const room = await getRoomOrThrow(ctx, roomId);
    await requireMember(ctx, roomId, profile._id);
    const request = room.switchRequest;
    if (!request || request.id !== requestId || request.declinedBy) return "gone" as const;
    if (request.by === profile._id)
      throw new ConvexError({ code: "FORBIDDEN", message: "You asked for this switch; the others answer it" });
    if (Date.now() - request.createdAt > SWITCH_TTL_MS) {
      await ctx.db.patch(roomId, { switchRequest: undefined });
      return "expired" as const;
    }
    if (accept) {
      await startJob(ctx, room, { media: request.media, startAt: request.startAt, by: request.by });
      await event(ctx, roomId, request.by, `put on ${mediaTitle(request.media)}`);
    } else {
      // Kept until the asker has seen the answer.
      await ctx.db.patch(roomId, { switchRequest: { ...request, declinedBy: profile._id } });
      await event(ctx, roomId, profile._id, "wants to keep watching");
    }
    return "done" as const;
  },
});

/** The asker lets it go ("Never mind", or acknowledging a no). The others say no with answerSwitch. */
export const cancelSwitch = mutation({
  args: { token: v.string(), roomId: v.id("rooms") },
  handler: async (ctx, { token, roomId }) => {
    const profile = await requireProfile(ctx, token);
    const room = await getRoomOrThrow(ctx, roomId);
    await requireMember(ctx, roomId, profile._id);
    if (!room.switchRequest) return;
    if (room.switchRequest.by !== profile._id)
      throw new ConvexError({ code: "FORBIDDEN", message: "Only whoever asked can call off a switch" });
    await ctx.db.patch(roomId, { switchRequest: undefined });
  },
});

/** Prepare what's likely next: the next episode while the current one plays, or a title whose Play the pointer rests on. */
export const warm = mutation({
  // From the player, the room it's for: then it's ready for everyone's screens there, not just this one.
  args: {
    token: v.string(),
    media: mediaValidator,
    screen: v.optional(screenValidator),
    roomId: v.optional(v.id("rooms")),
  },
  handler: async (ctx, { token, media, screen, roomId }) => {
    const profile = await requireProfile(ctx, token);
    const room = roomId ? await ctx.db.get(roomId) : null;
    await ctx.scheduler.runAfter(0, internal.engine.warm, {
      media,
      profileId: profile._id,
      keysFrom: room?.hostId,
      screen: roomId ? await screenFor(ctx, roomId, profile._id) : screen,
      binge: room ? bingeFor(room, media) : undefined,
    });
  },
});

/** The party I'm in, if any, for the header button that takes me back to it. */
export const mine = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const me = await requireProfile(ctx, token);
    const memberships = await ctx.db
      .query("roomMembers")
      .withIndex("by_profile", (q) => q.eq("profileId", me._id))
      .order("desc")
      .take(20);
    for (const m of memberships) {
      if (m.left) continue;
      const room = await ctx.db.get(m.roomId);
      if (!room || room.closedAt || room.kind !== "party") continue;
      if (Date.now() - room.lastActiveAt > PARTY_TTL_MS) continue;
      const rows = await ctx.db
        .query("roomMembers")
        .withIndex("by_room", (q) => q.eq("roomId", room._id))
        .collect();
      const members = [];
      for (const r of rows) {
        if (r.left) continue;
        const p = await ctx.db.get(r.profileId);
        if (p && !expired(p)) members.push({ ...publicProfile(p), lastSeenAt: r.lastSeenAt, watching: r.watching ?? true, isMe: p._id === me._id });
      }
      return {
        _id: room._id,
        media: room.media,
        status: room.status,
        playing: room.playback.playing,
        queueLength: (room.queue ?? []).length,
        next: room.next ?? room.queue?.[0],
        members,
      };
    }
    return null;
  },
});

/**
 * Rooms on right now that I could drop into: those hosted in my account, and those of other accounts I was invited to
 * or was in before. Each lists only my account's people in it; anyone else shows only once I'm in the room.
 */
export const live = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const me = await requireProfile(ctx, token);
    if (isGuest(me) || !me.accountId) return [];
    const accountId = me.accountId;
    const now = Date.now();
    const since = now - 6 * 60 * 60 * 1000;
    // Open rooms only: ended ones would take up the 20 and hide one that's on.
    const ours = await ctx.db
      .query("rooms")
      .withIndex("by_hostAccount_open", (q) => q.eq("hostAccountId", accountId).eq("closedAt", undefined).gt("lastActiveAt", since))
      .order("desc")
      .take(20);
    const elsewhere = new Set<Id<"rooms">>();
    for (const i of await ctx.db.query("invites").withIndex("by_to_status", (q) => q.eq("toId", me._id).eq("status", "pending")).collect())
      if (i.kind !== "knock") elsewhere.add(i.roomId);
    for (const m of await ctx.db.query("roomMembers").withIndex("by_profile", (q) => q.eq("profileId", me._id).gt("lastSeenAt", since)).order("desc").take(20))
      if (!m.kicked) elsewhere.add(m.roomId);
    const rooms = [...ours];
    for (const id of elsewhere) {
      const room = await ctx.db.get(id);
      if (room && !room.closedAt && room.lastActiveAt > since && !rooms.some((r) => r._id === id)) rooms.push(room);
    }
    const out = [];
    for (const room of rooms) {
      const members = await ctx.db
        .query("roomMembers")
        .withIndex("by_room", (q) => q.eq("roomId", room._id))
        .collect();
      const present = members.filter((m) => !m.left);
      if (present.some((m) => m.profileId === me._id)) continue;
      const ourHost = (await hostAccount(ctx, room)) === accountId;
      const others = [];
      for (const m of present) {
        const p = await ctx.db.get(m.profileId);
        if (!p || p.accountId !== accountId) continue;
        // In private mode only a party shows: one you start is meant to be joined.
        if (room.kind === "party" || !p.prefs.private) others.push({ ...publicProfile(p), lastSeenAt: m.lastSeenAt });
      }
      if (ourHost && others.length === 0) continue;
      out.push({
        _id: room._id,
        kind: room.kind ?? "solo",
        media: room.media,
        members: others,
        playing: room.playback.playing,
      });
    }
    return out;
  },
});

/**
 * Everyone who has been in the room, for names beside chat, suggestions and who asked for what, including people of
 * other accounts. Members only.
 */
export const people = query({
  args: { token: v.string(), roomId: v.id("rooms") },
  handler: async (ctx, { token, roomId }) => {
    const me = await requireProfile(ctx, token);
    await requireMember(ctx, roomId, me._id);
    const rows = await ctx.db.query("roomMembers").withIndex("by_room", (q) => q.eq("roomId", roomId)).collect();
    const out = [];
    for (const r of rows) {
      const p = await ctx.db.get(r.profileId);
      if (p) out.push(publicProfile(p));
    }
    return out;
  },
});

/**
 * The party's invite link code, made on first share: anyone signed in who opens the link joins, whatever their
 * account. Members of the party may share it; guests can't.
 */
export const shareLink = mutation({
  args: { token: v.string(), roomId: v.id("rooms") },
  returns: v.string(),
  handler: async (ctx, { token, roomId }) => {
    const me = await requireProfile(ctx, token);
    if (isGuest(me)) throw guestOnly();
    const room = await getRoomOrThrow(ctx, roomId);
    await requireMember(ctx, roomId, me._id);
    if (room.linkCode) return room.linkCode;
    const linkCode = randomHex(16);
    await ctx.db.patch(roomId, { linkCode, kind: "party" });
    return linkCode;
  },
});

/** What an invite link opens: whose party, and what's on. Null once the party has ended or the link is wrong. */
export const byLink = query({
  args: { token: v.string(), code: v.string() },
  handler: async (ctx, { token, code }) => {
    const me = await profileFromToken(ctx, token);
    if (!me || isGuest(me) || !/^[0-9a-f]{32}$/.test(code)) return null;
    const room = await ctx.db.query("rooms").withIndex("by_link", (q) => q.eq("linkCode", code)).unique();
    if (!room || room.closedAt) return null;
    const host = await ctx.db.get(room.hostId);
    const row = await memberRow(ctx, room._id, me._id);
    return {
      roomId: room._id,
      host: host ? publicProfile(host) : null,
      media: room.media,
      status: room.status,
      removed: !!row?.kicked,
      inIt: !!row && !row.left,
    };
  },
});

/** The host removes someone: they're out, and stay out even with the link. A guest's temporary profile ends. */
export const kick = mutation({
  args: { token: v.string(), roomId: v.id("rooms"), profileId: v.id("profiles") },
  returns: v.null(),
  handler: async (ctx, { token, roomId, profileId }) => {
    const me = await requireProfile(ctx, token);
    const room = await getRoomOrThrow(ctx, roomId);
    if (room.hostId !== me._id) throw new ConvexError({ code: "FORBIDDEN", message: "Only the host can remove people" });
    if (profileId === me._id) throw new ConvexError({ code: "INVALID", message: "Leave the party instead" });
    const row = await memberRow(ctx, roomId, profileId);
    const profile = await ctx.db.get(profileId);
    if (!row || !profile) return null;
    // Not swept: a heartbeat brings a swept row back.
    await ctx.db.patch(row._id, { left: true, watching: false, swept: false, kicked: true });
    for (const i of await ctx.db.query("invites").withIndex("by_room", (q) => q.eq("roomId", roomId)).collect())
      if (i.toId === profileId && i.status === "pending") await ctx.db.patch(i._id, { status: "cancelled" });
    await event(ctx, roomId, me._id, `removed ${profile.name}`);
    if (isGuest(profile)) {
      for (const invite of await ctx.db.query("temporaryInvites").withIndex("by_room", (q) => q.eq("roomId", roomId)).collect())
        if (invite.profileId === profileId) await ctx.db.delete(invite._id);
      await removeProfile(ctx, profileId);
    }
    return null;
  },
});

// ---------- internal, used by the engine ----------

export const getInternal = internalQuery({
  args: { roomId: v.id("rooms") },
  handler: async (ctx, { roomId }) => await ctx.db.get(roomId),
});

export const setStep = internalMutation({
  args: { roomId: v.id("rooms"), jobId: v.number(), step: v.string(), note: v.optional(v.string()) },
  handler: async (ctx, { roomId, jobId, step, note }) => {
    const room = await ctx.db.get(roomId);
    if (!room || room.jobId !== jobId) return false;
    // A Play waiting on another build asks every poll; only a new step is worth a write.
    if (room.step !== step || room.stepNote !== note) await ctx.db.patch(roomId, { step, stepNote: note });
    return true;
  },
});

export const setReady = internalMutation({
  args: {
    roomId: v.id("rooms"),
    jobId: v.number(),
    streamId: v.id("streams"),
    sourceIndex: v.number(),
    source: sourceSummaryValidator,
    // Someone chose this source: its binge group becomes the one this show's next episodes try first.
    picked: v.optional(v.boolean()),
  },
  handler: async (ctx, { roomId, jobId, streamId, sourceIndex, source, picked }) => {
    const room = await ctx.db.get(roomId);
    if (!room || room.jobId !== jobId) return;
    const now = Date.now();
    const show = room.media?.type === "series" ? room.media.imdbId : undefined;
    await rememberSource(ctx, room.requestedBy, room.media, source);
    await ctx.db.patch(roomId, {
      ...(picked ? { binge: show && source.bingeGroup ? { show, group: source.bingeGroup } : undefined } : {}),
      status: "ready",
      step: undefined,
      stepNote: undefined,
      error: undefined,
      errorDetail: undefined,
      sourceFallback: undefined,
      streamId,
      sourceIndex,
      source,
      lastActiveAt: now,
      playback: {
        ...room.playback,
        playing: false,
        anchorAt: now,
        seq: room.playback.seq + 1,
        action: "ready",
        // Whoever asked for this presses play for everyone once it can play.
        by: room.requestedBy,
      },
    });
  },
});

export const setError = internalMutation({
  args: { roomId: v.id("rooms"), jobId: v.number(), error: v.string(), detail: v.optional(v.string()), fallback: v.optional(sourceFallbackValidator) },
  handler: async (ctx, { roomId, jobId, error, detail, fallback }) => {
    const room = await ctx.db.get(roomId);
    if (!room || room.jobId !== jobId) return;
    await ctx.db.patch(roomId, { status: "error", step: undefined, stepNote: undefined, error, errorDetail: detail, sourceFallback: fallback });
  },
});

// Compatibility for older tabs with multi-item Up next.
export const queueAdd = mutation({
  args: { token: v.string(), roomId: v.id("rooms"), media: mediaValidator },
  handler: async (ctx, { token, roomId, media }) => {
    const profile = await requireProfile(ctx, token);
    const room = await getRoomOrThrow(ctx, roomId);
    await requireMember(ctx, roomId, profile._id);
    const queue = room.queue ?? [];
    if (queue.some((q) => q.media.videoId === media.videoId)) return false;
    if (queue.length >= QUEUE_LIMIT) throw new ConvexError({ code: "INVALID", message: "Up next is full" });
    const item = { id: randomHex(6), media, addedBy: profile._id, addedAt: Date.now() };
    await ctx.db.patch(roomId, { queue: [...queue, item], next: room.next ?? queue[0] ?? item, lastActiveAt: Date.now() });
    // Get it ready now, so playing it later starts at once.
    await ctx.scheduler.runAfter(0, internal.engine.warm, {
      media,
      profileId: profile._id,
      keysFrom: room.hostId,
      screen: await screenFor(ctx, roomId, profile._id),
      binge: bingeFor(room, media),
    });
    await event(ctx, roomId, profile._id, `added ${mediaTitle(media)} to Up next`);
    return true;
  },
});

export const queueRemove = mutation({
  args: { token: v.string(), roomId: v.id("rooms"), itemId: v.string() },
  handler: async (ctx, { token, roomId, itemId }) => {
    const profile = await requireProfile(ctx, token);
    const room = await getRoomOrThrow(ctx, roomId);
    await requireMember(ctx, roomId, profile._id);
    const queue = (room.queue ?? []).filter((q) => q.id !== itemId);
    await ctx.db.patch(roomId, { queue, next: queue[0] });
  },
});

export const queueRestore = mutation({
  args: {
    token: v.string(),
    roomId: v.id("rooms"),
    item: v.object({ id: v.string(), media: mediaValidator, addedBy: v.id("profiles"), addedAt: v.number() }),
    index: v.number(),
  },
  handler: async (ctx, { token, roomId, item, index }) => {
    const profile = await requireProfile(ctx, token);
    const room = await getRoomOrThrow(ctx, roomId);
    await requireMember(ctx, roomId, profile._id);
    const queue = (room.queue ?? []).filter((q) => q.id !== item.id);
    queue.splice(Math.min(index, queue.length), 0, item);
    await ctx.db.patch(roomId, { queue, next: queue[0] });
  },
});

export const queueMove = mutation({
  args: { token: v.string(), roomId: v.id("rooms"), itemId: v.string(), to: v.number() },
  handler: async (ctx, { token, roomId, itemId, to }) => {
    const profile = await requireProfile(ctx, token);
    const room = await getRoomOrThrow(ctx, roomId);
    await requireMember(ctx, roomId, profile._id);
    const queue = [...(room.queue ?? [])];
    const from = queue.findIndex((q) => q.id === itemId);
    if (from === -1) return;
    const [item] = queue.splice(from, 1);
    queue.splice(Math.max(0, Math.min(to, queue.length)), 0, item);
    await ctx.db.patch(roomId, { queue, next: queue[0] });
  },
});

export const queuePlay = mutation({
  args: { token: v.string(), roomId: v.id("rooms"), itemId: v.string() },
  handler: async (ctx, { token, roomId, itemId }) => {
    const profile = await requireProfile(ctx, token);
    const room = await getRoomOrThrow(ctx, roomId);
    await requireMember(ctx, roomId, profile._id);
    const item = (room.queue ?? []).find((q) => q.id === itemId);
    if (!item) return;
    await ctx.db.patch(roomId, { queue: (room.queue ?? []).filter((q) => q.id !== itemId) });
    await startJob(ctx, (await ctx.db.get(roomId))!, { media: item.media, startAt: 0, by: profile._id });
    await event(ctx, roomId, profile._id, `put on ${mediaTitle(item.media)}`);
  },
});
