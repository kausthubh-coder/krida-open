import { useCallback, useEffect, useRef } from "react";
import { useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { serverNow as appServerNow } from "../party";

export type Playback = {
  playing: boolean;
  position: number;
  anchorAt: number;
  seq: number;
  by?: Id<"profiles">;
  action?: string;
};

/**
 * The room state to wait for after sending an action. Each action moves the room on by one, so a second sent before
 * the first came back (two quick skips) is one past the first, not the same state again.
 */
export const pendingAfterSend = (pending: number, roomSeq: number) => Math.max(pending, roomSeq) + 1;

/**
 * Whether a room state is our own last action coming back, an earlier one overtaken by ours ("passed": following it
 * would jump back to where we've just left, and ours coming back would jump forward again), or someone else's.
 * Someone else's action landing just before ours takes the place we expected ours in: ours still overwrites it.
 * One landing after ours is theirs, whoever's turn it seemed to be.
 */
export function echoOf(seq: number, pending: number, byMe = true): "ours" | "passed" | "theirs" {
  if (pending === 0) return "theirs";
  if (seq < pending) return "passed";
  if (byMe) return "ours";
  return seq === pending ? "passed" : "theirs";
}

/**
 * Keeps one <video> in step with the room's shared clock.
 *
 * The room stores a single anchor: "at server time T, playback was at position P, playing or not".
 * Every client derives where it should be from that anchor and its own clock offset to the server,
 * corrects small drift by nudging the playback rate, and seeks only when it is far off.
 *
 * `rate` is the speed you chose, alone in the room (a party always plays at 1). Away from 1 there's no drift to
 * correct, since nobody else shares the clock, so it re-anchors the room's clock to the picture instead: when the
 * speed changes, and every 10 seconds while it plays, so a reload or a change of source starts where you are.
 */
export function useRoomSync({
  video,
  playback,
  roomId,
  token,
  enabled,
  rate = 1,
  myId,
  videoId,
  onAutoplayBlocked,
}: {
  video: HTMLVideoElement | null;
  playback: Playback;
  roomId: Id<"rooms">;
  /** The title on screen. */
  videoId?: string;
  token: string;
  enabled: boolean;
  rate?: number;
  /** Tells our own actions coming back from someone else's landing at the same moment. */
  myId?: Id<"profiles">;
  onAutoplayBlocked: () => void;
}) {
  const clock = useMutation(api.rooms.clock);
  const control = useMutation(api.rooms.control);
  // Until this room's own measure is in, the app's (usually measured already) places a joiner mid-title.
  const offset = useRef(appServerNow() - Date.now());
  const pb = useRef(playback);
  pb.current = playback;
  // Ignore our own echo for actions we already applied locally.
  const pendingLocal = useRef(0);
  const sentAt = useRef(0);
  const speed = useRef(rate);
  speed.current = rate;

  // Measure the clock offset: keep the sample with the shortest round trip.
  useEffect(() => {
    let alive = true;
    (async () => {
      let best = { rtt: Infinity, offset: 0 };
      for (let i = 0; i < 4 && alive; i++) {
        const t0 = Date.now();
        const server = await clock({}).catch(() => null);
        const t1 = Date.now();
        if (server === null) continue;
        const rtt = t1 - t0;
        if (rtt < best.rtt) best = { rtt, offset: server - (t0 + t1) / 2 };
      }
      if (alive && best.rtt !== Infinity) offset.current = best.offset;
    })();
    return () => {
      alive = false;
    };
  }, [clock]);

  /** Now, on the server's clock, which the room's anchors are stamped with. */
  const serverNow = useCallback(() => Date.now() + offset.current, []);
  const expected = useCallback((p: Playback = pb.current) => {
    if (!p.playing) return p.position;
    return p.position + (serverNow() - p.anchorAt) / 1000;
  }, [serverNow]);

  const blocked = useRef(false);
  const apply = useCallback(
    (p: Playback) => {
      if (!video || !enabled) return;
      // Before the stream has loaded, seeking and playing are silently dropped: wait for it.
      if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
        video.addEventListener("loadedmetadata", () => applyRef.current(pb.current), { once: true });
        return;
      }
      const target = expected(p);
      if (Number.isFinite(target) && Math.abs(video.currentTime - target) > 1) video.currentTime = target;
      if (p.playing && video.paused && !video.ended) {
        video.play().then(
          () => (blocked.current = false),
          (err: DOMException) => {
            if (err.name === "NotAllowedError") {
              blocked.current = true;
              onAutoplayBlocked();
            }
          },
        );
      } else if (!p.playing && !video.paused) {
        video.pause();
      }
      if (!p.playing) video.playbackRate = speed.current;
    },
    [video, enabled, expected, onAutoplayBlocked],
  );
  const applyRef = useRef(apply);
  applyRef.current = apply;

  // Apply every new room state.
  useEffect(() => {
    const echo = echoOf(playback.seq, pendingLocal.current, !myId || playback.by === myId);
    if (echo === "passed") return;
    pendingLocal.current = 0;
    if (echo === "ours") {
      // Our own action: the video is already there; only fix a large gap.
      if (video && enabled && Math.abs(video.currentTime - expected(playback)) > 1.5) apply(playback);
      return;
    }
    apply(playback);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playback.seq, video, enabled]);

  // Gentle drift correction while playing.
  useEffect(() => {
    if (!video || !enabled) return;
    let ticks = 0;
    const id = window.setInterval(() => {
      // Our own play, seek or new speed is on its way to the room: until it's back (or for 3 seconds, if it's lost),
      // the room's clock is the old one.
      if (pendingLocal.current > 0 && Date.now() - sentAt.current < 3000) return;
      const p = pb.current;
      // The party is playing but we aren't (a missed play, or we just came back): catch up.
      if (p.playing && video.paused && !video.ended && !blocked.current && video.readyState >= 2) {
        apply(p);
        return;
      }
      if (!p.playing || video.paused || video.seeking || video.readyState < 3) {
        if (video.playbackRate !== speed.current) video.playbackRate = speed.current;
        return;
      }
      if (speed.current !== 1) {
        if (video.playbackRate !== speed.current) video.playbackRate = speed.current;
        if (++ticks % 10 === 0) sendRef.current("rate", true, video.currentTime);
        return;
      }
      const drift = video.currentTime - expected(p);
      if (Math.abs(drift) > 2.5) {
        video.currentTime = expected(p);
        video.playbackRate = 1;
      } else if (Math.abs(drift) > 0.35) {
        video.playbackRate = drift > 0 ? 0.95 : 1.05;
      } else {
        video.playbackRate = 1;
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, [video, enabled, expected, apply]);

  // Our action didn't come back (refused, or lost): what we passed over meanwhile is the room's state after all.
  const giveUp = useCallback((pending: number) => {
    if (pendingLocal.current !== pending) return;
    pendingLocal.current = 0;
    applyRef.current(pb.current);
  }, []);

  const send = useCallback(
    (action: "play" | "pause" | "seek" | "wait" | "resume" | "move on" | "skip" | "rate", playing: boolean, position: number) => {
      const pending = pendingAfterSend(pendingLocal.current, pb.current.seq);
      pendingLocal.current = pending;
      sentAt.current = Date.now();
      window.setTimeout(() => giveUp(pending), 3000);
      // When it was pressed, and on which title: a slow request still starts the clock from the press, and a late
      // one from the title before can't move the next.
      void control({ token, roomId, playing, position, action, videoId, at: serverNow() }).catch(() => giveUp(pending));
    },
    [control, token, roomId, videoId, serverNow, giveUp],
  );
  const sendRef = useRef(send);
  sendRef.current = send;

  // A new speed: the picture takes it at once, and the room's clock starts again from here at the new pace. The
  // next episode starts at the speed the last one had (loading the stream resets it; the drift check puts it back).
  const lastRate = useRef(rate);
  useEffect(() => {
    if (!video || !enabled) return;
    video.playbackRate = rate;
    if (lastRate.current === rate) return;
    lastRate.current = rate;
    if (!video.paused) send("rate", true, video.currentTime);
  }, [video, enabled, rate, send]);

  return { expected, send, apply, serverNow };
}
