// Watching in step: holding for whoever is buffering, and skipping intros and recaps once, for everyone.
import { useEffect, useRef, useState, type RefObject } from "react";
import type { Me } from "../../data/session";
import type { Member, RoomData } from "../party";
import type { Playback, useRoomSync } from "./playbackSync";
import { inside, landing, skippedAt, type Part } from "./skips";
import type { SkipPart } from "./automatic";

/** How long "Skipped intro" offers Watch it. A toast with a button gets time to read and reach. */
export const RECEIPT_SECONDS = 8;

/**
 * Who the room holds for, and who leads. The first viewer who isn't buffering leads, so the leader is the same on
 * every screen. Alone, you still hold for yourself: it stops the room's clock where the picture stalled, so it doesn't
 * jump ahead once it loads. Only `together` says anyone is waiting.
 */
export function bufferingHold(online: Member[], myId: string, buffering: boolean) {
  const isBuffering = (x: Member) => (x.isMe ? buffering : x.buffering);
  const watchers = online.filter((x) => x.watching || x.isMe).sort((a, b) => a._id.localeCompare(b._id));
  const holdFor = watchers.filter(isBuffering);
  const leader = watchers.find((x) => !isBuffering(x)) ?? watchers[0];
  return { holdFor, iLead: leader?._id === myId, together: watchers.length > 1 };
}

/** The longest the room waits for anyone. */
export const HOLD_MAX_MS = 20_000;
/** After carrying on without someone, how long before their stalls hold the room again. */
export const MOVED_ON_MS = 30_000;

/**
 * The leader's next step in a hold, `now` on the server's clock. A short stall right after starting or seeking is
 * normal, so only one that lasts 2.5 seconds holds the room. It carries on once everyone has caught up, or after
 * 20 seconds ("move on") so one bad connection can't stall the party; then their stalls don't hold it again for a
 * while, or it would sit paused nearly all the time. Alone, it holds for as long as the stall lasts: there's no one
 * to move on for.
 */
export function holdStep(p: Playback, holding: number, now: number, together: boolean): { send: "wait" | "resume" | "move on"; delay: number } | null {
  const since = now - p.anchorAt;
  if (p.playing && holding > 0) {
    return { send: "wait", delay: p.action === "move on" ? Math.max(2500, MOVED_ON_MS - since) : 2500 };
  }
  if (p.action === "wait" && !p.playing) {
    if (holding === 0) return { send: "resume", delay: 600 };
    return together ? { send: "move on", delay: Math.max(0, HOLD_MAX_MS - since) } : null;
  }
  return null;
}

/**
 * Hold for whoever is buffering (yourself included), then carry on together. Without this, a stalled viewer falls
 * behind, jumps ahead to catch up, and lands somewhere TorBox hasn't converted yet. The leader pauses the room and
 * starts it again.
 */
export function useBufferingHold({ video, room, online, me, buffering, sync, setBlocked }: {
  video: HTMLVideoElement | null;
  room: RoomData;
  online: Member[];
  me: Me;
  buffering: boolean;
  sync: ReturnType<typeof useRoomSync>;
  setBlocked: (blocked: boolean) => void;
}) {
  const { holdFor, iLead, together } = bufferingHold(online, me._id, buffering);
  const waitingForOthers = room.playback.action === "wait" && !room.playback.playing;
  useEffect(() => {
    if (!iLead || !video) return;
    const step = holdStep(room.playback as Playback, holdFor.length, sync.serverNow(), together);
    if (!step) return;
    const t = setTimeout(() => {
      if (step.send === "wait") {
        // The room's clock stops here, so the picture has to: playing on would leave whoever stalled to jump ahead
        // to catch up when it starts again. Stalled ourselves, the picture has stopped already.
        if (!buffering) video.pause();
        sync.send("wait", false, video.currentTime);
      } else {
        video.play().catch(() => setBlocked(true));
        sync.send(step.send, true, video.currentTime);
      }
    }, step.delay);
    return () => clearTimeout(t);
  }, [iLead, video, room.playback.seq, holdFor.length, waitingForOthers, together]); // eslint-disable-line react-hooks/exhaustive-deps
  return { holdFor, iLead, waitingForOthers, together };
}

/**
 * Whether playback at `time` has just run into `seg`. With no tick before (`prev` null) it only counts when this
 * screen opened the title there: a reload, or someone joining, inside an intro mustn't skip it for everyone.
 */
export function ranInto(seg: { start: number; end: number }, prev: number | null, time: number, openedHere: boolean) {
  return (prev === null ? openedHere : prev < seg.start) && inside(seg, time);
}

/**
 * How many of `marks` the time has reached. The player's time changes only when this does (useVideoState): the skip
 * buttons, Up next and the next episode's warm-up compare the time with these marks alone, so between two of them a
 * playing film has nothing to redraw.
 */
export function stageOf(marks: number[], time: number) {
  let reached = 0;
  for (const mark of marks) if (time >= mark) reached++;
  return reached;
}

/**
 * What reads the player's time compares it with these alone: each skippable part's start and last second (the skip
 * button), the minute the next episode warms at, and Up next's last 40 seconds, just past the line, as that's "under
 * 40 left".
 */
export function playerMarks(parts: ({ start: number; end: number } | undefined)[], duration: number) {
  return parts.flatMap((seg) => (seg ? [seg.start, seg.end - 1] : [])).concat(60, duration - 40 + 0.001);
}

export type Receipt = { parts: SkipPart[]; seq: number };

/**
 * Only playback running into an intro or recap skips it (opening an episode inside one counts); a seek into one
 * never does. The leader seeks once, for everyone, and everyone sees what was skipped, with a moment to bring it back.
 */
export function useAutoSkip({ video, room, iLead, waitingForOthers, autoParts, declined, seekTo, serverNow }: {
  video: HTMLVideoElement | null;
  room: RoomData;
  iLead: boolean;
  waitingForOthers: boolean;
  autoParts: Part<SkipPart>[];
  declined: RefObject<Set<SkipPart>>;
  seekTo: (t: number, action?: "seek" | "skip") => void;
  serverNow: () => number;
}) {
  const stream = room.stream!;
  const lastTick = useRef<number | null>(null);
  // The title was ready but not yet started when this screen opened it.
  const openedHere = useRef(room.playback.action === "ready");
  // Watched from the video's own time, not the player's: that changes only at a few marks (stageOf).
  const latest = useRef({ iLead, waitingForOthers, autoParts, seekTo });
  useEffect(() => {
    latest.current = { iLead, waitingForOthers, autoParts, seekTo };
  });
  useEffect(() => {
    if (!video) return;
    const onTime = () => {
      if (video.paused) return;
      const time = video.currentTime;
      const prev = lastTick.current;
      lastTick.current = time;
      if (prev !== null && Math.abs(time - prev) > 2) return;
      const { iLead, waitingForOthers, autoParts, seekTo } = latest.current;
      if (!iLead || waitingForOthers) return;
      for (const seg of autoParts) {
        if (ranInto(seg, prev, time, openedHere.current)) {
          // One seek past this part and any it overlaps or nearly touches (a recap running into the intro).
          const to = landing(autoParts, seg.end);
          // Just before the end, so a part that starts later is run into, not jumped to.
          lastTick.current = to - 0.01;
          seekTo(to, "skip");
          return;
        }
      }
    };
    video.addEventListener("timeupdate", onTime);
    return () => video.removeEventListener("timeupdate", onTime);
  }, [video]);

  const [receipt, setReceipt] = useState<Receipt | null>(null);
  // Hovering or focusing it holds the timer. Keyed to one receipt, so a hover that never got its pointerleave
  // can't hold the next.
  const [heldSeq, setHeldSeq] = useState<number | null>(null);
  const [focusedSeq, setFocusedSeq] = useState<number | null>(null);
  useEffect(() => {
    const p = room.playback;
    if (p.action !== "skip" || serverNow() - p.anchorAt > RECEIPT_SECONDS * 1000) return;
    const parts = skippedAt(autoParts, p.position);
    if (parts.length > 0) setReceipt({ parts, seq: p.seq });
  }, [room.playback.seq]); // eslint-disable-line react-hooks/exhaustive-deps
  const watchSkipped = () => {
    if (!receipt) return;
    for (const part of receipt.parts) declined.current.add(part);
    const start = Math.min(...receipt.parts.map((part) => stream[part]?.start ?? Infinity));
    setReceipt(null);
    if (Number.isFinite(start)) seekTo(start);
  };
  return { receipt, dismissReceipt: () => setReceipt(null), held: !!receipt && (heldSeq === receipt.seq || focusedSeq === receipt.seq), setHeldSeq, setFocusedSeq, watchSkipped };
}
